/**
 * Редьюсер ленты вида «Chat» на настоящих событиях хуков (план 2026-10-01, Task 1, «Тесты»).
 * Фикстуры — `events.jsonl` проб разведки как есть: строка `{t, ev}` — событие, строка с
 * `decisionFor` — ответ стенда хуку; здесь он становится решением окна (`applyDecision`).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyDecision, applyHookEvent, emptyFeedState, settleCards } from './reduce.js';
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
import { FEED_RESULT_LIMIT } from './types.js';

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
 * Прогон фикстуры через редьюсер. `filter` отбрасывает события — так выглядит поток, который хост
 * получает HTTP-хуками (матчер `PreToolUse`).
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

/** Поток HTTP-хуков: `PreToolUse` доходит только для вопроса и плана. */
const httpOnly = (ev: Record<string, unknown>): boolean =>
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
    for (const line of lines('p3-modes')) {
      const ev = line.ev;
      if (ev === undefined) continue;
      const noise =
        (ev['hook_event_name'] === 'SubagentStop' && ev['agent_type'] === '') ||
        (ev['hook_event_name'] === 'PostModelSwitch' && ev['source'] === 'auto');
      if (!noise) continue;
      const result = applyHookEvent(emptyFeedState(), ev, iso(line.t));
      expect(result.changes).toEqual([]);
      expect(result.state.items).toEqual([]);
    }
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
    }
  });
});

describe('поток HTTP-хуков: PreToolUse только для вопроса и плана', () => {
  it('p2: вызов заводит PostToolUse, карточка без вызова снимается им же', () => {
    const { state } = replay('p2-permissions', httpOnly);
    const tools = ofKind(state.items, 'tool');
    const cards = ofKind(state.items, 'permission');

    expect(tools.map((tool) => tool.status)).toEqual(['done', 'done', 'done']);
    expect(cards).toHaveLength(4);
    expect(cards.every((card) => card.state === 'elsewhere')).toBe(true);
    // Снятая PostToolUse карточка узнаёт свой вызов.
    expect(cards[0]?.toolUseId).toBe(tools[0]?.toolUseId);
  });

  it('p6b: карточку агента заводит PostToolUse(Agent), вложенный Bash всё равно в ней', () => {
    const { state } = replay('p6b-subagents', httpOnly);
    const agents = ofKind(state.items, 'agent');

    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe('ad2fe21e96ffde3ba');
    expect(agents[0]?.description).toBe('List project files');
    expect(agents[0]?.children.map((child) => child.name)).toEqual(['Bash']);
    expect(agents[0]?.status).toBe('done');
  });

  it('p4: вопрос и план по-прежнему карточками', () => {
    const { state } = replay('p4-questions-plan', httpOnly);

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
