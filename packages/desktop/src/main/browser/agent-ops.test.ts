/**
 * Операция `open` агента в main (спека браузера 2026-10-07, 3.7, 5.1–5.2, 7; этап B2): проверки доступа и адреса, просьба окну,
 * перевод его ответа в ответ агенту. Окно подменено: проверяется логика main, а раскладку и тост проверяют тесты рендерера.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentConsoleResult, BrowserAgentOpEvent, BrowserAgentRequestDetail, BrowserAgentScreenshotResult, BrowserAgentOpenResult, BrowserAgentOwner, BrowserAgentResult } from '@parley/protocol';
import type { WebContents } from 'electron';
import { DEVTOOLS_LIMITS, type ConsoleEntry, type DevtoolsSnapshot, type NetworkEntry, type ViewportSpec } from '../../shared/browser-devtools.js';
import type { AgentActivity, AgentOpenTab, AgentOpenTabResult, AgentPageRegistration } from '../../shared/browser-types.js';
import { workKey } from '../../shared/work-keys.js';
import { PANEL_LIMITS } from '../../renderer/layout/tree.js';
import { captureSpec, createAgentOps, loopbackHref, NOT_MOUNTED_NOTE, type AgentOps } from './agent-ops.js';

const REF = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const OTHER_REF = { projectPath: '/proj', workId: 'w-2', sessionId: 's-01' };
const WORK = workKey(REF.projectPath, REF.workId);
const OTHER_WORK = workKey(OTHER_REF.projectPath, OTHER_REF.workId);
const PAGE = 'http://localhost:5173/form';
const OWN = { kind: 'session', sessionId: 's-02' } as const;
const room = (roomId: string): BrowserAgentOwner => ({ kind: 'room', roomId });

/** Гость-страница: URL и заголовок задаются, уничтожение и падение — флаги. */
function fakeGuest(id: number, url = 'http://localhost:5173/settings', title = 'Settings') {
  return { id, getURL: vi.fn(() => url), getTitle: vi.fn(() => title), isDestroyed: vi.fn(() => false), isCrashed: vi.fn(() => false) };
}
type Guest = ReturnType<typeof fakeGuest>;
const EMPTY: DevtoolsSnapshot = { epoch: 1, capture: 'on', console: [], network: [] };

/** PNG-заглушка: подпись и размеры в IHDR (24 байта). */
function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

/** Ответы `inspector.send`: вьюпорт 1280×800, страница 1280×2000, снимок — PNG-заглушка. */
function sendWith(options: { viewport?: { width: number; height: number }; content?: { width: number; height: number }; shot?: Buffer } = {}) {
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const content = options.content ?? { width: 1280, height: 2000 };
  return async (_id: number, method: string): Promise<unknown> => {
    if (method === 'Page.getLayoutMetrics') {
      return {
        cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height, pageX: 0, pageY: 0 },
        cssContentSize: { x: 0, y: 0, width: content.width, height: content.height },
      };
    }
    if (method === 'Page.captureScreenshot') return { data: (options.shot ?? png(viewport.width, viewport.height)).toString('base64') };
    return {};
  };
}

/** Окно отвечает на просьбу своим ответом (если он задан) сразу после неё, как ответил бы рендерер. */
function setup(overrides: { allowed?: boolean; reply?: AgentOpenTabResult | null; sent?: boolean; openMs?: number; owners?: BrowserAgentOwner[] } = {}) {
  const asked: AgentOpenTab[] = [];
  const state = { allowed: overrides.allowed ?? true, reply: overrides.reply === undefined ? { tabId: 'browser:aaaaaa', reused: false, mounted: true } : overrides.reply };
  const openTab = vi.fn((e: AgentOpenTab): boolean => {
    asked.push(e);
    if (overrides.sent === false) return false;
    if (state.reply !== null) {
      const reply = state.reply;
      queueMicrotask(() => ops.openTabResult(e.requestId, reply));
    }
    return true;
  });
  const guests = new Map<number, Guest>([[7, fakeGuest(7)]]);
  const snapshots = new Map<number, DevtoolsSnapshot>();
  const activity: AgentActivity[] = [];
  const inspector = {
    snapshot: vi.fn((id: number): DevtoolsSnapshot | null => snapshots.get(id) ?? EMPTY),
    send: vi.fn(sendWith() as <T>(id: number, method: string, params?: Record<string, unknown>) => Promise<T>),
    responseBody: vi.fn(async (): Promise<{ text: string; base64: boolean; truncated: boolean } | null> => null),
  };
  const emulation = {
    current: vi.fn((): ViewportSpec | null => null),
    withTemporary: vi.fn(async <T>(_id: number, _spec: ViewportSpec, run: () => Promise<T>): Promise<T> => run()),
  };
  const saveImage = vi.fn(async (): Promise<string | null> => '/drops/shot.png');
  const image = {
    size: (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) }),
    resize: (_data: Buffer, width: number, height: number) => png(width, height),
    stitch: (parts: Buffer[]) => png(parts[0] ? parts[0].readUInt32BE(16) : 0, parts.reduce((sum, part) => sum + part.readUInt32BE(20), 0)),
  };
  const deps = {
    agentsAllowed: async () => state.allowed,
    openTab,
    ...(overrides.openMs === undefined ? {} : { openMs: overrides.openMs }),
    fromId: (id) => (guests.get(id) as unknown as WebContents | undefined) ?? null,
    inspector,
    emulation,
    saveImage,
    image,
    activity: (e: AgentActivity) => void activity.push(e),
  };
  const ops: AgentOps = createAgentOps(deps);
  // Хост всегда кладёт в owners саму сессию: для чужого ref (другая работа) — её, а не s-02.
  const run = (args: unknown, ref = REF, op = 'open'): Promise<BrowserAgentResult> =>
    ops.run({ opId: 'op-1', ref, label: ref.sessionId === 's-02' ? 'S02' : 'S01', owners: overrides.owners ?? [{ kind: 'session', sessionId: ref.sessionId }], op: op as BrowserAgentOpEvent['op'], args });
  const runOp = (op: string, args: unknown = {}, ref = REF): Promise<BrowserAgentResult> => run(args, ref, op);
  return { ops, deps, run, runOp, asked, openTab, state, guests, snapshots, activity, inspector, emulation, saveImage };
}

