/**
 * Основа операций агента (задача 15a): внешние сайты, занятость человека, Stop, пауза панели и общий выключатель посреди
 * операции. Stop идёт через настоящие `registry.pauseFor` и `runner.stopPanel` (так же, как в `createAgentOps`), а не в обход.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAgentOpEvent, BrowserAgentResult } from '@parley/protocol';
import type { WebContents } from 'electron';
import type { DevtoolsSnapshot, ViewportSpec } from '../../shared/browser-devtools.js';
import type { AgentActivity, AgentOpenTab, AgentPageRegistration, AgentResize } from '../../shared/browser-types.js';
import { workKey } from '../../shared/work-keys.js';
import { createPageRegistry } from './agent-pages.js';
import type { InputGuard } from './agent-input.js';
import { AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentDownload, BrowserAgentDownloadsResult, BrowserAgentNavigateResult, BrowserAgentOpenResult, BrowserAgentResizeResult, BrowserAgentScreenshotResult } from '@parley/protocol';
import { createAgentStorage } from './agent-storage.js';
import { createAgentWindow } from './agent-window.js';
import { createTypingClock } from './human-typing.js';
import { agentViewport, createAgentOps, createFocusBorrower, createPageRunner, createWindowHooks, NOT_MOUNTED_NOTE, resolveAgentUrl, routeDownload, AgentOpError, type PageUse } from './agent-ops.js';

const REF = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const WORK = workKey(REF.projectPath, REF.workId);
const OWN = { kind: 'session', sessionId: 's-02' } as const;
const GEN = 'gen-1';

function fakeGuest(id: number, url = 'http://localhost:5173/settings', title = 'Settings') {
  const state = { url, loading: false };
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    id,
    state,
    getURL: vi.fn(() => state.url),
    getTitle: vi.fn(() => title),
    isDestroyed: vi.fn(() => false),
    isCrashed: vi.fn(() => false),
    getZoomFactor: vi.fn(() => 1),
    isLoading: vi.fn(() => state.loading),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, (listeners.get(event) ?? new Set()).add(listener)); }),
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.get(event)?.delete(listener); }),
    emit(event: string, ...args: unknown[]): void { for (const listener of [...(listeners.get(event) ?? [])]) listener(...args); },
    loadURL: vi.fn(async (next: string) => { state.url = next; }),
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
    navigationHistory: { canGoBack: vi.fn(() => true), canGoForward: vi.fn(() => true), goBack: vi.fn(), goForward: vi.fn() },
  };
}
type Guest = ReturnType<typeof fakeGuest>;

const codeOf = (result: BrowserAgentResult): string => (result.ok ? 'ok' : result.error.code);
const messageOf = (result: BrowserAgentResult): string => (result.ok ? '' : result.error.message);
function okResult<T>(result: BrowserAgentResult): T {
  if (!result.ok) throw new Error(`операция отказала: ${result.error.code} ${result.error.message}`);
  return result.result as T;
}

const AX_NODES = [
  { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Settings' }, childIds: ['2'] },
  { nodeId: '2', ignored: false, role: { value: 'button' }, name: { value: 'Save' }, parentId: '1', backendDOMNodeId: 12 },
];

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
function setup(options: { url?: string; requestFocus?: (contents: WebContents, id: string) => boolean; activity?: (e: AgentActivity) => void; uploadHome?: string; page?: boolean; openReply?: { mounted: boolean }; openMs?: number; resizeMs?: number; resizeApplies?: boolean; owners?: BrowserAgentOpEvent['owners']; realStorage?: boolean; typing?: ReturnType<typeof createTypingClock> } = {}) {
  const state = { allowed: true, epoch: 1 };
  const scripts = { evaluateOf: vi.fn<(contents: unknown, id: string, args: unknown, element: number | null, signal: AbortSignal) => Promise<unknown>>(async () => ({ tab: 't1', url: 'http://localhost:5173/settings', type: 'number', value: '1', truncated: false })) };
  const downloads = { list: vi.fn<(workKey: string, sessionId: string) => BrowserAgentDownload[]>(() => []), dirOf: vi.fn((work: string, session: string) => `/downloads/${work}/${session}`) };
  const storage = { cookiesOf: vi.fn(async () => ({})), storageOf: vi.fn(async () => ({})) };
  const guests = new Map<number, Guest>([[7, fakeGuest(7, options.url ?? 'http://localhost:5173/settings')]]);
  const emulationState = new Map<number, ViewportSpec | null>();
  const resize = vi.fn((e: AgentResize): boolean => {
    if (options.resizeApplies !== false) emulationState.set(e.webContentsId, e.viewport);
    return true;
  });
  const asked: AgentOpenTab[] = [];
  const inspector = {
    snapshot: vi.fn((): DevtoolsSnapshot | null => ({ epoch: state.epoch, capture: 'on', console: [], network: [] })),
    send: vi.fn(async (_id?: number, method?: string): Promise<unknown> => (method === 'Accessibility.getFullAXTree' ? { nodes: AX_NODES } : {})),
    responseBody: vi.fn(async () => null),
    onEvent: vi.fn(() => () => undefined),
  };
  const cookieJar = [
    { name: 'sid', value: 'S3SS', domain: 'localhost', path: '/', secure: false, httpOnly: true, sameSite: 'lax', session: true },
    { name: 'theme', value: 'dark', domain: 'localhost', path: '/', secure: false, httpOnly: false, sameSite: 'lax', session: true },
  ];
  const cropRect = vi.fn<(data: Buffer, rect: { x: number; y: number; width: number; height: number }) => Buffer>((data) => data);
  const ctx = { ops: null as unknown as ReturnType<typeof createAgentOps> };
  const ops = createAgentOps({
    agentsAllowed: async () => state.allowed,
    scripts: scripts as never,
    storage: options.realStorage === true ? createAgentStorage({ cookies: { get: async () => cookieJar, set: async () => undefined, remove: async () => undefined } as never, inspector: inspector as never }) : (storage as never),
    downloads,
    openTab: (e: AgentOpenTab) => {
      asked.push(e);
      if (options.openReply === undefined) return false;
      const reply = options.openReply;
      queueMicrotask(() => ctx.ops.openTabResult(e.requestId, { tabId: 'bp-aaaaaa', reused: false, mounted: reply.mounted }));
      return true;
    },
    ...(options.openMs === undefined ? {} : { openMs: options.openMs }),
    ...(options.resizeMs === undefined ? {} : { resizeMs: options.resizeMs }),
    pollMs: 10,
    resize,
    fromId: (id) => (guests.get(id) as unknown as WebContents | undefined) ?? null,
    inspector: inspector as never,
    emulation: { current: (id: number) => emulationState.get(id) ?? null, fitOf: () => null, withTemporary: async (_id: number, _spec: unknown, run: () => Promise<unknown>) => run() } as never,
    saveImage: async () => '/drops/shot.png',
    image: { resize: (data: Buffer) => data, stitch: (parts: Buffer[]) => parts[0] as Buffer, crop: (data: Buffer) => data, cropRect },
    inGuest: async () => undefined,
    activity: options.activity ?? (() => undefined),
    agentWindow: createAgentWindow(),
    typing: options.typing ?? createTypingClock(),
    ...(options.requestFocus === undefined ? {} : { requestFocus: options.requestFocus }),
    ...(options.uploadHome === undefined ? {} : { uploadHome: options.uploadHome }),
  });
  ctx.ops = ops;
  ops.registerTab({ kind: 'hello', generation: GEN });
  const registerPage = (): void => ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true });
  if (options.page !== false) registerPage();
  const run = (op: string, args: unknown = {}): Promise<BrowserAgentResult> => ops.run({ ...request(op), ...(options.owners === undefined ? {} : { owners: options.owners }), args });
  const control = {
    state,
    scripts,
    storage,
    downloads,
    register: (patch: Record<string, unknown> = {}): void => ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true, ...patch } as AgentPageRegistration),
    registerForeign: (patch: Record<string, unknown>): void => ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 8, workKey: WORK, visible: true, ...patch } as AgentPageRegistration),
    pause: (): void => ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true }),
    resume: (): void => ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: false }),
  };
  return Object.defineProperty({ ops, inspector, guests, run, resize, emulationState, asked, cropRect, registerPage, ...control }, 'allowed', { set: (value: boolean) => { state.allowed = value; } });
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
  const typing = { track: vi.fn(), ignore: vi.fn(), lend: vi.fn(() => () => undefined), idleFor: vi.fn(() => true), waitIdle: vi.fn(async () => true) };
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
    borrow: (agentId: string) => borrower.borrow(agentId)(guests.get(7) as unknown as WebContents, { signal: new AbortController().signal, check: () => undefined }),
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

  it('аренда клавиатуры (финальная рецензия B1): второе одалживание ждёт, пока первая операция не отпустит аренду; не дождалось за focusMs — timeout «Another agent is using the keyboard»', async () => {
    const ctx = windowSetup({ focusMs: 60 });
    ctx.requestFocus.mockImplementation((_c, id) => { queueMicrotask(() => ctx.borrower.focusReady(id, true)); return true; });
    const guest = { id: 7 } as unknown as WebContents;
    const releases: Array<() => void> = [];
    const guard = (): InputGuard => ({ signal: new AbortController().signal, check: () => undefined, lendFocus: (release) => { releases.push(release); } });
    await ctx.borrower.borrow('t1')(guest, guard());
    expect(ctx.requestFocus).toHaveBeenCalledTimes(1);
    const second = ctx.borrower.borrow('t2')(guest, guard());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Первая операция держит фокус: вторая окно не просит.
    expect(ctx.requestFocus).toHaveBeenCalledTimes(1);
    releases[0]?.();
    await expect(second).resolves.toBeUndefined();
    expect(ctx.requestFocus).toHaveBeenCalledTimes(2);
    // Вторая держит аренду и не отпускает: третья ждёт focusMs и отказывает, окно не просит.
    await expect(ctx.borrower.borrow('t3')(guest, guard())).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('Another agent is using the keyboard') });
    expect(ctx.requestFocus).toHaveBeenCalledTimes(2);
    // Обрыв в очереди — отказ с причиной обрыва, аренда не взята.
    const stop = new AbortController();
    const stopped = ctx.borrower.borrow('t4')(guest, { signal: stop.signal, check: () => undefined, lendFocus: (release) => { releases.push(release); } });
    stop.abort(new AgentOpError('access_denied', 'Stopped by the human.'));
    await expect(stopped).rejects.toMatchObject({ code: 'access_denied' });
    releases[1]?.();
    await expect(ctx.borrower.borrow('t5')(guest, guard())).resolves.toBeUndefined();
    expect(ctx.requestFocus).toHaveBeenCalledTimes(3);
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

  it('guard.keyboardQuiet: человек печатает — human_busy; потом можно (M3). guard.check на клавиатуру не смотрит: переход, размер и подготовка действия не ждут тишины (рецензия пачки 3)', async () => {
    const ctx = windowSetup();
    let guard: InputGuard | null = null;
    await ctx.runner.run(request(), 't1', async (_c, _r, g) => { guard = g; return 'x'; }, {});
    const g = guard as unknown as Required<InputGuard>;
    ctx.typing.idleFor.mockReturnValue(false);
    expect(() => g.keyboardQuiet()).toThrow(expect.objectContaining({ code: 'human_busy', message: expect.stringContaining('typing') }));
    expect(() => g.check()).not.toThrow();
    ctx.typing.idleFor.mockReturnValue(true);
    expect(() => g.keyboardQuiet()).not.toThrow();
  });

  it('нажатие человека в странице агента: в окне операции до одалживания — проходит; с просьбы о фокусе — погашено, операция оборвана human_busy; после неё — проходит (D1)', async () => {
    const guest = fakeGuest(7);
    const registry = createPageRegistry({ fromId: (id) => (id === 7 ? (guest as unknown as WebContents) : null) });
    registry.register({ kind: 'hello', generation: GEN });
    registry.register({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true });
    const typing = createTypingClock();
    typing.track(guest as unknown as WebContents);
    const inspector = { send: vi.fn(async (): Promise<unknown> => ({})), onEvent: vi.fn(() => () => undefined) };
    const runner = createPageRunner({ registry, agentsAllowed: async () => true, activity: () => undefined, window: createWindowHooks({ agentWindow: createAgentWindow({ tailMs: 20 }), inspector, typing }), typing });
    const borrower: ReturnType<typeof createFocusBorrower> = createFocusBorrower({ typing, requestFocus: (_c, id) => { queueMicrotask(() => borrower.focusReady(id, true)); return true; } });
    const press = (): string => {
      let prevented = false;
      guest.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'z' });
      return prevented ? 'prevented' : 'passed';
    };
    const seen: string[] = [];
    let lent: () => void = () => undefined;
    const borrowed = new Promise<void>((resolve) => { lent = resolve; });
    const op = runner.run(request('action'), 't1', async (contents, _record, guard) => {
      seen.push(press());
      await borrower.borrow('t1')(contents, guard);
      lent();
      // Ввод агента «идёт»: операцию заканчивает только обрыв.
      return new Promise<never>(() => undefined);
    }, { window: true, changes: true });
    await borrowed;
    seen.push(press());
    await expect(op).rejects.toMatchObject({ code: 'human_busy', message: expect.stringContaining('nothing of theirs reached the page') });
    seen.push(press());
    expect(seen).toEqual(['passed', 'prevented', 'passed']);
    // Нажатие отмечено в тишине: следующее одалживание подождёт.
    expect(typing.idleFor(AGENT_LIMITS.typingIdleMs)).toBe(false);
  });

  it('хвост D1 (финальная рецензия m1): операция кончилась, а окно ещё не подтвердило возврат фокуса — нажатие в странице агента гасится без обрыва; после подтверждения или запасного срока — проходит, аренда клавиатуры свободна', async () => {
    const guest = fakeGuest(7);
    const registry = createPageRegistry({ fromId: (id) => (id === 7 ? (guest as unknown as WebContents) : null) });
    registry.register({ kind: 'hello', generation: GEN });
    registry.register({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true });
    const press = (): string => {
      let prevented = false;
      guest.emit('before-input-event', { preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'z' });
      return prevented ? 'prevented' : 'passed';
    };
    const ends: AgentActivity[] = [];
    const setupTail = () => {
      const typing = createTypingClock();
      typing.track(guest as unknown as WebContents);
      const borrower: ReturnType<typeof createFocusBorrower> = createFocusBorrower({ typing, focusReturnMs: 40, requestFocus: (_c, id) => { queueMicrotask(() => borrower.focusReady(id, true)); return true; } });
      const runner = createPageRunner({ registry, agentsAllowed: async () => true, activity: (e) => { if (e.phase === 'end') ends.push(e); }, typing, focusReturned: borrower.focusReturned });
      const typed = (): Promise<string> => runner.run(request('action'), 't1', async (contents, _record, guard) => {
        await borrower.borrow('t1')(contents, guard);
        return 'typed';
      }, { changes: true });
      return { borrower, typed };
    };

    // Окно подтверждает возврат фокуса.
    const confirmed = setupTail();
    await expect(confirmed.typed()).resolves.toBe('typed');
    const id = ends.at(-1)?.focus?.id as string;
    expect(id).toEqual(expect.any(String));
    expect(press()).toBe('prevented');
    confirmed.borrower.focusReady(id, true);
    await vi.waitFor(() => expect(press()).toBe('passed'));

    // Окно молчит: запасной срок.
    const silent = setupTail();
    await expect(silent.typed()).resolves.toBe('typed');
    expect(press()).toBe('prevented');
    await vi.waitFor(() => expect(press()).toBe('passed'));
    // Аренда отпущена вместе с одолжением: следующая операция ввода идёт (тишина — после погашенных нажатий).
    await expect(silent.typed()).resolves.toBe('typed');
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

describe('action через createAgentOps (задача 17)', () => {
  const inputCalls = (ctx: ReturnType<typeof setup>): string[] =>
    ctx.inspector.send.mock.calls.map((call) => (call as unknown as [number, string])[1]).filter((method) => method.startsWith('Input.'));
  const REG = { kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa' } as const;

  it('human_busy: у занятой страницы action отказывает до ввода; чтение — можно', async () => {
    const ctx = setup();
    ctx.ops.registerTab({ ...REG, visible: true, humanBusy: true });
    expect(codeOf(await ctx.run('action', { tab: 't1', action: 'click', x: 5, y: 5 }))).toBe('human_busy');
    expect(inputCalls(ctx)).toEqual([]);
    expect(codeOf(await ctx.run('snapshot', { tab: 't1' }))).toBe('ok');
  });

  it('страница чужого хозяина — no_tab: ни одной команды, upload не доходит до DOM.setFileInputFiles (Фокус ревью 5)', async () => {
    const ctx = setup();
    ctx.ops.registerTab({ ...REG, owner: { kind: 'session', sessionId: 's-99' }, pageId: 'bp-zzzzzz', webContentsId: 8, visible: true });
    for (const args of [{ tab: 't2', action: 'click', x: 5, y: 5 }, { tab: 't2', action: 'upload', ref: 'e1', files: ['/tmp/a.png'] }]) {
      expect(codeOf(await ctx.run('action', args))).toBe('no_tab');
    }
    expect(ctx.inspector.send.mock.calls.some((call) => (call as unknown as [number, string])[1] === 'DOM.setFileInputFiles')).toBe(false);
    expect(inputCalls(ctx)).toEqual([]);
  });

  it('окно не смогло поставить фокус — tab_hidden «could not take keyboard focus», Input.insertText не вызван (Фокус ревью 2)', async () => {
    const holder: { ops: ReturnType<typeof setup>['ops'] | null } = { ops: null };
    const ctx = setup({ requestFocus: (_c, id) => { queueMicrotask(() => holder.ops?.focusReady(id, false)); return true; } });
    holder.ops = ctx.ops;
    const result = await ctx.run('action', { tab: 't1', action: 'type', text: 'Ann' });
    expect(codeOf(result)).toBe('tab_hidden');
    expect(messageOf(result)).toContain('could not take keyboard focus');
    expect(inputCalls(ctx)).toEqual([]);
  });

  it('скрытая страница, которую человек видел, принимает ввод; ни разу не показанная — tab_hidden до requestFocus (решение владельца 8)', async () => {
    const holder: { ops: ReturnType<typeof setup>['ops'] | null } = { ops: null };
    const requestFocus = vi.fn((_c: WebContents, id: string) => { queueMicrotask(() => holder.ops?.focusReady(id, true)); return true; });
    const ctx = setup({ requestFocus });
    holder.ops = ctx.ops;
    ctx.ops.registerTab({ ...REG, visible: false });
    const typed = okResult<{ done: string }>(await ctx.run('action', { tab: 't1', action: 'type', text: 'Ann' }));
    expect(typed.done).toBe('Typed 3 characters.');
    expect(inputCalls(ctx)).toContain('Input.insertText');

    // Вторая страница панели (t2) ни разу не была видна.
    ctx.guests.set(8, fakeGuest(8));
    ctx.ops.registerTab({ ...REG, pageId: 'bp-bbbbbb', webContentsId: 8, visible: false });
    requestFocus.mockClear();
    expect(codeOf(await ctx.run('action', { tab: 't2', action: 'type', text: 'Ann' }))).toBe('tab_hidden');
    expect(requestFocus).not.toHaveBeenCalled();
  });

  it('человек нажал клавишу, пока фокус одолжен агенту, — нажатие погашено, ввод оборван human_busy, Input.insertText не вызван; без вмешательства ввод проходит (D1)', async () => {
    const holder = { ops: null as ReturnType<typeof setup>['ops'] | null, human: false, prevented: 0 };
    const typing = createTypingClock();
    // Окно ставит фокус, и в этот миг человек жмёт клавишу: `before-input-event` гостя агента.
    const requestFocus = (contents: WebContents, id: string): boolean => {
      queueMicrotask(() => {
        if (holder.human) (contents as unknown as Guest).emit('before-input-event', { preventDefault: () => { holder.prevented += 1; } }, { type: 'keyDown', key: 'z' });
        holder.ops?.focusReady(id, true);
      });
      return true;
    };
    const ctx = setup({ typing, requestFocus });
    holder.ops = ctx.ops;
    typing.track(ctx.guests.get(7) as unknown as WebContents);
    ctx.ops.registerTab({ ...REG, visible: true });

    expect(okResult<{ done: string }>(await ctx.run('action', { tab: 't1', action: 'type', text: 'Ann' })).done).toBe('Typed 3 characters.');
    expect(holder.prevented).toBe(0);

    ctx.inspector.send.mockClear();
    holder.human = true;
    const result = await ctx.run('action', { tab: 't1', action: 'type', text: 'Bob' });
    expect(codeOf(result)).toBe('human_busy');
    expect(messageOf(result)).toContain('The human started typing while you held the keyboard; nothing of theirs reached the page.');
    expect(holder.prevented).toBe(1);
    expect(inputCalls(ctx)).toEqual([]);
  });

  it('две операции ввода на разных страницах одновременно (финальная рецензия B1): одалживания не пересекаются, ввод каждой — в свою страницу, фокус человека вернулся в Chat', async () => {
    const holder = { ops: null as ReturnType<typeof setup>['ops'] | null };
    // Модель окна: один фокус ввода на всё окно; у каждого гостя свой лендер, как `createFocusLender`: помнит, чей фокус
    // вернуть, и возвращает его, только если фокус всё ещё на его `<webview>`. События окна идут по порядку отправки.
    const win = { focused: 'chat', previous: new Map<number, string>(), log: [] as string[], misdirected: [] as string[] };
    const requestFocus = (contents: WebContents, id: string): boolean => {
      setTimeout(() => {
        if (!win.previous.has(contents.id)) win.previous.set(contents.id, win.focused);
        win.focused = `guest ${contents.id}`;
        win.log.push(`focus ${contents.id}`);
        holder.ops?.focusReady(id, true);
      }, 1);
      return true;
    };
    const activity = (e: AgentActivity): void => {
      if (e.phase !== 'end') return;
      setTimeout(() => {
        const was = win.previous.get(e.webContentsId);
        win.previous.delete(e.webContentsId);
        if (was !== undefined && win.focused === `guest ${e.webContentsId}`) win.focused = was;
        win.log.push(`end ${e.webContentsId}`);
        if (e.focus !== undefined) holder.ops?.focusReady(e.focus.id, true);
      }, 1);
    };
    const ctx = setup({ requestFocus, activity });
    holder.ops = ctx.ops;
    ctx.guests.set(8, fakeGuest(8));
    ctx.ops.registerTab({ ...REG, visible: true });
    ctx.ops.registerTab({ ...REG, pageId: 'bp-bbbbbb', webContentsId: 8, visible: true });
    ctx.inspector.send.mockImplementation(async (id?: number, method?: string): Promise<unknown> => {
      // CDP-клавиатура и мышь идут в гостя, у которого фокус ввода окна (спайк В1; E2E 22a, тест 3).
      if (method?.startsWith('Input.') === true && win.focused !== `guest ${String(id)}`) win.misdirected.push(`${method} of ${String(id)} went to ${win.focused}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      return {};
    });
    const results = await Promise.all([
      ctx.run('action', { tab: 't1', action: 'type', text: 'Ann', submit: true }),
      ctx.run('action', { tab: 't2', action: 'type', text: 'Bob', submit: true }),
    ]);
    expect(results.map(codeOf)).toEqual(['ok', 'ok']);
    expect(inputCalls(ctx).filter((method) => method === 'Input.insertText')).toHaveLength(2);
    expect(win.misdirected).toEqual([]);
    await vi.waitFor(() => expect(win.log).toHaveLength(4));
    expect([['focus 7', 'end 7', 'focus 8', 'end 8'], ['focus 8', 'end 8', 'focus 7', 'end 7']]).toContainEqual(win.log);
    expect(win.focused).toBe('chat');
  });
});


describe('navigate, resize, open, снимок элемента (задача 18)', () => {
  it('resolveAgentUrl: путь — от адреса страницы; другие схемы — null', () => {
    expect(resolveAgentUrl('/settings?x=1', 'https://app.example.test/a/b')).toBe('https://app.example.test/settings?x=1');
    expect(resolveAgentUrl('https://example.com/', 'http://localhost/')).toBe('https://example.com/');
    for (const raw of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings']) expect(resolveAgentUrl(raw, 'http://localhost/'), raw).toBeNull();
    expect(resolveAgentUrl('/x', 'about:blank')).toBeNull();
  });

  it('agentViewport: пресет с DPR правила меню; свой размер — не мобильный, DPR текущий или 1; fit — null', () => {
    expect(agentViewport({ tab: 't1', preset: 'mobile-m' }, null)).toEqual({ preset: 'mobile-m', rotated: false, dpr: 2 });
    expect(agentViewport({ tab: 't1', preset: 'laptop', rotated: true }, { preset: 'tablet', rotated: false, dpr: 3 })).toEqual({ preset: 'laptop', rotated: true, dpr: 3 });
    expect(agentViewport({ tab: 't1', width: 500, height: 400 }, null)).toEqual({ width: 500, height: 400, mobile: false, dpr: 1 });
    expect(agentViewport({ tab: 't1', width: 500, height: 400 }, { preset: 'mobile-m', rotated: false, dpr: 2 })).toEqual({ width: 500, height: 400, mobile: false, dpr: 2 });
    expect(agentViewport({ tab: 't1', fit: true }, { preset: 'mobile-m', rotated: false, dpr: 2 })).toBeNull();
  });

  it('navigate url: loadURL, ждёт загрузку, ответ — адрес и заголовок с маской; back/forward/reload/hard — методы webContents', async () => {
    const ctx = setup();
    const guest = ctx.guests.get(7) as Guest;
    const result = okResult<BrowserAgentNavigateResult>(await ctx.run('navigate', { tab: 't1', url: 'https://example.test/login?token=SECRET' }));
    expect(guest.loadURL).toHaveBeenCalledWith('https://example.test/login?token=SECRET');
    expect(result).toMatchObject({ tab: 't1', url: 'https://example.test/login?token=<redacted>', loaded: true });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await ctx.run('navigate', { tab: 't1', back: true });
    expect(guest.navigationHistory.goBack).toHaveBeenCalled();
    await ctx.run('navigate', { tab: 't1', forward: true });
    expect(guest.navigationHistory.goForward).toHaveBeenCalled();
    await ctx.run('navigate', { tab: 't1', reload: true });
    expect(guest.reload).toHaveBeenCalled();
    await ctx.run('navigate', { tab: 't1', reload: true, hard: true });
    expect(guest.reloadIgnoringCache).toHaveBeenCalled();
    expect(codeOf(await ctx.run('navigate', { tab: 't1', url: 'file:///etc/hosts' }))).toBe('bad_request');
    expect(guest.loadURL).toHaveBeenCalledTimes(1);
  });

  it('navigate: ERR_ABORTED не ошибка (скачивание); другой отказ загрузки — loaded: false и заметка; назад без истории — заметка', async () => {
    const ctx = setup();
    const guest = ctx.guests.get(7) as Guest;
    guest.loadURL.mockRejectedValueOnce(new Error('ERR_ABORTED (-3) loading "https://example.test/file.zip"'));
    expect(okResult<BrowserAgentNavigateResult>(await ctx.run('navigate', { tab: 't1', url: 'https://example.test/file.zip' }))).toMatchObject({ loaded: true });
    guest.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED (-105) loading "https://nope.test/"'));
    const failed = okResult<BrowserAgentNavigateResult>(await ctx.run('navigate', { tab: 't1', url: 'https://nope.test/' }));
    expect(failed.loaded).toBe(false);
    expect(failed.notes.join(' ')).toContain('ERR_NAME_NOT_RESOLVED');
    guest.navigationHistory.canGoBack.mockReturnValue(false);
    const none = okResult<BrowserAgentNavigateResult>(await ctx.run('navigate', { tab: 't1', back: true }));
    expect(guest.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(none.notes.join(' ')).toContain('no page to go back');
  });

  it('navigate у занятой страницы — human_busy, loadURL не вызван', async () => {
    const ctx = setup();
    ctx.ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true, humanBusy: true });
    expect(codeOf(await ctx.run('navigate', { tab: 't1', url: 'https://example.test/' }))).toBe('human_busy');
    expect((ctx.guests.get(7) as Guest).loadURL).not.toHaveBeenCalled();
  });

  it('resize: событие окну с ViewportSpec пресета (DPR — как правило меню размеров), ждёт emulation.current; fit — null', async () => {
    const ctx = setup();
    const result = okResult<BrowserAgentResizeResult>(await ctx.run('resize', { tab: 't1', preset: 'mobile-m' }));
    expect(ctx.resize).toHaveBeenCalledWith({ webContentsId: 7, viewport: { preset: 'mobile-m', rotated: false, dpr: 2 } });
    expect(result.viewport).toEqual({ width: 375, height: 812, emulated: true });
    const fit = okResult<BrowserAgentResizeResult>(await ctx.run('resize', { tab: 't1', fit: true }));
    expect(ctx.resize).toHaveBeenLastCalledWith({ webContentsId: 7, viewport: null });
    expect(fit.viewport).toBeNull();
  });

  it('resize: окно не поставило размер за resizeMs — timeout; окна нет — window_not_connected', async () => {
    const ctx = setup({ resizeApplies: false, resizeMs: 60 });
    expect(codeOf(await ctx.run('resize', { tab: 't1', preset: 'laptop' }))).toBe('timeout');
    ctx.resize.mockReturnValueOnce(false);
    expect(codeOf(await ctx.run('resize', { tab: 't1', preset: 'laptop' }))).toBe('window_not_connected');
  });

  it('open: после ответа окна ждёт регистрацию страницы и загрузку — loaded и заголовок; не смонтирована — без ожидания, NOT_MOUNTED_NOTE', async () => {
    const ctx = setup({ page: false, openReply: { mounted: true } });
    const guest = ctx.guests.get(7) as Guest;
    guest.state.loading = true;
    setTimeout(() => ctx.registerPage(), 30);
    setTimeout(() => { guest.state.loading = false; guest.emit('did-stop-loading'); }, 80);
    const result = okResult<BrowserAgentOpenResult>(await ctx.run('open', { url: 'https://example.test/' }));
    expect(result).toMatchObject({ tab: 't1', loaded: true, title: 'Settings', notes: [] });

    const unmounted = setup({ page: false, openReply: { mounted: false } });
    const skipped = okResult<BrowserAgentOpenResult>(await unmounted.run('open', { url: 'https://example.test/' }));
    expect(skipped).toMatchObject({ loaded: false, title: '', notes: [NOT_MOUNTED_NOTE] });
  });

  it('open: регистрации нет за openMs — ok с loaded: false и заметкой; Stop во время ожидания загрузки — access_denied (рецензия m9)', async () => {
    const quiet = setup({ page: false, openReply: { mounted: true }, openMs: 60 });
    const pending = okResult<BrowserAgentOpenResult>(await quiet.run('open', { url: 'https://example.test/' }));
    expect(pending).toMatchObject({ loaded: false, title: '' });
    expect(pending.notes.join(' ')).toContain('browser_tabs');

    const ctx = setup({ openReply: { mounted: true } });
    (ctx.guests.get(7) as Guest).state.loading = true;
    const running = ctx.run('open', { url: 'https://example.test/' });
    await vi.waitFor(() => expect((ctx.guests.get(7) as Guest).on).toHaveBeenCalledWith('did-stop-loading', expect.anything()));
    ctx.ops.stop(7);
    expect(codeOf(await running)).toBe('access_denied');
  });

  it('screenshot с ref: прокрутка к элементу, снимок вьюпорта, вырезка рамки × (ширина PNG / CSS-ширина); элемент больше вьюпорта — видимая часть и заметка', async () => {
    const ctx = setup();
    let box = { x: 100, y: 200, width: 300, height: 60 };
    const shot = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(shot);
    shot.writeUInt32BE(2560, 16);
    shot.writeUInt32BE(1600, 20);
    ctx.inspector.send.mockImplementation(async (_id: number, method: string): Promise<unknown> => {
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return { nodes: [
            { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2'], backendDOMNodeId: 1 },
            { nodeId: '2', parentId: '1', ignored: false, role: { value: 'button' }, name: { value: 'Save' }, properties: [{ name: 'focusable', value: { value: true } }], backendDOMNodeId: 12 },
          ] };
        case 'Page.getLayoutMetrics':
          return { layoutViewport: { clientWidth: 2560, clientHeight: 1600 }, cssLayoutViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 0 }, cssContentSize: { x: 0, y: 0, width: 1280, height: 2000 } };
        case 'Page.captureScreenshot':
          return { data: shot.toString('base64') };
        case 'DOM.getBoxModel': {
          const { x, y, width, height } = box;
          return { model: { content: [x, y, x + width, y, x + width, y + height, x, y + height] } };
        }
        default:
          return {};
      }
    });
    okResult(await ctx.run('snapshot', { tab: 't1' }));
    const result = okResult<BrowserAgentScreenshotResult>(await ctx.run('screenshot', { tab: 't1', ref: 'e1' }));
    expect(ctx.inspector.send).toHaveBeenCalledWith(7, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: 12 });
    expect(ctx.cropRect).toHaveBeenCalledWith(expect.anything(), { x: 200, y: 400, width: 600, height: 120 });
    expect(result.notes ?? []).toEqual([]);

    // Элемент шире вьюпорта: берётся видимая часть.
    box = { x: -100, y: 200, width: 1600, height: 60 };
    ctx.cropRect.mockClear();
    const wide = okResult<BrowserAgentScreenshotResult>(await ctx.run('screenshot', { tab: 't1', ref: 'e1' }));
    expect(ctx.cropRect).toHaveBeenCalledWith(expect.anything(), { x: 0, y: 400, width: 2560, height: 120 });
    expect(wide.notes?.join(' ')).toContain('larger than the viewport');

    // Ссылка прежнего документа — stale_ref, снимка нет.
    expect(codeOf(await ctx.run('screenshot', { tab: 't1', ref: 'e99' }))).toBe('stale_ref');
  });
});


describe('evaluate, cookies, storage, downloads (задача 19)', () => {
  it('evaluate на паузе, при выключенном доступе и у занятой страницы — отказ без sendAgentScript', async () => {
    const ctx = setup();
    ctx.register({ humanBusy: true });
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', expression: '1' }))).toBe('human_busy');
    ctx.register({ humanBusy: false });
    ctx.pause();
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', expression: '1' }))).toBe('access_denied');
    ctx.resume();
    ctx.allowed = false;
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', expression: '1' }))).toBe('access_denied');
    expect(ctx.scripts.evaluateOf).not.toHaveBeenCalled();
  });

  it('evaluate с ref — элемент из текущего снимка; устаревшая ссылка — stale_ref', async () => {
    const ctx = setup();
    const snap = okResult<{ text: string }>(await ctx.run('snapshot', { tab: 't1' }));
    const ref = /\[ref=(e\d+)\] button "Save"/.exec(snap.text)?.[1] as string;
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', function: '(el) => el.id', ref }))).toBe('ok');
    expect(ctx.scripts.evaluateOf.mock.calls[0]?.[3]).toBe(12);
    ctx.state.epoch = 2;
    expect(codeOf(await ctx.run('evaluate', { tab: 't1', function: '(el) => el.id', ref }))).toBe('stale_ref');
    expect(ctx.scripts.evaluateOf).toHaveBeenCalledTimes(1);
  });

  it('Stop посреди evaluate — access_denied, результат не отдаётся', async () => {
    const ctx = setup();
    ctx.scripts.evaluateOf.mockImplementation((_c, _id, _args, _el, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const pending = ctx.run('evaluate', { tab: 't1', expression: 'while (true) {}' });
    await vi.waitFor(() => expect(ctx.scripts.evaluateOf).toHaveBeenCalled());
    ctx.ops.stop(7);
    expect(codeOf(await pending)).toBe('access_denied');
  });

  it('cookies и storage — только у своей страницы: чужая — no_tab, cookies.get не вызван', async () => {
    const ctx = setup({ owners: [{ kind: 'session', sessionId: 's-02' }] });
    ctx.registerForeign({ owner: { kind: 'session', sessionId: 's-09' }, pageId: 'bp-foreign' }); // t2 — чат другой сессии
    expect(codeOf(await ctx.run('cookies', { tab: 't2', action: 'list', values: true }))).toBe('no_tab');
    expect(codeOf(await ctx.run('storage', { tab: 't2', area: 'local', action: 'list' }))).toBe('no_tab');
    expect(ctx.storage.cookiesOf).not.toHaveBeenCalled();
    expect(ctx.storage.storageOf).not.toHaveBeenCalled();
  });

  it('downloads: список и папка своей сессии; у другой сессии той же работы — свой', async () => {
    const ctx = setup();
    ctx.downloads.list.mockReturnValue([{ id: 'd1', tab: 't1', name: 'a.csv', path: '/d/a.csv', url: 'http://localhost/a.csv', state: 'completed', receivedBytes: 3, totalBytes: 3, startedAt: '2026-10-20T10:00:00.000Z' }]);
    const result = okResult<BrowserAgentDownloadsResult>(await ctx.run('downloads', {}));
    expect(ctx.downloads.list).toHaveBeenCalledWith('/proj w-1', 's-02');
    expect(result.downloads).toHaveLength(1);
    expect(result.dir).toBe(ctx.downloads.dirOf('/proj w-1', 's-02'));
  });

  it('выключатель посреди evaluate — access_denied, результат не отдаётся (рецензия M4, Фокус ревью 3)', async () => {
    const ctx = setup();
    ctx.scripts.evaluateOf.mockImplementation((_c, _id, _args, _el, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const pending = ctx.run('evaluate', { tab: 't1', expression: 'new Promise(() => {})' });
    await vi.waitFor(() => expect(ctx.scripts.evaluateOf).toHaveBeenCalled());
    ctx.ops.accessChanged(false);
    const result = await pending;
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('Let agents use the browser');
  });

  it('cookies с настоящим createAgentStorage: values: true — значение httpOnly не уходит в ответ (решение владельца 6, Фокус ревью 4)', async () => {
    const ctx = setup({ realStorage: true });
    const text = JSON.stringify(okResult(await ctx.run('cookies', { tab: 't1', action: 'list', values: true })));
    expect(text).toContain('dark');
    expect(text).toContain('<httpOnly: hidden>');
    expect(text).not.toContain('S3SS');
  });
});
