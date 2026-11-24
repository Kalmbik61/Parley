/**
 * Письма вместе с указателем: ответ хосту на `UserPromptSubmit` (план «Fewer mail turns», 3.2). Почта настоящая (хранилище
 * работы во временной папке); хук и контекст — подделки, как у соседних тестов приёмника.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONFIG, addSession, createWork, pointerText, readStoredMap, updateMap, workPaths, type McpContext,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { silentLog } from '../../test/feed-fakes.js';
import { EMPTY_HOOK_RESPONSE, type HookResponse } from './decisions.js';
import type { HookRequest } from './hook-server.js';
import { request as httpRequest } from 'node:http';
import { createHookServer } from './hook-server.js';
import { createInlineMail, hookWithInlineMail, INLINE_MAIL_BUDGET_MS } from './inline-mail.js';

let home = '';
let project = '';
let ref: SessionRef;

const contextOf = (revision?: string): McpContext => ({
  projectPath: ref.projectPath,
  workId: ref.workId,
  workDir: workPaths(ref.projectPath, ref.workId).dir,
  sessionId: ref.sessionId,
  channel: false,
  messageRate: DEFAULT_CONFIG.messageRate,
  ...(revision === undefined ? {} : { agentRevision: revision }),
});

const say = (text: string, to: string[] = ['s-02']): Promise<unknown> =>
  updateMap(project, ref.workId, (_map, letters) => {
    letters.add({ kind: 'note', from: 's-01', to, text, roomId: null });
  });
const unread = (): number => readStoredMap(project, ref.workId).messages.filter((m) => m.readBy['s-02'] === undefined).length;

const POINTER = (count: number): string => pointerText(
  Array.from({ length: count }, () => ({ id: 'm', roomId: null, from: 's-01', to: ['s-02'], at: '', text: '', kind: 'note', readBy: {} })) as never,
  [],
);

interface Probe { request: HookRequest; replies: HookResponse[]; abandoned(): void }

const hook = (prompt: string, event = 'UserPromptSubmit', agentRevision?: string): Probe => {
  const replies: HookResponse[] = [];
  let abandon: (() => void) | null = null;
  const request: HookRequest = {
    ref,
    body: { hook_event_name: event, prompt },
    ...(agentRevision === undefined ? {} : { agentRevision }),
    respond: (json) => { if (replies.length === 0) replies.push(json); },
    answered: () => replies.length > 0,
    onAbandon: (listener) => { abandon = listener; },
  };
  return { request, replies, abandoned: () => abandon?.() };
};
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const contextOfOutput = (reply: HookResponse | undefined): string | undefined =>
  (reply?.['hookSpecificOutput'] as { additionalContext?: string } | undefined)?.additionalContext;

const make = (over: Partial<Parameters<typeof createInlineMail>[0]> = {}) => {
  const journal = vi.fn();
  const inline = createInlineMail({
    log: silentLog(),
    provider: () => 'claude',
    context: async (_ref, launch) => contextOf(launch.agentRevision),
    journal,
    ...over,
  });
  return { inline, journal };
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env['PARLEY_HOME'] = home;
  const workId = (await createWork(project, { title: 'Работа', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    for (const label of ['лид', 'бэк']) addSession(map, { provider: 'claude', label, task: 'делать' });
  });
  ref = { projectPath: project, workId, sessionId: 's-02' };
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['PARLEY_HOME'];
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('письма вместе с указателем', () => {
  it('указатель и два письма: additionalContext с обоими, письма прочитаны, запись в журнал с числом', async () => {
    await say('первое');
    await say('второе');
    const { inline, journal } = make();
    const probe = hook(POINTER(2));
    expect(inline.handle(probe.request)).toBe(true);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    const text = contextOfOutput(probe.replies[0])!;
    expect(probe.replies[0]).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
    expect(text).toContain('Do not call check_inbox for them.');
    expect(text).toContain('первое');
    expect(text).toContain('второе');
    expect(text.length).toBeLessThanOrEqual(9000);
    expect(unread()).toBe(0);
    expect(journal).toHaveBeenCalledWith(ref, 2);
  });

  it('не указатель и не тот хук: не наш случай, письма не тронуты', async () => {
    await say('письмо');
    const { inline } = make();
    expect(inline.handle(hook('сделай задачу').request)).toBe(false);
    expect(inline.handle(hook(POINTER(1), 'Stop').request)).toBe(false);
    expect(unread()).toBe(1);
  });

  it('указатель, а почта пуста: ответ без additionalContext', async () => {
    const { inline, journal } = make();
    const probe = hook(POINTER(1));
    expect(inline.handle(probe.request)).toBe(true);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    expect(probe.replies[0]).toBe(EMPTY_HOOK_RESPONSE);
    expect(journal).not.toHaveBeenCalled();
  });

  it('устаревшая ревизия агента: без additionalContext, письма не прочитаны', async () => {
    await say('письмо');
    await updateMap(project, ref.workId, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.agentRevision = 'rev-new';
    });
    const { inline, journal } = make();
    const probe = hook(POINTER(1), 'UserPromptSubmit', 'rev-old');
    inline.handle(probe.request);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    expect(contextOfOutput(probe.replies[0])).toBeUndefined();
    expect(unread()).toBe(1);
    expect(journal).not.toHaveBeenCalled();
  });

  it('контекст не собрался (исключение): без additionalContext, письма не прочитаны', async () => {
    await say('письмо');
    const { inline } = make({ context: async () => { throw new Error('config unreadable'); } });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    expect(contextOfOutput(probe.replies[0])).toBeUndefined();
    expect(unread()).toBe(1);
  });

  it('ограда сна: без additionalContext, письма не прочитаны', async () => {
    await say('письмо');
    await updateMap(project, ref.workId, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.autoSleepPending = { at: '2026-11-11T10:00:00.000Z' } as never;
    });
    const { inline } = make();
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    expect(contextOfOutput(probe.replies[0])).toBeUndefined();
    expect(unread()).toBe(1);
  });

  it('сессия Codex и сессия без записи в карте: не наш случай', async () => {
    await say('письмо');
    for (const provider of ['codex', 'qwen', 'mystery', undefined]) {
      const { inline } = make({ provider: () => provider });
      expect(inline.handle(hook(POINTER(1)).request)).toBe(false);
    }
    expect(unread()).toBe(1);
  });

  it('дольше бюджета: пустой ответ по таймеру, письма позже не забираются', async () => {
    vi.useFakeTimers();
    await say('письмо');
    let release: (() => void) | undefined;
    const { inline } = make({
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.advanceTimersByTimeAsync(INLINE_MAIL_BUDGET_MS);
    expect(probe.replies).toEqual([EMPTY_HOOK_RESPONSE]);
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(unread()).toBe(1);
    expect(probe.replies).toHaveLength(1);
  });

  it('хук оборван до ответа: письма не забираются', async () => {
    await say('письмо');
    let release: (() => void) | undefined;
    const { inline } = make({
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    probe.abandoned();
    release!();
    await settle();
    await settle();
    expect(unread()).toBe(1);
  });
});

describe('бюджет и чужой ответ', () => {
  it('хуку уже ответил кто-то другой (сбой ленты, закрытие сервера): письма не забираются', async () => {
    await say('письмо');
    let release: (() => void) | undefined;
    const { inline, journal } = make({
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    probe.request.respond(EMPTY_HOOK_RESPONSE);
    release!();
    await settle();
    await settle();
    expect(unread()).toBe(1);
    expect(journal).not.toHaveBeenCalled();
    expect(probe.replies).toEqual([EMPTY_HOOK_RESPONSE]);
  });

  it('остаток бюджета уходит ожиданием записи: забор получает lockTimeoutMs = остаток', async () => {
    vi.useFakeTimers();
    await say('письмо');
    let release: (() => void) | undefined;
    const take = vi.fn(() => null);
    const { inline } = make({
      take,
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    inline.handle(hook(POINTER(1)).request);
    await vi.advanceTimersByTimeAsync(500);
    release!();
    await vi.advanceTimersByTimeAsync(1);
    expect(take).toHaveBeenCalledTimes(1);
    expect(take.mock.calls[0]?.[2]).toBe(INLINE_MAIL_BUDGET_MS - 500);
  });

  it('почти весь бюджет ушёл на контекст: ответ без писем, ничего не помечено, забор не вызван', async () => {
    vi.useFakeTimers();
    await say('письмо');
    let release: (() => void) | undefined;
    const take = vi.fn(() => null);
    const { inline } = make({
      take,
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.advanceTimersByTimeAsync(INLINE_MAIL_BUDGET_MS - 50);
    release!();
    await vi.advanceTimersByTimeAsync(1);
    expect(take).not.toHaveBeenCalled();
    expect(probe.replies).toEqual([EMPTY_HOOK_RESPONSE]);
    expect(unread()).toBe(1);
  });
});

describe('проводка приёмника хуков', () => {
  const post = (url: string, token: string, body: unknown): Promise<string> => new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpRequest({
      host: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)),
        Authorization: `Bearer ${token}`, 'X-Parley-Session': ref.sessionId },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.end(payload);
  });

  it('лента отвечает {} синхронно, а письма всё равно доходят и помечены только отданные; ревизия агента доходит до контекста', async () => {
    await say('письмо');
    const launches: { agentRevision?: string }[] = [];
    const { inline } = make({ context: async (_ref, launch) => { launches.push(launch); return contextOf(launch.agentRevision); } });
    // Как настоящая лента: отвечает `{}` сразу, в том же вызове.
    const server = createHookServer({
      log: silentLog(),
      onHook: hookWithInlineMail(inline, (request) => request.respond(EMPTY_HOOK_RESPONSE)),
    });
    try {
      const url = await server.listen();
      const token = server.register(ref, null, 'claude', 'rev-7');
      const answer = JSON.parse(await post(url, token, { hook_event_name: 'UserPromptSubmit', prompt: POINTER(1) })) as HookResponse;
      expect(contextOfOutput(answer)).toContain('письмо');
      expect(unread()).toBe(0);
      expect(launches).toEqual([{ agentRevision: 'rev-7' }]);
      // Не указатель: письма не трогаются, ответ — лента.
      await say('второе');
      const plain = JSON.parse(await post(url, token, { hook_event_name: 'UserPromptSubmit', prompt: 'сделай' })) as HookResponse;
      expect(plain).toEqual({});
      expect(unread()).toBe(1);
    } finally {
      await server.close();
    }
  });
});

describe('mail journal and the feed notice (spec 2026-11-12, M4)', () => {
  const withNotice = (over: Partial<Parameters<typeof createInlineMail>[0]> = {}) => {
    const mailJournal = vi.fn();
    const delivered = vi.fn();
    const made = make({ mailJournal, delivered, ...over });
    return { ...made, mailJournal, delivered };
  };

  it('order: journal line, then the answer, then the feed notice', async () => {
    await say('первое');
    const order: string[] = [];
    const { inline } = withNotice({
      mailJournal: vi.fn(() => { order.push('journal'); }),
      delivered: vi.fn(() => { order.push('delivered'); }),
    });
    const probe = hook(POINTER(1));
    probe.request.respond = (json) => { order.push('answer'); probe.replies.push(json); };
    inline.handle(probe.request);
    await vi.waitFor(() => expect(order).toEqual(['journal', 'answer', 'delivered']));
  });

  it('journal and notice receive the same text and at', async () => {
    await say('первое');
    const { inline, mailJournal, delivered } = withNotice();
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    const text = contextOfOutput(probe.replies[0])!;
    expect(mailJournal).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledTimes(1);
    const entry = mailJournal.mock.calls[0]![1] as { at: string; text: string };
    expect(entry.text).toBe(text);
    expect(delivered).toHaveBeenCalledWith(ref, text, entry.at);
    expect(Number.isNaN(Date.parse(entry.at))).toBe(false);
  });

  it('neither is called for a non-pointer, empty mail, a stale agent, a late answer and an abandoned hook', async () => {
    const { inline, mailJournal, delivered } = withNotice();
    inline.handle(hook('сделай задачу').request);
    const empty = hook(POINTER(1));
    inline.handle(empty.request);
    await vi.waitFor(() => expect(empty.replies).toHaveLength(1));

    await say('письмо');
    await updateMap(project, ref.workId, (map) => { map.sessions.find((session) => session.id === 's-02')!.agentRevision = 'rev-new'; });
    const stale = hook(POINTER(1), 'UserPromptSubmit', 'rev-old');
    inline.handle(stale.request);
    await vi.waitFor(() => expect(stale.replies).toHaveLength(1));

    let release: (() => void) | undefined;
    const slow = withNotice({
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    const abandoned = hook(POINTER(1));
    slow.inline.handle(abandoned.request);
    abandoned.abandoned();
    release!();
    await settle();
    await settle();

    expect(mailJournal).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(slow.mailJournal).not.toHaveBeenCalled();
    expect(slow.delivered).not.toHaveBeenCalled();
  });

  it('late (budget timer): neither is called', async () => {
    vi.useFakeTimers();
    await say('письмо');
    let release: (() => void) | undefined;
    const { inline, mailJournal, delivered } = withNotice({
      context: (_ref, launch) => new Promise<McpContext>((resolve) => { release = () => resolve(contextOf(launch.agentRevision)); }),
    });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.advanceTimersByTimeAsync(INLINE_MAIL_BUDGET_MS);
    release!();
    await vi.advanceTimersByTimeAsync(10);
    expect(mailJournal).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  it('a throwing journal or a throwing notice still answers the hook with the letters', async () => {
    await say('первое');
    const boom = (): never => { throw new Error('disk full'); };
    const { inline, delivered } = withNotice({ mailJournal: boom });
    const probe = hook(POINTER(1));
    inline.handle(probe.request);
    await vi.waitFor(() => expect(probe.replies).toHaveLength(1));
    expect(contextOfOutput(probe.replies[0])).toContain('первое');
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(unread()).toBe(0);

    await say('второе');
    const second = withNotice({ delivered: boom });
    const again = hook(POINTER(1));
    second.inline.handle(again.request);
    await vi.waitFor(() => expect(again.replies).toHaveLength(1));
    expect(contextOfOutput(again.replies[0])).toContain('второе');
    expect(unread()).toBe(0);
  });
});
