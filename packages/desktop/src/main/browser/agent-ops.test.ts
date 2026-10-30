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
import { pngSize } from './png.js';
import { createEmulation } from './emulation.js';
import { createPageRegistry } from './agent-pages.js';
import { createAgentWindow } from './agent-window.js';
import { createTypingClock } from './human-typing.js';
import { captureSpec, createAgentOps, NOT_MOUNTED_NOTE, openableHref, type AgentOps } from './agent-ops.js';

const REF = { projectPath: '/proj', workId: 'w-1', sessionId: 's-02' };
const OTHER_REF = { projectPath: '/proj', workId: 'w-2', sessionId: 's-01' };
const WORK = workKey(REF.projectPath, REF.workId);
const OTHER_WORK = workKey(OTHER_REF.projectPath, OTHER_REF.workId);
const PAGE = 'http://localhost:5173/form';
const OWN = { kind: 'session', sessionId: 's-02' } as const;
const room = (roomId: string): BrowserAgentOwner => ({ kind: 'room', roomId });

/** Гость-страница: URL и заголовок задаются, уничтожение и падение — флаги. */
function fakeGuest(id: number, url = 'http://localhost:5173/settings', title = 'Settings') {
  return { id, getURL: vi.fn(() => url), getTitle: vi.fn(() => title), isDestroyed: vi.fn(() => false), isCrashed: vi.fn(() => false), isLoading: vi.fn(() => false), on: vi.fn(), off: vi.fn() };
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
function sendWith(options: { viewport?: { width: number; height: number }; content?: { width: number; height: number }; shot?: Buffer; dpr?: number } = {}) {
  const viewport = options.viewport ?? { width: 1280, height: 800 };
  const content = options.content ?? { width: 1280, height: 2000 };
  return async (_id: number, method: string): Promise<unknown> => {
    if (method === 'Page.getLayoutMetrics') {
      return {
        // layoutViewport — в пикселях устройства (CDP): при DPR 2 вдвое шире CSS-вьюпорта.
        layoutViewport: { clientWidth: viewport.width * (options.dpr ?? 1), clientHeight: viewport.height * (options.dpr ?? 1) },
        cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height, pageX: 0, pageY: 0 },
        cssContentSize: { x: 0, y: 0, width: content.width, height: content.height },
      };
    }
    if (method === 'Page.captureScreenshot') return { data: (options.shot ?? png(viewport.width, viewport.height)).toString('base64') };
    return {};
  };
}

/** Окно отвечает на просьбу своим ответом (если он задан) сразу после неё, как ответил бы рендерер. */
function setup(overrides: { allowed?: boolean; reply?: AgentOpenTabResult | null; sent?: boolean; openMs?: number; owners?: BrowserAgentOwner[]; confirmSurface?: boolean; captureReadyMs?: number; windowHeight?: number; screenDpr?: number; screenDprHangs?: boolean; screenDprRejects?: boolean; guestCallMs?: number; opTimeoutMs?: number } = {}) {
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
  /** Мир гостя: ответ по умолчанию — «выражение ничего не вернуло» (заглушка); тесты fullPage подставляют свой. */
  const inGuest = vi.fn<(contents: WebContents, code: string) => Promise<unknown>>(async () => undefined);
  const image = {
    resize: vi.fn((_data: Buffer, width: number, height: number) => png(width, height)),
    stitch: (parts: Buffer[]) => png(parts[0] ? parts[0].readUInt32BE(16) : 0, parts.reduce((sum, part) => sum + part.readUInt32BE(20), 0)),
    crop: (data: Buffer, _top: number, height: number) => png(data.readUInt32BE(16), height),
    cropRect: (data: Buffer) => data,
  };
  const deps = {
    scripts: { evaluateOf: vi.fn() },
    storage: { cookiesOf: vi.fn(), storageOf: vi.fn() },
    downloads: { list: vi.fn(() => []), dirOf: vi.fn(() => '/downloads') },
    agentsAllowed: async () => state.allowed,
    openTab,
    // Страница после ответа окна в этих тестах чаще не регистрируется: ожидание регистрации короткое.
    openMs: overrides.openMs ?? 50,
    resize: () => false,
    fromId: (id) => (guests.get(id) as unknown as WebContents | undefined) ?? null,
    inspector,
    emulation,
    saveImage,
    image,
    inGuest,
    agentWindow: createAgentWindow(),
    typing: createTypingClock(),
    // Окно подтверждает поверхность снимка сразу после просьбы, как это делает рендерер (если тест не отключил подтверждение).
    activity: (e: AgentActivity) => {
      activity.push(e);
      const surface = e.capture;
      if (surface !== undefined && overrides.confirmSurface !== false) queueMicrotask(() => ops.captureReady(surface.id));
    },
    ...(overrides.captureReadyMs === undefined ? {} : { captureReadyMs: overrides.captureReadyMs }),
    ...(overrides.opTimeoutMs === undefined ? {} : { opTimeoutMs: overrides.opTimeoutMs }),
    ...(overrides.windowHeight === undefined ? {} : { windowHeight: () => overrides.windowHeight as number }),
    ...(overrides.screenDpr === undefined ? {} : { screenDpr: async () => overrides.screenDpr as number }),
    ...(overrides.screenDprHangs === true ? { screenDpr: () => new Promise<number | null>(() => undefined) } : {}),
    ...(overrides.screenDprRejects === true ? { screenDpr: () => Promise.reject(new Error('Script failed to execute')) } : {}),
    ...(overrides.guestCallMs === undefined ? {} : { guestCallMs: overrides.guestCallMs }),
  };
  const ops: AgentOps = createAgentOps(deps);
  // Окно всегда начинает с `hello`: записи до него реестр пропускает.
  ops.registerTab({ kind: 'hello', generation: GEN });
  // Хост всегда кладёт в owners саму сессию: для чужого ref (другая работа) — её, а не s-02.
  const run = (args: unknown, ref = REF, op = 'open'): Promise<BrowserAgentResult> =>
    ops.run({ opId: 'op-1', ref, label: ref.sessionId === 's-02' ? 'S02' : 'S01', owners: overrides.owners ?? [{ kind: 'session', sessionId: ref.sessionId }], op: op as BrowserAgentOpEvent['op'], args });
  const runOp = (op: string, args: unknown = {}, ref = REF): Promise<BrowserAgentResult> => run(args, ref, op);
  return { ops, deps, run, runOp, asked, openTab, state, guests, snapshots, activity, inspector, emulation, saveImage, inGuest, image };
}

/** Поколение документа окна в тестах реестра. */
const GEN = 'gen-1';

