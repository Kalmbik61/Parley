import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import { createSessionHandlers } from './sessions.js';

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
