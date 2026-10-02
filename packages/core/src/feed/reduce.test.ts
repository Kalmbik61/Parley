/**
 * Редьюсер ленты вида «Chat» на настоящих событиях хуков (план 2026-10-01, Task 1, «Тесты»).
 * Фикстуры — `events.jsonl` проб разведки как есть: строка `{t, ev}` — событие, строка с
 * `decisionFor` — ответ стенда хуку; здесь он становится решением окна (`applyDecision`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isHookNoise } from './noise.js';
import {
  applyDecision,
  applyHookEvent,
  closeFeedTurn,
  emptyFeedState,
  settleCards,
} from './reduce.js';
import type {
  FeedAgent,
  FeedDecision,
  FeedItem,
  FeedNotice,
  FeedPermissionCard,
  FeedPlanCard,
  FeedQuestionCard,
  FeedState,
  FeedText,
  FeedTool,
} from './types.js';
import {
  FEED_AGENT_TEXT_LIMIT,
  FEED_INPUT_LIMIT,
  FEED_PATCH_LINES,
  FEED_RESULT_LIMIT,
  FEED_TEXT_LIMIT,
} from './types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface FixtureLine {
  t: number;
  ev?: Record<string, unknown>;
  decisionFor?: string;
  decision?: { hookSpecificOutput: Record<string, unknown> };
}

const lines = (probe: string): FixtureLine[] =>
  readFileSync(path.join(FIXTURES, `${probe}.events.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as FixtureLine);

const iso = (t: number): string => new Date(t).toISOString();

/** Ответ стенда хуку → решение окна для последней ждущей карточки нужного вида. */
function decisionOf(line: FixtureLine): { kind: FeedDecision['kind']; decision: FeedDecision } {
  const out = line.decision?.hookSpecificOutput ?? {};
  if (line.decisionFor === 'PermissionRequest') {
    const decision = out['decision'] as { behavior: 'allow' | 'deny'; message?: string };
    const result: FeedDecision = { kind: 'permission', behavior: decision.behavior };
    if (decision.message !== undefined) result.message = decision.message;
    return { kind: 'permission', decision: result };
  }
  const input = out['updatedInput'] as { answers: Record<string, string> };
  return { kind: 'question', decision: { kind: 'question', answers: input.answers } };
}

interface Replay {
  state: FeedState;
  /** Состояние сразу после события с этим индексом строки фикстуры. */
  snapshots: FeedState[];
  applied: boolean[];
}

/**
 * Прогон фикстуры через редьюсер. Без `filter` — полный поток, как его шлют HTTP-хуки; `filter`
 * отбрасывает события — так проверяется прочность к неполному потоку.
 */
function replay(
  probe: string,
  filter: (ev: Record<string, unknown>) => boolean = () => true,
): Replay {
  let state = emptyFeedState();
  const snapshots: FeedState[] = [];
  const applied: boolean[] = [];
  for (const line of lines(probe)) {
    if (line.ev !== undefined) {
      if (filter(line.ev)) state = applyHookEvent(state, line.ev, iso(line.t)).state;
    } else if (line.decisionFor !== undefined) {
      const { kind, decision } = decisionOf(line);
      const card = [...state.items]
        .reverse()
        .find((item) => item.kind === kind && 'state' in item && item.state === 'pending');
      const result = applyDecision(state, card?.id ?? 'none', decision, iso(line.t));
      applied.push(result.applied);
      state = result.state;
    }
    snapshots.push(state);
  }
  return { state, snapshots, applied };
}

const ofKind = <K extends FeedItem['kind']>(
  items: readonly FeedItem[],
  kind: K,
): Extract<FeedItem, { kind: K }>[] =>
  items.filter((item): item is Extract<FeedItem, { kind: K }> => item.kind === kind);

/** Режим прочности: `PreToolUse` дошёл только для вопроса и плана, вызовы заводит `PostToolUse`. */
const sparse = (ev: Record<string, unknown>): boolean =>
  ev['hook_event_name'] !== 'PreToolUse' ||
  ev['tool_name'] === 'AskUserQuestion' ||
  ev['tool_name'] === 'ExitPlanMode';

