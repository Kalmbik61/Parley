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
import type { BrowserAgentArgs, BrowserAgentErrorCode, BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentResult } from '@parley/protocol';
import type { AgentActivity, AgentOpenTab, AgentOpenTabResult, AgentPageRegistration } from '../../shared/browser-types.js';
import type { BrowserOwner } from '../../shared/layout-types.js';
import { isLoopbackUrl } from '../../shared/loopback.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';
import { AgentOpError } from './agent-errors.js';
import { createAgentCapture } from './agent-capture.js';
import type { AgentCaptureDeps } from './agent-capture.js';
import { createPageRegistry, listTabs } from './agent-pages.js';
import type { PageRecord } from './agent-pages.js';
import { createPageQueue } from './agent-queue.js';
import { createAgentReads } from './agent-reads.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';

export { AgentOpError } from './agent-errors.js';
export { captureSpec } from './agent-capture.js';
export type { LayoutMetrics } from './agent-pages.js';

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
  image: AgentCaptureDeps['image'];
  /** Агент действует на странице: окно-хозяин показывает это человеку. */
  activity(e: AgentActivity): void;
  /** Сколько ждать операцию на странице; по умолчанию `AGENT_LIMITS.opMs - 2_000`, чтобы очередь освобождалась раньше `timeout` хоста. */
  opTimeoutMs?: number;
  /** Код main в изолированном мире гостя (прокрутка fullPage), см. `AgentCaptureDeps.inGuest`. */
  inGuest: AgentCaptureDeps['inGuest'];
  /** Высота содержимого окна гостя: выше {1,2 × высота} снимок не растят (Chromium тайлит поверхность). */
  windowHeight?: AgentCaptureDeps['windowHeight'];
  /** DPR экрана окна гостя, см. `AgentCaptureDeps.screenDpr`. */
  screenDpr?: AgentCaptureDeps['screenDpr'];
  /** Сколько ждать подтверждения окна, что `<webview>` стоит в размере снимка; по умолчанию `AGENT_LIMITS.captureReadyMs`. Тестам — меньше. */
  captureReadyMs?: number;
}

export interface AgentOps {
  run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>;
  /** Ответ окна на `browser:agent-open-tab` (канал `browser:agent-open-tab-result`); чужой и поздний id молча игнорируется. */
  openTabResult(requestId: string, result: AgentOpenTabResult): void;
  /** Окно сообщает о странице панели, её закрытии или паузе панели (спека 3.7, 4.8). */
  registerTab(e: AgentPageRegistration): void;
  /** Окно подтверждает, что `<webview>` стоит в размере снимка (канал `browser:agent-capture-ready`); чужой и поздний id молча игнорируется. */
  captureReady(id: string): void;
  /** Окно перезагрузилось: реестр и паузы забыты до новой регистрации, id агента сохраняются. */
  reset(): void;
}

/** Схема аргументов по имени операции: хост другой версии может прислать незнакомую. */
type ArgsSchema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const ARGS: Partial<Record<string, ArgsSchema>> = browserAgentArgs;

const ok = (result: unknown): BrowserAgentResult => ({ ok: true, result });
const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message } });

/** Пояснение агенту, когда работа вне LRU окна: вкладка в раскладке есть, гостя пока нет. */
export const NOT_MOUNTED_NOTE = "The workspace is not open in Parley's window, so the page loads when the human opens it.";