/** Регистрирует страницу панели чата сессии s-02 (гость 7); `patch` меняет поля. */
function register(ops: AgentOps, patch: Partial<Extract<AgentPageRegistration, { pageId: string; visible: boolean }>>): void {
  ops.registerTab({ webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true, ...patch });
}

const codeOf = (result: BrowserAgentResult): string => (result.ok ? 'ok' : result.error.code);
const messageOf = (result: BrowserAgentResult): string => (result.ok ? '' : result.error.message);
function okResult<T = BrowserAgentOpenResult>(result: BrowserAgentResult): T {
  if (!result.ok) throw new Error(`операция отказала: ${result.error.code} ${result.error.message}`);
  return result.result as T;
}

describe('open (спека 5.1 browser_open)', () => {
  it('просьба окну — работа из ref события, адрес, сессия и её номер; ответ агенту — id вкладки t1, адрес, reused и заметки', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', owner: OWN, url: PAGE, reused: false, notes: [] });
    expect(asked).toEqual([{ requestId: expect.any(String) as unknown as string, workKey: WORK, url: PAGE, sessionId: 's-02', session: 'S02', owner: OWN }]);
  });

  it('id вкладок — свой счёт у каждой работы и стабильный: та же вкладка — тот же id, новая — следующий, другая работа — снова t1', async () => {
    const { run, state } = setup();
    expect(okResult(await run({ url: PAGE })).tab).toBe('t1');
    state.reply = { tabId: 'browser:bbbbbb', reused: false, mounted: true };
    expect(okResult(await run({ url: 'http://localhost:5173/other' })).tab).toBe('t2');
    state.reply = { tabId: 'browser:aaaaaa', reused: true, mounted: true };
    expect(okResult(await run({ url: PAGE }))).toMatchObject({ tab: 't1', reused: true });
    state.reply = { tabId: 'browser:cccccc', reused: false, mounted: true };
    expect(okResult(await run({ url: PAGE }, OTHER_REF)).tab).toBe('t1');
  });

  it('работу назвать нельзя: лишнее поле аргументов — bad_request, окну ничего; ключ работы берётся из ref', async () => {
    const { run, asked } = setup();
    expect(codeOf(await run({ url: PAGE, workKey: OTHER_WORK }))).toBe('bad_request');
    expect(codeOf(await run({ url: PAGE, tab: 't1' }))).toBe('bad_request');
    expect(codeOf(await run({}))).toBe('bad_request');
    expect(codeOf(await run({ url: '' }))).toBe('bad_request');
    expect(asked).toEqual([]);
    await run({ url: PAGE }, OTHER_REF);
    expect(asked.map((e) => e.workKey)).toEqual([OTHER_WORK]);
  });

  it('Фокус ревью 2: не loopback и обходные записи — not_loopback, окну ничего', async () => {
    const { run, asked } = setup();
    for (const url of [
      'https://example.com/',
      'http://localhost.evil.test/',
      'http://127.0.0.1.nip.io/',
      'http://0.0.0.0:5173/',
      'http://192.168.1.10:5173/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost@evil.com/',
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,x',
      'localhost:5173',
      '/relative',
      'not a url',
    ]) {
      expect(codeOf(await run({ url })), url).toBe('not_loopback');
    }
    expect(asked).toEqual([]);
  });

  it('адрес уходит окну без учётных данных, с фрагментом (маршрут SPA) и в виде, как его запишет раскладка', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: 'http://user:pw@LOCALHOST:5173/a?b=1#/route' })).url).toBe('http://localhost:5173/a?b=1#/route');
    expect(asked[0]?.url).toBe('http://localhost:5173/a?b=1#/route');
    expect(loopbackHref('http://127.1/')).toBe('http://127.0.0.1/');
    expect(loopbackHref('https://example.com/')).toBeNull();
  });

  it('общий выключатель «Let agents use the browser» — access_denied, окну ничего', async () => {
    const { run, asked } = setup({ allowed: false });
    const result = await run({ url: PAGE });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('Let agents use the browser');
    expect(asked).toEqual([]);
  });

  it('неизвестная операция — unsupported', async () => {
    const { run, asked } = setup();
    expect(codeOf(await run({ code: '1' }, REF, 'evaluate'))).toBe('unsupported');
    expect(asked).toEqual([]);
  });

  it('предел вкладок — bad_request с советом; работы нет в окне — window_not_connected', async () => {
    const limit = setup({ reply: { error: 'limit' } });
    const refused = await limit.run({ url: PAGE });
    expect(codeOf(refused)).toBe('bad_request');
    expect(messageOf(refused)).toContain(`${AGENT_LIMITS.panelPages} pages`);
    const noWork = setup({ reply: { error: 'no_work' } });
    const unknown = await noWork.run({ url: PAGE });
    expect(codeOf(unknown)).toBe('window_not_connected');
    expect(messageOf(unknown)).toContain('try again in a moment');
  });

  it('работа не смонтирована — вкладка добавлена, ответ ok с заметкой, а не отказ', async () => {
    const { run } = setup({ reply: { tabId: 'browser:aaaaaa', reused: false, mounted: false } });
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', owner: OWN, url: PAGE, reused: false, notes: [NOT_MOUNTED_NOTE] });
  });
});