describe('applyHookEvent на фикстурах проб', () => {
  it('p1: ход — один промпт, один текст из 12 строк и конец хода', () => {
    const { state } = replay('p1-stream');
    const prompts = ofKind(state.items, 'prompt');
    const texts = ofKind(state.items, 'text');

    expect(prompts).toHaveLength(1);
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text.trimEnd().split('\n')).toHaveLength(12);
    expect(texts[0]?.streaming).toBe(false);
    expect(ofKind(state.items, 'turn')).toHaveLength(1);
    expect(state.items.map((item) => item.kind)).toEqual([
      'notice',
      'prompt',
      'text',
      'turn',
      'notice',
    ]);
  });

  it('p1: текст растёт порциями и до последней порции остаётся streaming', () => {
    const all = lines('p1-stream');
    const third = all.findIndex(
      (line) => line.ev?.['hook_event_name'] === 'MessageDisplay' && line.ev['index'] === 2,
    );
    const { snapshots } = replay('p1-stream');
    const growing = ofKind(snapshots[third]?.items ?? [], 'text')[0];

    expect(growing?.streaming).toBe(true);
    expect(growing?.text.trimEnd().split('\n')).toHaveLength(3);
  });

  it('p3: порция с final раньше предыдущей — текст собирается по index', () => {
    const { state } = replay('p3-modes');
    const text = ofKind(state.items, 'text').find(
      (item) => item.messageId === '809d8b07-8854-47b1-a6f5-abb3c0b05939',
    );

    expect(text?.text).toBe(Array.from({ length: 30 }, (_, i) => String(i + 1)).join('\n'));
    expect(text?.streaming).toBe(false);
    expect(state.streams).toEqual({});
  });

  it('p2: вызов с карточкой разрешения, после PostToolUse карточка — elsewhere', () => {
    const all = lines('p2-permissions');
    const post = all.findIndex((line) => line.ev?.['hook_event_name'] === 'PostToolUse');
    const { snapshots, state } = replay('p2-permissions');

    const pending = ofKind(snapshots[post - 1]?.items ?? [], 'permission')[0];
    expect(pending?.state).toBe('pending');
    expect(pending?.toolName).toBe('Bash');
    expect(pending?.toolInput['command']).toBe('touch probe-a.txt');
    expect(pending?.suggestions).toHaveLength(2);

    const tool = ofKind(state.items, 'tool')[0];
    const card = ofKind(state.items, 'permission')[0];
    expect(tool?.status).toBe('done');
    expect(card?.toolUseId).toBe(tool?.toolUseId);
    expect(card?.state).toBe('elsewhere');
  });

  it('p2: отказ Esc в терминале — следующий промпт снимает карточку, вызов отклонён', () => {
    const { state } = replay('p2-permissions');
    const tool = ofKind(state.items, 'tool').find(
      (item) => item.input['command'] === 'touch probe-b.txt',
    );
    const card = ofKind(state.items, 'permission').find(
      (item) => item.toolUseId === tool?.toolUseId,
    );

    expect(tool?.status).toBe('rejected');
    expect(card?.state).toBe('elsewhere');
  });

  it('p2: Notification permission_prompt помечает ждущую карточку', () => {
    const { state } = replay('p2-permissions');
    const card = ofKind(state.items, 'permission').find(
      (item) => item.toolInput['command'] === 'touch probe-c2.txt',
    );

    expect(card?.notified).toBe(true);
  });

  it('p2b: решения окна — allowed и denied, отказ отклоняет вызов', () => {
    const { state, applied } = replay('p2b-hook-decisions');
    const cards = ofKind(state.items, 'permission');

    expect(applied).toEqual([true, true, true]);
    expect(cards.map((card) => card.state)).toEqual(['allowed', 'denied', 'allowed']);
    expect(cards[1]?.message).toBe(
      'The user declined this command in the Parley window. Do not retry it.',
    );
    const denied = ofKind(state.items, 'tool').find(
      (item) => item.toolUseId === cards[1]?.toolUseId,
    );
    expect(denied?.status).toBe('rejected');
    // Решение окна PostToolUse не переписывает.
    expect(ofKind(state.items, 'tool')[0]?.status).toBe('done');
  });

  it('p4: вопрос, отвеченный в терминале, — elsewhere с ответом; отвеченный окном — answered', () => {
    const { state, applied } = replay('p4-questions-plan');
    const questions = ofKind(state.items, 'question');

    expect(applied).toEqual([true]);
    expect(questions).toHaveLength(2);
    expect(questions[0]?.questions[0]?.question).toBe('Which color?');
    expect(questions[0]?.questions[0]?.options.map((option) => option.label)).toEqual([
      'Red',
      'Blue',
    ]);
    expect(questions[0]?.state).toBe('elsewhere');
    expect(questions[0]?.answers).toEqual({ 'Which color?': 'Blue' });
    expect(questions[1]?.state).toBe('answered');
    expect(questions[1]?.answers).toEqual({ 'Which fruit?': 'Pear' });
    // Вопрос — своей карточкой, второй карточки разрешения на тот же вызов нет.
    expect(ofKind(state.items, 'permission')).toHaveLength(0);
  });

  it('p4: план — карточка с текстом плана', () => {
    const { state } = replay('p4-questions-plan');
    const plans = ofKind(state.items, 'plan');

    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan).toBe(
      '1. Create `hello.txt` in the project working directory.\n2. Write the single word `hi` as its contents.\n',
    );
    expect(plans[0]?.planFilePath).toBe('~/.claude/plans/make-a-two-line-plan-bright-cerf.md');
    expect(plans[0]?.state).toBe('elsewhere');
  });

  it('p5b: правка Edit даёт хунк -beta/+gamma', () => {
    const { state } = replay('p5b-write');
    const edit = ofKind(state.items, 'tool').find((item) => item.name === 'Edit');
    const write = ofKind(state.items, 'tool').find((item) => item.name === 'Write');

    expect(edit?.patch).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' alpha', '-beta', '+gamma'] },
    ]);
    // Новый файл: хунков нет, содержимое — во входе вызова.
    expect(write?.patch).toBeUndefined();
    expect(write?.input['content']).toBe('alpha\nbeta\n');
  });

  it('p3: шум — SubagentStop без типа и PostModelSwitch auto — не даёт элементов', () => {
    let noiseCount = 0;
    for (const line of lines('p3-modes')) {
      const ev = line.ev;
      if (ev === undefined) continue;
      const noise =
        (ev['hook_event_name'] === 'SubagentStop' && ev['agent_type'] === '') ||
        (ev['hook_event_name'] === 'PostModelSwitch' && ev['source'] === 'auto');
      if (!noise) continue;
      noiseCount += 1;
      const result = applyHookEvent(emptyFeedState(), ev, iso(line.t));
      expect(result.changes).toEqual([]);
      expect(result.state.items).toEqual([]);
    }
    expect(noiseCount).toBeGreaterThan(0);
    const { state } = replay('p3-modes');
    expect(ofKind(state.items, 'notice').some((item) => item.notice.type === 'model-switch')).toBe(
      false,
    );
  });

  it('p3: /clear — конец сессии с причиной clear и новый старт', () => {
    const { state } = replay('p3-modes');
    const notices = ofKind(state.items, 'notice').map((item) => item.notice);

    expect(notices).toContainEqual({ type: 'session-end', reason: 'clear' });
    expect(notices).toContainEqual({ type: 'session-start', source: 'clear', model: null });
    expect(ofKind(state.items, 'text').every((item) => !item.streaming)).toBe(true);
  });

  it('p3: промпт из очереди посреди хода — последний ответ встаёт в растущий текст, а не копией', () => {
    const { state } = replay('p3-modes');
    const texts = ofKind(state.items, 'text').map((item) => item.text);

    expect(
      texts.filter((text) => text.startsWith('1\n2\n3\n') && text.endsWith('\n30')),
    ).toHaveLength(1);
    expect(texts.filter((text) => text === 'queued')).toHaveLength(1);
  });

  it('p6b: одна карточка агента Explore с одним вложенным Bash, после SubagentStop — done с текстом', () => {
    const all = lines('p6b-subagents');
    const stop = all.findIndex(
      (line) =>
        line.ev?.['hook_event_name'] === 'SubagentStop' && line.ev['agent_type'] === 'Explore',
    );
    const { snapshots, state } = replay('p6b-subagents');

    const running = ofKind(snapshots[stop - 1]?.items ?? [], 'agent');
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe('running');
    expect(running[0]?.background).toBe(true);

    const agents = ofKind(state.items, 'agent');
    expect(agents).toHaveLength(1);
    const agent = agents[0] as FeedAgent;
    expect(agent.description).toBe('List project files');
    expect(agent.agentType).toBe('Explore');
    expect(agent.agentId).toBe('ad2fe21e96ffde3ba');
    expect(agent.model).toBe('claude-haiku-4-5-20251001');
    expect(agent.children.map((child) => child.name)).toEqual(['Bash']);
    expect(agent.children[0]?.status).toBe('done');
    expect(agent.toolCount).toBe(1);
    expect(agent.status).toBe('done');
    expect(agent.result).toMatch(/^Here's the complete listing/);
    expect(agent.transcriptPath).toMatch(/subagents\/agent-ad2fe21e96ffde3ba\.jsonl$/);
    expect(agent.durationMs).toBeGreaterThan(0);
    // Вложенный вызов живёт в карточке, а не в общем потоке.
    expect(ofKind(state.items, 'tool')).toHaveLength(0);
  });

  it('p6b: пробуждение <task-notification> — notice со ссылкой на карточку, а не промпт', () => {
    const { state } = replay('p6b-subagents');
    const prompts = ofKind(state.items, 'prompt');
    const reported = ofKind(state.items, 'notice').find(
      (item) => item.notice.type === 'agent-reported',
    ) as FeedNotice;

    expect(prompts).toHaveLength(1);
    expect(reported.notice).toEqual({
      type: 'agent-reported',
      agentItemId: 'agent:toolu_01G5PVnKhULnEvCGM7JckFjn',
      agentId: 'ad2fe21e96ffde3ba',
      status: 'completed',
      summary: 'Agent "List project files" finished',
    });
  });

  it('порция MessageDisplay после Stop не дублирует ответ', () => {
    for (const probe of ['p2-permissions', 'p5b-write', 'p6b-subagents']) {
      const { state } = replay(probe);
      const texts = ofKind(state.items, 'text');
      const turns = ofKind(state.items, 'turn');
      expect(texts.length, probe).toBe(turns.length);
      const lastStop = lines(probe)
        .filter((line) => line.ev?.['hook_event_name'] === 'Stop' && !('agent_id' in line.ev))
        .at(-1)?.ev?.['last_assistant_message'];
      expect(texts.at(-1)?.text.trimEnd(), probe).toBe(String(lastStop).trimEnd());
    }
  });
});