/** Регистрирует страницу панели чата сессии s-02 (гость 7); `patch` меняет поля. */
function register(ops: AgentOps, patch: Partial<Extract<AgentPageRegistration, { kind: 'page' }>>): void {
  ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true, ...patch });
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
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', owner: OWN, url: PAGE, reused: false, loaded: false, title: '', notes: [expect.stringContaining('browser_tabs')] });
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

  it('Фокус ревью 2: не http(s) и обходные записи — bad_request, окну ничего', async () => {
    const { run, asked } = setup();
    for (const url of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://example.com/',
      'chrome://settings',
      'localhost:5173',
      '/relative',
      'not a url',
    ]) {
      const result = await run({ url });
      expect(codeOf(result), url).toBe('bad_request');
      expect(messageOf(result), url).toContain('http(s)');
    }
    expect(asked).toEqual([]);
  });

  it('внешний http(s) открывается: окну уходит адрес без учётных данных, ответ — вкладка t1 (открывать, читать и действовать можно на любом сайте)', async () => {
    const { run, asked } = setup();
    for (const [url, href] of [
      ['https://example.test/', 'https://example.test/'],
      ['http://localhost.evil.test/', 'http://localhost.evil.test/'],
      ['http://127.0.0.1.nip.io/', 'http://127.0.0.1.nip.io/'],
      ['http://0.0.0.0:5173/', 'http://0.0.0.0:5173/'],
      ['http://192.168.1.10:5173/', 'http://192.168.1.10:5173/'],
      ['http://localhost@evil.com/', 'http://evil.com/'],
      ['https://user:pw@example.test/a?b=1#/route', 'https://example.test/a?b=1#/route'],
    ] as const) {
      asked.length = 0;
      expect(okResult(await run({ url })), url).toMatchObject({ tab: 't1', owner: OWN, url: href, reused: false });
      expect(asked.map((e) => e.url), url).toEqual([href]);
    }
  });

  it('внешний адрес не обходит отказы: выключатель, пауза панели, чужая комната и own вместе с room — прежние коды, окну ничего', async () => {
    const off = setup({ allowed: false });
    expect(codeOf(await off.run({ url: 'https://example.test/' }))).toBe('access_denied');
    expect(off.asked).toEqual([]);

    const { ops, run, asked } = setup({ owners: [OWN, ROOM] });
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    const paused = await run({ url: 'https://example.test/', own: true });
    expect(codeOf(paused)).toBe('access_denied');
    expect(messageOf(paused)).toContain('paused by the human');
    expect(codeOf(await run({ url: 'https://example.test/', room: 'r-99' }))).toBe('access_denied');
    expect(codeOf(await run({ url: 'https://example.test/', room: 'r-01', own: true }))).toBe('bad_request');
    expect(asked).toEqual([]);
  });

  it('адрес уходит окну без учётных данных, с фрагментом (маршрут SPA) и в виде, как его запишет раскладка', async () => {
    const { run, asked } = setup();
    expect(okResult(await run({ url: 'http://user:pw@LOCALHOST:5173/a?b=1#/route' })).url).toBe('http://localhost:5173/a?b=1#/route');
    expect(asked[0]?.url).toBe('http://localhost:5173/a?b=1#/route');
    expect(openableHref('http://127.1/')).toBe('http://127.0.0.1/');
    expect(openableHref('https://example.com/')).toBe('https://example.com/');
    expect(openableHref('file:///etc/hosts')).toBeNull();
    expect(openableHref('javascript:alert(1)')).toBeNull();
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
    expect(codeOf(await run({ code: '1' }, REF, 'teleport'))).toBe('unsupported');
    expect(asked).toEqual([]);
  });

  it('сообщение отказа не длиннее 2000 знаков', async () => {
    const { run } = setup();
    expect(messageOf(await run({ code: '1' }, REF, 'x'.repeat(5000)))).toHaveLength(2000);
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
    expect(okResult(await run({ url: PAGE }))).toEqual({ tab: 't1', owner: OWN, url: PAGE, reused: false, loaded: false, title: '', notes: [NOT_MOUNTED_NOTE] });
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


describe('open: пауза панели хозяина (S5)', () => {
  it('панель хозяина на паузе: browser_open — access_denied «paused by the human», окну ничего (asked пуст)', async () => {
    const { ops, run, asked } = setup({ owners: [OWN, ROOM] });
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: ROOM, paused: true });
    for (const args of [{ url: PAGE, own: true }, { url: PAGE, room: 'r-01' }, { url: PAGE }]) {
      const result = await run(args);
      expect(codeOf(result)).toBe('access_denied');
      expect(messageOf(result)).toContain('paused by the human');
    }
    expect(asked).toEqual([]);
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: false });
    expect(codeOf(await run({ url: PAGE, own: true }))).toBe('ok');
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
    // Ответ на вторую просьбу первую не закрыл: она ещё ждёт и принимает свой ответ (после ответа `open` ждёт страницу до openMs).
    await Promise.resolve();
    ops.openTabResult(asked[0]?.requestId ?? '', { tabId: 'browser:aaaaaa', reused: false, mounted: true });
    expect(okResult(await second).url).toBe('http://localhost:5173/second');
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

  it('хозяева (Фокус ревью, п. 3): страница комнаты сессии видна; чужой чат и комната вне owners — не видны, а по id — no_tab; другая работа — свой счёт id', async () => {
    const { ops, guests, runOp: run } = setup({ owners: [OWN, ROOM] });
    guests.set(8, fakeGuest(8, 'http://localhost:3000/', 'Room page'));
    guests.set(9, fakeGuest(9, 'http://localhost:4000/', 'Other chat'));
    guests.set(10, fakeGuest(10, 'http://localhost:6000/', 'Other room'));
    register(ops, {});
    register(ops, { webContentsId: 8, owner: ROOM, pageId: 'bp-bbbbbb' });
    register(ops, { webContentsId: 9, owner: { kind: 'session', sessionId: 's-09' }, pageId: 'bp-cccccc' });
    register(ops, { webContentsId: 10, owner: { kind: 'room', roomId: 'r-99' }, pageId: 'bp-dddddd' });
    expect(okResult<Tabs>(await run('tabs', {})).tabs.map((tab) => [tab.id, tab.title])).toEqual([['t1', 'Settings'], ['t2', 'Room page']]);
    // Чужая страница по id неотличима от несуществующей (S11).
    expect(codeOf(await run('console', { tab: 't3' }))).toBe('no_tab');
    expect(codeOf(await run('console', { tab: 't9' }))).toBe('no_tab');
    ops.registerTab({ kind: 'page', generation: GEN, webContentsId: 11, workKey: OTHER_WORK, owner: OWN, pageId: 'bp-eeeeee', visible: true });
    expect(okResult<Tabs>(await run('tabs', {}, OTHER_REF)).tabs.map((tab) => tab.id)).toEqual(['t1']);
  });

  it('пауза панели (спека 4.8): страниц нет в tabs, операции — access_denied «paused by the human»; снятие паузы возвращает их', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toEqual([]);
    const denied = await run('console', { tab: 't1' });
    expect(codeOf(denied)).toBe('access_denied');
    expect(messageOf(denied)).toContain('paused by the human');
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: false });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toHaveLength(1);
  });

  it('пауза своей панели по id — по-прежнему access_denied «paused by the human»', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    const denied = await run('screenshot', { tab: 't1' });
    expect(codeOf(denied)).toBe('access_denied');
    expect(messageOf(denied)).toContain('paused by the human');
  });

  it('эмуляция — размер из её спеки; секрет в адресе — с маской; длинный заголовок — 200 символов', async () => {
    const { ops, emulation, guests, runOp: run } = setup();
    register(ops, {});
    guests.set(7, fakeGuest(7, 'http://localhost:5173/a?token=SECRET1', 'x'.repeat(300)));
    emulation.current.mockReturnValue({ preset: 'mobile-m', rotated: false, dpr: 2 });
    const [tab] = okResult<Tabs>(await run('tabs', {})).tabs;
    expect(tab?.viewport).toEqual({ width: 375, height: 812, emulated: true });
    expect(tab?.url).not.toContain('SECRET1');
    expect(tab?.title).toHaveLength(200);
  });

  it('внешняя страница: tabs показывает полный адрес с маской, заголовок и размер (любые сайты)', async () => {
    const { ops, guests, inspector, emulation, runOp: run } = setup();
    register(ops, {});
    guests.set(7, fakeGuest(7, 'https://example.com/private/path?token=SECRET1#frag', 'Private title for example'));
    emulation.current.mockReturnValue({ preset: 'mobile-m', rotated: false, dpr: 2 });
    const [tab] = okResult<Tabs>(await run('tabs', {})).tabs;
    expect(tab).toMatchObject({ url: 'https://example.com/private/path?token=<redacted>#frag', title: 'Private title for example', viewport: { width: 375, height: 812, emulated: true }, loopback: false, loaded: true });
    expect(inspector.send).not.toHaveBeenCalled();
    guests.set(7, fakeGuest(7, 'about:blank', 'Blank'));
    expect(okResult<Tabs>(await run('tabs', {})).tabs[0]).toMatchObject({ url: 'about:blank', title: 'Blank', loopback: false });
  });

  it('три гостя с зависшим getLayoutMetrics: tabs отвечает меньше чем за 2 с, у них viewport null', async () => {
    const { ops, guests, inspector, runOp: run } = setup();
    guests.set(8, fakeGuest(8));
    guests.set(9, fakeGuest(9));
    register(ops, {});
    register(ops, { webContentsId: 8, pageId: 'bp-bbbbbb' });
    register(ops, { webContentsId: 9, pageId: 'bp-cccccc' });
    inspector.send.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const { tabs } = okResult<Tabs>(await run('tabs', {}));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(tabs.map((tab) => tab.viewport)).toEqual([null, null, null]);
  });

  it('заголовок страницы с секретом вида значения — с маской', async () => {
    const { ops, guests, runOp: run } = setup();
    register(ops, {});
    guests.set(7, fakeGuest(7, 'http://localhost:5173/a', 'Reset password=hunter2 for http://localhost:5173/r?token=SECRET9'));
    const [tab] = okResult<Tabs>(await run('tabs', {})).tabs;
    expect(tab?.title).toBe('Reset password=<redacted> for http://localhost:5173/r?token=<redacted>');
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
    ops.registerTab({ kind: 'gone', generation: GEN, workKey: WORK, pageId: 'bp-bbbbbb' });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toHaveLength(1);
  });

  it('hello сбрасывает реестр; запись старого поколения пропущена; id прежние', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    ops.registerTab({ kind: 'hello', generation: 'gen-2' });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toEqual([]);
    // Запоздавшая запись прежнего документа окна: ни страница, ни пауза не появляются.
    register(ops, {});
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    expect(okResult<Tabs>(await run('tabs', {})).tabs).toEqual([]);
    ops.registerTab({ kind: 'page', generation: 'gen-2', webContentsId: 7, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true });
    expect(okResult<Tabs>(await run('tabs', {})).tabs[0]?.id).toBe('t1');
  });

  it('pageId с другим owner и webContentsId у второй страницы не перепривязываются; до hello записи пропущены', async () => {
    const { ops, runOp: run, guests } = setup({ owners: [OWN, ROOM] });
    guests.set(8, fakeGuest(8));
    register(ops, {});
    // Тот же pageId, другой хозяин: запись пропущена.
    register(ops, { owner: ROOM, webContentsId: 8 });
    // Гость 7 уже у bp-aaaaaa: вторая страница его не получает.
    register(ops, { pageId: 'bp-bbbbbb' });
    // Новая страница с новым гостем принимается.
    register(ops, { pageId: 'bp-cccccc', webContentsId: 8 });
    const tabs = okResult<Tabs>(await run('tabs', {})).tabs;
    expect(tabs.map((tab) => [tab.id, tab.owner])).toEqual([['t1', OWN], ['t2', OWN]]);
    // Реестр без hello записей не принимает.
    const raw = createPageRegistry({ fromId: () => null });
    raw.register({ kind: 'page', generation: GEN, webContentsId: null, workKey: WORK, owner: OWN, pageId: 'bp-aaaaaa', visible: true });
    expect(raw.listed({ ref: REF, owners: [OWN] } as BrowserAgentOpEvent).records).toEqual([]);
  });

  it('работа, о которой окно ничего не сообщало, — пустой список и пояснение; работа известна (страница или пауза), но список пуст — без пояснения', async () => {
    const { ops, runOp: run } = setup();
    const unknown = okResult<Tabs>(await run('tabs', {}));
    expect(unknown.tabs).toEqual([]);
    expect(unknown.notes).toEqual(["Parley's window has not reported any browser pages for this workspace. If the human has not opened this workspace in Parley's window yet, its pages are not known; a page you open with browser_open will appear here."]);
    register(ops, {});
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
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

describe('close (browser_close)', () => {
  /** Страница t1 зарегистрирована (гость 7); окно отвечает на просьбу закрыть своим ответом. */
  async function ready(reply: AgentOpenTabResult | null) {
    const kit = setup();
    kit.state.reply = { tabId: 'bp-aaaaaa', reused: false, mounted: true };
    await kit.runOp('open', { url: 'http://localhost:5173/' });
    register(kit.ops, {});
    kit.guests.set(7, fakeGuest(7, 'https://example.test/a?sid=SECRET9'));
    kit.asked.length = 0;
    kit.state.reply = reply;
    return kit;
  }

  it('закрывает страницу агента: окну уходит closePage с id страницы раскладки; ответ — адрес с маской', async () => {
    const { runOp, asked } = await ready({ closed: true });
    const result = okResult<{ tab: string; url: string; done: string }>(await runOp('close', { tab: 't1' }));
    expect(result).toEqual({ tab: 't1', url: 'https://example.test/a?sid=<redacted>', done: 'Closed t1.' });
    expect(asked).toEqual([{ requestId: expect.any(String) as unknown as string, workKey: WORK, url: '', sessionId: 's-02', session: 'S02', owner: OWN, closePage: 'bp-aaaaaa' }]);
  });

  it('страница человека (окно: not_agent) — access_denied с понятным текстом', async () => {
    const { runOp } = await ready({ error: 'not_agent' });
    const result = await runOp('close', { tab: 't1' });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('opened by the human');
  });

  it('страницы уже нет в раскладке — no_tab; нет такой t9 — no_tab, окну ничего', async () => {
    const { runOp, asked } = await ready({ error: 'no_page' });
    expect(codeOf(await runOp('close', { tab: 't1' }))).toBe('no_tab');
    asked.length = 0;
    expect(codeOf(await runOp('close', { tab: 't9' }))).toBe('no_tab');
    expect(asked).toEqual([]);
  });

  it('человек занят Select/Annotate — human_busy, окну ничего; пауза панели — access_denied', async () => {
    const { ops, runOp, asked } = await ready({ closed: true });
    register(ops, { humanBusy: true });
    expect(codeOf(await runOp('close', { tab: 't1' }))).toBe('human_busy');
    register(ops, { humanBusy: false });
    ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true });
    expect(codeOf(await runOp('close', { tab: 't1' }))).toBe('access_denied');
    expect(asked).toEqual([]);
  });

  it('окна нет или молчит; лишние поля и нет tab — bad_request', async () => {
    const quiet = await ready(null);
    expect(codeOf(await quiet.runOp('close', { tab: 't1' }))).toBe('timeout');
    const bad = await ready({ closed: true });
    expect(codeOf(await bad.runOp('close', {}))).toBe('bad_request');
    expect(codeOf(await bad.runOp('close', { tab: 't1', force: true }))).toBe('bad_request');
  });

  it('предел страниц у open называет browser_close', async () => {
    const { runOp, state } = setup();
    state.reply = { error: 'limit' };
    expect(messageOf(await runOp('open', { url: PAGE }))).toContain('Close one of your pages with browser_close');
  });
});

