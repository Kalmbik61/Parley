/**
 * Схемы ленты (план 2026-10-01, Task 2, подкусок 2a): всё, что собирает core — редьюсер хуков на
 * фикстурах проб и разбор журналов, — проходит `feedItem`; лишнее и чужое — нет. Фикстуры — те же
 * файлы, что у тестов core (`packages/core/src/feed/fixtures`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '@parley/core';
import type { FeedDecision, FeedItem, FeedState } from '@parley/core';
import {
  CODEX_FEED_MIN_VERSION,
  FEED_AGENT_CHILDREN,
  FEED_AGENT_TEXT_LIMIT,
  FEED_CODEX_FEATURE,
  FEED_IMAGE_MIME_LIMIT,
  FEED_IMAGE_PATH_LIMIT,
  FEED_IMAGES_PER_CALL,
  FEED_INPUT_LIMIT,
  FEED_MIN_VERSION,
  FEED_PATCH_LINES,
  FEED_RESULT_LIMIT,
  FEED_SCHEMA_VERSION,
  FEED_TEXT_LIMIT,
  feedCardState,
  feedDecision,
  feedItem,
} from './index.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../core/src/feed/fixtures',
);

const jsonl = (file: string): Record<string, unknown>[] =>
  readFileSync(path.join(FIXTURES, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const fixtures = (suffix: string, prefix = ''): string[] =>
  readdirSync(FIXTURES)
    .filter((file) => file.endsWith(suffix) && file.startsWith(prefix))
    .sort();

const iso = (t: unknown): string => new Date(typeof t === 'number' ? t : 0).toISOString();

/** Ответ стенда хуку → решение окна (как в `reduce.test.ts` core). */
function decisionOf(line: Record<string, unknown>): FeedDecision {
  const out = (line['decision'] as { hookSpecificOutput: Record<string, unknown> })
    .hookSpecificOutput;
  if (line['decisionFor'] === 'PermissionRequest') {
    const decision = out['decision'] as { behavior: 'allow' | 'deny'; message?: string };
    return decision.message === undefined
      ? { kind: 'permission', behavior: decision.behavior }
      : { kind: 'permission', behavior: decision.behavior, message: decision.message };
  }
  const input = out['updatedInput'] as { answers: Record<string, string> };
  return { kind: 'question', answers: input.answers };
}

/**
 * Прогон фикстуры хуков: все элементы из `changes` каждого шага и из итогового состояния, плюс
 * решения стенда, решение плана и снятие оставшихся карточек как `stale`.
 */
function hookItems(file: string): FeedItem[] {
  const seen: FeedItem[] = [];
  let state: FeedState = core.emptyFeedState();
  let last = 0;
  for (const line of jsonl(file)) {
    last = typeof line['t'] === 'number' ? line['t'] : last;
    if (line['ev'] !== undefined) {
      const update = core.applyHookEvent(state, line['ev'], iso(line['t']));
      seen.push(...update.changes);
      state = update.state;
    } else if (line['decisionFor'] !== undefined) {
      const decision = decisionOf(line);
      const card = [...state.items]
        .reverse()
        .find((item) => item.kind === decision.kind && 'state' in item && item.state === 'pending');
      const update = core.applyDecision(state, card?.id ?? 'none', decision, iso(line['t']));
      seen.push(...update.changes);
      state = update.state;
    }
    // Ветки, которых стенд не прошёл, — на копии состояния, поток не меняют: ждущий план получает
    // решение окна (карточка с `choice`), все ждущие карточки снимаются как `stale`.
    const plan = state.items.find((item) => item.kind === 'plan' && item.state === 'pending');
    if (plan !== undefined) {
      seen.push(
        ...core.applyDecision(state, plan.id, { kind: 'plan', choice: 'auto-accept' }, iso(last))
          .changes,
      );
    }
    seen.push(...core.settleCards(state, 'stale', iso(last)).changes);
  }
  seen.push(...state.items);
  return seen;
}