const PROBES = [
  'p1-stream',
  'p2-permissions',
  'p2b-hook-decisions',
  'p3-modes',
  'p4-questions-plan',
  'p5b-write',
  'p6b-subagents',
] as const;

const MODES: [string, (ev: Record<string, unknown>) => boolean][] = [
  ['полный поток', () => true],
  ['sparse', sparse],
];

describe.each(MODES)('пробы в режиме «%s»: одинаковые ожидания', (_mode, filter) => {
  it.each(PROBES)('%s: после хода streams пуст, тексты закрыты, вызовы не running', (probe) => {
    const { state } = replay(probe, filter);

    expect(state.streams).toEqual({});
    expect(ofKind(state.items, 'text').every((item) => !item.streaming)).toBe(true);
    expect(ofKind(state.items, 'tool').every((item) => item.status !== 'running')).toBe(true);
    expect(ofKind(state.items, 'permission').every((card) => card.state !== 'pending')).toBe(true);
  });

  it('p2b: решения окна — allowed и denied', () => {
    const { state, applied } = replay('p2b-hook-decisions', filter);

    expect(applied).toEqual([true, true, true]);
    expect(ofKind(state.items, 'permission').map((card) => card.state)).toEqual([
      'allowed',
      'denied',
      'allowed',
    ]);
  });

  it('p5b: хунк Edit и вход Write', () => {
    const { state } = replay('p5b-write', filter);
    const edit = ofKind(state.items, 'tool').find((item) => item.name === 'Edit');
    const write = ofKind(state.items, 'tool').find((item) => item.name === 'Write');

    expect(edit?.patch).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' alpha', '-beta', '+gamma'] },
    ]);
    expect(write?.patch).toBeUndefined();
    expect(write?.input['content']).toBe('alpha\nbeta\n');
  });

  it('p1 и p3: тексты собраны целиком', () => {
    const p1 = ofKind(replay('p1-stream', filter).state.items, 'text');
    const p3 = ofKind(replay('p3-modes', filter).state.items, 'text').find(
      (item) => item.messageId === '809d8b07-8854-47b1-a6f5-abb3c0b05939',
    );

    expect(p1).toHaveLength(1);
    expect(p1[0]?.text.trimEnd().split('\n')).toHaveLength(12);
    expect(p3?.text).toBe(Array.from({ length: 30 }, (_, i) => String(i + 1)).join('\n'));
  });

  it('p4: вопросы и план карточками', () => {
    const { state } = replay('p4-questions-plan', filter);

    expect(ofKind(state.items, 'question').map((card) => card.state)).toEqual([
      'elsewhere',
      'answered',
    ]);
    expect(ofKind(state.items, 'plan')).toHaveLength(1);
    expect(ofKind(state.items, 'permission')).toHaveLength(0);
  });

  it('p6b: агент с вложенным Bash закончен', () => {
    const { state } = replay('p6b-subagents', filter);
    const agents = ofKind(state.items, 'agent');

    expect(agents).toHaveLength(1);
    expect(agents[0]?.children.map((child) => child.name)).toEqual(['Bash']);
    expect(agents[0]?.status).toBe('done');
  });
});

