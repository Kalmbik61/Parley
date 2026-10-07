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
    planEffects: service(),
    worksReady,
  } as unknown as MethodDeps;
  return { deps, touched: () => calls };
}

it('registers the window-only decisions list and room history actions', () => {
  const { deps } = fakeDeps(Promise.resolve());
  const handlers = createHostHandlers(deps);
  for (const name of ['decisions.list', 'rooms.history.get', 'rooms.history.share', 'rooms.history.unshare'] as const)
    expect(handlers.methods[name]).toBeTypeOf('function');
});

it('registers the window-only project memory and history search methods', () => {
  const { deps } = fakeDeps(Promise.resolve());
  const handlers = createHostHandlers(deps);
  for (const name of ['memory.get', 'memory.add', 'memory.update', 'memory.accept', 'memory.dismiss', 'memory.undo', 'history.search'] as const)
    expect(handlers.methods[name]).toBeTypeOf('function');
});

it('registers both explicit native skill sharing actions', () => {
  const { deps } = fakeDeps(Promise.resolve());
  const handlers = createHostHandlers(deps);
  expect(handlers.methods['capabilities.skills.share']).toBeTypeOf('function');
  expect(handlers.methods['capabilities.skills.unshare']).toBeTypeOf('function');
});

const request = { client: {} } as unknown as RequestInfo;
const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };

describe('методы на старте хоста ждут первого чтения работ (lane-r4, п. 4)', () => {
  it('перечень: plans.*, rooms.resolveProposal/setMode, works.list, sessions.*, pty.*, feed.* и activity.seen', () => {
    expect([...WORKS_GATED_METHODS].sort()).toEqual(
      [
        'rooms.resolveProposal',
        'rooms.setMode',
        'plans.update',
        'plans.submit',
        'plans.verify',
        'plans.cancel',
        'plans.retryEffects',
        'works.list',
        'decisions.list',
        'sessions.create',
        'sessions.resume',
        'sessions.stop',
        'sessions.close',
        'sessions.delete',
        'sessions.interrupted',
        'sessions.setMode',
        'sessions.setEffort',
        'sessions.setModel',
        'sessions.resumeInterrupted',
        'pty.attach',
        'pty.detach',
        'pty.send',
        // Лента вида «Chat» сверяет сессию со снимком работ.
        'feed.snapshot',
        'feed.subscribe',
        'feed.unsubscribe',
        'feed.decide',
        'feed.interrupt',
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
    for (const name of ['rooms.setMode', 'plans.update', 'plans.submit', 'plans.verify', 'plans.cancel', 'plans.retryEffects'] as const)
      expect(handlers.methods[name]).toBeDefined();
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
