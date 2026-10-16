/**
 * Операции агента над браузером окна в main (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1–5.2, 7; этап B2:
 * `open`). Событие хоста `browser.agentOp` приходит сюда (`host-connection.ts#answerBrowserAgentOps`), ответ уходит
 * методом `browser.agentResult`.
 *
 * Агент называет только адрес: работу вкладки задаёт хост по токену сессии (`ref` события), а не аргументы. Адрес должен
 * быть http(s) на loopback (`shared/loopback.ts`) и до окна доходит без учётных данных. Раскладка — дело окна:
 * место вкладки, предел страниц панели, повтор уже открытой страницы и тост решает рендерер (`renderer/browser/agent-open.ts`), main
 * просит его событием `browser:agent-open-tab`, ждёт ответ не дольше `AGENT_LIMITS.openMs` и переводит его в ответ агенту.
 * Страницы панелей main знает по реестру (`registerTab`, наполняет окно): по нему работает `tabs` (этап C), доступ к странице
 * решает хозяин из `owners` и пауза панели (`pageOf`). `open` страницу не трогает: ни гостя, ни CDP, ни ожидания загрузки.
 *
 * Чей браузер получает страницу, решает `ownerOf` по правилу спеки 5.1 и по `owners` события — хозяевам, которых хост
 * вложил по карте работы (3.7, 3.10); хозяин вне списка — `access_denied`. Выбранный хозяин уходит окну в `AgentOpenTab`.
 *
 * Вкладку агент называет коротким id (`t1`, `t2`…): у каждой работы свой счёт, id держится, пока жив main. Этапы C и D
 * опираются на те же id.
 */
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { AGENT_LIMITS, browserAgentArgs } from '@parley/protocol';
import type {
  BrowserAgentArgs,
  BrowserAgentErrorCode,
  BrowserAgentOpEvent,
  BrowserAgentOpenResult,
  BrowserAgentOwner,
  BrowserAgentResult,
  BrowserAgentTabInfo,
} from '@parley/protocol';
import { viewportSize } from '../../shared/browser-devtools.js';
import type { AgentActivity, AgentOpenTab, AgentOpenTabResult, AgentPageRegistration } from '../../shared/browser-types.js';
import type { BrowserOwner } from '../../shared/layout-types.js';
import { isLoopbackUrl } from '../../shared/loopback.js';
import { redactUrl } from '../../shared/redact.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';

export interface AgentOpsDeps {
  /** «Let agents use the browser» (`UiFile.browser.agentsAllowed`): читается на каждую операцию. */
  agentsAllowed(): Promise<boolean>;
  /** Просит окно открыть вкладку (`browser:agent-open-tab`); `false` — окно не готово слушать. */
  openTab(e: AgentOpenTab): boolean;
  /** Сколько ждать ответа окна; по умолчанию `AGENT_LIMITS.openMs`. Тестам — меньше. */
  openMs?: number;
  /** Гость-страница по id её WebContents; `null` — такого нет. */
  fromId(id: number): WebContents | null;
  inspector: Pick<Inspector, 'snapshot' | 'send' | 'responseBody'>;
  emulation: Pick<Emulation, 'current' | 'withTemporary'>;
  /** PNG снимка — в `drops/` (`main/drops.ts#saveImage`); `null` — не сохранился. */
  saveImage(png: Buffer): Promise<string | null>;
  /** Картинки в main — `nativeImage`, в тестах заглушка. */
  image: { size(png: Buffer): { width: number; height: number }; resize(png: Buffer, width: number, height: number): Buffer; stitch(parts: Buffer[]): Buffer };
  /** Агент действует на странице: окно-хозяин показывает это человеку. */
  activity(e: AgentActivity): void;
  /** Сколько ждать операцию на странице; по умолчанию `AGENT_LIMITS.opMs - 2_000`, чтобы очередь освобождалась раньше `timeout` хоста. */
  opTimeoutMs?: number;
}

export interface AgentOps {
  run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>;
  /** Ответ окна на `browser:agent-open-tab` (канал `browser:agent-open-tab-result`); чужой и поздний id молча игнорируется. */
  openTabResult(requestId: string, result: AgentOpenTabResult): void;
  /** Окно сообщает о странице панели, её закрытии или паузе панели (спека 3.7, 4.8). */
  registerTab(e: AgentPageRegistration): void;
  /** Окно перезагрузилось: реестр и паузы забыты до новой регистрации, id агента сохраняются. */
  reset(): void;
}

