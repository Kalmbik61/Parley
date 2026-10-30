import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { foldFeed, formatTurnDuration, groupTitle, turnStatusText, workKind, type FoldRow } from './turn-fold.js';

let seq = 0;
const base = (): { id: string; at: string } => ({ id: `i${(seq += 1)}`, at: '2026-10-30T00:00:00Z' });
const prompt = (text = 'do it'): FeedItem => ({ ...base(), kind: 'prompt', text, images: 0 });
const text = (): FeedItem => ({ ...base(), kind: 'text', messageId: null, text: 'reply', streaming: false });
const tool = (name: string): FeedItem => ({ ...base(), kind: 'tool', toolUseId: 't', name, input: {}, status: 'done' });
const agent = (): FeedItem =>
  ({ ...base(), kind: 'agent', toolUseId: 'a', agentId: null, agentType: null, description: null, prompt: null, model: null, background: false, status: 'done', toolCount: 0, children: [] }) as FeedItem;
const permission = (): FeedItem => ({ ...base(), kind: 'permission', state: 'pending' }) as unknown as FeedItem;
const notice = (): FeedItem => ({ ...base(), kind: 'notice', notice: { type: 'session-end', reason: null } });
const turn = (durationMs: number | null = 1000, interrupted = false): FeedItem =>
  ({ ...base(), kind: 'turn', durationMs, ...(interrupted ? { interrupted: true } : {}) }) as FeedItem;
const failure = (): FeedItem => ({ ...base(), kind: 'error', error: 'boom', message: null });
const retry = (): FeedItem => ({ ...base(), kind: 'error', error: 'busy', message: null, retry: { delayMs: 1, attempt: 1, maxAttempts: 3 } });

const none = new Set<string>();
const shape = (rows: FoldRow[]): string[] => rows.map((row) => (row.kind === 'item' ? row.item.kind : row.kind === 'group' ? `group:${row.title}` : `control:${row.status}`));

describe('foldFeed: режим off', () => {
  it('по строке на элемент, включая turn, без control', () => {
    const items = [prompt(), tool('Read'), text(), turn()];
    expect(shape(foldFeed(items, 'off', none))).toEqual(['prompt', 'tool', 'text', 'turn']);
  });
});

describe('foldFeed: границы хода', () => {
  it('завершённый ход: control после промпта, turn не выводится', () => {
    const rows = foldFeed([prompt(), tool('Bash'), text(), turn(2000)], 'replies', none);
    expect(shape(rows)).toEqual(['prompt', 'control:completed', 'group:Ran commands', 'text']);
    expect(rows[1]).toMatchObject({ durationMs: 2000 });
  });

  it('turn с interrupted — остановлен и не сворачивается', () => {
    expect(shape(foldFeed([prompt(), tool('Bash'), turn(5, true)], 'replies', none))).toEqual(['prompt', 'control:stopped', 'tool']);
  });

  it('error без retry — упал, error остаётся в ленте, ход не сворачивается', () => {
    expect(shape(foldFeed([prompt(), tool('Bash'), failure()], 'replies', none))).toEqual(['prompt', 'control:failed', 'tool', 'error']);
  });

  it('идущий ход без control и не сворачивается', () => {
    expect(shape(foldFeed([prompt(), tool('Bash'), text()], 'replies', none))).toEqual(['prompt', 'tool', 'text']);
  });

  it('промпт внутри незакрытого хода: оба хода не сворачиваются', () => {
    const rows = foldFeed([prompt(), tool('Bash'), prompt(), tool('Read'), turn()], 'replies', none);
    expect(shape(rows)).toEqual(['prompt', 'tool', 'prompt', 'control:completed', 'tool']);
  });

  it('следующий закрытый ход после незакрытого сворачивается снова', () => {
    const rows = foldFeed([prompt(), tool('Bash'), prompt(), turn(), prompt(), tool('Read'), turn()], 'replies', none);
    expect(shape(rows).slice(-3)).toEqual(['prompt', 'control:completed', 'group:Read files']);
  });

  it('слеш-команда без ответа считается закрытой', () => {
    const rows = foldFeed([prompt('/clear'), notice(), prompt(), tool('Read'), turn()], 'replies', none);
    expect(shape(rows)).toEqual(['prompt', 'notice', 'prompt', 'control:completed', 'group:Read files']);
  });

  it('элементы до первого промпта не трогаем', () => {
    const rows = foldFeed([notice(), tool('Read'), turn(), prompt(), tool('Read'), turn()], 'replies', none);
    expect(shape(rows).slice(0, 3)).toEqual(['notice', 'tool', 'turn']);
  });
});