describe('проверки страницы (спека 5.2)', () => {
  it('внешняя страница читается; страница упала, гость уничтожен или его нет — tab_not_loaded', async () => {
    const { ops, guests, runOp: run } = setup();
    register(ops, {});
    guests.set(7, fakeGuest(7, 'https://example.com/'));
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('ok');
    guests.set(7, fakeGuest(7));
    guests.get(7)?.isCrashed.mockReturnValue(true);
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('tab_not_loaded');
    guests.get(7)?.isCrashed.mockReturnValue(false);
    guests.get(7)?.isDestroyed.mockReturnValue(true);
    expect(codeOf(await run('network', { tab: 't1' }))).toBe('tab_not_loaded');
    register(ops, { webContentsId: null });
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('tab_not_loaded');
  });

  it('внешняя страница из browser_open: console, network и screenshot читаются; tabs показывает адрес с маской', async () => {
    const { ops, guests, saveImage, runOp: run, state } = setup();
    state.reply = { tabId: 'bp-aaaaaa', reused: false, mounted: true };
    expect(okResult<{ tab: string }>(await run('open', { url: 'https://example.test/' })).tab).toBe('t1');
    guests.set(7, fakeGuest(7, 'https://example.test/'));
    register(ops, {});
    for (const [op, args] of [['console', { tab: 't1' }], ['network', { tab: 't1' }], ['screenshot', { tab: 't1' }]] as const) {
      expect(codeOf(await run(op, args)), op).toBe('ok');
    }
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(okResult<Tabs>(await run('tabs', {})).tabs[0]).toMatchObject({ id: 't1', url: 'https://example.test/', title: 'Settings', loopback: false });
  });

  it('страница ушла redirect на внешний адрес: вкладка в списке с адресом без секрета, чтение работает', async () => {
    const { ops, guests, runOp: run, state } = setup();
    state.reply = { tabId: 'bp-aaaaaa', reused: false, mounted: true };
    expect(okResult<{ tab: string }>(await run('open', { url: 'http://localhost:5173/login' })).tab).toBe('t1');
    register(ops, {});
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('ok');
    guests.set(7, fakeGuest(7, 'https://accounts.example.test/signin?sid=SECRET9', 'Sign in'));
    expect(codeOf(await run('console', { tab: 't1' }))).toBe('ok');
    const [tab] = okResult<Tabs>(await run('tabs', {})).tabs;
    expect(tab).toMatchObject({ id: 't1', url: 'https://accounts.example.test/signin?sid=<redacted>', title: 'Sign in', loopback: false, loaded: true });
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

  it('pattern смотрит на текст с маской: секрет из адреса не подобрать, matched его не выдаёт', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, console: entries });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', pattern: 'SECRET3' }));
    expect(result.entries).toEqual([]);
    expect(result.matched).toBe(0);
  });

  it('бюджет 20 КБ: при длинных записях их меньше limit, новейшие сохраняются', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    // Тексты различаются буквами, а не числами: числа свёртка похожих склеила бы в одну запись.
    const word = (index: number): string => String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
    snapshots.set(7, { ...EMPTY, console: Array.from({ length: 60 }, (_, index) => consoleEntry({ id: index + 10, text: `${word(index)} ${'x'.repeat(1000)}` })) });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', limit: 100 }));
    expect(result.matched).toBe(60);
    expect(Buffer.byteLength(JSON.stringify(result.entries))).toBeLessThanOrEqual(20_480 + 1200);
    expect(result.entries.at(-1)?.text.startsWith(`${word(59)} `)).toBe(true);
  });

  it('ошибка с 20 кадрами (15 из node_modules) и 25-строчным текстом — 5 своих кадров, текст 1024 с «…»', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    const own = (index: number) => ({ fn: `own${index}`, url: `http://localhost:5173/src/f${index}.tsx`, line: index + 1, column: 1 });
    const vendor = (index: number) => ({ fn: `lib${index}`, url: `http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=${index}`, line: index + 1, column: 1 });
    // Свои и вендорские вперемешку: 5 своих кадров из 20 — первые пять своих по порядку.
    const stack = Array.from({ length: 20 }, (_, index) => (index % 4 === 0 ? own(index) : vendor(index)));
    const text = Array.from({ length: 25 }, (_, index) => `    at Component (http://localhost:5173/src/components/Feature/Component.tsx:${10 + index}:5)`).join('\n');
    snapshots.set(7, { ...EMPTY, console: [consoleEntry({ id: 40, text, stack })] });
    const [entry] = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' })).entries;
    expect(entry?.stack).toEqual([0, 4, 8, 12, 16].map((index) => `own${index} (http://localhost:5173/src/f${index}.tsx:${index + 1}:1)`));
    expect(Array.from(entry?.text ?? '')).toHaveLength(1025);
    expect(entry?.text.endsWith('…')).toBe(true);
    expect(entry?.id).toBe(40);
  });

  it('стек только из вендорских кадров — первый кадр; кадров своих больше пяти — пять', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    const vendor = (index: number) => ({ fn: `lib${index}`, url: index % 2 === 0 ? 'node:internal/process' : 'webpack-internal:///./node_modules/x.js', line: 1, column: 1 });
    const own = (index: number) => ({ fn: `own${index}`, url: `http://localhost:5173/src/f${index}.tsx`, line: 1, column: 1 });
    snapshots.set(7, {
      ...EMPTY,
      console: [
        consoleEntry({ id: 1, text: 'only vendor', stack: [vendor(0), vendor(1), vendor(2)] }),
        consoleEntry({ id: 2, text: 'many own', stack: Array.from({ length: 8 }, (_, index) => own(index)) }),
      ],
    });
    const [vendorOnly, manyOwn] = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' })).entries;
    expect(vendorOnly?.stack).toEqual(['lib0 (node:internal/process:1:1)']);
    expect(manyOwn?.stack).toHaveLength(5);
  });

  it('40 сообщений, различающихся числом, — одна запись, count 40, similar 40', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, {
      ...EMPTY,
      console: [
        consoleEntry({ id: 1, text: 'Other failure' }),
        ...Array.from({ length: 40 }, (_, index) => consoleEntry({ id: index + 2, text: `List ${index} has no key`, ts: Date.UTC(2026, 9, 7, 10, 0, index) })),
      ],
    });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' }));
    expect(result.matched).toBe(41);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1]).toMatchObject({ id: 41, text: 'List 39 has no key', count: 40, similar: 40 });
    expect(result.entries[0]?.similar).toBeUndefined();
    // Группа — по уровню и тексту: тот же текст на другом уровне не склеивается; count повторов суммируется.
    snapshots.set(7, {
      ...EMPTY,
      console: [
        consoleEntry({ id: 1, level: 'warning', text: 'retry 1 failed', count: 3 }),
        consoleEntry({ id: 2, level: 'error', text: 'retry 2 failed', count: 2 }),
        consoleEntry({ id: 3, level: 'error', text: 'retry 3 failed', count: 4 }),
      ],
    });
    const mixed = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', level: 'all' }));
    expect(mixed.entries.map((entry) => [entry.level, entry.count, entry.similar])).toEqual([['warning', 3, undefined], ['error', 6, 2]]);
  });

  it('after: только записи новее; next — последний id', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, console: [consoleEntry({ id: 3, text: 'alpha' }), consoleEntry({ id: 5, text: 'beta' }), consoleEntry({ id: 9, text: 'gamma' })] });
    const first = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' }));
    expect(first.next).toBe(9);
    const second = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', after: 5 }));
    expect(second.entries.map((entry) => entry.text)).toEqual(['gamma']);
    expect([second.matched, second.next]).toEqual([1, 9]);
    const none = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', after: 9 }));
    expect([none.entries, none.matched, none.next]).toEqual([[], 0, null]);
  });

  it('46 React-подобных ошибок из пробы 1 укладываются в 20 КБ все', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    const trace = Array.from({ length: 25 }, (_, index) => `    at Component${index} (http://127.0.0.1:5173/src/components/Feature${index}/Component${index}.tsx?t=1760000000000:${10 + index}:5)`).join('\n');
    const frames = (name: string) => Array.from({ length: 36 }, (_, index) => ({ fn: name, url: 'http://127.0.0.1:5173/', line: 65, column: 30 + index }));
    const keyWarnings = Array.from({ length: 40 }, (_, index) =>
      consoleEntry({ id: index + 1, text: `Warning: Each child in a list should have a unique "key" prop. Check the render method of \`List${index}\`. See https://reactjs.org/link/warning-keys for more information.\n${trace}`, stack: frames('rec') }),
    );
    const uncaught = Array.from({ length: 5 }, (_, index) => consoleEntry({ id: 41 + index, origin: 'exception', text: `Uncaught Error: Uncaught render failure ${index}`, stack: frames('deep') }));
    const auth = consoleEntry({ id: 46, text: 'Auth failed: password=hunter2' });
    snapshots.set(7, { ...EMPTY, console: [...keyWarnings, ...uncaught, auth] });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', limit: 100 }));
    expect(result.matched).toBe(46);
    expect(result.entries.map((entry) => entry.similar)).toEqual([40, 5, undefined]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(20_480);
  });

  it('консоль: секреты вида значения в тексте скрыты, pattern по сырому секрету ничего не находит', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, {
      ...EMPTY,
      console: [
        consoleEntry({ id: 20, text: 'Auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2ln; password=hunter2; api_key=AKIAIOSFODNN7EXAMPLE' }),
        consoleEntry({ id: 21, text: 'GET /reset?token=RESETTOKEN 404' }),
      ],
    });
    const result = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' }));
    expect(result.entries.map((entry) => entry.text)).toEqual([
      'Auth failed: Bearer <redacted>; password=<redacted>; api_key=<redacted>',
      'GET /reset?token=<redacted> 404',
    ]);
    for (const secret of ['hunter2', 'AKIAIOSFODNN7EXAMPLE', 'c2ln', 'RESETTOKEN']) {
      expect(JSON.stringify(result), secret).not.toContain(secret);
      const found = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1', pattern: secret }));
      expect([found.entries, found.matched], secret).toEqual([[], 0]);
    }
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

