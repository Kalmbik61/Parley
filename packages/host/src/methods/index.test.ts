import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import { createHostHandlers, WORKS_GATED_METHODS, WORKS_GATED_NOTIFICATIONS } from './index.js';
import type { MethodDeps } from './index.js';

/**
 * Методы, которым нужен снимок работ хоста, ждут его первого чтения (раунд lane-r4, п. 4):
 * пока `worksReady` не разрешён, ни один из них не доходит до сервисов.
 */
function fakeDeps(worksReady: Promise<void>): { deps: MethodDeps; touched: () => number } {
  let calls = 0;
  // Любой метод любого сервиса — счётчик вызова и пустой ответ.
  const service = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === 'then') return undefined;
          return () => {
            calls += 1;
            return key === 'on' ? () => {} : undefined;
          };
        },
      },
    );
  const deps = {
    works: service(),
    activity: service(),
    pty: service(),
    sessions: service(),
    wake: { ...(service() as object), enterDelayMs: 0 },
    worktrees: service(),
    worksReady,
  } as unknown as MethodDeps;
  return { deps, touched: () => calls };
}

const request = { client: {} } as unknown as RequestInfo;
const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

describe('методы на старте хоста ждут первого чтения работ (lane-r4, п. 4)', () => {
  it('перечень: works.list, sessions.*, pty.attach/detach/send и activity.seen', () => {
    expect([...WORKS_GATED_METHODS].sort()).toEqual(
      [
        'works.list',
        'sessions.create',
        'sessions.resume',
        'sessions.stop',
        'sessions.close',
        'sessions.delete',
        'sessions.interrupted',
        'sessions.resumeInterrupted',
        'pty.attach',
        'pty.detach',
        'pty.send',
      ].sort(),
    );
    expect([...WORKS_GATED_NOTIFICATIONS]).toEqual(['activity.seen']);
  });

  it('до worksReady ни один из них не трогает сервисы; после — трогает', async () => {
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      markReady = resolve;
    });
    const { deps, touched } = fakeDeps(ready);
    const handlers = createHostHandlers(deps);
    const baseline = touched();
    const params = { ref, refs: [ref], text: 'x', cols: 80, rows: 24, projectPath: '/p', workId: 'w-1' } as never;

    const pending = WORKS_GATED_METHODS.map((name) => handlers.methods[name]?.(params, request).catch(() => undefined));
    for (const name of WORKS_GATED_NOTIFICATIONS) handlers.notifications[name]?.(params, request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(touched()).toBe(baseline);

    markReady();
    await Promise.all(pending);
    await vi.waitFor(() => expect(touched()).toBeGreaterThan(baseline));
  });
});
