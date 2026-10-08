import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FeedAgent, FeedTool } from '../types.js';
import { applyCodexRecords, emptyCodexCursor, feedFromCodexRollout } from './apply-codex.js';
import { codexAgentMeta, withCodexAgentMeta } from './codex-agents.js';
import { parseRolloutLine, type RolloutRecord } from './rollout-record.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const records = (name: string): RolloutRecord[] =>
  readFileSync(path.join(FIXTURES, `${name}.rollout.jsonl`), 'utf8')
    .split('\n')
    .map(parseRolloutLine)
    .filter((r): r is RolloutRecord => r !== null);
const agentOf = (items: readonly unknown[]): FeedAgent => items.find((item) => (item as FeedAgent).kind === 'agent') as FeedAgent;

describe('агенты Codex в ленте родителя', () => {
  it('SubAgentActivity started — карточка с agentId = id треда; completed — done; interacted — без изменений', () => {
    const { state } = feedFromCodexRollout(records('codex-parent'));
    const agent = agentOf(state.items);
    expect(agent).toMatchObject({ id: 'agent:th-child', agentId: 'th-child', toolUseId: 'th-child', status: 'done' });
    expect(state.items.filter((item) => item.kind === 'agent')).toHaveLength(1);
  });

  it('CollabAgentToolCall wait — вызов с получателями', () => {
    const { state } = feedFromCodexRollout(records('codex-parent'));
    const wait = state.items.find((item) => item.kind === 'tool') as FeedTool;
    expect(wait).toMatchObject({ name: 'wait', status: 'done', input: { receivers: ['th-child'] } });
  });
});

describe('журнал агента', () => {
  const child = records('codex-child');

  it('сведения: роль, прозвище, модель, отметка истории, задание после отметки, итог', () => {
    expect(codexAgentMeta(child)).toEqual({
      threadId: 'th-child',
      parentThreadId: 'th-parent',
      nickname: 'explorer',
      role: 'explorer',
      model: 'gpt-6-mini',
      historyStart: 3,
      task: 'Найди все места, где строится карточка агента, и перечисли файлы со строками',
      result: 'Нашёл: reduce.ts:452',
    });
  });

  it('сведения хвостом: prior сохраняется, новое дописывается', () => {
    const head = codexAgentMeta(child.slice(0, 5));
    expect(head.result).toBeNull();
    expect(codexAgentMeta(child.slice(5), head)).toMatchObject({ task: head.task, result: 'Нашёл: reduce.ts:452', historyStart: 3 });
  });

  it('вызовы агента — в children с отметки истории; сведения — в карточку', () => {
    const parent = feedFromCodexRollout(records('codex-parent').slice(0, 3)).state;
    const meta = codexAgentMeta(child);
    const withMeta = withCodexAgentMeta(parent, 'th-child', meta).state;
    const { update } = applyCodexRecords(withMeta, child, { ...emptyCodexCursor(), lastOrdinal: meta.historyStart - 1 }, 'th-child');
    const agent = agentOf(update.state.items);
    expect(agent).toMatchObject({ agentType: 'explorer', description: 'explorer', model: 'gpt-6-mini', result: 'Нашёл: reduce.ts:452' });
    expect(agent.prompt).toBe(meta.task);
    expect(agent.children.map((call) => call.toolUseId)).toEqual(['child_cmd']);
    expect(agent.toolCount).toBe(1);
  });

  it('снимок агента — лента его журнала с отметки истории, без копии родителя', () => {
    const meta = codexAgentMeta(child);
    const { state } = feedFromCodexRollout(child, { historyStart: meta.historyStart });
    expect(state.items.some((item) => item.kind === 'tool' && item.toolUseId === 'parent_old')).toBe(false);
    expect(state.items.some((item) => item.kind === 'tool' && item.toolUseId === 'child_cmd')).toBe(true);
  });

  it('карточки нет — withCodexAgentMeta ничего не меняет', () => {
    const empty = feedFromCodexRollout([]).state;
    expect(withCodexAgentMeta(empty, 'th-x', codexAgentMeta(child)).changes).toEqual([]);
  });
});