describe('open: выбор хозяина (спека 5.1, 3.10)', () => {
  const ownerAsked = async (owners: BrowserAgentOwner[], args: Record<string, unknown>) => {
    const { run, asked } = setup({ owners });
    const result = await run({ url: PAGE, ...args });
    return { result, owner: asked[0]?.owner, asked };
  };

  it('без own и room: комнат нет — браузер своего чата', async () => {
    const { result, owner } = await ownerAsked([OWN], {});
    expect(owner).toEqual(OWN);
    expect(okResult(result).owner).toEqual(OWN);
  });

  it('без own и room: ровно одна комната — её браузер; две — браузер своего чата', async () => {
    const one = await ownerAsked([OWN, room('r-01')], {});
    expect(one.owner).toEqual(room('r-01'));
    expect(okResult(one.result).owner).toEqual(room('r-01'));
    const two = await ownerAsked([OWN, room('r-01'), room('r-02')], {});
    expect(two.owner).toEqual(OWN);
  });

  it('own: true — браузер чата, даже если сессия в одной комнате', async () => {
    expect((await ownerAsked([OWN, room('r-01')], { own: true })).owner).toEqual(OWN);
  });

  it('own: false ведёт себя как без own', async () => {
    expect((await ownerAsked([OWN, room('r-01')], { own: false })).owner).toEqual(room('r-01'));
  });

  it('room из owners — браузер этой комнаты, даже когда комнат две', async () => {
    const { owner } = await ownerAsked([OWN, room('r-01'), room('r-02')], { room: 'r-02' });
    expect(owner).toEqual(room('r-02'));
  });

  it('room вне owners — access_denied, окну ничего', async () => {
    const { result, asked } = await ownerAsked([OWN, room('r-01')], { room: 'r-09' });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('r-09');
    expect(asked).toEqual([]);
  });

  it('own вместе с room — bad_request, окну ничего', async () => {
    const { result, asked } = await ownerAsked([OWN, room('r-01')], { own: true, room: 'r-01' });
    expect(codeOf(result)).toBe('bad_request');
    expect(asked).toEqual([]);
  });

  it('в owners нет самой сессии — access_denied', async () => {
    const noSelf = await ownerAsked([room('r-01')], {});
    expect(codeOf(noSelf.result)).toBe('access_denied');
    expect(noSelf.asked).toEqual([]);
  });
});