/** Отказ при выключенном общем «Let agents use the browser». */
const AGENTS_OFF = 'The human turned off agent access to the browser (Settings → Browser → Let agents use the browser).';

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
  const registry = createPageRegistry({ fromId: deps.fromId });
  const queue = createPageQueue();
  const reads = createAgentReads({ inspector: deps.inspector });
  const capture = createAgentCapture({ inspector: deps.inspector, emulation: deps.emulation, registry, saveImage: deps.saveImage, image: deps.image, activity: deps.activity, inGuest: deps.inGuest, ...(deps.captureReadyMs === undefined ? {} : { captureReadyMs: deps.captureReadyMs }), ...(deps.windowHeight === undefined ? {} : { windowHeight: deps.windowHeight }), ...(deps.screenDpr === undefined ? {} : { screenDpr: deps.screenDpr }) });
  const opTimeoutMs = deps.opTimeoutMs ?? AGENT_LIMITS.opMs - 2_000;
  const pageKey = (workKey: string, pageId: string): string => `${workKey}\n${pageId}`;

  /** Страница по id агента: доступ (`pageOf`), состояние гостя, loopback. */
  function checked(request: BrowserAgentOpEvent, agentId: string): { record: PageRecord; contents: WebContents } {
    const record = registry.pageOf(request, agentId);
    const contents = registry.live(record);
    if (contents === null) throw new AgentOpError('tab_not_loaded', `Page ${agentId} is not loaded: its panel or workspace is not open in the window.`);
    if (contents.isCrashed()) throw new AgentOpError('tab_not_loaded', `The page ${agentId} crashed.`);
    if (!isLoopbackUrl(contents.getURL())) throw new AgentOpError('not_loopback', `Page ${agentId} is not on localhost.`);
    return { record, contents };
  }

  /** Ошибка не `AgentOpError` внутри страницы: записи нет — `no_tab`; гость уничтожен или упал — `tab_not_loaded`; иначе `unsupported`. */
  function pageFailure(record: PageRecord, contents: WebContents, signal: AbortSignal, error: unknown): AgentOpError {
    if (error instanceof AgentOpError) return error;
    if (signal.aborted) return new AgentOpError('timeout', 'The operation was cancelled: it took too long.');
    const message = error instanceof Error ? error.message : String(error);
    if (registry.fresh(record) === undefined) return new AgentOpError('no_tab', `Page ${record.agentId} was closed during the operation: call browser_tabs.`);
    let gone = false;
    try {
      gone = contents.isDestroyed() || contents.isCrashed();
    } catch {
      gone = true;
    }
    if (gone) return new AgentOpError('tab_not_loaded', `Page ${record.agentId} went away during the operation (${message.slice(0, 200)}).`);
    return new AgentOpError('unsupported', message.slice(0, 2000));
  }

  /**
   * Операция на странице в её очереди. Срок — с постановки (`deadline`), а не со старта: в очереди ждут до `opTimeoutMs`.
   * Проверки — сразу (быстрый отказ) и ещё раз перед запуском; `activity end` — в `finally` самой задачи, по её настоящему концу.
   */
  async function onPage<T>(request: BrowserAgentOpEvent, agentId: string, run: (contents: WebContents, record: PageRecord, signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = Date.now() + opTimeoutMs;
    const first = checked(request, agentId);
    return queue.run(pageKey(first.record.workKey, first.record.pageId), deadline, async (signal) => {
      // Пока операция ждала, человек мог выключить доступ, поставить панель на паузу или увести страницу на внешний сайт.
      if (!(await deps.agentsAllowed())) throw new AgentOpError('access_denied', AGENTS_OFF);
      const { record, contents } = checked(request, agentId);
      signal.throwIfAborted();
      deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'start' });
      try {
        return await run(contents, record, signal);
      } catch (error) {
        throw pageFailure(record, contents, signal, error);
      } finally {
        deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'end' });
      }
    });
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
    return { tab: registry.agentIdFor(workKey, answer.tabId), owner, url, reused: answer.reused, notes: answer.mounted ? [] : [NOT_MOUNTED_NOTE] };
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
        return failure('access_denied', AGENTS_OFF);
      }
      try {
        switch (request.op) {
          case 'open':
            return ok(await openOf(request, parsed.data as BrowserAgentArgs<'open'>));
          case 'tabs':
            return ok(await listTabs(registry, deps, request));
          case 'console': {
            const args = parsed.data as BrowserAgentArgs<'console'>;
            return ok(await onPage(request, args.tab, async (contents, record) => reads.consoleOf(contents, record, args)));
          }
          case 'network': {
            const args = parsed.data as BrowserAgentArgs<'network'>;
            return ok(await onPage(request, args.tab, (contents, record) => reads.networkOf(contents, record, args)));
          }
          case 'screenshot': {
            const args = parsed.data as BrowserAgentArgs<'screenshot'>;
            return ok(await onPage(request, args.tab, (contents, record, signal) => capture.screenshotOf(contents, record, request, args, signal)));
          }
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
      registry.register(e);
    },
    captureReady(id) {
      capture.captureReady(id);
    },
    reset() {
      registry.reset();
    },
  };
}
