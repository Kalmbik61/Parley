/**
 * Основа операций агента (задача 15a): внешние сайты, занятость человека, Stop, пауза панели и общий выключатель посреди
 * операции. Stop идёт через настоящие `registry.pauseFor` и `runner.stopPanel` (так же, как в `createAgentOps`), а не в обход.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAgentOpEvent, BrowserAgentResult } from '@parley/protocol';
import type { WebContents } from 'electron';
import type { DevtoolsSnapshot } from '../../shared/browser-devtools.js';
import type { AgentPageRegistration } from '../../shared/browser-types.js';
import { workKey } from '../../shared/work-keys.js';
import { createPageRegistry } from './agent-pages.js';
import type { InputGuard } from './agent-input.js';
import { createAgentOps, createPageRunner, AgentOpError, type PageUse } from './agent-ops.js';

const REF = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const WORK = workKey(REF.projectPath, REF.workId);
const OWN = { kind: 'session', sessionId: 's-02' } as const;
const GEN = 'gen-1';

function fakeGuest(id: number, url = 'http://localhost:5173/settings', title = 'Settings') {
  return { id, getURL: vi.fn(() => url), getTitle: vi.fn(() => title), isDestroyed: vi.fn(() => false), isCrashed: vi.fn(() => false) };
}
type Guest = ReturnType<typeof fakeGuest>;

const codeOf = (result: BrowserAgentResult): string => (result.ok ? 'ok' : result.error.code);
const messageOf = (result: BrowserAgentResult): string => (result.ok ? '' : result.error.message);
function okResult<T>(result: BrowserAgentResult): T {
  if (!result.ok) throw new Error(`операция отказала: ${result.error.code} ${result.error.message}`);
  return result.result as T;
}

const request = (op = 'console'): BrowserAgentOpEvent => ({ opId: 'op-1', ref: REF, label: 'S02', owners: [OWN], op: op as BrowserAgentOpEvent['op'], args: {} });

/** Снимок журнала: одна запись консоли и один упавший запрос. */
function devtoolsWith(options: { consoleText: string; requestUrl: string }): DevtoolsSnapshot {
  return {
    epoch: 1,
    capture: 'on',
    console: [{ id: 1, origin: 'console', level: 'error', text: options.consoleText, count: 1, ts: 1, stack: [] } as unknown as DevtoolsSnapshot['console'][number]],
    network: [
      { id: '1.1', epoch: 1, ts: 1, method: 'GET', url: options.requestUrl, kind: 'fetch', status: 500, statusText: 'Error', mimeType: 'application/json', requestHeaders: {}, responseHeaders: {} } as unknown as DevtoolsSnapshot['network'][number],
    ],
  };
}

/** Полный `createAgentOps` с внешней страницей. */
function setup(options: { url?: string } = {}) {
  const guests = new Map<number, Guest>([[7, fakeGuest(7, options.url ?? 'http://localhost:5173/settings')]]);
  const inspector = {
    snapshot: vi.fn((): DevtoolsSnapshot | null => ({ epoch: 1, capture: 'on', console: [], network: [] })),
    send: vi.fn(async (): Promise<unknown> => ({})),
    responseBody: vi.fn(async () => null),
  };
  const ops = createAgentOps({
    agentsAllowed: async () => true,
    openTab: () => false,
    fromId: (id) => (guests.get(id) as unknown as WebContents | undefined) ?? null,
    inspector: inspector as never,
    emulation: { current: () => null, withTemporary: async (_id: number, _spec: unknown, run: () => Promise<unknown>) => run() } as never,
    saveImage: async () => '/drops/shot.png',
    image: { resize: (data: Buffer) => data, stitch: (parts: Buffer[]) => parts[0] as Buffer, crop: (data: Buffer) => data },
    inGuest: async () => undefined,
    activity: () => undefined,
  });
  ops.registerTab({ kind: 'hello', generation: GEN });
  ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true });
  const run = (op: string, args: unknown = {}): Promise<BrowserAgentResult> => ops.run({ ...request(op), args });
  return { ops, inspector, guests, run };
}