function transcriptItems(file: string): FeedItem[] {
  return [...core.feedFromTranscript(jsonl(file)).items];
}

const failures = (items: readonly FeedItem[]): unknown[] =>
  items.flatMap((item) => {
    const result = feedItem.safeParse(item);
    return result.success ? [] : [{ id: item.id, issues: result.error.issues }];
  });

describe('feedItem на том, что собирает core', () => {
  const hookFiles = fixtures('.events.jsonl');
  const transcriptFiles = fixtures('.jsonl', 'transcript-');

  it('фикстуры на месте: семь проб хуков и четыре журнала', () => {
    expect(hookFiles).toHaveLength(7);
    expect(transcriptFiles).toHaveLength(4);
  });

  it.each(hookFiles)('applyHookEvent: %s — каждый элемент проходит схему', (file) => {
    const items = hookItems(file);
    expect(items.length).toBeGreaterThan(0);
    expect(failures(items)).toEqual([]);
  });

  it.each(transcriptFiles)('feedFromTranscript: %s — каждый элемент проходит схему', (file) => {
    const items = transcriptItems(file);
    expect(items.length).toBeGreaterThan(0);
    expect(failures(items)).toEqual([]);
  });

  it('фикстуры покрывают все виды элементов, кроме error, и все состояния карточек', () => {
    const items = [...hookFiles.flatMap(hookItems), ...transcriptFiles.flatMap(transcriptItems)];
    const kinds = new Set(items.map((item) => item.kind));
    for (const kind of [
      'prompt',
      'text',
      'tool',
      'permission',
      'question',
      'plan',
      'agent',
      'notice',
      'turn',
    ]) {
      expect(kinds).toContain(kind);
    }
    const states = new Set(items.flatMap((item) => ('state' in item ? [item.state] : [])));
    for (const state of ['pending', 'allowed', 'denied', 'answered', 'elsewhere', 'stale']) {
      expect(states).toContain(state);
    }
  });

  it('ошибка хода (StopFailure) проходит схему', () => {
    const { changes } = core.applyHookEvent(
      core.emptyFeedState(),
      {
        hook_event_name: 'StopFailure',
        session_id: 's',
        error: 'rate_limit',
        last_assistant_message: 'API Error',
      },
      iso(0),
    );
    expect(changes.map((item) => item.kind)).toContain('error');
    expect(failures(changes)).toEqual([]);
  });

  it('retry records pass the wire schema; invalid delay and attempts do not', () => {
    const item = {
      id: 'retry:6', at: iso(0), kind: 'error', error: '429', message: 'Usage limit reached',
      retry: { delayMs: 8000, attempt: 6, maxAttempts: 10 },
    };
    expect(feedItem.safeParse(item).success).toBe(true);
    expect(feedItem.safeParse({ ...item, retry: { ...item.retry, resolved: true } }).success).toBe(true);
    for (const retry of [
      { delayMs: -1, attempt: 6, maxAttempts: 10 },
      { delayMs: 8000, attempt: 11, maxAttempts: 10 },
      { delayMs: 8000, attempt: 1.5, maxAttempts: 10 },
    ]) expect(feedItem.safeParse({ ...item, retry }).success).toBe(false);
  });

  it('пределы строк длиннее элементов core: усечённые элементы проходят схему', () => {
    const long = 'я'.repeat(FEED_TEXT_LIMIT * 2);
    const at = iso(0);
    let state = core.applyHookEvent(
      core.emptyFeedState(),
      { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'go' },
      at,
    ).state;
    const steps = [
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        tool_name: 'Bash',
        tool_use_id: 't1',
        tool_input: { command: long, nested: [{ deep: long }] },
      },
      {
        hook_event_name: 'PermissionRequest',
        session_id: 's',
        tool_name: 'Bash',
        tool_input: { command: long },
      },
      {
        hook_event_name: 'PostToolUse',
        session_id: 's',
        tool_name: 'Bash',
        tool_use_id: 't1',
        tool_input: { command: long },
        tool_response: { stdout: long, stderr: '' },
      },
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        tool_name: 'Agent',
        tool_use_id: 'a1',
        tool_input: { prompt: long, description: 'd', subagent_type: 'Explore' },
      },
      { hook_event_name: 'Stop', session_id: 's', last_assistant_message: long },
    ];
    const seen: FeedItem[] = [];
    for (const ev of steps) {
      const update = core.applyHookEvent(state, ev, at);
      seen.push(...update.changes);
      state = update.state;
    }
    expect(seen.some((item) => 'truncated' in item && item.truncated === true)).toBe(true);
    expect(failures(seen)).toEqual([]);
  });
});