describe('окно ушло или молчит (Фокус ревью, п. 4)', () => {
  it('окна нет (просьба не ушла) и окно закрылось посреди вызова — window_not_connected сразу', async () => {
    const none = setup({ sent: false });
    expect(codeOf(await none.run({ url: PAGE }))).toBe('window_not_connected');
    const ops = createAgentOps({
      ...setup().deps,
      agentsAllowed: async () => true,
      openTab: () => {
        throw new Error('Object has been destroyed');
      },
    });
    const result = await ops.run({ opId: 'op-1', ref: REF, label: 'S02', owners: [OWN], op: 'open', args: { url: PAGE } });
    expect(codeOf(result)).toBe('window_not_connected');
  });

  it('окно молчит — timeout через openMs; поздний ответ ничего не ломает и ничего не принимает', async () => {
    const { run, ops, asked } = setup({ reply: null, openMs: 30 });
    expect(codeOf(await run({ url: PAGE }))).toBe('timeout');
    expect(() => ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:late00', reused: false, mounted: true })).not.toThrow();
    expect(() => ops.openTabResult('never-asked', { error: 'limit' })).not.toThrow();
  });

  it('ответ на чужую просьбу не закрывает другую: каждая ждёт свой requestId', async () => {
    const { run, ops, asked } = setup({ reply: null, openMs: 200 });
    const first = run({ url: PAGE });
    const second = run({ url: 'http://localhost:5173/second' });
    await Promise.resolve();
    expect(asked).toHaveLength(2);
    ops.openTabResult(asked[1]?.requestId ?? '', { tabId: 'browser:bbbbbb', reused: false, mounted: true });
    expect(okResult(await second).url).toBe('http://localhost:5173/second');
    ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:aaaaaa', reused: false, mounted: true });
    expect(okResult(await first).url).toBe(PAGE);
  });
});

type Tabs = { notes: string[]; tabs: Array<{ id: string; owner: unknown; url: string; title: string; viewport: unknown; loaded: boolean; visible: boolean; loopback: boolean }> };
const ROOM = { kind: 'room', roomId: 'r-01' } as const;

describe('реестр страниц панелей и tabs (спека 3.7, 3.10, 5.1)', () => {
  it('своя страница: id t1, хозяин, URL, заголовок, размер, loaded, visible, loopback', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    expect(okResult<Tabs>(await run('tabs', {}))).toEqual({
      notes: [],
      tabs: [{ id: 't1', owner: OWN, url: 'http://localhost:5173/settings', title: 'Settings', viewport: { width: 1280, height: 800, emulated: false }, loaded: true, visible: true, loopback: true }],
    });
  });

  it('хозяева (Фокус ревью, п. 3): страница комнаты сессии видна; чужой чат и комната вне owners — не видны, а по id — access_denied; другая работа — свой счёт id', async () => {
    const { ops, guests, runOp: run } = setup({ owners: [OWN, ROOM] });
    guests.set(8, fakeGuest(8, 'http://localhost:3000/', 'Room page'));
    guests.set(9, fakeGuest(9, 'http://localhost:4000/', 'Other chat'));
    guests.set(10, fakeGuest(10, 'http://localhost:6000/', 'Other room'));
    register(ops, {});
    register(ops, { webContentsId: 8, owner: ROOM, pageId: 'bp-bbbbbb' });
    register(ops, { webContentsId: 9, owner: { kind: 'session', sessionId: 's-09' }, pageId: 'bp-cccccc' });
    register(ops, { webContentsId: 10, owner: { kind: 'room', roomId: 'r-99' }, pageId: 'bp-dddddd' });
    expect(okResult<Tabs>(await run('tabs', {})).tabs.map((tab) => [tab.id, tab.title])).toEqual([['t1', 'Settings'], ['t2', 'Room page']]);
    expect(codeOf(await run('console', { tab: 't3' }))).toBe('access_denied');
    expect(codeOf(await run('console', { tab: 't9' }))).toBe('no_tab');
    ops.registerTab({ webContentsId: 11, workKey: OTHER_WORK, owner: OWN, pageId: 'bp-eeeeee', visible: true });
    expect(okResult<Tabs>(await run('tabs', {}, OTHER_REF)).tabs.map((tab) => tab.id)).toEqual(['t1']);
  });

  it('пауза панели (спека 4.8): страниц нет в tabs, операции — access_denied «paused by the human»; снятие паузы возвращает их', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    ops.registerTab({ workKey: WORK, owner: OWN, paused: true });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toEqual([]);
    const denied = await run('console', { tab: 't1' });
    expect(codeOf(denied)).toBe('access_denied');
    expect(messageOf(denied)).toContain('paused by the human');
    ops.registerTab({ workKey: WORK, owner: OWN, paused: false });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toHaveLength(1);
  });

  it('эмуляция — размер из её спеки; секрет в адресе — с маской; длинный заголовок — 200 символов; чужой сайт — loopback: false', async () => {
    const { ops, emulation, guests, runOp: run } = setup();
    register(ops, {});
    guests.set(7, fakeGuest(7, 'http://localhost:5173/a?token=SECRET1', 'x'.repeat(300)));
    emulation.current.mockReturnValue({ preset: 'mobile-m', rotated: false, dpr: 2 });
    const [tab] = okResult<Tabs>(await run('tabs', {})).tabs;
    expect(tab?.viewport).toEqual({ width: 375, height: 812, emulated: true });
    expect(tab?.url).not.toContain('SECRET1');
    expect(tab?.title).toHaveLength(200);
    guests.set(7, fakeGuest(7, 'https://example.com/', 'External'));
    expect(okResult<Tabs>(await run('tabs', {})).tabs[0]?.loopback).toBe(false);
  });

  it('id общий с open: страница, открытая browser_open (t1), после регистрации остаётся t1; новая — t2', async () => {
    const { ops, runOp: run, state } = setup();
    state.reply = { tabId: 'bp-aaaaaa', reused: false, mounted: true };
    expect(okResult<{ tab: string }>(await run('open', { url: 'http://localhost:5173/settings' })).tab).toBe('t1');
    register(ops, {});
    register(ops, { webContentsId: 8, pageId: 'bp-bbbbbb', visible: false });
    expect(okResult<Tabs>(await run('tabs', {})).tabs.map((tab) => [tab.id, tab.visible])).toEqual([['t1', true], ['t2', false]]);
  });

  it('страница без гостя или с уничтоженным — loaded: false, не видна, размера нет; gone убирает её', async () => {
    const { ops, guests, runOp: run } = setup();
    register(ops, {});
    register(ops, { webContentsId: null, pageId: 'bp-bbbbbb', visible: true });
    guests.get(7)?.isDestroyed.mockReturnValue(true);
    const { tabs } = okResult<Tabs>(await run('tabs', {}));
    expect(tabs.map((tab) => [tab.loaded, tab.visible, tab.viewport])).toEqual([[false, false, null], [false, false, null]]);
    ops.registerTab({ workKey: WORK, pageId: 'bp-bbbbbb', gone: true });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toHaveLength(1);
  });

  it('reset (окно перезагрузилось): реестр и паузы пусты до новой регистрации, id прежние', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    ops.registerTab({ workKey: WORK, owner: OWN, paused: true });
    ops.reset();
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toEqual([]);
    register(ops, {});
    expect(okResult<Tabs>(await run('tabs', {})).tabs[0]?.id).toBe('t1');
  });

  it('работа, о которой окно ничего не сообщало, — пустой список и пояснение; работа известна (страница или пауза), но список пуст — без пояснения', async () => {
    const { ops, runOp: run } = setup();
    const unknown = okResult<Tabs>(await run('tabs', {}));
    expect(unknown.tabs).toEqual([]);
    expect(unknown.notes).toEqual(["Parley's window has not reported any browser pages for this workspace. If the human has not opened this workspace in Parley's window yet, its pages are not known; a page you open with browser_open will appear here."]);
    register(ops, {});
    ops.registerTab({ workKey: WORK, owner: OWN, paused: true });
    expect(okResult<Tabs>(await run('tabs', {}))).toEqual({ tabs: [], notes: [] });
  });

  it('предел страниц: текст отказа browser_open называет число из AGENT_LIMITS.panelPages, а оно равно PANEL_LIMITS.pages окна', async () => {
    expect(AGENT_LIMITS.panelPages).toBe(PANEL_LIMITS.pages);
    const { runOp: run, state } = setup();
    state.reply = { error: 'limit' };
    const refused = await run('open', { url: PAGE });
    expect(codeOf(refused)).toBe('bad_request');
    expect(messageOf(refused)).toContain(`${AGENT_LIMITS.panelPages} pages`);
    expect(messageOf(refused)).not.toContain('10');
  });

  it('общий выключатель — access_denied и у tabs; неверные аргументы — bad_request', async () => {
    const { runOp: run, state } = setup();
    state.allowed = false;
    expect(codeOf(await run('tabs', {}))).toBe('access_denied');
    state.allowed = true;
    expect(codeOf(await run('tabs', { extra: 1 }))).toBe('bad_request');
    expect(codeOf(await run('console', { tab: 'bp-aaaaaa' }))).toBe('bad_request');
  });
});