describe('foldFeed: что видно', () => {
  it('replies: все тексты, карточки и notice видны; вызовы, агенты и retry в группах', () => {
    const items = [prompt(), tool('Read'), text(), permission(), agent(), retry(), notice(), turn()];
    expect(shape(foldFeed(items, 'replies', none))).toEqual(['prompt', 'control:completed', 'group:Read files', 'text', 'permission', 'group:Ran subagents', 'notice']);
  });

  it('final: виден только последний текст, если за ним нет вызовов', () => {
    const items = [prompt(), text(), tool('Read'), text(), turn()];
    expect(shape(foldFeed(items, 'final', none))).toEqual(['prompt', 'control:completed', 'group:Read files', 'text']);
  });

  it('final: если за последним текстом идёт вызов, текстов не видно', () => {
    const items = [prompt(), text(), tool('Read'), turn()];
    expect(shape(foldFeed(items, 'final', none))).toEqual(['prompt', 'control:completed', 'group:Read files']);
  });

  it('открытая группа выводит свои элементы следом; ключ — id первого', () => {
    const first = tool('Read');
    const items = [prompt(), first, tool('Bash'), turn()];
    const rows = foldFeed(items, 'replies', new Set([first.id]));
    expect(rows[2]).toMatchObject({ kind: 'group', key: first.id, open: true, count: 2 });
    expect(shape(rows)).toEqual(['prompt', 'control:completed', 'group:Read files, ran commands', 'tool', 'tool']);
  });
});

describe('workKind и заголовок', () => {
  it('таблица видов', () => {
    expect(workKind('ViewImage')).toBe('read');
    expect(workKind('Glob')).toBe('search');
    expect(workKind('exec_command')).toBe('shell');
    expect(workKind('apply_patch')).toBe('edit');
    expect(workKind('WebSearch')).toBe('web');
    expect(workKind('mcp__parley__browser_open')).toBe('browser');
    expect(workKind('mcp__claude-in-chrome__navigate')).toBe('browser');
    expect(workKind('mcp__playwright__click')).toBe('browser');
    expect(workKind('close_agent')).toBe('agents');
    expect(workKind('mcp__parley__get_map')).toBe('parley');
    expect(workKind('mcp__other__thing')).toBe('tools');
    expect(workKind('Whatever')).toBe('tools');
  });

  it('три самых частых, ничьи — по первому появлению, без чисел', () => {
    const items = [tool('Read'), tool('Bash'), tool('Bash'), tool('Edit'), tool('Grep')];
    expect(groupTitle(items)).toMatchObject({ kinds: ['shell', 'read', 'edit', 'search'], title: 'Ran commands, read files, edited files, etc.' });
  });

  it('ровно три вида — без etc.', () => {
    expect(groupTitle([tool('Read'), tool('Bash'), tool('Edit')]).title).toBe('Read files, ran commands, edited files');
  });

  it('карточка агента — ran subagents', () => {
    expect(groupTitle([agent()]).kinds).toEqual(['agents']);
  });

  it('только тексты — Wrote replies', () => {
    expect(groupTitle([text(), text()]).title).toBe('Wrote replies');
  });
});

describe('строка статуса', () => {
  it('Completed с длительностью', () => {
    expect(turnStatusText('completed', 31_000)).toBe('Completed in 31s');
    expect(turnStatusText('completed', 151_000)).toBe('Completed in 2m 31s');
    expect(turnStatusText('completed', 3_840_000)).toBe('Completed in 1h 4m');
  });
  it('без длительности и у остановленного/упавшего', () => {
    expect(turnStatusText('completed', null)).toBe('Completed');
    expect(turnStatusText('stopped', 5000)).toBe('Stopped');
    expect(turnStatusText('failed', 5000)).toBe('Failed');
  });
  it('круглые значения без нулей справа', () => {
    expect(formatTurnDuration(120_000)).toBe('2m');
    expect(formatTurnDuration(3_600_000)).toBe('1h');
  });
});