/** Ответ `Page.getLayoutMetrics`: нужные поля. */
export interface LayoutMetrics {
  cssLayoutViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
  cssContentSize: { x: number; y: number; width: number; height: number };
}

/** Отказ операции с кодом протокола; текст читает агент. */
export class AgentOpError extends Error {
  readonly code: BrowserAgentErrorCode;

  constructor(code: BrowserAgentErrorCode, message: string) {
    super(message);
    this.name = 'AgentOpError';
    this.code = code;
  }
}

/** Схема аргументов по имени операции: хост другой версии может прислать незнакомую. */
type ArgsSchema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const ARGS: Partial<Record<string, ArgsSchema>> = browserAgentArgs;

const ok = (result: unknown): BrowserAgentResult => ({ ok: true, result });
const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Пояснение агенту, когда работа вне LRU окна: вкладка в раскладке есть, гостя пока нет. */
export const NOT_MOUNTED_NOTE = "The workspace is not open in Parley's window, so the page loads when the human opens it.";

/** Длина заголовка страницы в `tabs`. */
const TITLE_LIMIT = 200;

/** Пояснение агенту, когда окно о работе ничего не сообщало: пустой список здесь не значит «страниц нет». */
const UNKNOWN_WORK_NOTE =
  "Parley's window has not reported any browser pages for this workspace. If the human has not opened this workspace in Parley's window yet, its pages are not known; a page you open with browser_open will appear here.";