function consoleEntry(patch: Partial<ConsoleEntry>): ConsoleEntry {
  return { id: 1, epoch: 1, ts: Date.UTC(2026, 9, 7, 10), level: 'error', origin: 'console', text: 'boom', location: null, stack: [], count: 1, ...patch };
}
function networkEntry(patch: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: '100.1', epoch: 1, ts: Date.UTC(2026, 9, 7, 10), method: 'GET', url: 'http://localhost:5173/api', kind: 'fetch', status: 200, statusText: 'OK',
    failure: null, mimeType: 'application/json', encodedBytes: 10, durationMs: 12, fromCache: false, remoteAddress: '127.0.0.1:5173',
    requestHeaders: [], responseHeaders: [], hasPostData: false, postData: null, ...patch,
  };
}

describe('проверки страницы (спека 5.2)', () => {
  it('не loopback — not_loopback; страница упала, гость уничтожен или его нет — tab_not_loaded', async () => {
    const { ops, guests, runOp: run } = setup();
    register(ops, {});
    guests.set(7, fakeGuest(7, 'https://example.com/'));
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('not_loopback');
    guests.set(7, fakeGuest(7));
    guests.get(7)?.isCrashed.mockReturnValue(true);
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('tab_not_loaded');
    guests.get(7)?.isCrashed.mockReturnValue(false);
    guests.get(7)?.isDestroyed.mockReturnValue(true);
    expect(codeOf(await run('network', { tab: 't1' }))).toBe('tab_not_loaded');
    register(ops, { webContentsId: null });
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('tab_not_loaded');
  });
});