describe('feedItem отвергает чужое', () => {
  const turn: FeedItem = { id: 'turn:#1', at: iso(0), kind: 'turn', durationMs: 10 };
  const text: FeedItem = {
    id: 'text:m1',
    at: iso(0),
    kind: 'text',
    messageId: 'm1',
    text: 'hi',
    streaming: false,
  };

  it('эталон проходит', () => {
    expect(feedItem.safeParse(turn).success).toBe(true);
    expect(feedItem.safeParse(text).success).toBe(true);
  });

  it('черта прерванного хода: `interrupted: true` проходит, `false` — нет (признак только истинный)', () => {
    expect(feedItem.safeParse({ ...turn, interrupted: true }).success).toBe(true);
    expect(feedItem.safeParse({ ...turn, interrupted: false }).success).toBe(false);
  });

  it('лишнее поле не проходит — на элементе и внутри него', () => {
    expect(feedItem.safeParse({ ...turn, extra: 1 }).success).toBe(false);
    const notice = {
      id: 'notice:#1',
      at: iso(0),
      kind: 'notice',
      notice: { type: 'session-end', reason: null },
    };
    expect(feedItem.safeParse(notice).success).toBe(true);
    expect(
      feedItem.safeParse({ ...notice, notice: { type: 'session-end', reason: null, x: 1 } })
        .success,
    ).toBe(false);
  });

  it('неверный kind и неверный тип notice не проходят', () => {
    expect(feedItem.safeParse({ ...turn, kind: 'thinking' }).success).toBe(false);
    expect(feedItem.safeParse({ ...turn, kind: undefined }).success).toBe(false);
    expect(
      feedItem.safeParse({ id: 'n', at: iso(0), kind: 'notice', notice: { type: 'clear' } })
        .success,
    ).toBe(false);
  });

  it('необязательное поле со значением undefined не проходит: элемент — чистый JSON', () => {
    expect(feedItem.safeParse({ ...text, truncated: undefined }).success).toBe(false);
  });

  it('строки длиннее пределов core не проходят', () => {
    expect(feedItem.safeParse({ ...text, text: 'x'.repeat(FEED_TEXT_LIMIT) }).success).toBe(true);
    expect(feedItem.safeParse({ ...text, text: 'x'.repeat(FEED_TEXT_LIMIT + 1) }).success).toBe(
      false,
    );

    const tool = {
      id: 'tool:t1',
      at: iso(0),
      kind: 'tool',
      toolUseId: 't1',
      name: 'Bash',
      input: { command: 'ls' },
      status: 'done',
    };
    expect(feedItem.safeParse(tool).success).toBe(true);
    expect(
      feedItem.safeParse({ ...tool, input: { a: [{ b: 'x'.repeat(FEED_INPUT_LIMIT + 1) }] } })
        .success,
    ).toBe(false);
    const response = (size: number) => ({ text: 'x'.repeat(size), size, truncated: false });
    expect(feedItem.safeParse({ ...tool, response: response(FEED_RESULT_LIMIT) }).success).toBe(
      true,
    );
    expect(feedItem.safeParse({ ...tool, response: response(FEED_RESULT_LIMIT + 1) }).success).toBe(
      false,
    );
    const hunk = (lines: number) => ({
      oldStart: 1,
      oldLines: lines,
      newStart: 1,
      newLines: lines,
      lines: Array.from({ length: lines }, () => '+x'),
    });
    expect(feedItem.safeParse({ ...tool, patch: [hunk(FEED_PATCH_LINES)] }).success).toBe(true);
    expect(feedItem.safeParse({ ...tool, patch: [hunk(FEED_PATCH_LINES), hunk(1)] }).success).toBe(
      false,
    );
  });
});