describe('полный поток: PreToolUse для всех инструментов', () => {
  it('p2: обычный вызов running с PreToolUse, карточка разрешения знает свой вызов', () => {
    const all = lines('p2-permissions');
    const request = all.findIndex((line) => line.ev?.['hook_event_name'] === 'PermissionRequest');
    const { snapshots } = replay('p2-permissions');
    const items = snapshots[request]?.items ?? [];

    expect(ofKind(items, 'tool')[0]?.status).toBe('running');
    expect(ofKind(items, 'permission')[0]?.toolUseId).toBe(ofKind(items, 'tool')[0]?.toolUseId);
  });

  it('p2b: отказ окна отклоняет вызов сразу после решения', () => {
    const all = lines('p2b-hook-decisions');
    const deny = all.findIndex(
      (line) =>
        line.decisionFor === 'PermissionRequest' &&
        (line.decision?.hookSpecificOutput['decision'] as { behavior: string }).behavior === 'deny',
    );
    const { snapshots } = replay('p2b-hook-decisions');
    const items = snapshots[deny]?.items ?? [];
    const card = ofKind(items, 'permission').find((item) => item.state === 'denied');

    expect(card?.toolUseId).not.toBeNull();
    expect(ofKind(items, 'tool').find((item) => item.toolUseId === card?.toolUseId)?.status).toBe(
      'rejected',
    );
  });
});

describe('режим sparse: PreToolUse только для вопроса и плана', () => {
  it('p2: вызов заводит PostToolUse, карточка без вызова снимается им же', () => {
    const { state } = replay('p2-permissions', sparse);
    const tools = ofKind(state.items, 'tool');
    const cards = ofKind(state.items, 'permission');

    expect(tools.map((tool) => tool.status)).toEqual(['done', 'done', 'done']);
    expect(cards).toHaveLength(4);
    expect(cards.every((card) => card.state === 'elsewhere')).toBe(true);
    // Снятая PostToolUse карточка узнаёт свой вызов.
    expect(cards[0]?.toolUseId).toBe(tools[0]?.toolUseId);
  });

  it('p6b: карточку агента заводит PostToolUse(Agent), вложенный Bash всё равно в ней', () => {
    const { state } = replay('p6b-subagents', sparse);
    const agents = ofKind(state.items, 'agent');

    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe('ad2fe21e96ffde3ba');
    expect(agents[0]?.description).toBe('List project files');
    expect(agents[0]?.children.map((child) => child.name)).toEqual(['Bash']);
    expect(agents[0]?.status).toBe('done');
  });

  it('p4: вопрос и план по-прежнему карточками', () => {
    const { state } = replay('p4-questions-plan', sparse);

    expect(ofKind(state.items, 'question').map((card) => card.state)).toEqual([
      'elsewhere',
      'answered',
    ]);
    expect(ofKind(state.items, 'plan')).toHaveLength(1);
  });
});