describe('console (спека 5.1)', () => {
  const entries: ConsoleEntry[] = [
    consoleEntry({ id: 1, epoch: 0, text: 'old page error' }),
    consoleEntry({ id: 2, text: 'boom' }),
    consoleEntry({ id: 3, level: 'warning', text: 'Careful' }),
    consoleEntry({ id: 4, level: 'info', text: 'hello' }),
    consoleEntry({
      id: 5, origin: 'exception', text: 'Uncaught TypeError: x at http://localhost:5173/a?token=SECRET3', count: 3,
      location: { url: 'http://localhost:5173/src/app.tsx?token=SECRET2', line: 12, column: 5 },
      stack: [{ fn: 'render', url: 'http://localhost:5173/src/app.tsx?token=SECRET2', line: 12, column: 5 }, { fn: '', url: 'http://localhost:5173/main.tsx', line: 1, column: 1 }],
    }),
  ];

  it('по умолчанию — ошибки текущей эпохи; warning — и предупреждения; all — всё; pattern без учёта регистра', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, console: entries });
    const texts = async (args: Record<string, unknown>) => okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', ...args })).entries.map((entry) => entry.level + ':' + entry.origin);
    expect(await texts({})).toEqual(['error:console', 'error:exception']);
    expect(await texts({ level: 'warning' })).toEqual(['error:console', 'warning:console', 'error:exception']);
    expect(await texts({ level: 'all' })).toHaveLength(4);
    expect(await texts({ level: 'all', pattern: 'CAREFUL' })).toEqual(['warning:console']);
  });

  it('limit — новейшие, старые первыми; matched; источник, стек и текст — с маской URL (Фокус ревью, п. 1)', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, console: entries });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', limit: 1 }));
    expect(result).toMatchObject({ tab: 't1', matched: 2 });
    const [entry] = result.entries;
    expect(entry).toMatchObject({ level: 'error', origin: 'exception', count: 3, at: new Date(Date.UTC(2026, 9, 7, 10)).toISOString() });
    expect(entry?.stack[1]).toBe('(anonymous) (http://localhost:5173/main.tsx:1:1)');
    for (const secret of ['SECRET2', 'SECRET3']) expect(JSON.stringify(result), secret).not.toContain(secret);
  });

  it('бюджет 20 КБ: при длинных записях их меньше limit, новейшие сохраняются', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, console: Array.from({ length: 60 }, (_, index) => consoleEntry({ id: index + 10, text: `${index} ${'x'.repeat(1000)}` })) });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', limit: 100 }));
    expect(result.matched).toBe(60);
    expect(Buffer.byteLength(JSON.stringify(result.entries))).toBeLessThanOrEqual(20_480 + 200);
    expect(result.entries.at(-1)?.text.startsWith('59 ')).toBe(true);
  });

  it('захвата нет — unsupported с советом перезагрузить страницу', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, capture: 'unavailable' });
    const result = await run('console', { tab: 't1' });
    expect(codeOf(result)).toBe('unsupported');
    expect(messageOf(result)).toContain('reload');
  });
});

