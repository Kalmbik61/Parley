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
import { AGENT_LIMITS } from '@parley/protocol';
import { createAgentWindow } from './agent-window.js';
import { createTypingClock } from './human-typing.js';
import { createAgentOps, createFocusBorrower, createPageRunner, createWindowHooks, routeDownload, AgentOpError, type PageUse } from './agent-ops.js';

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
    agentWindow: createAgentWindow(),
    typing: createTypingClock(),
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


/** Окно операции: настоящий `createPageRunner` с крючками 15b, журнал CDP-событий — вручную. */
function windowSetup(options: { tailMs?: number; focusMs?: number } = {}) {
  const guests = new Map<number, Guest>([[7, fakeGuest(7)]]);
  const registry = createPageRegistry({ fromId: (id) => (guests.get(id) as unknown as WebContents | undefined) ?? null });
  const listeners = new Map<string, Array<(params: unknown) => void>>();
  const inspector = {
    send: vi.fn(async (): Promise<unknown> => ({})),
    onEvent: vi.fn((id: number, method: string, listener: (params: unknown) => void) => {
      const key = `${id}:${method}`;
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
      return () => { listeners.set(key, (listeners.get(key) ?? []).filter((item) => item !== listener)); };
    }),
  };
  const agentWindow = createAgentWindow({ tailMs: options.tailMs ?? 2_000 });
  const typing = { track: vi.fn(), ignore: vi.fn(), idleFor: vi.fn(() => true), waitIdle: vi.fn(async () => true) };
  const requestFocus = vi.fn<(contents: WebContents, id: string) => boolean>(() => true);
  const hooks = createWindowHooks({ agentWindow, inspector, typing });
  const runner = createPageRunner({ registry, agentsAllowed: async () => true, activity: () => undefined, window: hooks, typing });
  const borrower = createFocusBorrower({ typing, requestFocus, ...(options.focusMs === undefined ? {} : { focusMs: options.focusMs }) });
  const ctx = {
    inspector, agentWindow, typing, requestFocus, borrower, runner,
    pageKey: `${WORK}\nbp-aaaaaa`,
    ran: 0,
    release: (): void => undefined,
    register(patch: Record<string, unknown> = {}): void {
      registry.register({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true, ...patch } as AgentPageRegistration);
    },
    emitCdp(id: number, method: string, params: unknown): void {
      for (const listener of listeners.get(`${id}:${method}`) ?? []) listener(params);
    },
    pageOp(agentId: string, use: PageUse & { hold?: boolean }): Promise<unknown> {
      const { hold, ...pageUse } = use;
      return runner.run(request(), agentId, async () => {
        ctx.ran += 1;
        if (hold === true) await new Promise<void>((resolve) => { ctx.release = resolve; });
        return 'done';
      }, pageUse);
    },
    borrow: (agentId: string) => borrower.borrow(agentId)(guests.get(7) as unknown as WebContents, new AbortController().signal),
  };
  registry.register({ kind: 'hello', generation: GEN });
  ctx.register();
  return ctx;
}

const downloadItem = (name: string) => ({ getFilename: () => name }) as unknown as import('electron').DownloadItem;