describe('адрес страницы в ответах (аудит 4.1, S6)', () => {
  it('URL в 1 МБ — в ответе не длиннее 512 знаков', async () => {
    const { ops, snapshots, guests, runOp: run } = setup();
    register(ops, {});
    const huge = `http://localhost:5173/${'a'.repeat(1_000_000)}?token=SECRETVALUE`;
    guests.get(7)?.getURL.mockReturnValue(huge);
    const longRequest = networkEntry({ id: '100.9', url: huge, status: 500 });
    snapshots.set(7, { ...EMPTY, console: [consoleEntry({ id: 1, text: 'boom', location: { url: huge, line: 1, column: 1 }, stack: [{ fn: 'f', url: huge, line: 1, column: 1 }] })], network: [longRequest] });
    const consoleResult = okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' }));
    const list = okResult<{ url: string; requests: Array<{ url: string }> }>(await run('network', { tab: 't1' }));
    const detail = okResult<{ url: string; request: { url: string } }>(await run('network', { tab: 't1', requestId: '100.9' }));
    const tabs = okResult<{ tabs: Array<{ url: string }> }>(await run('tabs'));
    const urls = [consoleResult.url, consoleResult.entries[0]?.source ?? '', consoleResult.entries[0]?.stack[0] ?? '', list.url, list.requests[0]?.url ?? '', detail.url, detail.request.url, tabs.tabs[0]?.url ?? ''];
    for (const url of urls) {
      expect(Array.from(url).length, url.slice(0, 40)).toBeLessThanOrEqual(530);
      expect(url).not.toContain('SECRETVALUE');
    }
    for (const url of [consoleResult.url, list.url, list.requests[0]?.url ?? '', detail.url, detail.request.url, tabs.tabs[0]?.url ?? '']) {
      expect(Array.from(url).length).toBeLessThanOrEqual(512);
      expect(url.endsWith('…')).toBe(true);
    }
  });

  it('короткий адрес не меняется', async () => {
    const { ops, runOp: run } = setup();
    register(ops, {});
    expect(okResult<BrowserAgentConsoleResult>(await run('console', { tab: 't1' })).url).toBe('http://localhost:5173/settings');
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

  it('деталь запроса прошлой эпохи — bad_request, как неизвестный', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, network: [old, failing] });
    expect(codeOf(await run('network', { tab: 't1', requestId: '99.1' }))).toBe('bad_request');
    expect(okResult<{ request: { id: string } }>(await run('network', { tab: 't1', requestId: '100.1' })).request.id).toBe('100.1');
  });

  it('60 заголовков по 2 КБ: значения по 256 знаков с «…», не больше 40 на сторону, заметка «20 more response headers are not shown.»', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    const headers = Array.from({ length: 60 }, (_, index): [string, string] => [`X-H${index}`, 'v'.repeat(2048)]);
    snapshots.set(7, { ...EMPTY, network: [networkEntry({ ...failing, requestHeaders: headers.slice(0, 3), responseHeaders: headers })] });
    const detail = await detailOf(run);
    expect(detail.responseHeaders).toHaveLength(40);
    expect(detail.requestHeaders).toHaveLength(3);
    for (const [, value] of detail.responseHeaders) expect(value).toBe(`${'v'.repeat(256)}…`);
    expect(detail.notes).toContain('20 more response headers are not shown.');
    expect(detail.notes.some((note) => note.includes('request headers'))).toBe(false);
  });

  it('список: query длиннее 80 знаков обрезан с «…»; в детали адрес полный (с маской)', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    const url = `http://localhost:5173/api/search?q=${'a'.repeat(300)}&token=SECRET123`;
    snapshots.set(7, { ...EMPTY, network: [networkEntry({ ...failing, url })] });
    const [summary] = okResult<{ requests: Array<{ url: string }> }>(await run('network', { tab: 't1' })).requests;
    expect(summary?.url).toBe(`http://localhost:5173/api/search?q=${'a'.repeat(78)}…`);
    expect(JSON.stringify(summary)).not.toContain('SECRET123');
    const detail = await detailOf(run);
    expect(detail.url).toBe(`http://localhost:5173/api/search?q=${'a'.repeat(300)}&token=<redacted>`);
  });

  it('after: только запросы после названного в текущей эпохе; next — id последнего; неизвестный after — все и заметка «Request X is no longer in the log; all matching requests are listed.»', async () => {
    const { ops, snapshots, runOp: run } = setup();
    register(ops, {});
    const all = ['1', '2', '3', '4'].map((id) => networkEntry({ id: `100.${id}`, status: 500 }));
    snapshots.set(7, { ...EMPTY, network: [old, ...all] });
    type List = { requests: Array<{ id: string }>; notes: string[]; next: string | null };
    const first = okResult<List>(await run('network', { tab: 't1', limit: 2 }));
    expect(first.requests.map((request) => request.id)).toEqual(['100.3', '100.4']);
    expect(first.next).toBe('100.4');
    expect(first.notes).toEqual([]);
    const after = okResult<List>(await run('network', { tab: 't1', after: '100.2' }));
    expect(after.requests.map((request) => request.id)).toEqual(['100.3', '100.4']);
    expect(after.next).toBe('100.4');
    expect(okResult<List>(await run('network', { tab: 't1', after: '100.4' })).next).toBeNull();
    // Запрос прошлой эпохи как курсор — неизвестный.
    const unknown = okResult<List>(await run('network', { tab: 't1', after: '99.1' }));
    expect(unknown.requests.map((request) => request.id)).toEqual(['100.1', '100.2', '100.3', '100.4']);
    expect(unknown.notes).toEqual(['Request 99.1 is no longer in the log; all matching requests are listed.']);
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
      { webContentsId: 7, session: 'S02', op: 'screenshot', phase: 'start', capture: { width: 375, height: 812, id: expect.any(String) as unknown as string } },
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
    expect(activity.map((e) => [e.phase, e.capture === undefined ? undefined : { width: e.capture.width, height: e.capture.height }])).toEqual([['start', undefined], ['start', { width: 1280, height: 800 }], ['end', undefined]]);
  });

  it('невидимая страница: первый снимок отклонён (кадр ещё не рисуется) — повтор, снимок возвращается; у видимой отказ не повторяется', async () => {
    const hidden = setup();
    register(hidden.ops, { visible: false });
    let shots = 0;
    hidden.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      shots += 1;
      if (shots === 1) throw new Error('Unable to capture screenshot');
      return { data: png(1280, 800).toString('base64') };
    });
    expect(codeOf(await hidden.runOp('screenshot', { tab: 't1' }))).toBe('ok');
    expect(shots).toBe(2);

    const visible = setup();
    register(visible.ops, {});
    let visibleShots = 0;
    visible.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      visibleShots += 1;
      throw new Error('Unable to capture screenshot');
    });
    expect(codeOf(await visible.runOp('screenshot', { tab: 't1' }))).not.toBe('ok');
    expect(visibleShots).toBe(1);
  });

  it('видимость читается в момент решения о повторе: показали страницу посреди снимка — отказ без повтора; спрятали — повтор', async () => {
    const shown = setup();
    register(shown.ops, { visible: false });
    let shots = 0;
    shown.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      shots += 1;
      register(shown.ops, { visible: true });
      throw new Error('Unable to capture screenshot');
    });
    expect(codeOf(await shown.runOp('screenshot', { tab: 't1' }))).not.toBe('ok');
    expect(shots).toBe(1);

    const hiddenLater = setup();
    register(hiddenLater.ops, {});
    let laterShots = 0;
    hiddenLater.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      laterShots += 1;
      if (laterShots === 1) {
        register(hiddenLater.ops, { visible: false });
        throw new Error('Unable to capture screenshot');
      }
      return { data: png(1280, 800).toString('base64') };
    });
    expect(codeOf(await hiddenLater.runOp('screenshot', { tab: 't1' }))).toBe('ok');
    expect(laterShots).toBe(2);
  });

  it('невидимая страница: после готовности поверхности снимок повторяется при любой ошибке не больше captureRetries раз, затем tab_hidden', async () => {
    const other = setup();
    register(other.ops, { visible: false });
    let shots = 0;
    other.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      shots += 1;
      throw new Error(shots === 1 ? 'Target closed' : 'Unable to capture screenshot');
    });
    const result = await other.runOp('screenshot', { tab: 't1' });
    expect(codeOf(result)).toBe('tab_hidden');
    expect(messageOf(result)).toContain('browser_console');
    expect(shots).toBe(AGENT_LIMITS.captureRetries + 1);
    // Поверхность готовили один раз, а не на каждый повтор.
    expect(other.activity.filter((e) => e.capture !== undefined)).toHaveLength(1);

    // У видимой страницы любая ошибка уходит агенту сразу.
    const visible = setup();
    register(visible.ops, {});
    let visibleShots = 0;
    visible.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      visibleShots += 1;
      throw new Error('Target closed');
    });
    expect(codeOf(await visible.runOp('screenshot', { tab: 't1' }))).toBe('unsupported');
    expect(visibleShots).toBe(1);
  });

  it('снимок в заданном размере ждёт готовности поверхности: captureScreenshot не раньше captureReady(id)', async () => {
    const { ops, inspector, activity, runOp: run } = setup({ confirmSurface: false });
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ shot: png(375, 812) }));
    const pending = run('screenshot', { tab: 't1', width: 375, height: 812 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const surface = activity.find((e) => e.capture !== undefined)?.capture;
    expect(surface).toMatchObject({ width: 375, height: 812 });
    expect(inspector.send.mock.calls.some(([, method]) => method === 'Page.captureScreenshot')).toBe(false);
    ops.captureReady('чужой id');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inspector.send.mock.calls.some(([, method]) => method === 'Page.captureScreenshot')).toBe(false);
    ops.captureReady((surface as { id: string }).id);
    expect(codeOf(await pending)).toBe('ok');
    expect(inspector.send.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot')).toHaveLength(1);
  });

  it('окно не подтвердило за captureReadyMs — timeout, размер человека возвращён, PNG не сохранён', async () => {
    const { ops, inspector, emulation, saveImage, runOp: run } = setup({ confirmSurface: false, captureReadyMs: 30 });
    register(ops, {});
    const trace: string[] = [];
    emulation.withTemporary.mockImplementation(async <T,>(_id: number, _spec: ViewportSpec, work: () => Promise<T>): Promise<T> => {
      trace.push('temporary on');
      try {
        return await work();
      } finally {
        trace.push('human size back');
      }
    });
    const result = await run('screenshot', { tab: 't1', width: 375, height: 812 });
    expect(codeOf(result)).toBe('timeout');
    expect(messageOf(result)).toContain('did not prepare the page for the screenshot');
    expect(trace).toEqual(['temporary on', 'human size back']);
    expect(saveImage).not.toHaveBeenCalled();
    expect(inspector.send.mock.calls.some(([, method]) => method === 'Page.captureScreenshot')).toBe(false);
  });

  it('видимая страница без размера поверхность не готовит: activity без capture, снимок сразу', async () => {
    const { ops, activity, runOp: run } = setup({ confirmSurface: false });
    register(ops, {});
    expect(codeOf(await run('screenshot', { tab: 't1' }))).toBe('ok');
    expect(activity.every((e) => e.capture === undefined)).toBe(true);
  });

  it('снимок выше окна (больше 1,2 высоты его содержимого) — bad_request до эмуляции; в пределе — снимается', async () => {
    const tall = setup({ windowHeight: 900 });
    register(tall.ops, {});
    const refused = await tall.runOp('screenshot', { tab: 't1', width: 1440, height: 1440 });
    expect(codeOf(refused)).toBe('bad_request');
    expect(messageOf(refused)).toContain('up to 1080 px');
    expect(tall.emulation.withTemporary).not.toHaveBeenCalled();
    tall.inspector.send.mockImplementation(sendWith({ shot: png(1920, 1080) }));
    expect(codeOf(await tall.runOp('screenshot', { tab: 't1', width: 1920, height: 1080 }))).toBe('ok');
  });

  it('fullPage страницы шире вьюпорта: ширина = вьюпорт, заметка «The page is 6000 px wide; the screenshot shows the first 1280 px.»', async () => {
    const { ops, inspector, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ content: { width: 6000, height: 800 }, shot: png(1280, 800) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', fullPage: true }));
    expect(result.viewport.width).toBe(1280);
    expect(result.width).toBe(1280);
    expect(result.notes).toEqual(['The page is 6000 px wide; the screenshot shows the first 1280 px.']);
  });

  it('fullPage: страница 2000 при вьюпорте 800 — три полосы вьюпортом с прокруткой гостя (0, 800, 1600), последняя обрезана до 400, склейка; прокрутка человека возвращена', async () => {
    const { ops, inspector, inGuest, saveImage, runOp: run } = setup();
    register(ops, {});
    const evaluated: string[] = [];
    inGuest.mockImplementation(async (_contents, code) => {
      evaluated.push(code);
      if (code.startsWith('[window.scrollX')) return [0, 340];
      // Документ 2000 при вьюпорте 800: прокрутка до 1600 зажимается на 1200.
      const to = /top: (\d+)/.exec(code)?.[1];
      return to === '1600' ? 1200 : Number(to);
    });
    inspector.send.mockImplementation(sendWith({ content: { width: 1280, height: 2000 }, shot: png(1280, 800) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', fullPage: true }));
    expect(result).toMatchObject({ fullPage: true, viewport: { width: 1280, height: 2000 }, width: 1004, height: 1568 });
    // 800 + 800 + 400 (последняя обрезана) = 2000 → вписано в 1568 по длинной стороне; без обрезки было бы 2400 и ширина 853.
    const shots = inspector.send.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot').map(([, , params]) => params);
    // fullPage — без клипа: масштаб клипа на экране DPR > 1 ненадёжен, длинная сторона режется после склейки.
    expect(shots).toEqual([{ format: 'png' }, { format: 'png' }, { format: 'png' }]);
    // Через CDP код не исполняется никогда: прокрутка идёт только через мир гостя.
    expect(inspector.send.mock.calls.some(([, method]) => method === 'Runtime.evaluate')).toBe(false);
    expect(evaluated.map((e) => /scrollTo\(\{ left: (\d+), top: (\d+), behavior: 'instant' \}\)/.exec(e)?.slice(1).join(','))).toEqual([undefined, '0,0', '0,800', '0,1600', '0,340']);
    // CSS `scroll-behavior: smooth` страницы не должен замедлять прокрутку: любая прокрутка гостя — мгновенная.
    expect(evaluated.filter((e) => e.includes('scrollTo')).every((e) => e.includes("behavior: 'instant'"))).toBe(true);
    expect(saveImage).toHaveBeenCalledTimes(1);
  });

  it('страница 3780 px при вьюпорте 752 — три полосы, ok, заметка «The page is 3780 px tall; the screenshot shows the first 2256 px (3 viewport heights).»', async () => {
    const { ops, inspector, saveImage, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ viewport: { width: 399, height: 752 }, content: { width: 399, height: 3780 } }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', fullPage: true }));
    const shots = inspector.send.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot');
    expect(shots).toHaveLength(3);
    expect(result.viewport).toEqual({ width: 399, height: 2256 });
    expect(result.notes).toEqual(['The page is 3780 px tall; the screenshot shows the first 2256 px (3 viewport heights).']);
    expect(saveImage).toHaveBeenCalledTimes(1);
  });

  it('эпоха сменилась посреди снимка (переход на localhost) — tab_not_loaded «Page t1 navigated during the screenshot: take it again.», saveImage не вызван', async () => {
    const { ops, inspector, snapshots, saveImage, runOp: run } = setup();
    register(ops, {});
    snapshots.set(7, { ...EMPTY, epoch: 1 });
    let shots = 0;
    inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method === 'Page.captureScreenshot' && (shots += 1) === 1) snapshots.set(7, { ...EMPTY, epoch: 2 });
      return sendWith({ content: { width: 1280, height: 2000 }, shot: png(1280, 800) })(id, method);
    });
    const result = await run('screenshot', { tab: 't1', fullPage: true });
    expect(codeOf(result)).toBe('tab_not_loaded');
    expect(messageOf(result)).toBe('Page t1 navigated during the screenshot: take it again.');
    expect(saveImage).not.toHaveBeenCalled();
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

  it('DPR 2 (layoutViewport 798, css 399×752): без клипа — клип с масштабом 1/DPR на экране DPR > 1 даёт неверную четверть; PNG в пикселях устройства влезает в 1568 — отдан как есть, resize не вызван', async () => {
    const { ops, inspector, image, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ viewport: { width: 399, height: 752 }, dpr: 2, shot: png(798, 1504) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1' }));
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
    expect([result.width, result.height]).toEqual([798, 1504]);
    expect(result.viewport).toEqual({ width: 399, height: 752 });
    expect(image.resize).not.toHaveBeenCalled();
  });

  it('DPR 2: PNG 2560×1600 длиннее 1568 — уменьшен до 1568×980 один раз', async () => {
    const { ops, inspector, image, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ dpr: 2, shot: png(2560, 1600) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1' }));
    expect([result.width, result.height]).toEqual([1568, 980]);
    expect(image.resize).toHaveBeenCalledTimes(1);
  });

  it('DPR 2: PNG больше screenshotBytes — снятая картинка уменьшается ×0,7 (не больше двух раз), повторных снимков нет', async () => {
    const { ops, inspector, image, saveImage, runOp: run } = setup();
    register(ops, {});
    const big = Buffer.concat([png(798, 1504), Buffer.alloc(AGENT_LIMITS.screenshotBytes)]);
    inspector.send.mockImplementation(sendWith({ viewport: { width: 399, height: 752 }, dpr: 2, shot: big }));
    image.resize.mockImplementation((_data, width, height) => Buffer.concat([png(width, height), Buffer.alloc(AGENT_LIMITS.screenshotBytes)]));
    const refused = await run('screenshot', { tab: 't1' });
    expect(codeOf(refused)).toBe('unsupported');
    expect(inspector.send.mock.calls.filter(([, method]) => method === 'Page.captureScreenshot')).toHaveLength(1);
    expect(image.resize).toHaveBeenCalledTimes(2);
    expect(image.resize.mock.calls[0]?.slice(1)).toEqual([559, 1053]);
    expect(saveImage).not.toHaveBeenCalled();
  });

  it('3840×2400 в эмуляции: clip.scale = 1568/3840, resize не вызван', async () => {
    const { ops, inspector, image, runOp: run } = setup();
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ viewport: { width: 3840, height: 2400 }, shot: png(1568, 980) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', width: 3840, height: 2400 }));
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 3840, height: 2400, scale: 1568 / 3840 } });
    expect([result.width, result.height]).toEqual([1568, 980]);
    expect(image.resize).not.toHaveBeenCalled();
  });

  it('эмуляция на экране DPR 2: withTemporary получает DPR экрана (эмуляция с DPR 1 там не действует), клипа нет, PNG в пикселях устройства', async () => {
    const { ops, inspector, emulation, image, runOp: run } = setup({ screenDpr: 2 });
    register(ops, {});
    inspector.send.mockImplementation(sendWith({ viewport: { width: 375, height: 700 }, dpr: 2, shot: png(750, 1400) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', width: 375, height: 700 }));
    expect(emulation.withTemporary).toHaveBeenCalledWith(7, { width: 375, height: 700, mobile: false, dpr: 1 }, expect.any(Function), 2);
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
    expect([result.width, result.height]).toEqual([750, 1400]);
    expect(result.viewport).toEqual({ width: 375, height: 700 });
    expect(image.resize).not.toHaveBeenCalled();
  });

  it('эмуляция человека включена на экране DPR 2 — клипа нет, PNG 3840×2400 уменьшается на main до 1568', async () => {
    const { ops, inspector, emulation, image, runOp: run } = setup({ screenDpr: 2 });
    register(ops, {});
    emulation.current.mockReturnValue({ preset: 'laptop', rotated: false, dpr: 1 });
    inspector.send.mockImplementation(sendWith({ viewport: { width: 3840, height: 2400 }, shot: png(3840, 2400) }));
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1', width: 3840, height: 2400 }));
    expect(inspector.send).toHaveBeenCalledWith(7, 'Page.captureScreenshot', { format: 'png' });
    expect([result.width, result.height]).toEqual([1568, 980]);
    expect(image.resize).toHaveBeenCalledTimes(1);
  });

  it('PNG больше screenshotBytes — повтор с масштабом ×0,7, не больше двух раз; всё ещё больше — unsupported «The screenshot is too large…»', async () => {
    const { ops, inspector, saveImage, runOp: run } = setup();
    register(ops, {});
    const scales: number[] = [];
    inspector.send.mockImplementation(async (id: number, method: string, params?: Record<string, unknown>) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      scales.push((params?.clip as { scale: number } | undefined)?.scale ?? 1);
      return { data: Buffer.concat([png(1280, 800), Buffer.alloc(AGENT_LIMITS.screenshotBytes)]).toString('base64') };
    });
    const result = await run('screenshot', { tab: 't1' });
    expect(codeOf(result)).toBe('unsupported');
    expect(messageOf(result)).toContain('The screenshot is too large');
    expect(scales).toHaveLength(3);
    // Первый снимок вьюпорта в 1280 — без клипа (масштаб 1), повторы — клипом с масштабом ×0,7.
    expect(scales[0]).toBe(1);
    expect(scales[1]).toBeCloseTo(0.7);
    expect(scales[2]).toBeCloseTo(0.49);
    expect(saveImage).not.toHaveBeenCalled();

    // Помещается со второй попытки — ok.
    scales.length = 0;
    inspector.send.mockImplementation(async (id: number, method: string, params?: Record<string, unknown>) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      scales.push((params?.clip as { scale: number } | undefined)?.scale ?? 1);
      return { data: (scales.length === 1 ? Buffer.concat([png(1280, 800), Buffer.alloc(AGENT_LIMITS.screenshotBytes)]) : png(896, 560)).toString('base64') };
    });
    expect(okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1' })).width).toBe(896);
    expect(scales).toHaveLength(2);
    expect(saveImage).toHaveBeenCalledTimes(1);
    expect(pngSize(saveImage.mock.calls[0]?.[0] as unknown as Buffer)).toEqual({ width: 896, height: 560 });
  });

  it('drops не записался — unsupported', async () => {
    const { ops, saveImage, runOp: run } = setup();
    register(ops, {});
    saveImage.mockResolvedValue(null);
    expect(codeOf(await run('screenshot', { tab: 't1' }))).toBe('unsupported');
  });
});

describe('проверки перед запуском из очереди (операция ждёт до opTimeoutMs)', () => {
  /** Первый снимок держит очередь страницы, второй операции — `console` — стоит за ним; `release` отпускает первый. */
  async function queued(change: (ctx: ReturnType<typeof setup>) => void) {
    const ctx = setup();
    register(ctx.ops, {});
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    ctx.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method === 'Page.captureScreenshot') {
        await gate;
        return { data: png(100, 100).toString('base64') };
      }
      return sendWith()(id, method);
    });
    const first = ctx.runOp('screenshot', { tab: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = ctx.runOp('console', { tab: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    change(ctx);
    release();
    await first;
    return second;
  }

  it('пауза панели между постановкой и запуском — access_denied «paused by the human»', async () => {
    const result = await queued(({ ops }) => ops.registerTab({ kind: 'paused', generation: GEN, workKey: WORK, owner: OWN, paused: true }));
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('paused by the human');
  });

  it('выключили «Let agents use the browser» — access_denied', async () => {
    const result = await queued(({ state }) => { state.allowed = false; });
    expect(codeOf(result)).toBe('access_denied');
    expect(messageOf(result)).toContain('Let agents use the browser');
  });

  it('страница ушла на внешний адрес — операция всё равно идёт (любые сайты)', async () => {
    const result = await queued(({ guests }) => guests.set(7, fakeGuest(7, 'https://example.com/')));
    expect(codeOf(result)).toBe('ok');
  });
});

describe('срок операции и очередь (R1, R6, R13, R14)', () => {
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Снимок, у которого `Page.captureScreenshot` держится управляемым промисом; `shots` — сколько раз его вызвали. */
  function heldShots(ctx: ReturnType<typeof setup>) {
    const gate = { release: () => undefined as void, shots: 0 };
    const held = new Promise<void>((resolve) => { gate.release = resolve; });
    ctx.inspector.send.mockImplementation(async (id: number, method: string) => {
      if (method !== 'Page.captureScreenshot') return sendWith()(id, method);
      gate.shots += 1;
      if (gate.shots === 1) await held;
      return { data: png(1280, 800).toString('base64') };
    });
    return gate;
  }

  it('тайм-аут: агент получает timeout через 100 мс, а вторая операция страницы стартует только после конца первой', async () => {
    const ctx = setup({ opTimeoutMs: 100 });
    register(ctx.ops, {});
    const gate = heldShots(ctx);
    const started = Date.now();
    const first = await ctx.runOp('screenshot', { tab: 't1' });
    expect(codeOf(first)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(400);
    const second = ctx.runOp('screenshot', { tab: 't1' });
    await sleep(40);
    expect(gate.shots).toBe(1);
    gate.release();
    expect(codeOf(await second)).toBe('ok');
    expect(gate.shots).toBe(2);
  });

  it('activity end — после реального конца операции, не на тайм-ауте', async () => {
    const ctx = setup({ opTimeoutMs: 100 });
    register(ctx.ops, {});
    const gate = heldShots(ctx);
    expect(codeOf(await ctx.runOp('screenshot', { tab: 't1' }))).toBe('timeout');
    expect(ctx.activity.map((e) => e.phase)).toEqual(['start']);
    gate.release();
    await sleep(20);
    expect(ctx.activity.map((e) => e.phase)).toEqual(['start', 'end']);
  });

  it('после тайм-аута снимок не сохраняется: saveImage не вызван', async () => {
    const ctx = setup({ opTimeoutMs: 100 });
    register(ctx.ops, {});
    const gate = heldShots(ctx);
    expect(codeOf(await ctx.runOp('screenshot', { tab: 't1' }))).toBe('timeout');
    gate.release();
    await sleep(30);
    expect(ctx.saveImage).not.toHaveBeenCalled();
  });

  it('операция, простоявшая в очереди дольше срока, не запускается: timeout, ни activity, ни Emulation.*', async () => {
    const ctx = setup({ opTimeoutMs: 100 });
    register(ctx.ops, {});
    const gate = heldShots(ctx);
    const first = ctx.runOp('screenshot', { tab: 't1' });
    await sleep(10);
    const second = await ctx.runOp('screenshot', { tab: 't1', width: 375, height: 812 });
    expect(codeOf(second)).toBe('timeout');
    expect(messageOf(second)).toContain('waited too long');
    expect(codeOf(await first)).toBe('timeout');
    gate.release();
    await sleep(30);
    expect(ctx.activity.filter((e) => e.phase === 'start')).toHaveLength(1);
    expect(ctx.emulation.withTemporary).not.toHaveBeenCalled();
    expect(ctx.inspector.send.mock.calls.some(([, method]) => String(method).startsWith('Emulation.'))).toBe(false);
  });

  it('гость уничтожен посреди деталей запроса — tab_not_loaded, а не unsupported', async () => {
    const ctx = setup();
    register(ctx.ops, {});
    ctx.snapshots.set(7, { epoch: 1, capture: 'on', console: [], network: [networkEntry({ id: 'r1' })] });
    ctx.inspector.responseBody.mockImplementation(async () => {
      ctx.guests.get(7)?.isDestroyed.mockReturnValue(true);
      throw new Error('Object has been destroyed');
    });
    const result = await ctx.runOp('network', { tab: 't1', requestId: 'r1' });
    expect(codeOf(result)).toBe('tab_not_loaded');
  });
});

describe('тайм-аут и немедленный повтор с настоящей эмуляцией (Фокус ревью, п. 5; reviewer-probes/race1.ts)', () => {
  it('тайм-аут и немедленный повтор: у человека прежний laptop 2x', async () => {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const log: string[] = [];
    let metrics = { width: 1280, height: 800 };
    let shots = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const inspector = {
      snapshot: (): DevtoolsSnapshot => EMPTY,
      responseBody: async () => null,
      send: vi.fn(async (_id: number, method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          metrics = { width: params?.['width'] as number, height: params?.['height'] as number };
          log.push(`metrics ${metrics.width}x${metrics.height} dpr ${String(params?.['deviceScaleFactor'])}`);
        }
        if (method === 'Emulation.clearDeviceMetricsOverride') {
          metrics = { width: 1280, height: 800 };
          log.push('clear');
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            layoutViewport: { clientWidth: metrics.width, clientHeight: metrics.height },
            cssLayoutViewport: { clientWidth: metrics.width, clientHeight: metrics.height, pageX: 0, pageY: 0 },
            cssContentSize: { x: 0, y: 0, width: metrics.width, height: metrics.height },
          };
        }
        if (method === 'Page.captureScreenshot') {
          shots += 1;
          if (shots === 1) await held;
          return { data: png(metrics.width, metrics.height).toString('base64') };
        }
        return {};
      }),
    };
    const emulation = createEmulation({ inspector });
    const guest = fakeGuest(7);
    const ops = createAgentOps({
      scripts: { evaluateOf: vi.fn() },
      storage: { cookiesOf: vi.fn(), storageOf: vi.fn() },
      downloads: { list: vi.fn(() => []), dirOf: vi.fn(() => '/downloads') },
      agentsAllowed: async () => true,
      openTab: () => true,
      resize: () => false,
      fromId: () => guest as unknown as WebContents,
      inspector,
      emulation,
      saveImage: async () => '/drops/x.png',
      image: { resize: (_data: Buffer, width: number, height: number) => png(width, height), stitch: (parts: Buffer[]) => parts[0] as Buffer, crop: (data: Buffer) => data, cropRect: (data: Buffer) => data },
      inGuest: async () => undefined,
      agentWindow: createAgentWindow(),
      typing: createTypingClock(),
      activity: (e: AgentActivity) => {
        if (e.capture !== undefined) queueMicrotask(() => ops.captureReady((e.capture as { id: string }).id));
      },
      opTimeoutMs: 100,
    });
    ops.registerTab({ kind: 'hello', generation: GEN });
    register(ops, {});
    const human: ViewportSpec = { preset: 'laptop', rotated: false, dpr: 2 };
    await emulation.set(7, human, { width: 900, height: 600 });
    log.length = 0;
    const call = (width: number, height: number): Promise<BrowserAgentResult> =>
      ops.run({ opId: 'x', ref: REF, label: 'S02', owners: [{ kind: 'session', sessionId: 's-02' }], op: 'screenshot', args: { tab: 't1', width, height } });
    expect(codeOf(await call(1000, 700))).toBe('timeout');
    const second = call(600, 500);
    await sleep(30);
    expect(log).toEqual(['metrics 1000x700 dpr 1']);
    release();
    expect(codeOf(await second)).toBe('ok');
    await sleep(20);
    expect(emulation.current(7)).toEqual(human);
    // Последняя команда размера — размер человека (laptop 1280×800, DPR 2), а не размер снимка.
    expect(log.filter((entry) => entry.startsWith('metrics')).at(-1)).toBe('metrics 1280x800 dpr 2');
  });
});

describe('окно не отвечает про DPR экрана (ревью G4)', () => {
  it('screenDpr не отвечает за срок вызова — запасной путь по раскладке страницы, снимок проходит', async () => {
    const { ops, runOp: run } = setup({ screenDprHangs: true, guestCallMs: 30 });
    register(ops, {});
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1' }));
    expect(result.viewport).toEqual({ width: 1280, height: 800 });
  });

  it('screenDpr отказал — тот же запасной путь, а не unsupported', async () => {
    const { ops, runOp: run } = setup({ screenDprRejects: true });
    register(ops, {});
    const result = okResult<BrowserAgentScreenshotResult>(await run('screenshot', { tab: 't1' }));
    expect(result.viewport).toEqual({ width: 1280, height: 800 });
  });
});

describe('замёрзший гость посреди fullPage не клинит очередь страницы и размер человека (ревью G4, п. 5–6; reviewer-probes/review56/hang-probe.mts)', () => {
  /** Настоящие `createAgentOps` и `createEmulation`; `inGuest` отвечает на первый вызов (исходная прокрутка), дальше молчит. */
  async function frozenGuestSetup(timing: { opTimeoutMs: number; guestCallMs: number }) {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const log: string[] = [];
    let metrics = { width: 1280, height: 800 };
    const inspector = {
      snapshot: (): DevtoolsSnapshot => EMPTY,
      responseBody: async () => null,
      send: vi.fn(async (_id: number, method: string, params?: Record<string, unknown>): Promise<unknown> => {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          metrics = { width: params?.['width'] as number, height: params?.['height'] as number };
          log.push(`metrics ${metrics.width}x${metrics.height} dpr ${String(params?.['deviceScaleFactor'])}`);
        }
        if (method === 'Emulation.clearDeviceMetricsOverride') {
          metrics = { width: 1280, height: 800 };
          log.push('clear');
        }
        if (method === 'Page.getLayoutMetrics') {
          return {
            layoutViewport: { clientWidth: metrics.width, clientHeight: metrics.height },
            cssLayoutViewport: { clientWidth: metrics.width, clientHeight: metrics.height, pageX: 0, pageY: 0 },
            cssContentSize: { x: 0, y: 0, width: metrics.width, height: metrics.height * 2 },
          };
        }
        if (method === 'Page.captureScreenshot') return { data: png(metrics.width, metrics.height).toString('base64') };
        return {};
      }),
    };
    const emulation = createEmulation({ inspector });
    const guest = fakeGuest(7);
    let evals = 0;
    const ops = createAgentOps({
      scripts: { evaluateOf: vi.fn() },
      storage: { cookiesOf: vi.fn(), storageOf: vi.fn() },
      downloads: { list: vi.fn(() => []), dirOf: vi.fn(() => '/downloads') },
      agentsAllowed: async () => true,
      openTab: () => true,
      resize: () => false,
      fromId: () => guest as unknown as WebContents,
      inspector,
      emulation,
      saveImage: async () => '/drops/x.png',
      image: { resize: (_data: Buffer, width: number, height: number) => png(width, height), stitch: (parts: Buffer[]) => parts[0] as Buffer, crop: (data: Buffer) => data, cropRect: (data: Buffer) => data },
      // Первый вызов — исходная прокрутка; со второго гость не отвечает вовсе (упал или завис).
      inGuest: (_contents: WebContents, code: string) => {
        evals += 1;
        return evals === 1 ? Promise.resolve(code.startsWith('[') ? [0, 0] : 0) : new Promise<unknown>(() => undefined);
      },
      activity: (e: AgentActivity) => {
        if (e.capture !== undefined) queueMicrotask(() => ops.captureReady((e.capture as { id: string }).id));
      },
      agentWindow: createAgentWindow(),
      typing: createTypingClock(),
      ...timing,
    });
    ops.registerTab({ kind: 'hello', generation: GEN });
    register(ops, {});
    const human: ViewportSpec = { preset: 'laptop', rotated: false, dpr: 2 };
    await emulation.set(7, human, { width: 900, height: 600 });
    log.length = 0;
    const base = { ref: REF, label: 'S02', owners: [{ kind: 'session', sessionId: 's-02' }] as BrowserAgentOwner[] };
    const shoot = (): Promise<BrowserAgentResult> => ops.run({ ...base, opId: 'x', op: 'screenshot', args: { tab: 't1', width: 1000, height: 700, fullPage: true } });
    return { ops, emulation, log, base, shoot, sleep };
  }

  it('гость молчит дольше срока вызова: op1 — tab_not_loaded, следующая операция страницы и emulation.set человека проходят, размер — человека', async () => {
    const { ops, emulation, log, base, shoot, sleep } = await frozenGuestSetup({ opTimeoutMs: 100, guestCallMs: 40 });
    expect(codeOf(await shoot())).toBe('tab_not_loaded');
    const tablet: ViewportSpec = { preset: 'tablet', rotated: false, dpr: 2 };
    let humanSet = false;
    void emulation.set(7, tablet, { width: 900, height: 600 }).then(() => { humanSet = true; });
    const startedAt = Date.now();
    const second = await ops.run({ ...base, opId: 'y', op: 'console', args: { tab: 't1' } });
    // Хвост очереди освободился: не позже срока вызова в госте после срока операции (с запасом на таймеры).
    expect(codeOf(second)).toBe('ok');
    expect(Date.now() - startedAt).toBeLessThan(400);
    await sleep(300);
    expect(humanSet).toBe(true);
    expect(emulation.current(7)).toEqual(tablet);
    // Последняя команда размера — размер человека (tablet 768×1024, DPR 2), а не размер снимка.
    expect(log.filter((entry) => entry.startsWith('metrics')).at(-1)).toBe('metrics 768x1024 dpr 2');
  });

  it('срок операции вышел раньше срока вызова: op1 — timeout (отмена), вызов в госте отпущен отменой, а возврат прокрутки ограничен сроком; потом страница и размер человека свободны', async () => {
    const { ops, emulation, log, base, shoot, sleep } = await frozenGuestSetup({ opTimeoutMs: 100, guestCallMs: 250 });
    expect(codeOf(await shoot())).toBe('timeout');
    // Возврат прокрутки в finally — только по сроку, без отмены: ждёт до guestCallMs, и только потом хвост свободен.
    await sleep(300);
    const tablet: ViewportSpec = { preset: 'tablet', rotated: false, dpr: 2 };
    await emulation.set(7, tablet, { width: 900, height: 600 });
    expect(codeOf(await ops.run({ ...base, opId: 'y', op: 'console', args: { tab: 't1' } }))).toBe('ok');
    expect(emulation.current(7)).toEqual(tablet);
    expect(log.filter((entry) => entry.startsWith('metrics')).at(-1)).toBe('metrics 768x1024 dpr 2');
  });
});