/** Только `createPageRunner` со своим реестром; страницы `t1` (гость 7) и, по просьбе, `t2` (гость 8). */
function pageSetup(options: { pages?: string[] } = {}) {
  const pageIds = ['bp-aaaaaa', 'bp-bbbbbb'];
  const guests = new Map<number, Guest>([[7, fakeGuest(7)], [8, fakeGuest(8)]]);
  const registry = createPageRegistry({ fromId: (id) => (guests.get(id) as unknown as WebContents | undefined) ?? null });
  const ctx = {
    ran: 0,
    allowed: true,
    lastGuard: null as InputGuard | null,
    release: (): void => undefined,
    gate: null as Promise<void> | null,
    registry,
    runner: null as unknown as ReturnType<typeof createPageRunner>,
    ops: {
      stop(webContentsId: number): void {
        const record = registry.pauseFor(webContentsId);
        if (record !== null) ctx.runner.stopPanel(record.workKey, record.owner, new AgentOpError('access_denied', 'Stopped by the human: agents are paused in this browser panel (paused by the human).'));
      },
    },
    register(patch: Record<string, unknown> = {}, index = 0): void {
      registry.register({ kind: 'page', generation: GEN, webContentsId: 7 + index, workKey: WORK, owner: OWN, pageId: pageIds[index] as string, visible: true, ...patch } as AgentPageRegistration);
      // Запись паузы панели идёт мимо `createAgentOps.registerTab`: обрыв операций повторяем так же, как он.
      if (patch.kind === 'paused' && patch.paused === true) ctx.runner.stopPanel(WORK, OWN, new AgentOpError('access_denied', 'The human paused agents in this browser panel (paused by the human).'));
    },
    page(agentId: string, use: PageUse & { hold?: boolean }): Promise<unknown> {
      const { hold, ...pageUse } = use;
      return ctx.runner.run(request(), agentId, async (_contents, _record, guard) => {
        ctx.ran += 1;
        ctx.lastGuard = guard;
        if (hold === true) {
          ctx.gate = new Promise<void>((resolve) => { ctx.release = resolve; });
          await ctx.gate;
        }
        return 'done';
      }, pageUse);
    },
  };
  ctx.runner = createPageRunner({ registry, agentsAllowed: async () => ctx.allowed, activity: () => undefined });
  registry.register({ kind: 'hello', generation: GEN });
  const count = options.pages?.length ?? 1;
  // Страницу человек пока не видел (seen = false): тесты показывают её сами.
  for (let index = 0; index < count; index += 1) ctx.register({ visible: false }, index);
  return ctx;
}

describe('любые сайты (решение владельца 2026-10-20; Фокус ревью 6)', () => {
  it('внешняя страница: console и network читаются, URL и тексты — с маской', async () => {
    const ctx = setup({ url: 'https://example.test/reset?token=SECRET1' });
    ctx.inspector.snapshot.mockReturnValue(devtoolsWith({ consoleText: 'login failed for Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', requestUrl: 'https://api.example.test/me?access_token=SECRET2' }));
    const text = JSON.stringify([okResult(await ctx.run('console', { tab: 't1' })), okResult(await ctx.run('network', { tab: 't1', failedOnly: false }))]);
    for (const secret of ['SECRET1', 'SECRET2', 'eyJ']) expect(text, secret).not.toContain(secret);
    expect(text).toContain('<redacted>');
  });
});

describe('занятость, Stop, пауза и выключатель (Фокус ревью 3, 8)', () => {
  it('human_busy: операция с changes у страницы с Select/Annotate — отказ до task; чтение — можно', async () => {
    const ctx = pageSetup();
    ctx.register({ humanBusy: true });
    await expect(ctx.page('t1', {})).resolves.toBeDefined();
    await expect(ctx.page('t1', { changes: true })).rejects.toMatchObject({ code: 'human_busy' });
    expect(ctx.ran).toBe(1);
  });

  it('Stop: пауза в реестре сразу; идущие операции всех страниц панели — access_denied; следующая — access_denied', async () => {
    const ctx = pageSetup({ pages: ['t1', 't2'] });
    const first = ctx.page('t1', { changes: true, hold: true });
    const second = ctx.page('t2', { hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(2));
    ctx.ops.stop(7);
    await expect(first).rejects.toMatchObject({ code: 'access_denied', message: expect.stringContaining('paused by the human') });
    await expect(second).rejects.toMatchObject({ code: 'access_denied' });
    await expect(ctx.page('t1', {})).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('«Pause agents» (запись paused: true) посреди операции — обрыв, как у Stop', async () => {
    const ctx = pageSetup();
    const pending = ctx.page('t1', { hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(1));
    ctx.register({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    await expect(pending).rejects.toMatchObject({ code: 'access_denied', message: expect.stringContaining('paused by the human') });
  });

  it('выключатель: accessChanged(false) обрывает идущие операции и синхронно закрывает guard.check; true — снова можно', async () => {
    const ctx = pageSetup();
    const pending = ctx.page('t1', { hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(1));
    ctx.runner.accessChanged(false);
    await expect(pending).rejects.toMatchObject({ code: 'access_denied', message: expect.stringContaining('Let agents use the browser') });
    expect(() => ctx.lastGuard!.check()).toThrow(expect.objectContaining({ code: 'access_denied' }));
    ctx.runner.accessChanged(true);
    ctx.allowed = true;
    await expect(ctx.page('t1', {})).resolves.toBeDefined();
  });

  it('страница, которую человек ни разу не видел, — tab_hidden для seen-операций (этап 0, 0.2)', async () => {
    const ctx = pageSetup();
    ctx.register({ visible: false });
    await expect(ctx.page('t1', { seen: true })).rejects.toMatchObject({ code: 'tab_hidden' });
    ctx.register({ visible: true });
    ctx.register({ visible: false });
    await expect(ctx.page('t1', { seen: true })).resolves.toBeDefined();
  });

  it('createAgentOps: Stop и accessChanged — настоящие методы, не заглушки', async () => {
    const ctx = setup();
    expect(messageOf(await ctx.run('console', { tab: 't1' }))).toBe('');
    ctx.ops.stop(7);
    const result = await ctx.run('console', { tab: 't1' });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('paused by the human');
  });
});
