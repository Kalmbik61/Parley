import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import { createSessionHandlers } from './sessions.js';
import type { SessionMethodDeps } from './sessions.js';

const request = { client: {}, host: {} } as unknown as RequestInfo;
const params = {
  projectPath: '/p',
  workId: 'w-1',
  provider: 'claude',
  label: '',
  task: '',
  parent: null,
} as const;
const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

/** Сервис-подмена: до настоящего claude и codex тут дело не доходит, важен только вызов `create`. */
function handlers(): {
  create: ReturnType<typeof vi.fn>;
  sessionsCreate: ReturnType<typeof createSessionHandlers>['sessionsCreate'];
} {
  const create = vi.fn(async () => ref);
  const { sessionsCreate } = createSessionHandlers({
    sessions: { create } as unknown as SessionsService,
    pty: {} as unknown as SessionMethodDeps['pty'],
  });
  return { create, sessionsCreate };
}

describe('sessions.create: модель и усилие из диалога (дизайн комнат, 3.2)', () => {
  it('model и effort доезжают до сервиса как есть; ответ — ref', async () => {
    const { create, sessionsCreate } = handlers();

    const response = await sessionsCreate({ ...params, model: 'opus', effort: 'high' }, request);

    expect(response).toEqual({ ref });
    expect(create).toHaveBeenCalledWith({ ...params, model: 'opus', effort: 'high' });
  });

  it('без выбора ключей model и effort в вызове сервиса нет вовсе, даже со значением undefined', async () => {
    const { create, sessionsCreate } = handlers();

    await sessionsCreate(
      { ...params, model: undefined, effort: undefined, worktree: undefined },
      request,
    );

    // `exactOptionalPropertyTypes`: `CreateSessionInput` явного `undefined` ключом не принимает.
    const [input] = create.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(input).sort()).toEqual([
      'label',
      'parent',
      'projectPath',
      'provider',
      'task',
      'workId',
    ]);
  });
});

describe('sessions.setMode (план 2026-10-01, решение 4)', () => {
  const footer = '  ⏸ plan mode on (shift+tab to cycle) · ← for agents';

  function setup(live: boolean, withFeed = true) {
    const noteMode = vi.fn();
    const write = vi.fn();
    const { sessionsSetMode } = createSessionHandlers({
      sessions: {} as unknown as SessionsService,
      pty: {
        get: () => (live ? ({ ref } as never) : undefined),
        write,
        screenText: () => [footer],
        on: () => () => {},
      } as unknown as SessionMethodDeps['pty'],
      ...(withFeed ? { feed: { noteMode } } : {}),
    });
    return { sessionsSetMode, noteMode, write };
  }

  it('режим уже стоит: ответ из подвала, лента узнаёт режим, ничего не нажато', async () => {
    vi.useFakeTimers();
    try {
      const { sessionsSetMode, noteMode, write } = setup(true);
      const response = sessionsSetMode({ ref, mode: 'plan' }, request);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(response).resolves.toEqual({ mode: 'plan', verified: true });
      expect(noteMode).toHaveBeenCalledWith(ref, 'plan');
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('без ленты метод только отвечает', async () => {
    vi.useFakeTimers();
    try {
      const { sessionsSetMode } = setup(true, false);
      const response = sessionsSetMode({ ref, mode: 'plan' }, request);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(response).resolves.toEqual({ mode: 'plan', verified: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('нет живого PTY — not_found, лента не зовётся', async () => {
    const { sessionsSetMode, noteMode } = setup(false);
    await expect(sessionsSetMode({ ref, mode: 'plan' }, request)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(noteMode).not.toHaveBeenCalled();
  });
});