describe('решения и снятие карточек', () => {
  const AT = '2026-10-01T10:00:00.000Z';
  const LATER = '2026-10-01T10:00:05.000Z';

  /** Ход с одним Bash и запросом разрешения. */
  function pendingBash(): FeedState {
    let state = emptyFeedState();
    for (const ev of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu_1',
      },
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        permission_suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash' }], destination: 'session' },
        ],
      },
    ]) {
      state = applyHookEvent(state, ev, AT).state;
    }
    return state;
  }

  it('второе нажатие ничего не меняет: applied false', () => {
    const state = pendingBash();
    const first = applyDecision(
      state,
      'permission:toolu_1',
      { kind: 'permission', behavior: 'allow', always: true },
      LATER,
    );
    const second = applyDecision(
      first.state,
      'permission:toolu_1',
      { kind: 'permission', behavior: 'deny' },
      LATER,
    );

    expect(first.applied).toBe(true);
    const card = first.changes[0] as FeedPermissionCard;
    expect(card.state).toBe('allowed');
    expect(card.always).toBe(true);
    expect(card.settledAt).toBe(LATER);
    expect(second.applied).toBe(false);
    expect(second.changes).toEqual([]);
    expect(second.state).toBe(first.state);
  });

  it('решение не того вида и чужая карточка — applied false', () => {
    const state = pendingBash();

    expect(
      applyDecision(state, 'permission:toolu_1', { kind: 'question', answers: {} }, LATER).applied,
    ).toBe(false);
    expect(
      applyDecision(state, 'permission:nope', { kind: 'permission', behavior: 'allow' }, LATER)
        .applied,
    ).toBe(false);
  });

  it('карточка, снятая хостом, — elsewhere отклоняет вызов, stale оставляет его идти', () => {
    const elsewhere = settleCards(pendingBash(), 'elsewhere', LATER);
    const stale = settleCards(pendingBash(), 'stale', LATER, ['permission:toolu_1']);

    expect(ofKind(elsewhere.state.items, 'permission')[0]?.state).toBe('elsewhere');
    expect(ofKind(elsewhere.state.items, 'tool')[0]?.status).toBe('rejected');
    expect(ofKind(stale.state.items, 'permission')[0]?.state).toBe('stale');
    expect(ofKind(stale.state.items, 'tool')[0]?.status).toBe('running');
    expect(
      applyDecision(
        stale.state,
        'permission:toolu_1',
        { kind: 'permission', behavior: 'allow' },
        LATER,
      ).applied,
    ).toBe(false);
  });

  it('план: решение окна — allowed с выбором', () => {
    let state = emptyFeedState();
    state = applyHookEvent(
      state,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'ExitPlanMode',
        tool_input: { plan: 'step' },
        tool_use_id: 'toolu_p',
      },
      AT,
    ).state;
    const result = applyDecision(
      state,
      'plan:toolu_p',
      { kind: 'plan', choice: 'auto-accept' },
      LATER,
    );
    const card = ofKind(result.state.items, 'plan')[0] as FeedPlanCard;

    expect(result.applied).toBe(true);
    expect(card.state).toBe('allowed');
    expect(card.choice).toBe('auto-accept');
  });

  it('вопрос: ответ окна не перетирается ответом из PostToolUse', () => {
    let state = emptyFeedState();
    const input = {
      questions: [
        {
          question: 'Q?',
          header: 'H',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: true,
        },
      ],
    };
    state = applyHookEvent(
      state,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: input,
        tool_use_id: 'toolu_q',
      },
      AT,
    ).state;
    state = applyDecision(
      state,
      'question:toolu_q',
      { kind: 'question', answers: { 'Q?': 'A' } },
      LATER,
    ).state;
    state = applyHookEvent(
      state,
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: input,
        tool_response: { answers: { 'Q?': 'B' } },
        tool_use_id: 'toolu_q',
      },
      LATER,
    ).state;
    const card = ofKind(state.items, 'question')[0] as FeedQuestionCard;

    expect(card.state).toBe('answered');
    expect(card.answers).toEqual({ 'Q?': 'A' });
    expect(card.questions[0]?.multiSelect).toBe(true);
    expect(card.questions[0]?.options[0]).toEqual({ label: 'A', description: null });
  });
});

