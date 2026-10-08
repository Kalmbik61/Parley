import { describe, expect, it } from 'vitest';
import { emptyFeedState } from '../reduce.js';
import type { FeedAgent, FeedPermissionCard, FeedState, FeedTool } from '../types.js';
import { applyCodexRecords, emptyCodexCursor } from './apply-codex.js';
import { applyCodexHookEvent, CODEX_EARLY_TOOLS } from './apply-codex-hook.js';

const AT = '2026-10-07T12:00:00.000Z';
const run = (events: Array<Record<string, unknown>>, from: FeedState = emptyFeedState()): FeedState =>
  events.reduce<FeedState>((state, body) => applyCodexHookEvent(state, body, AT).state, from);

describe('applyCodexHookEvent', () => {
  it('PermissionRequest — карточка pending без suggestions', () => {
    const state = run([{ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch ~/outside' } }]);
    const card = state.items[0] as FeedPermissionCard;
    expect(card).toMatchObject({
      kind: 'permission',
      state: 'pending',
      toolName: 'Bash',
      toolInput: { command: 'touch ~/outside' },
      suggestions: [],
      toolUseId: null,
    });
    expect(card.cardId).toBe(card.id);
  });

  it.runIf(CODEX_EARLY_TOOLS)('PreToolUse Bash — вызов running; запись журнала с тем же id его закрывает без дубля', () => {
    const early = run([{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'ls' } }]);
    expect((early.items[0] as FeedTool).status).toBe('running');
    const { update } = applyCodexRecords(
      early,
      [
        {
          ordinal: 1,
          at: AT,
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            item: { type: 'CommandExecution', id: 'call_1', command: ['ls'], cwd: '/tmp', status: 'completed', aggregated_output: 'a', exit_code: 0 },
          },
        },
      ],
      emptyCodexCursor(),
    );
    expect(update.state.items).toHaveLength(1);
    expect((update.state.items[0] as FeedTool).status).toBe('done');
  });

  it('PreToolUse без раннего режима и apply_patch — без раннего вызова', () => {
    expect(run([{ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'p1', tool_input: {} }]).items).toEqual([]);
    if (!CODEX_EARLY_TOOLS) {
      expect(run([{ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command: 'ls' } }]).items).toEqual([]);
    }
  });

  it('SubagentStart и SubagentStop — карточка агента и итог', () => {
    const state = run([
      { hook_event_name: 'SubagentStart', agent_id: 'th-sub', agent_type: 'explorer' },
      { hook_event_name: 'SubagentStop', agent_id: 'th-sub', last_assistant_message: 'Готово' },
    ]);
    expect(state.items[0] as FeedAgent).toMatchObject({ agentId: 'th-sub', agentType: 'explorer', status: 'done', result: 'Готово' });
  });

  it('Stop закрывает ход один раз: task_complete журнала потом не добавляет черту', () => {
    const started = applyCodexRecords(
      emptyFeedState(),
      [{ ordinal: 1, at: AT, type: 'event_msg', payload: { type: 'task_started' } }],
      emptyCodexCursor(),
    );
    const stopped = run([{ hook_event_name: 'Stop', last_assistant_message: 'ok' }], started.update.state);
    expect(stopped.items.filter((item) => item.kind === 'turn')).toHaveLength(1);
    const { update } = applyCodexRecords(
      stopped,
      [{ ordinal: 2, at: AT, type: 'event_msg', payload: { type: 'task_complete' } }],
      started.cursor,
    );
    expect(update.state.items.filter((item) => item.kind === 'turn')).toHaveLength(1);
  });

  it('незнакомое событие — без изменений', () => {
    expect(applyCodexHookEvent(emptyFeedState(), { hook_event_name: 'Nope' }, AT).changes).toEqual([]);
  });
});