/** Адрес, который агент может открыть: http(s) на loopback, без учётных данных; иначе `null`. Фрагмент (#…) остаётся: им бывают маршруты SPA. */
export function loopbackHref(raw: string): string | null {
  if (!isLoopbackUrl(raw)) return null;
  const parsed = new URL(raw);
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

/**
 * Хозяин для `open` (спека 5.1): с `room` — браузер этой комнаты, если она в `owners`; с `own` — браузер чата сессии;
 * без обоих — браузер комнаты, когда сессия участник ровно одной, иначе браузер чата. `own` вместе с `room` схема
 * протокола отвергает раньше, здесь это тоже `bad_request`: проверка у каждой стороны своя.
 */
export function ownerOf(request: BrowserAgentOpEvent, args: BrowserAgentArgs<'open'>): BrowserOwner {
  if (args.own === true && args.room !== undefined) throw new AgentOpError('bad_request', 'Pass either own or room, not both.');
  const rooms = request.owners.flatMap((owner) => (owner.kind === 'room' ? [owner.roomId] : []));
  const own = { kind: 'session', sessionId: request.ref.sessionId } as const;
  if (!request.owners.some((owner) => owner.kind === 'session' && owner.sessionId === own.sessionId)) {
    throw new AgentOpError('access_denied', 'This session has no browser of its own right now.');
  }
  if (args.room !== undefined) {
    if (!rooms.includes(args.room)) {
      throw new AgentOpError('access_denied', `You are not a member of room ${args.room}, so you cannot use its browser. Use own: true for the browser of your own chat.`);
    }
    return { kind: 'room', roomId: args.room };
  }
  if (args.own === true) return own;
  const [only] = rooms;
  return rooms.length === 1 && only !== undefined ? { kind: 'room', roomId: only } : own;
}

export function createAgentOps(deps: AgentOpsDeps): AgentOps {
  const openMs = deps.openMs ?? AGENT_LIMITS.openMs;
  /** Ждущие ответа окна: id просьбы → продолжение. */
  const pendingOpens = new Map<string, (result: AgentOpenTabResult | 'no_window' | 'timeout') => void>();
  /** id агента по работе и вкладке; счёт — свой у каждой работы. */
  const ids = new Map<string, string>();
  const counters = new Map<string, number>();

  function agentIdFor(workKey: string, tabId: string): string {
    const key = `${workKey}\n${tabId}`;
    const known = ids.get(key);
    if (known !== undefined) return known;
    const next = (counters.get(workKey) ?? 0) + 1;
    counters.set(workKey, next);
    const id = `t${next}`;
    ids.set(key, id);
    return id;
  }

  interface PageRecord {
    agentId: string;
    webContentsId: number | null;
    workKey: string;
    owner: BrowserOwner;
    pageId: string;
    visible: boolean;
    lastUrl: string;
    lastTitle: string;
  }
  /** Страницы панелей: ключ — работа и страница (`bp-…` уникален на окно, но счёт `agentIdFor` — на работу). */
  const pages = new Map<string, PageRecord>();
  /** Приостановленные панели: работа и хозяин. */
  const paused = new Set<string>();
  const pageKey = (workKey: string, pageId: string): string => `${workKey}\n${pageId}`;
  const ownerId = (owner: BrowserAgentOwner | BrowserOwner): string => (owner.kind === 'session' ? `session:${owner.sessionId}` : `room:${owner.roomId}`);
  const panelKey = (workKey: string, owner: BrowserOwner): string => `${workKey}\n${ownerId(owner)}`;
  const entitled = (request: BrowserAgentOpEvent, record: PageRecord): boolean => request.owners.some((owner) => ownerId(owner) === ownerId(record.owner));
  const isPaused = (record: PageRecord): boolean => paused.has(panelKey(record.workKey, record.owner));

  function live(record: PageRecord): WebContents | null {
    if (record.webContentsId === null) return null;
    const contents = deps.fromId(record.webContentsId);
    return contents === null || contents.isDestroyed() ? null : contents;
  }

  /** Страница своей работы по id агента и проверки доступа (спека 5.2); дальше проверки состояния — задачи 11–12. */
  function pageOf(request: BrowserAgentOpEvent, agentId: string): PageRecord {
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const record = [...pages.values()].find((candidate) => candidate.workKey === workKey && candidate.agentId === agentId);
    if (record === undefined) throw new AgentOpError('no_tab', `There is no page ${agentId} in your browsers: call browser_tabs.`);
    if (!entitled(request, record)) throw new AgentOpError('access_denied', `You have no access to page ${agentId}: it belongs to a browser panel that is not your chat's or your rooms'.`);
    if (isPaused(record)) throw new AgentOpError('access_denied', 'The human paused agents in this browser panel (paused by the human).');
    return record;
  }

  async function viewportOf(id: number): Promise<BrowserAgentTabInfo['viewport']> {
    const spec = deps.emulation.current(id);
    if (spec !== null) {
      const { width, height } = viewportSize(spec);
      return { width, height, emulated: true };
    }
    try {
      const metrics = await deps.inspector.send<LayoutMetrics>(id, 'Page.getLayoutMetrics');
      return { width: Math.round(metrics.cssLayoutViewport.clientWidth), height: Math.round(metrics.cssLayoutViewport.clientHeight), emulated: false };
    } catch {
      return null;
    }
  }

  async function listTabs(request: BrowserAgentOpEvent): Promise<{ tabs: BrowserAgentTabInfo[]; notes: string[] }> {
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const mine = [...pages.values()]
      .filter((record) => record.workKey === workKey && entitled(request, record) && !isPaused(record))
      .sort((a, b) => Number(a.agentId.slice(1)) - Number(b.agentId.slice(1)));
    const tabs: BrowserAgentTabInfo[] = [];
    for (const record of mine) {
      const contents = live(record);
      const loaded = contents !== null && !contents.isCrashed();
      if (contents !== null) {
        record.lastUrl = contents.getURL();
        record.lastTitle = contents.getTitle();
      }
      tabs.push({
        id: record.agentId,
        owner: record.owner,
        url: redactUrl(record.lastUrl),
        title: record.lastTitle.slice(0, TITLE_LIMIT),
        viewport: loaded && record.webContentsId !== null ? await viewportOf(record.webContentsId) : null,
        loaded,
        // Невыгруженную, но невидимую страницу человек не видит; незагруженную — тем более.
        visible: loaded && record.visible,
        loopback: isLoopbackUrl(record.lastUrl),
      });
    }
    // Работа известна реестру, если о ней приходила хоть одна запись (страница или пауза); иначе пустой список — не «страниц нет».
    const known = [...pages.values()].some((record) => record.workKey === workKey) || [...paused].some((key) => key.startsWith(`${workKey}\n`));
    return { tabs, notes: tabs.length === 0 && !known ? [UNKNOWN_WORK_NOTE] : [] };
  }

  function askWindow(event: AgentOpenTab): Promise<AgentOpenTabResult | 'no_window' | 'timeout'> {
    return new Promise((resolve) => {
      const done = (result: AgentOpenTabResult | 'no_window' | 'timeout'): void => {
        clearTimeout(timer);
        pendingOpens.delete(event.requestId);
        resolve(result);
      };
      const timer = setTimeout(() => done('timeout'), openMs);
      pendingOpens.set(event.requestId, done);
      let sent = false;
      try {
        sent = deps.openTab(event);
      } catch {
        // Окно закрыто посреди вызова — как будто его нет.
      }
      if (!sent) done('no_window');
    });
  }

  async function openOf(request: BrowserAgentOpEvent, args: BrowserAgentArgs<'open'>): Promise<BrowserAgentOpenResult> {
    const url = loopbackHref(args.url);
    if (url === null) {
      throw new AgentOpError('not_loopback', 'Only http(s) pages on localhost can be opened: pass an absolute URL such as http://localhost:5173/.');
    }
    const owner = ownerOf(request, args);
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    const answer = await askWindow({ requestId: randomUUID(), workKey, url, sessionId: request.ref.sessionId, session: request.label, owner });
    if (answer === 'no_window') throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    if (answer === 'timeout') throw new AgentOpError('timeout', `The window did not place the tab within ${Math.round(openMs / 1000)} s.`);
    if ('error' in answer) {
      throw answer.error === 'limit'
        ? new AgentOpError('bad_request', `This browser panel already has ${AGENT_LIMITS.panelPages} pages, the most Parley allows. Ask the human to close one.`)
        : new AgentOpError('window_not_connected', "Parley's window does not know this workspace yet: try again in a moment.");
    }
    return { tab: agentIdFor(workKey, answer.tabId), owner, url, reused: answer.reused, notes: answer.mounted ? [] : [NOT_MOUNTED_NOTE] };
  }

  return {
    async run(request) {
      const schema = ARGS[request.op];
      if (schema === undefined) {
        return failure('unsupported', `This window does not know the operation ${String(request.op)}: ask the human to restart Parley.`);
      }
      const parsed = schema.safeParse(request.args ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined || issue.path.length === 0 ? 'args' : issue.path.map(String).join('.');
        return failure('bad_request', `Invalid arguments for ${request.op}: ${where} — ${issue?.message ?? 'invalid'}.`);
      }
      if (!(await deps.agentsAllowed())) {
        return failure('access_denied', 'The human turned off agent access to the browser (Settings → Browser → Let agents use the browser).');
      }
      try {
        switch (request.op) {
          case 'open':
            return ok(await openOf(request, parsed.data as BrowserAgentArgs<'open'>));
          case 'tabs':
            return ok(await listTabs(request));
          case 'console':
            // До задачи 11 читать нечего: страница проверяется (чужая, на паузе), чтение ещё не умеем.
            pageOf(request, (parsed.data as BrowserAgentArgs<'console'>).tab);
            return failure('unsupported', 'Reading the console is not available yet.');
          default:
            // Операции чтения, которых ещё нет (задачи 11–12).
            return failure('unsupported', `This window does not support the operation ${request.op} yet: ask the human to update Parley.`);
        }
      } catch (error) {
        if (error instanceof AgentOpError) return failure(error.code, error.message);
        return failure('unsupported', error instanceof Error ? error.message : String(error));
      }
    },
    openTabResult(requestId, result) {
      pendingOpens.get(requestId)?.(result);
    },
    registerTab(e) {
      if ('gone' in e) {
        pages.delete(pageKey(e.workKey, e.pageId));
        return;
      }
      if ('paused' in e) {
        if (e.paused) paused.add(panelKey(e.workKey, e.owner));
        else paused.delete(panelKey(e.workKey, e.owner));
        return;
      }
      const key = pageKey(e.workKey, e.pageId);
      const previous = pages.get(key);
      const contents = e.webContentsId === null ? null : deps.fromId(e.webContentsId);
      pages.set(key, {
        agentId: agentIdFor(e.workKey, e.pageId),
        webContentsId: e.webContentsId,
        workKey: e.workKey,
        owner: e.owner,
        pageId: e.pageId,
        visible: e.visible,
        lastUrl: contents?.getURL() ?? previous?.lastUrl ?? '',
        lastTitle: contents?.getTitle() ?? previous?.lastTitle ?? '',
      });
    },
    reset() {
      pages.clear();
      paused.clear();
    },
  };
}