describe('ход, ошибки и результаты', () => {
  const AT = '2026-10-01T10:00:00.000Z';
  const run = (events: Record<string, unknown>[], at = AT): FeedState =>
    events.reduce<FeedState>((state, ev) => applyHookEvent(state, ev, at).state, emptyFeedState());

  it('/clear посреди хода закрывает ход: текст, карточки, вызовы и черта хода', () => {
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'count' },
      { hook_event_name: 'MessageDisplay', message_id: 'm1', delta: '1\n', final: false },
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 't1',
      },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { hook_event_name: 'SessionEnd', reason: 'clear' },
    ]);

    expect((ofKind(state.items, 'text')[0] as FeedText).streaming).toBe(false);
    expect(ofKind(state.items, 'permission')[0]?.state).toBe('elsewhere');
    expect((ofKind(state.items, 'tool')[0] as FeedTool).status).toBe('rejected');
    expect(ofKind(state.items, 'turn')).toHaveLength(1);
    expect(state.turnStartedAt).toBeNull();
    expect(state.items.at(-1)).toMatchObject({
      kind: 'notice',
      notice: { type: 'session-end', reason: 'clear' },
    });
  });

  it('StopFailure — карточка ошибки, ход закрыт', () => {
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'hi' },
      {
        hook_event_name: 'StopFailure',
        error: 'account_on_hold',
        last_assistant_message: 'Your account is on hold',
      },
    ]);

    expect(ofKind(state.items, 'error')).toEqual([
      {
        id: 'error:#2',
        at: AT,
        kind: 'error',
        error: 'account_on_hold',
        message: 'Your account is on hold',
      },
    ]);
    expect(state.turnStartedAt).toBeNull();
  });

  it('результат больше 64 КБ усечён явно', () => {
    const big = 'x'.repeat(FEED_RESULT_LIMIT + 10);
    const state = run([
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'yes' },
        tool_use_id: 't1',
      },
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'yes' },
        tool_response: { stdout: big, stderr: '' },
        tool_use_id: 't1',
      },
    ]);
    const tool = ofKind(state.items, 'tool')[0] as FeedTool;

    expect(tool.response?.truncated).toBe(true);
    expect(tool.response?.size).toBe(FEED_RESULT_LIMIT + 10);
    expect(tool.response?.text).toHaveLength(FEED_RESULT_LIMIT);
  });

  it('PostToolUseFailure — failed с текстом ошибки', () => {
    const state = run([
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        tool_use_id: 't1',
      },
      {
        hook_event_name: 'PostToolUseFailure',
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        error: 'Exit code 1',
        tool_use_id: 't1',
      },
    ]);
    const tool = ofKind(state.items, 'tool')[0] as FeedTool;

    expect(tool.status).toBe('failed');
    expect(tool.response?.text).toBe('Exit code 1');
  });

  it('смена модели человеком и компакция — notice', () => {
    const state = run([
      { hook_event_name: 'PostModelSwitch', from_model: 'a', to_model: 'b', source: 'command' },
      { hook_event_name: 'PreCompact', trigger: 'manual' },
      { hook_event_name: 'PostCompact', trigger: 'manual' },
    ]);

    expect(ofKind(state.items, 'notice').map((item) => item.notice)).toEqual([
      { type: 'model-switch', from: 'a', to: 'b', source: 'command' },
      { type: 'compact', phase: 'pre', trigger: 'manual' },
      { type: 'compact', phase: 'post', trigger: 'manual' },
    ]);
  });

  it('кривые события и неизвестные имена состояние не меняют', () => {
    const state = emptyFeedState();
    for (const ev of [
      null,
      'Stop',
      [],
      {},
      { hook_event_name: '' },
      { hook_event_name: 'PostToolBatch', tool_calls: [] },
    ]) {
      const result = applyHookEvent(state, ev, AT);
      expect(result.changes).toEqual([]);
      expect(result.state.items).toEqual([]);
    }
  });

  it('changes — только тронутые элементы, по одному на id', () => {
    let state = run([{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }]);
    const first = applyHookEvent(
      state,
      { hook_event_name: 'MessageDisplay', message_id: 'm', delta: 'a\n', final: false },
      AT,
    );
    state = first.state;
    const second = applyHookEvent(
      state,
      { hook_event_name: 'Stop', last_assistant_message: 'a\nb' },
      AT,
    );

    expect(first.changes.map((item) => item.id)).toEqual(['text:m']);
    expect(second.changes.map((item) => item.kind)).toEqual(['text', 'turn']);
    expect((second.changes[0] as FeedText).text).toBe('a\nb');
    // Прежнее состояние не тронуто.
    expect((ofKind(state.items, 'text')[0] as FeedText).streaming).toBe(true);
  });
});