describe('network (спека 5.1, 6)', () => {
  const failing = networkEntry({
    id: '100.1', method: 'POST', url: 'http://localhost:5173/api/settings?token=SECRET123&page=2', status: 500, statusText: 'Internal Server Error',
    requestHeaders: [['Authorization', 'Bearer SECRET-AUTH'], ['Content-Type', 'application/json'], ['Cookie', 'sid=COOKIE1']],
    responseHeaders: [['Content-Type', 'application/json'], ['Set-Cookie', 'sid=COOKIE2']],
    hasPostData: true, postData: JSON.stringify({ user: { name: 'ann', password: 'hunter2' } }),
  });
  const fine = networkEntry({ id: '100.2', url: 'http://localhost:5173/api/ok' });
  const missing = networkEntry({ id: '100.3', url: 'http://localhost:5173/missing.png', kind: 'image', status: 404, mimeType: 'text/html' });
  const cors = networkEntry({ id: '100.4', url: 'http://localhost:9999/api', status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } });
  const old = networkEntry({ id: '99.1', epoch: 0, status: 500 });
  const detailOf = async (run: (op: string, args?: unknown) => Promise<BrowserAgentResult>) => okResult<{ request: BrowserAgentRequestDetail }>(await run('network', { tab: 't1', requestId: '100.1' })).request;

  it('по умолчанию — упавшие текущей эпохи; failedOnly: false — все; urlPattern смотрит на адрес с маской (секрет не подобрать)', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, network: [old, failing, fine, missing, cors] });
    const ids = async (args: Record<string, unknown>) => okResult<{ requests: Array<{ id: string }> }>(await run('network', { tab: 't1', ...args })).requests.map((request) => request.id);
    expect(await ids({})).toEqual(['100.1', '100.3', '100.4']);
    expect(await ids({ failedOnly: false })).toEqual(['100.1', '100.2', '100.3', '100.4']);
    expect(await ids({ failedOnly: false, urlPattern: '/API' })).toEqual(['100.1', '100.2', '100.4']);
    expect(await ids({ urlPattern: 'SECRET123' })).toEqual([]);
  });

  it('секреты упавшего запроса — только <redacted> и в списке, и в деталях (Фокус ревью, п. 1)', async () => {
    const { ops, inspector, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, network: [failing] });
    inspector.responseBody.mockResolvedValue({ text: JSON.stringify({ error: 'db down', session: 'S3SS10N' }), base64: false, truncated: false });
    const list = await run('network', { tab: 't1' });
    const detail = await detailOf(run);
    const all = JSON.stringify([list, detail]);
    for (const secret of ['SECRET123', 'SECRET-AUTH', 'COOKIE1', 'COOKIE2', 'hunter2', 'S3SS10N']) expect(all, secret).not.toContain(secret);
    expect(detail.requestHeaders).toEqual([['Authorization', '<redacted>'], ['Content-Type', 'application/json'], ['Cookie', '<redacted>']]);
    expect(detail.responseHeaders).toEqual([['Content-Type', 'application/json'], ['Set-Cookie', '<redacted>']]);
    expect(JSON.parse(detail.requestBody ?? 'null')).toEqual({ user: { name: 'ann', password: '<redacted>' } });
    expect(JSON.parse(detail.responseBody ?? 'null')).toEqual({ error: 'db down', session: '<redacted>' });
    // Тело берётся целиком, до предела панели: маска разбирает весь JSON, режется уже результат.
    expect(inspector.responseBody).toHaveBeenCalledWith(7, '100.1', DEVTOOLS_LIMITS.panelBody);
  });

  it('JSON, который нельзя разобрать целиком, агенту не отдаётся (Фокус ревью, п. 2)', async () => {
    const { ops, inspector, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, network: [networkEntry({ ...failing, postData: '{"user":{"name":"ann","password":"hunter2"' })] });
    inspector.responseBody.mockResolvedValue({ text: `{"items":[${'1,'.repeat(10)}`, base64: false, truncated: true });
    const detail = await detailOf(run);
    expect(detail.requestBody).toBeNull();
    expect(detail.responseBody).toBeNull();
    expect(detail.notes).toEqual([
      'The request body is JSON that cannot be parsed in full (cut by the capture limit or malformed), so it is not shown: it cannot be masked.',
      'The response body is JSON that cannot be parsed in full (cut by the capture limit or malformed), so it is not shown: it cannot be masked.',
    ]);
    expect(JSON.stringify(detail)).not.toContain('hunter2');
  });

  it('тело формы — с маской полей; длинное текстовое — 8192 символа; бинарное и не снятое — заметки', async () => {
    const { ops, inspector, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, network: [networkEntry({ ...failing, mimeType: 'text/plain', requestHeaders: [['Content-Type', 'application/x-www-form-urlencoded']], postData: 'user=ann&password=hunter2' })] });
    inspector.responseBody.mockResolvedValue({ text: 'x'.repeat(20_000), base64: false, truncated: false });
    let detail = await detailOf(run);
    expect(detail.requestBody).toBe('user=ann&password=<redacted>');
    expect(Array.from(detail.responseBody ?? '').length).toBeLessThanOrEqual(8192 + 32);
    snapshots.set(7, { ...EMPTY, network: [networkEntry({ ...failing, postData: null, hasPostData: true })] });
    inspector.responseBody.mockResolvedValue({ text: 'iVBORw0KGgo=', base64: true, truncated: false });
    detail = await detailOf(run);
    expect([detail.requestBody, detail.responseBody]).toEqual([null, null]);
    expect(detail.notes).toEqual(['The request body was not captured.', 'The response body is binary and is not shown.']);
  });

  it('неизвестный requestId — bad_request', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    expect(codeOf(await run('network', { tab: 't1', requestId: 'nope' }))).toBe('bad_request');
  });
});

describe('captureSpec — размер снимка агента', () => {
  it('совпал с пресетом в любой ориентации — пресет с DPR 1; иначе Custom без мобильного режима', () => {
    expect(captureSpec(375, 812)).toEqual({ preset: 'mobile-m', rotated: false, dpr: 1 });
    expect(captureSpec(812, 375)).toEqual({ preset: 'mobile-m', rotated: true, dpr: 1 });
    expect(captureSpec(1280, 800)).toEqual({ preset: 'laptop', rotated: false, dpr: 1 });
    expect(captureSpec(500, 700)).toEqual({ width: 500, height: 700, mobile: false, dpr: 1 });
  });
});