describe('пределы и версия', () => {
  it('пределы протокола равны пределам core', () => {
    expect(FEED_RESULT_LIMIT).toBe(core.FEED_RESULT_LIMIT);
    expect(FEED_INPUT_LIMIT).toBe(core.FEED_INPUT_LIMIT);
    expect(FEED_PATCH_LINES).toBe(core.FEED_PATCH_LINES);
    expect(FEED_AGENT_TEXT_LIMIT).toBe(core.FEED_AGENT_TEXT_LIMIT);
    expect(FEED_TEXT_LIMIT).toBe(core.FEED_TEXT_LIMIT);
    expect(FEED_AGENT_CHILDREN).toBe(core.FEED_AGENT_CHILDREN);
    expect(FEED_IMAGES_PER_CALL).toBe(core.FEED_IMAGES_PER_CALL);
    expect(FEED_MIN_VERSION).toBe(core.FEED_MIN_VERSION);
    expect(CODEX_FEED_MIN_VERSION).toBe(core.CODEX_FEED_MIN_VERSION);
    expect(FEED_CODEX_FEATURE).toBe('feed-codex');
    expect(FEED_SCHEMA_VERSION).toBe(3);
  });

  it('карточка агента: вложенных вызовов не больше FEED_AGENT_CHILDREN', () => {
    const child = (i: number) => ({
      id: `tool:c${i}`,
      at: '2026-10-01T10:00:00.000Z',
      kind: 'tool',
      toolUseId: `c${i}`,
      name: 'Bash',
      input: { command: 'ls' },
      status: 'done',
      agentId: 'ag1',
    });
    const agent = (children: number) => ({
      id: 'agent:a1',
      at: '2026-10-01T10:00:00.000Z',
      kind: 'agent',
      toolUseId: 'a1',
      agentId: 'ag1',
      agentType: 'Explore',
      description: 'x',
      prompt: null,
      model: null,
      background: false,
      status: 'running',
      toolCount: children,
      children: Array.from({ length: children }, (_, i) => child(i)),
    });
    expect(feedItem.safeParse(agent(FEED_AGENT_CHILDREN)).success).toBe(true);
    expect(feedItem.safeParse(agent(FEED_AGENT_CHILDREN + 1)).success).toBe(false);
  });

  it('feedCardState — шесть состояний карточки', () => {
    for (const state of ['pending', 'allowed', 'denied', 'answered', 'elsewhere', 'stale']) {
      expect(feedCardState.safeParse(state).success).toBe(true);
    }
    expect(feedCardState.safeParse('done').success).toBe(false);
  });

  it('feedDecision: три вида решения', () => {
    expect(
      feedDecision.safeParse({ kind: 'permission', behavior: 'allow', always: true }).success,
    ).toBe(true);
    expect(
      feedDecision.safeParse({ kind: 'permission', behavior: 'allow', always: false }).success,
    ).toBe(false);
    expect(feedDecision.safeParse({ kind: 'question', answers: { Q: 'A' } }).success).toBe(true);
    expect(feedDecision.safeParse({ kind: 'plan', choice: 'manual' }).success).toBe(true);
    expect(feedDecision.safeParse({ kind: 'plan', choice: 'edit' }).success).toBe(false);
  });
});