describe('прочность и пределы', () => {
  const AT = '2026-10-01T10:00:00.000Z';
  const LATER = '2026-10-01T10:00:05.000Z';
  const run = (events: Record<string, unknown>[], from = emptyFeedState()): FeedState =>
    events.reduce<FeedState>((state, ev) => applyHookEvent(state, ev, AT).state, from);
  const pre = (id: string, name: string, input: Record<string, unknown>, agentId?: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: name,
    tool_input: input,
    tool_use_id: id,
    ...(agentId !== undefined ? { agent_id: agentId, agent_type: 'Explore' } : {}),
  });
  const post = (id: string, name: string, input: Record<string, unknown>, response: unknown) => ({
    hook_event_name: 'PostToolUse',
    tool_name: name,
    tool_input: input,
    tool_response: response,
    tool_use_id: id,
  });
  const request = (name: string, input: Record<string, unknown>) => ({
    hook_event_name: 'PermissionRequest',
    tool_name: name,
    tool_input: input,
  });
  const display = (index: unknown, delta: string, final = false) => ({
    hook_event_name: 'MessageDisplay',
    message_id: 'm',
    delta,
    index,
    final,
  });

  it('index 1e9 разбирается быстро и не растит streams', () => {
    const started = performance.now();
    const state = run([{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, display(1e9, 'a')]);

    // Порог с запасом: без защиты цикл на 1e9 шёл бы секунды или падал по памяти, а на
    // нагруженной машине честные 50 мс флейкали бы.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(state.streams['m']).toEqual({ head: 'a', count: 1, ahead: {}, finalIndex: null });
    expect(JSON.stringify(state.streams).length).toBeLessThan(200);
    expect(ofKind(state.items, 'text')[0]?.text).toBe('a');
  });

  it('index -1, 1.5 и NaN — следующая по счёту порция, текст не теряется', () => {
    const state = run([
      display(0, 'a'),
      display(-1, 'b'),
      display(1.5, 'c'),
      display(Number.NaN, 'd'),
      display(4, 'e', true),
    ]);
    const text = ofKind(state.items, 'text')[0];

    expect(text?.text).toBe('abcde');
    expect(text?.streaming).toBe(false);
    expect(state.streams).toEqual({});
  });

  it('порция дальше 64 от следующей — следующая по счёту', () => {
    const state = run([display(0, 'a'), display(66, 'b'), display(65, 'c')]);

    expect(ofKind(state.items, 'text')[0]?.text).toBe('abc');
    expect(state.streams['m']?.count).toBe(2);
    expect(Object.keys(state.streams['m']?.ahead ?? {})).toEqual(['65']);
  });

  it('пустая финальная порция после Stop не заводит пустой текст', () => {
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      { hook_event_name: 'Stop', last_assistant_message: 'hi' },
      display(1, '', true),
    ]);

    expect(ofKind(state.items, 'text').map((item) => item.text)).toEqual(['hi']);
    expect(state.streams).toEqual({});
  });

  it('пустая финальная порция до Stop — тоже без пустого текста', () => {
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      display(0, '', true),
      { hook_event_name: 'Stop', last_assistant_message: 'hi' },
    ]);

    expect(ofKind(state.items, 'text').map((item) => [item.text, item.streaming])).toEqual([
      ['hi', false],
    ]);
    expect(state.streams).toEqual({});
  });

  it('StopFailure закрывает ход как Stop: карточка elsewhere, вызов rejected, ошибка и черта хода', () => {
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      pre('t1', 'Bash', { command: 'ls' }),
      request('Bash', { command: 'ls' }),
      { hook_event_name: 'StopFailure', error: 'overloaded' },
    ]);

    expect(ofKind(state.items, 'permission')[0]?.state).toBe('elsewhere');
    expect(ofKind(state.items, 'tool')[0]?.status).toBe('rejected');
    expect(state.items.slice(-2).map((item) => item.kind)).toEqual(['error', 'turn']);
    expect(state.turnStartedAt).toBeNull();
  });

  it('вызов без карточки, оставшийся running, отклоняют Stop и SessionEnd', () => {
    const start = [{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }, pre('t1', 'Bash', {})];
    const stopped = run([...start, { hook_event_name: 'Stop', last_assistant_message: 'x' }]);
    const ended = run([...start, { hook_event_name: 'SessionEnd', reason: 'other' }]);

    expect(ofKind(stopped.items, 'tool')[0]?.status).toBe('rejected');
    expect(ofKind(ended.items, 'tool')[0]?.status).toBe('rejected');
  });

  it('closeFeedTurn: процесс вышел посреди хода — текст закрыт, вызов отклонён, черта хода', () => {
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      { hook_event_name: 'MessageDisplay', message_id: 'm1', index: 0, delta: 'a\n' },
      pre('t1', 'Bash', { command: 'ls' }),
      request('Bash', { command: 'ls' }),
    ]);
    const stale = settleCards(state, 'stale', LATER);
    const closed = closeFeedTurn(stale.state, LATER);

    expect(ofKind(closed.state.items, 'permission')[0]?.state).toBe('stale');
    expect(ofKind(closed.state.items, 'text')[0]?.streaming).toBe(false);
    expect(ofKind(closed.state.items, 'tool')[0]?.status).toBe('rejected');
    expect(closed.state.items.at(-1)?.kind).toBe('turn');
    expect(closed.state.turnStartedAt).toBeNull();
    // Хода нет — закрывать нечего, черта не добавляется.
    expect(closeFeedTurn(closed.state, LATER).changes).toEqual([]);
  });

  it('два одинаковых запроса без tool_use_id: PostToolUse снимает только самую раннюю карточку', () => {
    const input = { command: 'ls' };
    const state = run([
      request('Bash', input),
      request('Bash', input),
      post('t1', 'Bash', input, { stdout: '', stderr: '' }),
    ]);
    const cards = ofKind(state.items, 'permission');

    expect(cards.map((card) => [card.state, card.toolUseId])).toEqual([
      ['elsewhere', 't1'],
      ['pending', null],
    ]);
  });

  it('два одинаковых параллельных вызова с tool_use_id не путают карточки', () => {
    const input = { command: 'ls' };
    const state = run([
      pre('t1', 'Bash', input),
      pre('t2', 'Bash', input),
      request('Bash', input),
      request('Bash', input),
      post('t1', 'Bash', input, { stdout: '', stderr: '' }),
    ]);
    const cards = ofKind(state.items, 'permission');
    const tools = ofKind(state.items, 'tool');

    expect(new Set(cards.map((card) => card.toolUseId))).toEqual(new Set(['t1', 't2']));
    expect(cards.find((card) => card.toolUseId === 't1')?.state).toBe('elsewhere');
    expect(cards.find((card) => card.toolUseId === 't2')?.state).toBe('pending');
    expect(tools.map((tool) => [tool.toolUseId, tool.status])).toEqual([
      ['t1', 'done'],
      ['t2', 'running'],
    ]);
  });

  it('Stop.background_tasks: running — background, completed — done', () => {
    const start = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      pre('ta', 'Agent', { subagent_type: 'Explore', description: 'look', prompt: 'p' }),
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
    ]);
    const stop = (status: string) => ({
      hook_event_name: 'Stop',
      last_assistant_message: 'x',
      background_tasks: [{ id: 'a1', type: 'subagent', status }],
    });
    const running = ofKind(run([stop('running')], start).items, 'agent')[0];
    const done = ofKind(run([stop('completed')], start).items, 'agent')[0];

    expect(running).toMatchObject({ agentId: 'a1', background: true, status: 'running' });
    expect(done).toMatchObject({ agentId: 'a1', background: true, status: 'done' });
  });

  it('два параллельных агента разных типов: SubagentStart в обратном порядке привязывается по типу', () => {
    const state = run([
      pre('tx', 'Agent', { subagent_type: 'Explore', prompt: 'x' }),
      pre('tg', 'Agent', { subagent_type: 'general-purpose', prompt: 'g' }),
      { hook_event_name: 'SubagentStart', agent_id: 'ag', agent_type: 'general-purpose' },
      { hook_event_name: 'SubagentStart', agent_id: 'ax', agent_type: 'Explore' },
    ]);
    const agents = ofKind(state.items, 'agent');

    expect(agents.map((agent) => [agent.toolUseId, agent.agentId])).toEqual([
      ['tx', 'ax'],
      ['tg', 'ag'],
    ]);
  });

  it('ответы при решении копируются: мутация входа после decide карточку не меняет', () => {
    const state = run([
      pre('tq', 'AskUserQuestion', { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] }),
    ]);
    const answers: Record<string, string> = { 'Q?': 'A' };
    const result = applyDecision(state, 'question:tq', { kind: 'question', answers }, LATER);
    answers['Q?'] = 'B';

    expect(ofKind(result.state.items, 'question')[0]?.answers).toEqual({ 'Q?': 'A' });
  });

  it('isHookNoise: служебные субагенты без типа и автосмена модели', () => {
    expect(isHookNoise({ hook_event_name: 'SubagentStart', agent_type: '' })).toBe(true);
    expect(isHookNoise({ hook_event_name: 'SubagentStop', agent_type: '' })).toBe(true);
    expect(isHookNoise({ hook_event_name: 'SubagentStart' })).toBe(true);
    expect(isHookNoise({ hook_event_name: 'PostModelSwitch', source: 'auto' })).toBe(true);
    expect(isHookNoise({ hook_event_name: 'SubagentStart', agent_type: 'Explore' })).toBe(false);
    expect(isHookNoise({ hook_event_name: 'PostModelSwitch', source: 'command' })).toBe(false);
    expect(isHookNoise({ hook_event_name: 'Stop' })).toBe(false);
  });

  it('предел входа: длинная строка внутри input обрезана, вызов и карточка помечены', () => {
    const long = 'x'.repeat(FEED_INPUT_LIMIT + 5);
    const input = { file_path: 'a.txt', content: long, nested: [{ text: long }] };
    const state = run([pre('t1', 'Write', input), request('Write', input)]);
    const tool = ofKind(state.items, 'tool')[0] as FeedTool;
    const card = ofKind(state.items, 'permission')[0] as FeedPermissionCard;

    expect(tool.truncated).toBe(true);
    expect(tool.input['file_path']).toBe('a.txt');
    expect(tool.input['content']).toHaveLength(FEED_INPUT_LIMIT);
    expect((tool.input['nested'] as { text: string }[])[0]?.text).toHaveLength(FEED_INPUT_LIMIT);
    expect(card.truncated).toBe(true);
    expect(card.toolInput['content']).toHaveLength(FEED_INPUT_LIMIT);
    // Обрезанный вход карточки всё равно узнаёт свой вызов.
    expect(card.toolUseId).toBe('t1');
    expect(input.content).toHaveLength(FEED_INPUT_LIMIT + 5);
  });

  it('короткий вход — без пометки и тем же объектом', () => {
    const input = { command: 'ls' };
    const tool = ofKind(run([pre('t1', 'Bash', input)]).items, 'tool')[0] as FeedTool;

    expect(tool.truncated).toBeUndefined();
    expect(tool.input).toBe(input);
  });

  it('предел диффа: хвост сверх FEED_PATCH_LINES строк отброшен, patchTruncated', () => {
    const hunk = (n: number) => ({
      oldStart: 1,
      oldLines: n,
      newStart: 1,
      newLines: n,
      lines: Array.from({ length: n }, (_, i) => `+${i}`),
    });
    const input = { file_path: 'a.txt', old_string: 'a', new_string: 'b' };
    const state = run([
      pre('t1', 'Edit', input),
      post('t1', 'Edit', input, {
        structuredPatch: [hunk(FEED_PATCH_LINES - 10), hunk(50), hunk(5)],
      }),
    ]);
    const tool = ofKind(state.items, 'tool')[0] as FeedTool;

    expect(tool.patchTruncated).toBe(true);
    expect(tool.patch).toHaveLength(2);
    expect(tool.patch?.flatMap((item) => item.lines)).toHaveLength(FEED_PATCH_LINES);
  });

  it('предел агента: задание и итог обрезаны, truncated', () => {
    const long = 'y'.repeat(FEED_AGENT_TEXT_LIMIT + 1);
    const state = run([
      pre('ta', 'Agent', { subagent_type: 'Explore', prompt: long }),
      { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      {
        hook_event_name: 'SubagentStop',
        agent_id: 'a1',
        agent_type: 'Explore',
        last_assistant_message: long,
      },
    ]);
    const agent = ofKind(state.items, 'agent')[0] as FeedAgent;

    expect(agent.prompt).toHaveLength(FEED_AGENT_TEXT_LIMIT);
    expect(agent.result).toHaveLength(FEED_AGENT_TEXT_LIMIT);
    expect(agent.truncated).toBe(true);
  });

  it('предел текста: ответ длиннее FEED_TEXT_LIMIT обрезан и из порций, и из Stop', () => {
    const long = 'z'.repeat(FEED_TEXT_LIMIT + 3);
    const streamed = run([display(0, long, true)]);
    const stopped = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      { hook_event_name: 'Stop', last_assistant_message: long },
    ]);

    for (const state of [streamed, stopped]) {
      const text = ofKind(state.items, 'text')[0] as FeedText;
      expect(text.text).toHaveLength(FEED_TEXT_LIMIT);
      expect(text.truncated).toBe(true);
    }
    expect(ofKind(run([display(0, 'short', true)]).items, 'text')[0]?.truncated).toBeUndefined();
  });

  it('Stop узнаёт обрезанный растущий текст и не дублирует его', () => {
    const long = 'z'.repeat(FEED_TEXT_LIMIT + 3);
    const state = run([
      { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      display(0, long),
      { hook_event_name: 'Stop', last_assistant_message: long },
    ]);

    expect(ofKind(state.items, 'text')).toHaveLength(1);
  });
});