describe('окно операции, выбор файла, скачивания, фокус (15b)', () => {
  it('операция с window: окно операции и перехват выбора файла; после хвоста перехват снят', async () => {
    const ctx = windowSetup({ tailMs: 20 });
    const done = ctx.pageOp('t1', { window: true, hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(1));
    expect(ctx.inspector.send).toHaveBeenCalledWith(7, 'Page.setInterceptFileChooserDialog', { enabled: true });
    expect(ctx.agentWindow.activeFor(7)).toMatchObject({ sessionId: 's-02', agentId: 't1' });
    expect(ctx.typing.ignore).toHaveBeenCalledWith(7, true);
    ctx.release();
    await done;
    expect(ctx.typing.ignore).toHaveBeenLastCalledWith(7, false);
    await vi.waitFor(() => expect(ctx.inspector.send).toHaveBeenCalledWith(7, 'Page.setInterceptFileChooserDialog', { enabled: false }));
    expect(ctx.agentWindow.activeFor(7)).toBeNull();
  });

  it('вторая операция внутри хвоста перехват не включает заново и не снимает', async () => {
    const ctx = windowSetup({ tailMs: 20 });
    await ctx.pageOp('t1', { window: true });
    await ctx.pageOp('t1', { window: true });
    const enables = ctx.inspector.send.mock.calls.filter((call) => (call as unknown[])[2] !== undefined && ((call as unknown[])[2] as { enabled: boolean }).enabled);
    expect(enables).toHaveLength(1);
    await vi.waitFor(() => expect(ctx.inspector.send).toHaveBeenCalledWith(7, 'Page.setInterceptFileChooserDialog', { enabled: false }));
  });

  it('операция без window: окна операции и перехвата нет', async () => {
    const ctx = windowSetup();
    await ctx.pageOp('t1', {});
    expect(ctx.inspector.send).not.toHaveBeenCalled();
    expect(ctx.agentWindow.activeFor(7)).toBeNull();
  });

  it('Page.fileChooserOpened в окне — заметка «use upload»; системного окна нет (Фокус ревью 5)', async () => {
    const ctx = windowSetup();
    const done = ctx.pageOp('t1', { window: true, hold: true });
    await vi.waitFor(() => expect(ctx.ran).toBe(1));
    ctx.emitCdp(7, 'Page.fileChooserOpened', { frameId: 'F', mode: 'selectSingle', backendNodeId: 31 });
    ctx.release();
    await done;
    expect(ctx.agentWindow.take(ctx.pageKey)).toEqual(['The page opened a file chooser; nothing was shown to the human. Take a browser_snapshot and use browser_action with action upload on the file input.']);
  });

  it('routeDownload: в окне агента — claim и заметка, true; вне окна — false, claim не вызван (Фокус ревью 7)', () => {
    const agentWindow = createAgentWindow({ tailMs: 2_000 });
    const claim = vi.fn(() => ({ id: 'd1', name: 'report.csv', path: '/d/report.csv' }) as never);
    const deps = { agentWindow, downloads: { claim } };
    const owner = { pageKey: `${WORK}\nbp-bbbbbb`, webContentsId: 7, workKey: WORK, sessionId: 's-02', agentId: 't2' };
    expect(routeDownload(downloadItem('report.csv'), { id: 7 }, deps)).toBe(false);
    expect(claim).not.toHaveBeenCalled();
    agentWindow.begin(owner);
    expect(routeDownload(downloadItem('report.csv'), { id: 7 }, deps)).toBe(true);
    // Рецензия пачки 2: в claim уходит страница-источник (t2), а не null.
    expect(claim).toHaveBeenCalledWith(expect.anything(), { workKey: WORK, sessionId: 's-02', agentId: 't2', tab: 't2' });
    expect(agentWindow.take(owner.pageKey)).toEqual(['The page started a download: report.csv → /d/report.csv (see browser_downloads).']);
    // Другой гость вне окна — диалог человека.
    expect(routeDownload(downloadItem('x.bin'), { id: 9 }, deps)).toBe(false);
  });

  it('borrowFocus: ждёт тишину, просит окно, ok — дальше; ok: false — tab_hidden; человек печатает дольше focusMs — human_busy (Фокус ревью 1, 2)', async () => {
    const ctx = windowSetup({ focusMs: 50 });
    ctx.requestFocus.mockImplementation((_c, id) => { queueMicrotask(() => ctx.borrower.focusReady(id, true)); return true; });
    await expect(ctx.borrow('t1')).resolves.toBeUndefined();
    expect(ctx.typing.waitIdle).toHaveBeenCalledWith(AGENT_LIMITS.typingIdleMs, 50, expect.anything());
    ctx.requestFocus.mockImplementation((_c, id) => { queueMicrotask(() => ctx.borrower.focusReady(id, false)); return true; });
    await expect(ctx.borrow('t1')).rejects.toMatchObject({ code: 'tab_hidden', message: expect.stringContaining('Page t1 could not take keyboard focus') });
    ctx.requestFocus.mockClear();
    ctx.typing.waitIdle.mockImplementation(async () => false);
    await expect(ctx.borrow('t1')).rejects.toMatchObject({ code: 'human_busy', message: expect.stringContaining('typing') });
    expect(ctx.requestFocus).not.toHaveBeenCalled();
  });

  it('borrowFocus: окно не отвечает за focusMs — tab_hidden; окна нет (requestFocus → false) — window_not_connected', async () => {
    const ctx = windowSetup({ focusMs: 30 });
    ctx.requestFocus.mockImplementation(() => true);
    await expect(ctx.borrow('t1')).rejects.toMatchObject({ code: 'tab_hidden' });
    ctx.requestFocus.mockImplementation(() => false);
    await expect(ctx.borrow('t1')).rejects.toMatchObject({ code: 'window_not_connected' });
  });

  it('скрытая страница, которую человек видел (visible: false после true), — borrowFocus просит окно, как у видимой; ok: true — ввод идёт (решение владельца 8)', async () => {
    const ctx = windowSetup({ focusMs: 50 });
    ctx.register({ visible: true });
    ctx.register({ visible: false });
    ctx.requestFocus.mockImplementation((_c, id) => { queueMicrotask(() => ctx.borrower.focusReady(id, true)); return true; });
    await expect(ctx.pageOp('t1', { seen: true })).resolves.toBeDefined();
    await expect(ctx.borrow('t1')).resolves.toBeUndefined();
    expect(ctx.requestFocus).toHaveBeenCalledTimes(1);
  });

  it('guard.check: человек печатает — human_busy; потом можно (M3)', async () => {
    const ctx = windowSetup();
    let guard: InputGuard | null = null;
    await ctx.runner.run(request(), 't1', async (_c, _r, g) => { guard = g; return 'x'; }, {});
    ctx.typing.idleFor.mockReturnValue(false);
    expect(() => (guard as unknown as InputGuard).check()).toThrow(expect.objectContaining({ code: 'human_busy', message: expect.stringContaining('typing') }));
    ctx.typing.idleFor.mockReturnValue(true);
    expect(() => (guard as unknown as InputGuard).check()).not.toThrow();
  });
});

describe('snapshot и wait_for через createAgentOps (задача 16)', () => {
  it('snapshot у страницы, которую человек сейчас не видит, и wait_for у занятой страницы — ok (спайк 0.2; чтения при human_busy)', async () => {
    const ctx = setup();
    ctx.ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: false, humanBusy: true });
    expect(codeOf(await ctx.run('snapshot', { tab: 't1' }))).toBe('ok');
    expect(codeOf(await ctx.run('wait_for', { tab: 't1', ms: 5 }))).toBe('ok');
  });

  it('Stop и «Pause agents» посреди wait_for — access_denied сразу, а не через 10 с; очередь свободна (Фокус ревью 8)', async () => {
    const ctx = setup();
    const started = Date.now();
    const pending = ctx.run('wait_for', { tab: 't1', text: 'Never' });
    await vi.waitFor(() => expect(ctx.inspector.send).toHaveBeenCalled());
    ctx.ops.stop(7);
    const stopped = await pending;
    expect(codeOf(stopped)).toBe('access_denied');
    expect(Date.now() - started).toBeLessThan(AGENT_LIMITS.waitMs / 2);
    // Пауза снята окном: следующая операция стартует, очередь не застряла.
    ctx.ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: false });
    expect(codeOf(await ctx.run('snapshot', { tab: 't1' }))).toBe('ok');

    const second = ctx.run('wait_for', { tab: 't1', text: 'Never' });
    await vi.waitFor(() => expect(ctx.inspector.send.mock.calls.length).toBeGreaterThan(4));
    ctx.ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    expect(codeOf(await second)).toBe('access_denied');
  });
});
