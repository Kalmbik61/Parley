import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyFeedState } from '../reduce.js';
import type { FeedAgent, FeedItem, FeedNotice, FeedPrompt, FeedText, FeedTool, FeedTurn } from '../types.js';
import { applyCodexRecords, CODEX_HISTORY_IN_TERMINAL, commandText, emptyCodexCursor, feedFromCodexRollout } from './apply-codex.js';
import { parseRolloutLine, type RolloutRecord } from './rollout-record.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const records = (name: string): RolloutRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.rollout.jsonl`), 'utf8')
    .split('\n')
    .map(parseRolloutLine)
    .filter((record): record is RolloutRecord => record !== null);
const ofKind = <K extends FeedItem['kind']>(items: readonly FeedItem[], kind: K): Array<Extract<FeedItem, { kind: K }>> =>
  items.filter((item): item is Extract<FeedItem, { kind: K }> => item.kind === kind);

describe('feedFromCodexRollout — основной тред', () => {
  const { state, cursor } = feedFromCodexRollout(records('codex-main'));

  it('порядок элементов ленты', () => {
    expect(state.items.map((item) => item.kind)).toEqual([
      'notice', 'prompt', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'text', 'turn', 'prompt', 'turn',
    ]);
  });

  it('модель из turn_context — заметка session-start; режим — approval · sandbox', () => {
    const notice = ofKind(state.items, 'notice')[0] as FeedNotice;
    expect(notice.notice).toEqual({ type: 'session-start', source: 'codex', model: 'gpt-6-astra' });
    expect(state.permissionMode).toBe('on-request · workspace-write');
  });

  it('промпт и итоговый текст', () => {
    expect((ofKind(state.items, 'prompt')[0] as FeedPrompt).text).toBe('Почини тесты ленты');
    const text = ofKind(state.items, 'text')[0] as FeedText;
    expect(text).toMatchObject({ text: 'Готово: тесты зелёные.', streaming: false, messageId: 'am1' });
  });

  it('команды: скрипт оболочки как есть, вывод, ненулевой код — failed', () => {
    const [cmd1, cmd2] = ofKind(state.items, 'tool') as FeedTool[];
    expect(cmd1).toMatchObject({ name: 'Bash', status: 'done', toolUseId: 'call_cmd1' });
    expect(cmd1?.input['command']).toBe('pnpm -C packages/core exec vitest run src/feed/codex --reporter=verbose 2>&1 | tail -n 40');
    expect(cmd1?.response?.text).toBe('Test Files 2 passed');
    expect(cmd2).toMatchObject({ name: 'Bash', status: 'failed' });
    expect(cmd2?.input['command']).toBe('git commit -m "fix: тесты"');
  });

  it('правка файла: Edit с хунками, Write без хунков, Delete', () => {
    const files = (ofKind(state.items, 'tool') as FeedTool[]).filter((tool) => ['Edit', 'Write', 'Delete'].includes(tool.name));
    expect(files.map((tool) => [tool.name, tool.input['file_path']])).toEqual([
      ['Edit', '/tmp/p/src/a.ts'], ['Write', '/tmp/p/src/new.ts'], ['Delete', '/tmp/p/src/old.ts'],
    ]);
    expect(files[0]?.patch?.[0]?.lines).toEqual([' const a = 1;', '-const b = 2;', '+const b = 3;']);
    expect(files[1]?.patch).toBeUndefined();
    expect(files[1]?.input['content']).toBe('export const x = 1;\n');
  });

  it('MCP — сервер и инструмент в имени, ответ текстом', () => {
    const mcp = (ofKind(state.items, 'tool') as FeedTool[]).find((tool) => tool.name.startsWith('mcp__'));
    expect(mcp).toMatchObject({ name: 'mcp__parley__report', input: { status: 'done' }, status: 'done' });
    expect(mcp?.response?.text).toBe('ok');
  });

  it('конец хода; прерванный ход — interrupted', () => {
    const [done, aborted] = ofKind(state.items, 'turn') as FeedTurn[];
    expect(done?.interrupted).toBeUndefined();
    expect(aborted?.interrupted).toBe(true);
  });

  it('незнакомый тип элемента считается и пропускается; журнал современный', () => {
    expect(cursor.skipped).toBe(1);
    expect(cursor.modern).toBe(true);
    expect(cursor.lastOrdinal).toBe(14);
  });
});

describe('applyCodexRecords', () => {
  it('записи с ordinal не больше применённого — без дублей', () => {
    const all = records('codex-main');
    const first = applyCodexRecords(emptyFeedState(), all.slice(0, 6), emptyCodexCursor());
    const again = applyCodexRecords(first.update.state, all.slice(3, 9), first.cursor);
    const once = feedFromCodexRollout(all.slice(0, 9)).state;
    expect(again.update.state.items.map((item) => item.id)).toEqual(once.items.map((item) => item.id));
  });

  it('смена модели — заметка model-switch', () => {
    const ctx = (ordinal: number, model: string): RolloutRecord => ({ ordinal, at: '2026-10-07T10:00:00.000Z', type: 'turn_context', payload: { model, approval_policy: 'on-request' } });
    const { update } = applyCodexRecords(emptyFeedState(), [ctx(1, 'gpt-6'), ctx(2, 'gpt-6'), ctx(3, 'gpt-6-mini')], emptyCodexCursor());
    const notices = ofKind(update.state.items, 'notice').map((item) => item.notice);
    expect(notices).toEqual([
      { type: 'session-start', source: 'codex', model: 'gpt-6' },
      { type: 'model-switch', from: 'gpt-6', to: 'gpt-6-mini', source: 'codex' },
    ]);
  });

  it('записи журнала субагента — вызовы в children его карточки, текст и ход не в ленту', () => {
    const agent: FeedAgent = { id: 'agent:th-sub', at: 't', kind: 'agent', toolUseId: 'th-sub', agentId: 'th-sub', agentType: null, description: null, prompt: null, model: null, background: false, status: 'running', toolCount: 0, children: [] };
    const base = { ...emptyFeedState(), items: [agent] };
    const all = records('codex-main');
    const { update } = applyCodexRecords(base, all, emptyCodexCursor(), 'th-sub');
    const card = update.state.items.find((item) => item.kind === 'agent') as FeedAgent;
    expect(update.state.items).toHaveLength(1);
    expect(card.children.map((child) => child.name)).toEqual(['Bash', 'Bash', 'Edit', 'Write', 'Delete', 'mcp__parley__report']);
    expect(card.toolCount).toBe(6);
    expect(card.children[2]?.patch).toBeUndefined();
  });
});

describe('журнал без item_completed (Codex до 0.160)', () => {
  it('одна ошибка-заметка «история в терминале», без элементов разговора', () => {
    const legacy: RolloutRecord[] = [
      { ordinal: null, at: '2026-09-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'old', cli_version: '0.150.0' } },
      { ordinal: null, at: '2026-09-01T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      { ordinal: null, at: '2026-09-01T10:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant' } },
    ];
    const { state, cursor } = feedFromCodexRollout(legacy);
    expect(cursor.modern).toBe(false);
    expect(state.items).toEqual([expect.objectContaining({ kind: 'error', error: CODEX_HISTORY_IN_TERMINAL })]);
  });
});

describe('commandText', () => {
  it('оболочка -lc — скрипт; иначе аргументы, с пробелами — в кавычках; не массив — пусто', () => {
    expect(commandText(['/bin/bash', '-lc', 'ls -la'])).toBe('ls -la');
    expect(commandText(['rg', 'Feed Agent', 'src'])).toBe('rg "Feed Agent" src');
    expect(commandText('ls')).toBe('');
  });
});