describe('screenshot (спека 5.1, 8)', () => {
  it('вьюпорт человека: PNG 2560×1600 уменьшен до 1568×980 и сохранён в drops; CSS-размер — из Page.getLayoutMetrics', async () => {
    const { ops, inspector, saveImage, emulation, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ shot: png(2560, 1600) }));
    expect(okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1' }))).toEqual({
      tab: 't1', url: 'http://localhost:5173/settings', path: '/drops/shot.png', width: 1568, height: 980, viewport: { width: 1280, height: 800 }, fullPage: false, emulated: false,
    });
    const saved = saveImage.mock.calls[0]?.[0] as unknown as Buffer;
    expect([saved.readUInt32BE(16), saved.readUInt32BE(20)]).toEqual([1568, 980]);
    expect(emulation.withTemporary).not.toHaveBeenCalled();
    // Без fromSurface: false (спайк 0.2: виснет всегда).
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
  });

  it('375×812: временная эмуляция mobile-m с DPR 1; подпись «Agent capture 375×812» на время снимка', async () => {
    const { ops, inspector, emulation, activity, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ shot: png(375, 812) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', width: 375, height: 812 }));
    expect(emulation.withTemporary).toHaveBeenCalledWith(7, { preset: 'mobile-m', rotated: false, dpr: 1 }, expect.any(Function));
    expect(result).toMatchObject({ width: 375, height: 812, viewport: { width: 375, height: 812 }, emulated: true });
    expect(activity).toEqual([
      { webContentsId: 7, session: 'S02', op: 'screenshot', phase: 'start' },
      { webContentsId: 7, session: 'S02', op: 'screenshot', phase: 'start', capture: { width: 375, height: 812 } },
      { webContentsId: 7, session: 'S02', op: 'screenshot', phase: 'end' },
    ]);
  });

  it('одна сторона — вторая от текущего вьюпорта: width 500 при вьюпорте 1280×800 — Custom 500×800', async () => {
    const { ops, emulation, runOp: run } = setup();
    register(ops, {});
    await run('screenshot', { tab: 't1', width: 500 });
    expect(emulation.withTemporary).toHaveBeenCalledWith(7, { width: 500, height: 800, mobile: false, dpr: 1 }, expect.any(Function));
  });

  it('невидимая страница снимается: activity с capture до снимка (окно переводит поверхность в opacity: 0), эмуляции нет', async () => {
    const { ops, inspector, emulation, activity, runOp: run } = setup();
    register(ops, { visible: false });
    inspector.send.mockImplementation(sendWith({ shot: png(1280, 800) }));
    expect(codeOf(await run('screenshot', { tab: 't1' }))).toBe('ok');
    expect(emulation.withTemporary).not.toHaveBeenCalled();
    expect(activity.map((e) => [e.phase, e.capture])).toEqual([['start', undefined], ['start', { width: 1280, height: 800 }], ['end', undefined]]);
  });

  it('fullPage: страница 2000 при вьюпорте 800 — три полосы 800+800+400, склейка; длиннее трёх вьюпортов — bad_request с советом', async () => {
    const { ops, inspector, saveImage, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ content: { width: 1280, height: 2000 }, shot: png(1280, 800) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', fullPage: true }));
    expect(result).toMatchObject({ fullPage: true, viewport: { width: 1280, height: 2000 } });
    const clips = inspector.send.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot').map(([, , params]) => (params as { clip: { y: number; height: number }; captureBeyondViewport: boolean }));
    expect(clips.map((call) => [call.clip.y, call.clip.height, call.captureBeyondViewport])).toEqual([[0, 800, true], [800, 800, true], [1600, 400, true]]);
    expect(saveImage).toHaveBeenCalledTimes(1);
    inspector.send.mockImplementation(sendWith({ content: { width: 1280, height: 2401 } }));
    const tall = await run('screenshot', { tab: 't1', fullPage: true });
    expect(codeOf(tall)).toBe('bad_request');
    expect(messageOf(tall)).toContain('3 viewport heights');
  });

  it('операции одной страницы — по одной: второй снимок начинается после первого', async () => {
    const { ops, inspector, runOp: run } = setup();
    register(ops, {});
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let shots = 0;
    inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      shots += 1;
      const n = shots;
      order.push(`start ${n}`);
      if (n === 1) await gate;
      order.push(`end ${n}`);
      return { data: png(100, 100).toString('base64') };
    });
    const first = run('screenshot', { tab: 't1' });
    const second = run('screenshot', { tab: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['start 1']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('drops не записался — unsupported', async () => {
    const { ops, saveImage, runOp: run } = setup();
    register(ops, {});
    saveImage.mockResolvedValue(null);
    expect(codeOf(await run('screenshot', { tab: 't1' }))).toBe('unsupported');
  });
});