describe('feedItem: картинки результата инструмента (план 2026-10-09, Task 1)', () => {
  const tool = (response: Record<string, unknown>) => ({
    id: 'tool:t1',
    at: iso(0),
    kind: 'tool',
    toolUseId: 't1',
    name: 'mcp__browser__screenshot',
    input: {},
    status: 'done',
    response,
  });
  const body = { text: '[image png, 1 KB]', size: 17, truncated: false };
  const ref = (n = 1) => ({
    path: `/home/.parley/feed-images/img${n}.png`,
    mime: 'image/png',
    bytes: 1024,
  });
  const ok = (response: Record<string, unknown>): boolean =>
    feedItem.safeParse(tool(response)).success;

  it('сводка без images — как раньше; с images проходит', () => {
    expect(ok(body)).toBe(true);
    expect(ok({ ...body, images: [ref()] })).toBe(true);
  });

  it('images: не больше FEED_IMAGES_PER_CALL ссылок (шесть можно, семь — ошибка)', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ref(i + 1));

    expect(ok({ ...body, images: many(FEED_IMAGES_PER_CALL) })).toBe(true);
    expect(ok({ ...body, images: many(FEED_IMAGES_PER_CALL + 1) })).toBe(false);
    expect(FEED_IMAGES_PER_CALL).toBe(6);
  });

  it('ссылка: bytes необязателен, целое не меньше нуля; path и mime в пределах; лишнее поле нельзя', () => {
    expect(ok({ ...body, images: [{ path: ref().path, mime: ref().mime }] })).toBe(true);
    expect(ok({ ...body, images: [{ ...ref(), bytes: 0 }] })).toBe(true);
    expect(ok({ ...body, images: [{ ...ref(), bytes: -1 }] })).toBe(false);
    expect(ok({ ...body, images: [{ ...ref(), bytes: 1.5 }] })).toBe(false);
    expect(ok({ ...body, images: [{ ...ref(), path: 'x'.repeat(FEED_IMAGE_PATH_LIMIT) }] })).toBe(true);
    expect(ok({ ...body, images: [{ ...ref(), path: 'x'.repeat(FEED_IMAGE_PATH_LIMIT + 1) }] })).toBe(false);
    expect(ok({ ...body, images: [{ ...ref(), mime: 'x'.repeat(FEED_IMAGE_MIME_LIMIT) }] })).toBe(true);
    expect(ok({ ...body, images: [{ ...ref(), mime: 'x'.repeat(FEED_IMAGE_MIME_LIMIT + 1) }] })).toBe(false);
    expect(ok({ ...body, images: [{ ...ref(), base64: 'AAAA' }] })).toBe(false);
    expect(ok({ ...body, images: [{ path: '/a.png' }] })).toBe(false);
    expect(ok({ ...body, images: ['/a.png'] })).toBe(false);
  });

  it('необязательное images со значением undefined не проходит: элемент — чистый JSON', () => {
    expect(ok({ ...body, images: undefined })).toBe(false);
  });

  it('пределы path и mime — 4096 и 100 символов, и равны пределам core (ими отсекает ссылки редьюсер)', () => {
    expect(FEED_IMAGE_PATH_LIMIT).toBe(4096);
    expect(FEED_IMAGE_MIME_LIMIT).toBe(100);
    expect(FEED_IMAGE_PATH_LIMIT).toBe(core.FEED_IMAGE_PATH_LIMIT);
    expect(FEED_IMAGE_MIME_LIMIT).toBe(core.FEED_IMAGE_MIME_LIMIT);
  });

  it('вызов, который собрал core из события с картинкой, проходит схему', () => {
    const ref1 = ref();
    const event = core.stashFeedImages(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__browser__screenshot',
        tool_use_id: 't1',
        tool_input: {},
        tool_response: [
          { type: 'text', text: 'Took a screenshot' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        ],
      },
      () => ref1,
    );
    const update = core.applyHookEvent(core.emptyFeedState(), event, iso(0));
    const item = update.changes.find((change) => change.kind === 'tool');

    expect(item?.kind === 'tool' && item.response?.images).toEqual([ref1]);
    expect(failures(update.changes)).toEqual([]);
  });
});
