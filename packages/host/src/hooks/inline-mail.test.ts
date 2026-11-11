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
import { createInlineMail, INLINE_MAIL_BUDGET_MS } from './inline-mail.js';

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
    for (const provider of ['codex', undefined]) {
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
