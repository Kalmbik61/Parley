import { describe, expect, it, vi } from 'vitest';
import type { RequestInfo } from '../context.js';
import type { AssistantService } from '../assistant/assistant-service.js';
import type { ConsentsService } from '../consents/consents-service.js';
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

it('assistant.* регистрируются, только если сервис помощника передан', () => {
  const { deps } = fakeDeps(Promise.resolve());
  const assistant = {} as unknown as AssistantService;
  expect(createHostHandlers({ ...deps, assistant }).methods['assistant.ask']).toBeTypeOf('function');
  expect(createHostHandlers(deps).methods['assistant.ask']).toBeUndefined();
});

it('registers the window-only project memory and history search methods', () => {
  const { deps } = fakeDeps(Promise.resolve());
  const handlers = createHostHandlers(deps);
  for (const name of ['memory.get', 'memory.add', 'memory.update', 'memory.accept', 'memory.dismiss', 'memory.undo', 'history.search'] as const)
    expect(handlers.methods[name]).toBeTypeOf('function');
});

it('registers sessions.rename, which reads and writes the map on disk and does not wait for the works snapshot', () => {
  const { deps } = fakeDeps(Promise.resolve());
  expect(createHostHandlers(deps).methods['sessions.rename']).toBeTypeOf('function');
  expect(WORKS_GATED_METHODS as readonly string[]).not.toContain('sessions.rename');
});

it('registers rooms.archive and rooms.reopen, which read the live processes and the map on disk and do not wait for the works snapshot', () => {
  const { deps } = fakeDeps(Promise.resolve());
  const { methods } = createHostHandlers(deps);
  for (const name of ['rooms.archive', 'rooms.reopen'] as const) {
    expect(methods[name]).toBeTypeOf('function');
    expect(WORKS_GATED_METHODS as readonly string[]).not.toContain(name);
  }
});

it('методы диагностики есть только при health и profiler', () => {
  const names = ['host.diagnostics', 'host.profile.start', 'host.profile.status'] as const;
  const { deps } = fakeDeps(Promise.resolve());
  const without = createHostHandlers(deps).methods;
  for (const name of names) expect(without).not.toHaveProperty(name);

  const withBoth = createHostHandlers({
    ...deps,
    health: { sample: () => ({}) },
    profiler: { status: () => ({ state: 'idle' }), files: async () => [], start: () => ({ state: 'idle' }), stop: async () => {} },
  } as never).methods;
  for (const name of names) expect(withBoth[name]).toBeTypeOf('function');
});

it('consents.* и trust.* регистрируются, только если сервис согласий передан, и снимка работ не ждут', () => {
  const names = ['consents.list', 'consents.decide', 'trust.list', 'trust.grant', 'trust.revoke'] as const;
  const { deps } = fakeDeps(Promise.resolve());
  for (const name of names) expect(createHostHandlers(deps).methods).not.toHaveProperty(name);

  const { methods } = createHostHandlers({ ...deps, consents: {} as unknown as ConsentsService });
  for (const name of names) {
    expect(methods[name]).toBeTypeOf('function');
    expect(WORKS_GATED_METHODS as readonly string[]).not.toContain(name);
  }
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
        'sessions.compact',
        'sessions.cancelCompact',
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

it('browser.agentResult: ответ окна уходит приёмнику агента вместе с клиентом-отправителем (спека браузера 3.7; этап B2)', async () => {
  const { deps } = fakeDeps(Promise.resolve());
  const resolve = vi.fn(() => true);
  const handlers = createHostHandlers({ ...deps, browserAgent: { resolve } });
  const client = { id: 'c-1' };
  const handler = handlers.methods['browser.agentResult'] as unknown as (params: unknown, request: unknown) => Promise<unknown>;
  const opened = { tab: 't1', url: 'http://localhost:5173/', reused: false, notes: [] };
  await expect(handler({ opId: 'op-1', ok: true, result: opened }, { client })).resolves.toEqual({ accepted: true });
  expect(resolve).toHaveBeenLastCalledWith('op-1', { ok: true, result: opened }, client);
  resolve.mockReturnValueOnce(false);
  await expect(handler({ opId: 'op-2', ok: false, error: { code: 'not_loopback', message: 'x' } }, { client })).resolves.toEqual({ accepted: false });
  expect(resolve).toHaveBeenLastCalledWith('op-2', { ok: false, error: { code: 'not_loopback', message: 'x' } }, client);
});

it('browser.agentResult: неизвестный код окна — агенту unsupported с текстом окна, не timeout', async () => {
  const { deps } = fakeDeps(Promise.resolve());
  const resolve = vi.fn(() => true);
  const handlers = createHostHandlers({ ...deps, browserAgent: { resolve } });
  const client = { id: 'c-1' };
  const handler = handlers.methods['browser.agentResult'] as unknown as (params: unknown, request: unknown) => Promise<unknown>;
  await handler({ opId: 'op-1', ok: false, error: { code: 'tab_crashed', message: 'The tab crashed.' } }, { client });
  expect(resolve).toHaveBeenLastCalledWith('op-1', { ok: false, error: { code: 'unsupported', message: 'The tab crashed.' } }, client);
});

it('browser.agentResult: сообщение 5000 знаков — агенту 2000', async () => {
  const { deps } = fakeDeps(Promise.resolve());
  const resolve = vi.fn(() => true);
  const handlers = createHostHandlers({ ...deps, browserAgent: { resolve } });
  const client = { id: 'c-1' };
  const handler = handlers.methods['browser.agentResult'] as unknown as (params: unknown, request: unknown) => Promise<unknown>;
  await handler({ opId: 'op-1', ok: false, error: { code: 'timeout', message: 'x'.repeat(5000) } }, { client });
  expect(resolve).toHaveBeenLastCalledWith('op-1', { ok: false, error: { code: 'timeout', message: 'x'.repeat(2000) } }, client);
});

it('без приёмника агента метода browser.agentResult нет', () => {
  const { deps } = fakeDeps(Promise.resolve());
  expect(createHostHandlers(deps).methods['browser.agentResult']).toBeUndefined();
});
