/**
 * Операции агента над браузером окна в main (спека 2026-10-07-browser-devtools-agent-design.md, 3.7, 5.1–5.2, 7; этап B2:
 * `open`). Событие хоста `browser.agentOp` приходит сюда (`host-connection.ts#answerBrowserAgentOps`), ответ уходит
 * методом `browser.agentResult`.
 *
 * Агент называет только адрес: работу вкладки задаёт хост по токену сессии (`ref` события), а не аргументы. Открыть можно
 * любой http(s) (`openableHref`), до окна он доходит без учётных данных; читать и действовать можно на любом сайте
 * (решение владельца 2026-10-20: проверка «только loopback» снята), доступ решают хозяин, пауза панели и выключатель. Раскладка — дело окна:
 * место вкладки, предел страниц панели, повтор уже открытой страницы и тост решает рендерер (`renderer/browser/agent-open.ts`), main
 * просит его событием `browser:agent-open-tab`, ждёт ответ не дольше `AGENT_LIMITS.openMs` и переводит его в ответ агенту.
 * Страницы панелей main знает по реестру (`registerTab`, наполняет окно): по нему работает `tabs` (этап C), доступ к странице
 * решает хозяин из `owners` и пауза панели (`pageOf`). `open` просит окно поставить вкладку, ждёт её регистрации и загрузки (задача 18).
 *
 * Чей браузер получает страницу, решает `ownerOf` по правилу спеки 5.1 и по `owners` события — хозяевам, которых хост
 * вложил по карте работы (3.7, 3.10); хозяин вне списка — `access_denied`. Выбранный хозяин уходит окну в `AgentOpenTab`.
 *
 * Вкладку агент называет коротким id (`t1`, `t2`…): у каждой работы свой счёт, id держится, пока жив main. Этапы C и D
 * опираются на те же id.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DownloadItem, WebContents } from 'electron';
import { AGENT_LIMITS, browserAgentArgs } from '@parley/protocol';
import type { BrowserAgentArgs, BrowserAgentCloseResult, BrowserAgentErrorCode, BrowserAgentDownloadsResult, BrowserAgentNavigateResult, BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentResizeResult, BrowserAgentResult } from '@parley/protocol';
import { presetSpec, viewportSize } from '../../shared/browser-devtools.js';
import type { ViewportSpec } from '../../shared/browser-devtools.js';
import type { AgentActivity, AgentOpenTab, AgentOpenTabResult, AgentPageRegistration, AgentResize } from '../../shared/browser-types.js';
import type { BrowserOwner } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { redactSecretsInText, redactUrlsInText } from '../../shared/redact.js';
import { workKey as workKeyOf } from '../../shared/work-keys.js';
import { AgentOpError } from './agent-errors.js';
import type { AgentDownloads } from './agent-downloads.js';
import type { AgentScripts } from './agent-evaluate.js';
import type { AgentStorage } from './agent-storage.js';
import type { AgentWindow } from './agent-window.js';
import type { TypingClock } from './human-typing.js';
import { createAgentCapture } from './agent-capture.js';
import { createAgentActions, settleLoad, sleep, withNavigation } from './agent-actions.js';
import { createAgentDom } from './agent-dom.js';
import type { AgentCaptureDeps } from './agent-capture.js';
import { createPageRegistry, listTabs } from './agent-pages.js';
import type { PageRecord, PageRegistry } from './agent-pages.js';
import { createAgentInput } from './agent-input.js';
import type { InputGuard } from './agent-input.js';
import { createPageQueue } from './agent-queue.js';
import { createAgentReads } from './agent-reads.js';
import { clipUrl, urlForAgent } from './agent-url.js';
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
  inspector: Pick<Inspector, 'snapshot' | 'send' | 'responseBody' | 'onEvent'>;
  emulation: Pick<Emulation, 'current' | 'withTemporary' | 'fitOf'>;
  /** PNG снимка — в `drops/` (`main/drops.ts#saveImage`); `null` — не сохранился. */
  saveImage(png: Buffer): Promise<string | null>;
  /** Картинки в main — `nativeImage`, в тестах заглушка. */
  image: AgentCaptureDeps['image'];
  /** Агент действует на странице: окно-хозяин показывает это человеку. */
  activity(e: AgentActivity): void;
  /** Сколько ждать операцию на странице; по умолчанию `AGENT_LIMITS.opMs - 2_000`, чтобы очередь освобождалась раньше `timeout` хоста. */
  opTimeoutMs?: number;
  /** Срок одного вызова в госте и окне при снимке, см. `AgentCaptureDeps.guestCallMs`. */
  guestCallMs?: AgentCaptureDeps['guestCallMs'];
  /** Код main в изолированном мире гостя (прокрутка fullPage), см. `AgentCaptureDeps.inGuest`. */
  inGuest: AgentCaptureDeps['inGuest'];
  /** Высота содержимого окна гостя: выше {1,2 × высота} снимок не растят (Chromium тайлит поверхность). */
  windowHeight?: AgentCaptureDeps['windowHeight'];
  /** DPR экрана окна гостя, см. `AgentCaptureDeps.screenDpr`. */
  screenDpr?: AgentCaptureDeps['screenDpr'];
  /** Сколько ждать подтверждения окна, что `<webview>` стоит в размере снимка; по умолчанию `AGENT_LIMITS.captureReadyMs`. Тестам — меньше. */
  captureReadyMs?: number;
  /** Скрипты агента в мире страницы (11): единственный вход `Inspector.sendAgentScript`. */
  scripts: AgentScripts;
  /** Куки и хранилище страницы агента (12). */
  storage: AgentStorage;
  /** Скачивания агента (10): `downloads` читает список и папку сессии. */
  downloads: Pick<AgentDownloads, 'list' | 'dirOf'>;
  /** Окно операции агента (15b): скачивания и выбор файла в нём принадлежат агенту. */
  agentWindow: AgentWindow;
  /** Тишина клавиатуры человека (15b, рецензия M3). */
  typing: TypingClock;
  /** Просит окно поставить фокус на `<webview>` (событие `browser:agent-activity` с `focus`); `false` — окна нет. Только шлёт событие. */
  requestFocus?(contents: WebContents, id: string): boolean;
  /** Сколько ждать тишины клавиатуры и ответа окна о фокусе; по умолчанию `AGENT_LIMITS.focusMs`. Тестам — меньше. */
  focusMs?: number;
  /** Просит окно поставить размер вкладки (`browser:agent-resize`); `false` — окна нет. Ответа нет: размер видно по `emulation.current`. */
  resize(e: AgentResize): boolean;
  /** Шаг ожидания регистрации страницы `open` и размера `resize`; по умолчанию `AGENT_LIMITS.pollMs`. Тестам — меньше. */
  pollMs?: number;
  /** Сколько ждать, пока окно поставит размер; по умолчанию `AGENT_LIMITS.resizeMs`. Тестам — меньше. */
  resizeMs?: number;
  /** Домашняя папка для проверки секретных мест при загрузке файла; по умолчанию `os.homedir()`. Тестам — своя. */
  uploadHome?: string;
}

export interface AgentOps {
  run(request: BrowserAgentOpEvent): Promise<BrowserAgentResult>;
  /** Ответ окна на `browser:agent-open-tab` (канал `browser:agent-open-tab-result`); чужой и поздний id молча игнорируется. */
  openTabResult(requestId: string, result: AgentOpenTabResult): void;
  /** Окно сообщает о новом поколении документа, странице панели, её закрытии или паузе панели (спека 3.7, 4.8). */
  registerTab(e: AgentPageRegistration): void;
  /** Окно подтверждает, что `<webview>` стоит в размере снимка (канал `browser:agent-capture-ready`); чужой и поздний id молча игнорируется. */
  captureReady(id: string): void;
  /** Stop на значке агента: пауза панели страницы и обрыв операций всех страниц этой панели (канал `browser:agent-stop`). */
  stop(webContentsId: number): void;
  /** Ответ окна на просьбу о фокусе (канал `browser:agent-focus-ready`): `ok` — фокус на `<webview>`; на `end` с `focus` — фокус вернулся человеку. */
  focusReady(id: string, ok: boolean): void;
  /** Общий выключатель «Let agents use the browser» изменился: при `false` оборвать идущие операции. */
  accessChanged(allowed: boolean): void;
}

/** Схема аргументов по имени операции: хост другой версии может прислать незнакомую. */
type ArgsSchema = { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const ARGS: Partial<Record<string, ArgsSchema>> = browserAgentArgs;

const ok = (result: unknown): BrowserAgentResult => ({ ok: true, result });
const failure = (code: BrowserAgentErrorCode, message: string): BrowserAgentResult => ({ ok: false, error: { code, message: message.slice(0, 2000) } });

/** Пояснение агенту, когда работа вне LRU окна: вкладка в раскладке есть, гостя пока нет. */
export const NOT_MOUNTED_NOTE = "The workspace is not open in Parley's window, so the page loads when the human opens it.";

/** Отказ при выключенном общем «Let agents use the browser». */
const AGENTS_OFF = `The human turned off agent access to the browser (Settings → Browser → ${S.settings.letAgentsUseBrowser}).`;

/** Пауза панели: общий текст для `pageOf`, `registerTab` и Stop. */
const PAUSED = 'The human paused agents in this browser panel (paused by the human).';
const STOPPED = 'Stopped by the human: agents are paused in this browser panel (paused by the human).';
const HUMAN_TYPING = "The human is typing in Parley's window: retry in a moment.";
const HUMAN_BUSY = 'The human is selecting or annotating on this page: retry in a moment.';
/** D1: нажатие человека пришло в страницу, пока фокус одолжен агенту, — погашено, операция оборвана. */
const HUMAN_KEY = 'The human started typing while you held the keyboard; nothing of theirs reached the page. Your action may be partly done: check the page, wait a moment and retry.';
/**
 * Хвост D1: сколько после `end` ждать подтверждения окна, что фокус вернулся человеку, пока нажатия в странице агента ещё
 * гасятся. Окно отвечает за миллисекунды; срок — на случай, если ответа нет (окно закрыто, гость без лендера).
 */
const FOCUS_RETURN_MS = 300;
/** B1: клавиатуру окна держит операция ввода другой страницы (другой агент или параллельный вызов того же). */
const KEYBOARD_BUSY = "Another agent is using the keyboard in Parley's window: retry in a moment.";

/** Что операции нужно от страницы: `changes` — меняет страницу (отказ при `human_busy`), `window` — открывает окно операции, `seen` — нужна страница, которую человек видел. */
export interface PageUse {
  changes?: boolean;
  window?: boolean;
  seen?: boolean;
}

/** 15b: окно операции (перехват выбора файла, скачивания, подавление `browser:focus`); в 15a его нет. */
export interface PageWindowHooks {
  begin(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent): () => void;
}

export interface PageRunner {
  run<T>(request: BrowserAgentOpEvent, agentId: string, task: (contents: WebContents, record: PageRecord, guard: InputGuard) => Promise<T>, use?: PageUse): Promise<T>;
  /** Обрыв операций всех страниц панели с этой причиной (Stop, пауза панели). */
  stopPanel(workKey: string, owner: BrowserOwner, reason: AgentOpError): void;
  /** Общий выключатель: `false` обрывает все идущие операции. */
  accessChanged(allowed: boolean): void;
}

const ownerKey = (owner: BrowserOwner): string => (owner.kind === 'session' ? `session:${owner.sessionId}` : `room:${owner.roomId}`);

export function createPageRunner(deps: {
  registry: PageRegistry;
  agentsAllowed(): Promise<boolean>;
  activity(e: AgentActivity): void;
  opTimeoutMs?: number;
  window?: PageWindowHooks;
  /**
   * Тишина клавиатуры человека: пока он печатает, `guard.keyboardQuiet()` отказывает `human_busy` (15b, рецензия пачки 3);
   * `guard.lendFocus()` до конца операции гасит нажатия человека в странице и обрывает операцию `human_busy` (D1).
   */
  typing?: Pick<TypingClock, 'idleFor' | 'lend'>;
  /** Ждёт, пока окно подтвердит возврат фокуса человеку по `end` с этим id (`FocusBorrower.focusReturned`); без него одолжение снимается сразу. */
  focusReturned?(id: string): Promise<void>;
}): PageRunner {
  const { registry } = deps;
  const opTimeoutMs = deps.opTimeoutMs ?? AGENT_LIMITS.opMs - 2_000;
  const queue = createPageQueue();
  /** Синхронный флаг выключателя для `guard.check()`; `agentsAllowed` читает файл настроек и асинхронен. */
  let allowed = true;
  /** Идущие операции: свой обрыв у каждой, ключ панели — работа и хозяин. */
  const running = new Set<{ panel: string; abort(reason: AgentOpError): void }>();

  /** Страница по id агента: выключатель, доступ (`pageOf`), состояние гостя. */
  function checked(request: BrowserAgentOpEvent, agentId: string, use: PageUse): { record: PageRecord; contents: WebContents } {
    // Синхронный флаг: чтение файла настроек, начатое до сохранения, может отдать `true` уже после выключения (финальная рецензия m6).
    if (!allowed) throw new AgentOpError('access_denied', AGENTS_OFF);
    const record = registry.pageOf(request, agentId);
    const contents = registry.live(record);
    if (contents === null) throw new AgentOpError('tab_not_loaded', `Page ${agentId} is not loaded: its panel or workspace is not open in the window.`);
    if (contents.isCrashed()) throw new AgentOpError('tab_not_loaded', `The page ${agentId} crashed.`);
    if (use.seen === true && !record.seen) throw new AgentOpError('tab_hidden', `Page ${agentId} has not been shown to the human yet: ask the human to show the page.`);
    if (use.changes === true && record.humanBusy) throw new AgentOpError('human_busy', HUMAN_BUSY);
    return { record, contents };
  }

  /** Ошибка не `AgentOpError` внутри страницы: оборвали — причина обрыва; записи нет — `no_tab`; гость уничтожен или упал — `tab_not_loaded`; иначе `unsupported`. */
  function pageFailure(record: PageRecord, contents: WebContents, signal: AbortSignal, error: unknown): AgentOpError {
    if (error instanceof AgentOpError) return error;
    if (signal.aborted) return signal.reason instanceof AgentOpError ? signal.reason : new AgentOpError('timeout', 'The operation was cancelled: it took too long.');
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
   * Stop, пауза панели и выключатель обрывают идущую задачу: она получает `guard.signal`, а результат отбрасывается.
   */
  async function run<T>(request: BrowserAgentOpEvent, agentId: string, task: (contents: WebContents, record: PageRecord, guard: InputGuard) => Promise<T>, use: PageUse = {}): Promise<T> {
    const deadline = Date.now() + opTimeoutMs;
    const first = checked(request, agentId, use);
    return queue.run(`${first.record.workKey}\n${first.record.pageId}`, deadline, async (queueSignal) => {
      // Пока операция ждала, человек мог выключить доступ, поставить панель на паузу или занять страницу.
      if (!(await deps.agentsAllowed())) throw new AgentOpError('access_denied', AGENTS_OFF);
      const { record, contents } = checked(request, agentId, use);
      queueSignal.throwIfAborted();
      const control = new AbortController();
      const signal = AbortSignal.any([queueSignal, control.signal]);
      const entry = { panel: `${record.workKey}\n${ownerKey(record.owner)}`, abort: (reason: AgentOpError): void => control.abort(reason) };
      running.add(entry);
      // Одолженный фокус (D1) и аренда клавиатуры окна (B1): держатся до конца операции, пока окно не вернуло фокус человеку.
      // Тип — приведением: присваивает его замыкание `lendFocus`, иначе TS сузит переменную до `null` в `finally`.
      let lent = null as { unlend(): void; release(): void } | null;
      const guard: InputGuard = {
        signal,
        check() {
          if (!allowed) throw new AgentOpError('access_denied', AGENTS_OFF);
          if (registry.isPaused(record.workKey, record.owner)) throw new AgentOpError('access_denied', PAUSED);
          if (use.changes === true && registry.fresh(record)?.humanBusy === true) throw new AgentOpError('human_busy', HUMAN_BUSY);
          signal.throwIfAborted();
        },
        keyboardQuiet() {
          if (deps.typing?.idleFor(AGENT_LIMITS.typingIdleMs) === false) throw new AgentOpError('human_busy', HUMAN_TYPING);
        },
        lendFocus(release) {
          // Одалживание — одно на операцию (`AgentInput` помнит его по signal): повтор вторую аренду не держит.
          if (lent !== null) {
            release();
            return;
          }
          const unlend = deps.typing?.lend(contents.id, () => control.abort(new AgentOpError('human_busy', HUMAN_KEY))) ?? ((): void => undefined);
          lent = { unlend, release };
        },
      };
      const endWindow = use.window === true ? (deps.window?.begin(contents, record, request) ?? null) : null;
      deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'start' });
      try {
        // Только обрыв человека (Stop, пауза, выключатель) отпускает очередь сразу; срок очереди держит её до настоящего конца задачи.
        const aborted = new Promise<never>((_resolve, reject) => {
          control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true });
        });
        // Незавершённая задача после обрыва не должна оставить необработанный отказ.
        const working = task(contents, record, guard);
        working.catch(() => undefined);
        return await Promise.race([working, aborted]);
      } catch (error) {
        throw pageFailure(record, contents, signal, error);
      } finally {
        running.delete(entry);
        const held = lent;
        const free = (): void => {
          held?.unlend();
          held?.release();
        };
        let returned: Promise<unknown> | null = null;
        // Сбой окна или журнала в конце операции не должен держать общую аренду клавиатуры навсегда (повторная рецензия,
        // minor-1): освобождение назначается во внутреннем finally при любом исходе.
        try {
          endWindow?.();
          // Окно возвращает фокус человеку по `end` и подтверждает это ответом на `focus.id`. До подтверждения (не дольше
          // `focusReturnMs`) нажатие в странице агента всё ещё чужое: оно гасится, а обрывать уже нечего (финальная рецензия
          // m1). Аренда клавиатуры — тогда же: просьба о фокусе следующей операции придёт окну после возврата этой.
          const back = held === null || deps.focusReturned === undefined ? null : randomUUID();
          // Ожидание ставится до `end`: окно может ответить раньше, чем main вернётся сюда.
          returned = back === null || deps.focusReturned === undefined ? null : deps.focusReturned(back);
          deps.activity({ webContentsId: contents.id, session: request.label, op: request.op, phase: 'end', ...(back === null ? {} : { focus: { id: back } }) });
        } finally {
          if (returned === null) free();
          else void returned.then(free, free);
        }
      }
    });
  }

  return {
    run,
    stopPanel(workKey, owner, reason) {
      const panel = `${workKey}\n${ownerKey(owner)}`;
      for (const entry of [...running]) if (entry.panel === panel) entry.abort(reason);
    },
    accessChanged(next) {
      allowed = next;
      if (next) return;
      const reason = new AgentOpError('access_denied', AGENTS_OFF);
      for (const entry of [...running]) entry.abort(reason);
    },
  };
}

/** Заметка агенту: страница открыла выбор файла, человеку ничего не показано. */
const FILE_CHOOSER_NOTE =
  'The page opened a file chooser; nothing was shown to the human. Take a browser_snapshot and use browser_action with action upload on the file input.';

/**
 * Окно операции для `createPageRunner` (15b): учёт окна (`agentWindow`) и перехват выбора файла на время окна и хвоста.
 * Перехват включается один раз на окно, а не на каждую операцию, и снимается, когда окно и хвост кончились. Гость агента
 * из тишины клавиатуры человека не исключается: CDP-ввод агента `before-input-event` не порождает (проба D1), и нажатие в
 * его странице до одалживания — человека, одалживание должно его подождать (финальная рецензия m5).
 */
export function createWindowHooks(deps: {
  agentWindow: AgentWindow;
  inspector: Pick<Inspector, 'send' | 'onEvent'>;
}): PageWindowHooks {
  const { agentWindow, inspector } = deps;
  /** Гости с включённым перехватом → отписка от `Page.fileChooserOpened`. */
  const intercepted = new Map<number, () => void>();
  agentWindow.onIdle((id) => {
    const unsubscribe = intercepted.get(id);
    if (unsubscribe === undefined) return;
    intercepted.delete(id);
    unsubscribe();
    // Гость мог исчезнуть вместе с окном: снимать нечего.
    void Promise.resolve(inspector.send(id, 'Page.setInterceptFileChooserDialog', { enabled: false })).catch(() => undefined);
  });
  return {
    begin(contents, record, request) {
      const id = contents.id;
      const end = agentWindow.begin({
        pageKey: `${record.workKey}\n${record.pageId}`,
        webContentsId: id,
        workKey: record.workKey,
        sessionId: request.ref.sessionId,
        agentId: record.agentId,
      });
      if (!intercepted.has(id)) {
        intercepted.set(id, inspector.onEvent(id, 'Page.fileChooserOpened', () => agentWindow.note(id, FILE_CHOOSER_NOTE)));
        void Promise.resolve(inspector.send(id, 'Page.setInterceptFileChooserDialog', { enabled: true })).catch(() => undefined);
      }
      return end;
    },
  };
}

/**
 * Скачивание во время окна операции агента (или 2 с после) — в папку сессии без диалога, заметка в ответ операции; вне окна
 * `false`, и страж ведёт скачивание как у человека. В `claim` уходит страница-источник (`tN`).
 */
export function routeDownload(
  item: DownloadItem,
  source: Pick<WebContents, 'id'>,
  deps: { agentWindow: Pick<AgentWindow, 'activeFor' | 'note'>; downloads: Pick<AgentDownloads, 'claim'> },
): boolean {
  const owner = deps.agentWindow.activeFor(source.id);
  if (owner === null) return false;
  const record = deps.downloads.claim(item, { workKey: owner.workKey, sessionId: owner.sessionId, tab: owner.agentId });
  // Имя файла задаёт сервер — это данные страницы, а заметка идёт агенту вне ограды: имя и путь — только в огороженном
  // списке `browser_downloads` (финальная рецензия m2).
  deps.agentWindow.note(source.id, `The page started download ${record.id} into ${path.dirname(record.path)}: browser_downloads shows its file name.`);
  return true;
}

export interface FocusBorrower {
  /** Одалживание фокуса для страницы `agentId` — это `borrowFocus` из `createAgentInput`. Бросает `human_busy`, `window_not_connected`, `tab_hidden`, `timeout` (клавиатуру держит другая операция). */
  borrow(agentId: string): (contents: WebContents, guard: InputGuard) => Promise<void>;
  /** Ответ окна на просьбу о фокусе и на `end` с `focus` (фокус вернулся человеку); чужой и поздний id молча игнорируется. */
  focusReady(id: string, ok: boolean): void;
  /** Ждёт, пока окно подтвердит возврат фокуса по `end` с этим id, не дольше `focusReturnMs`; не отказывает. */
  focusReturned(id: string): Promise<void>;
}

/** Аренда по очереди: `acquire` ждёт не дольше `limitMs`, `null` — не дождались; обрыв `signal` — отказ с его причиной. */
interface Lease {
  acquire(signal: AbortSignal, limitMs: number): Promise<(() => void) | null>;
}

function createLease(): Lease {
  let busy = false;
  /** Ждущие по порядку постановки: вызов отдаёт аренду следующему. */
  const waiting: Array<() => void> = [];
  const grant = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiting.shift();
      if (next === undefined) busy = false;
      else next();
    };
  };
  return {
    acquire(signal, limitMs) {
      if (signal.aborted) return Promise.reject(signal.reason as Error);
      if (!busy) {
        busy = true;
        return Promise.resolve(grant());
      }
      return new Promise((resolve, reject) => {
        function leave(): void {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          const at = waiting.indexOf(turn);
          if (at >= 0) waiting.splice(at, 1);
        }
        function turn(): void {
          leave();
          resolve(grant());
        }
        function onAbort(): void {
          leave();
          reject(signal.reason as Error);
        }
        const timer = setTimeout(() => {
          leave();
          resolve(null);
        }, limitMs);
        waiting.push(turn);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/**
 * Одалживание фокуса `<webview>` для ввода агента (путь А, решения владельца 7 и 8): ждём тишину клавиатуры человека,
 * просим окно поставить фокус и ждём его ответ. `ok` не требует видимости: у скрытой страницы, которую человек видел,
 * фокус встаёт; `tab_hidden` — только отказ фокуса. `host.focus()` и `guest.focus()` не зовутся (спайк В4 (2)).
 * Фокус считается одолженным (`guard.lendFocus`, D1) с просьбы окну: окно может поставить его раньше, чем main узнает ответ.
 *
 * Клавиатура окна одна (финальная рецензия B1): две операции ввода сразу (две сессии, комната с двумя агентами, два
 * параллельных `browser_action` одного агента) перекладывали бы фокус друг у друга — шаги одной уходили бы в страницу
 * другой, а возврат фокуса человеку шёл бы по цепочке в страницу агента. Поэтому одалживание берёт аренду (одну на
 * `createFocusBorrower`, а он один на main) до тишины и просьбы окну, ждёт её не дольше `focusMs` и отдаёт в `guard.lendFocus`: runner
 * отпускает её вместе с одолжением.
 */
export function createFocusBorrower(deps: {
  typing: Pick<TypingClock, 'waitIdle'>;
  requestFocus?(contents: WebContents, id: string): boolean;
  focusMs?: number;
  /** Запасной срок подтверждения возврата фокуса; по умолчанию `FOCUS_RETURN_MS`. Тестам — меньше. */
  focusReturnMs?: number;
}): FocusBorrower {
  const focusMs = deps.focusMs ?? AGENT_LIMITS.focusMs;
  const focusReturnMs = deps.focusReturnMs ?? FOCUS_RETURN_MS;
  const pending = new Map<string, (ok: boolean) => void>();
  const keyboard = createLease();

  /** Просьба окну поставить фокус и ожидание ответа не дольше `focusMs`. */
  async function askFocus(agentId: string, contents: WebContents, signal: AbortSignal): Promise<void> {
    const id = randomUUID();
    const answered = new Promise<boolean>((resolve) => {
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        pending.delete(id);
        resolve(ok);
      };
      const onAbort = (): void => done(false);
      const timer = setTimeout(() => done(false), focusMs);
      pending.set(id, done);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let sent = false;
    try {
      sent = deps.requestFocus?.(contents, id) ?? false;
    } catch {
      // Окно закрыто посреди вызова — как будто его нет.
    }
    if (!sent) {
      pending.get(id)?.(false);
      throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    }
    const ok = await answered;
    signal.throwIfAborted();
    if (!ok) throw new AgentOpError('tab_hidden', `Page ${agentId} could not take keyboard focus: ask the human to show the page.`);
  }

  return {
    focusReady(id, ok) {
      pending.get(id)?.(ok);
    },
    focusReturned(id) {
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          pending.delete(id);
          resolve();
        };
        const timer = setTimeout(done, focusReturnMs);
        pending.set(id, done);
      });
    },
    borrow: (agentId) => async (contents, guard) => {
      const { signal } = guard;
      const release = await keyboard.acquire(signal, focusMs);
      if (release === null) throw new AgentOpError('timeout', KEYBOARD_BUSY);
      let handed = false;
      try {
        if (!(await deps.typing.waitIdle(AGENT_LIMITS.typingIdleMs, focusMs, signal))) throw new AgentOpError('human_busy', HUMAN_TYPING);
        signal.throwIfAborted();
        if (guard.lendFocus !== undefined) {
          guard.lendFocus(release);
          handed = true;
        }
        await askFocus(agentId, contents, signal);
      } finally {
        // Аренду не взял runner (отказ до одолжения или вызов без него): она кончается здесь.
        if (!handed) release();
      }
    },
  };
}

/**
 * Адрес, который агент может открыть: любой http(s), без учётных данных; иначе `null` (`file:`, `javascript:`, `data:` и
 * прочие схемы, не-адрес). Фрагмент (#…) остаётся: им бывают маршруты SPA. Читать и управлять можно на любом http(s) (решение владельца 2026-10-20).
 */
export function openableHref(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.username = '';
  parsed.password = '';
  return parsed.href;
}

/**
 * Адрес для `navigate`: абсолютный http(s) как есть, путь от `/` — от адреса страницы; иное (`file:`, `javascript:`, `chrome:`,
 * не-адрес, страница без http(s)-адреса) — `null`. Итог проходит `openableHref` (без учётных данных).
 */
export function resolveAgentUrl(raw: string, base: string): string | null {
  const direct = openableHref(raw);
  if (direct !== null) return direct;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  try {
    return openableHref(new URL(raw, base).href);
  } catch {
    return null;
  }
}

/** Размер для окна по аргументам `resize`: пресет (DPR — правило меню), свой размер (не мобильный, DPR текущий или 1) или `fit` (`null`). */
export function agentViewport(args: BrowserAgentArgs<'resize'>, current: ViewportSpec | null): ViewportSpec | null {
  if (args.fit === true) return null;
  if (args.preset !== undefined) return presetSpec(args.preset, args.rotated === true, current);
  return { width: args.width ?? 0, height: args.height ?? 0, mobile: false, dpr: current?.dpr ?? 1 };
}

/** Один и тот же размер: `current` отдаёт спеку как есть, но порядок полей не гарантирован. */
function sameViewport(a: ViewportSpec | null, b: ViewportSpec | null): boolean {
  if (a === null || b === null) return a === b;
  if ('preset' in a || 'preset' in b) return 'preset' in a && 'preset' in b && a.preset === b.preset && a.rotated === b.rotated && a.dpr === b.dpr;
  return a.width === b.width && a.height === b.height && a.mobile === b.mobile && a.dpr === b.dpr;
}

/** Заголовок страницы для ответа: маска и не длиннее 200 знаков (как в `tabs`). */
const titleForAgent = (title: string): string => redactSecretsInText(redactUrlsInText(title)).slice(0, 200);

/** Заметка агенту: окно ответило, но страница ещё не появилась в реестре. */
const NOT_STARTED_NOTE = 'The page has not started yet; call browser_tabs in a moment.';

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
  const pollMs = deps.pollMs ?? AGENT_LIMITS.pollMs;
  const resizeMs = deps.resizeMs ?? AGENT_LIMITS.resizeMs;
  /** Ждущие ответа окна: id просьбы → продолжение. */
  const pendingOpens = new Map<string, (result: AgentOpenTabResult | 'no_window' | 'timeout') => void>();
  const registry = createPageRegistry({ fromId: deps.fromId });
  const focus = createFocusBorrower({ typing: deps.typing, ...(deps.requestFocus === undefined ? {} : { requestFocus: deps.requestFocus }), ...(deps.focusMs === undefined ? {} : { focusMs: deps.focusMs }) });
  const runner = createPageRunner({
    registry,
    agentsAllowed: deps.agentsAllowed,
    activity: deps.activity,
    window: createWindowHooks({ agentWindow: deps.agentWindow, inspector: deps.inspector }),
    typing: deps.typing,
    focusReturned: focus.focusReturned,
    ...(deps.opTimeoutMs === undefined ? {} : { opTimeoutMs: deps.opTimeoutMs }),
  });
  const reads = createAgentReads({ inspector: deps.inspector });
  const dom = createAgentDom({ inspector: deps.inspector });
  const capture = createAgentCapture({ inspector: deps.inspector, emulation: deps.emulation, registry, dom, saveImage: deps.saveImage, image: deps.image, activity: deps.activity, inGuest: deps.inGuest, ...(deps.captureReadyMs === undefined ? {} : { captureReadyMs: deps.captureReadyMs }), ...(deps.guestCallMs === undefined ? {} : { guestCallMs: deps.guestCallMs }), ...(deps.windowHeight === undefined ? {} : { windowHeight: deps.windowHeight }), ...(deps.screenDpr === undefined ? {} : { screenDpr: deps.screenDpr }) });

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
    const url = openableHref(args.url);
    if (url === null) {
      throw new AgentOpError('bad_request', 'Only http(s) pages can be opened: pass an absolute URL such as https://example.com/ or http://localhost:5173/.');
    }
    const owner = ownerOf(request, args);
    const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
    // Человек приостановил агентов в этой панели: страницу в ней не открываем, как не работаем с уже открытыми (спека 4.8, S5).
    if (registry.isPaused(workKey, owner)) throw new AgentOpError('access_denied', PAUSED);
    const answer = await askWindow({ requestId: randomUUID(), workKey, url, sessionId: request.ref.sessionId, session: request.label, owner });
    if (answer === 'no_window') throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    if (answer === 'timeout') throw new AgentOpError('timeout', `The window did not place the tab within ${Math.round(openMs / 1000)} s.`);
    if ('error' in answer) {
      throw answer.error === 'limit'
        ? new AgentOpError('bad_request', `This browser panel already has ${AGENT_LIMITS.panelPages} pages, the most Parley allows. Close one of your pages with browser_close, or ask the human to close one.`)
        : new AgentOpError('window_not_connected', "Parley's window does not know this workspace yet: try again in a moment.");
    }
    if ('closed' in answer) throw new AgentOpError('unsupported', 'The window answered the open request as a close.');
    const agentId = registry.agentIdFor(workKey, answer.tabId);
    const base = { tab: agentId, owner, url: clipUrl(url), reused: answer.reused };
    if (!answer.mounted) return { ...base, loaded: false, title: '', notes: [NOT_MOUNTED_NOTE] };
    // Страницу регистрирует окно, когда `<webview>` готов: ждём запись не дольше `openMs`, дальше — загрузку через runner.
    const until = Date.now() + openMs;
    while (!registered(request, agentId)) {
      const left = until - Date.now();
      if (left <= 0) return { ...base, loaded: false, title: '', notes: [NOT_STARTED_NOTE] };
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, left)));
    }
    return runner.run(request, agentId, async (contents, record, guard) => {
      const loaded = await settleLoad(contents, AGENT_LIMITS.loadMs, guard.signal);
      return { ...base, loaded, title: titleForAgent(contents.getTitle()), notes: deps.agentWindow.take(`${record.workKey}\n${record.pageId}`) };
    }, { window: true });
  }

  /**
   * `close`: окно закрывает страницу как крестик человека (тот же канал, что `open`, `closePage`); решает окно — у него раскладка
   * и признак «открыта агентом». Доступ, паузу и `human_busy` проверил `runner.run` до этого.
   */
  async function closeOf(request: BrowserAgentOpEvent, contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'close'>): Promise<BrowserAgentCloseResult> {
    const url = urlForAgent(contents.getURL());
    const answer = await askWindow({ requestId: randomUUID(), workKey: record.workKey, url: '', sessionId: request.ref.sessionId, session: request.label, owner: record.owner, closePage: record.pageId });
    if (answer === 'no_window') throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    if (answer === 'timeout') throw new AgentOpError('timeout', `The window did not close the page within ${Math.round(openMs / 1000)} s.`);
    if ('error' in answer) {
      if (answer.error === 'not_agent') throw new AgentOpError('access_denied', `Page ${args.tab} was opened by the human, not by an agent: only the human can close it. Close pages that you opened with browser_open.`);
      if (answer.error === 'no_page') throw new AgentOpError('no_tab', `Page ${args.tab} is already closed: call browser_tabs.`);
      throw new AgentOpError('window_not_connected', "Parley's window does not know this workspace yet: try again in a moment.");
    }
    return { tab: args.tab, url, done: `Closed ${args.tab}.` };
  }

  /** Страница агента уже в реестре и у неё есть живой гость. Пауза и чужой хозяин — отказ, как у прочих операций. */
  function registered(request: BrowserAgentOpEvent, agentId: string): boolean {
    try {
      return registry.live(registry.pageOf(request, agentId)) !== null;
    } catch (error) {
      if (error instanceof AgentOpError && error.code === 'no_tab') return false;
      throw error;
    }
  }

  /** `navigate`: переход методом `webContents`; загрузку ждёт `withNavigation` до `loadMs`. */
  async function navigateOf(contents: WebContents, record: PageRecord, args: BrowserAgentArgs<'navigate'>, guard: InputGuard): Promise<BrowserAgentNavigateResult> {
    const target = args.url === undefined ? null : resolveAgentUrl(args.url, contents.getURL());
    if (args.url !== undefined && target === null) {
      throw new AgentOpError('bad_request', 'Only http(s) pages can be opened: pass an absolute URL such as https://example.com/, or a path starting with / on the current site.');
    }
    const notes: string[] = [];
    const failure = { text: null as string | null };
    const history = contents.navigationHistory;
    const act = async (): Promise<void> => {
      guard.check();
      if (target !== null) {
        // ERR_ABORTED — не ошибка: так отвечает переход, ставший скачиванием. Загрузку ждёт withNavigation, а не обещание.
        contents.loadURL(target).catch((error: unknown) => {
          const text = error instanceof Error ? error.message : String(error);
          if (!/ERR_ABORTED/.test(text)) failure.text = text;
        });
      } else if (args.back === true) {
        if (history.canGoBack()) history.goBack();
        else notes.push('There is no page to go back to.');
      } else if (args.forward === true) {
        if (history.canGoForward()) history.goForward();
        else notes.push('There is no page to go forward to.');
      } else if (args.hard === true) {
        contents.reloadIgnoringCache();
      } else {
        contents.reload();
      }
    };
    const outcome = await withNavigation(contents, act, guard.signal);
    if (failure.text !== null) notes.push(`The page failed to load: ${titleForAgent(failure.text)}`);
    return {
      tab: args.tab,
      url: urlForAgent(contents.getURL()),
      title: titleForAgent(contents.getTitle()),
      loaded: outcome.loaded && failure.text === null,
      notes: [...notes, ...deps.agentWindow.take(`${record.workKey}\n${record.pageId}`)],
    };
  }

  /** `resize`: просит окно, ждёт, пока размер встанет (`emulation.current`), не дольше `resizeMs`. */
  async function resizeOf(contents: WebContents, args: BrowserAgentArgs<'resize'>, guard: InputGuard): Promise<BrowserAgentResizeResult> {
    const id = contents.id;
    const spec = agentViewport(args, deps.emulation.current(id));
    guard.check();
    if (!deps.resize({ webContentsId: id, viewport: spec })) throw new AgentOpError('window_not_connected', "Parley's window is not ready: ask the human to open it.");
    const until = Date.now() + resizeMs;
    while (!sameViewport(deps.emulation.current(id), spec)) {
      const left = until - Date.now();
      if (left <= 0) throw new AgentOpError('timeout', `Parley's window did not apply the size within ${Math.round(resizeMs / 1000)} s.`);
      await sleep(Math.min(pollMs, left), guard.signal);
    }
    const size = spec === null ? null : viewportSize(spec);
    return { tab: args.tab, url: urlForAgent(contents.getURL()), viewport: size === null ? null : { width: size.width, height: size.height, emulated: true } };
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
            return ok(await runner.run(request, args.tab, async (contents, record) => reads.consoleOf(contents, record, args)));
          }
          case 'network': {
            const args = parsed.data as BrowserAgentArgs<'network'>;
            return ok(await runner.run(request, args.tab, (contents, record) => reads.networkOf(contents, record, args)));
          }
          case 'screenshot': {
            const args = parsed.data as BrowserAgentArgs<'screenshot'>;
            return ok(await runner.run(request, args.tab, (contents, record, guard) => capture.screenshotOf(contents, record, request, args, guard.signal)));
          }
          case 'snapshot': {
            const args = parsed.data as BrowserAgentArgs<'snapshot'>;
            return ok(await runner.run(request, args.tab, (contents, record) => dom.snapshotOf(contents, record, args)));
          }
          case 'wait_for': {
            const args = parsed.data as BrowserAgentArgs<'wait_for'>;
            return ok(await runner.run(request, args.tab, (contents, record, guard) => dom.waitFor(contents, record, args, guard.signal)));
          }
          case 'action': {
            const args = parsed.data as BrowserAgentArgs<'action'>;
            // Ввод агента: одалживание фокуса знает страницу (`borrow(agentId)`), поэтому ввод и действия — на вызов.
            const actions = createAgentActions({
              inspector: deps.inspector,
              input: createAgentInput({ inspector: deps.inspector, borrowFocus: focus.borrow(args.tab) }),
              dom,
              emulation: deps.emulation,
              window: deps.agentWindow,
              activity: deps.activity,
              ...(deps.uploadHome === undefined ? {} : { home: deps.uploadHome }),
            });
            return ok(await runner.run(request, args.tab, (contents, record, guard) => actions.actionOf(contents, record, request, args, guard), { changes: true, window: true, seen: true }));
          }
          case 'navigate': {
            const args = parsed.data as BrowserAgentArgs<'navigate'>;
            return ok(await runner.run(request, args.tab, (contents, record, guard) => navigateOf(contents, record, args, guard), { changes: true, window: true }));
          }
          case 'resize': {
            const args = parsed.data as BrowserAgentArgs<'resize'>;
            return ok(await runner.run(request, args.tab, (contents, _record, guard) => resizeOf(contents, args, guard), { changes: true }));
          }
          case 'evaluate': {
            const args = parsed.data as BrowserAgentArgs<'evaluate'>;
            return ok(await runner.run(request, args.tab, (contents, record, guard) => {
              // Ссылка — из текущего снимка страницы; устаревшая — stale_ref до всякого скрипта.
              const element = args.ref === undefined ? null : dom.nodeOf(contents, record, args.ref);
              return deps.scripts.evaluateOf(contents, record.agentId, args, element, guard.signal);
            }, { changes: true, window: true }));
          }
          case 'cookies': {
            const args = parsed.data as BrowserAgentArgs<'cookies'>;
            return ok(await runner.run(request, args.tab, (contents, record) => deps.storage.cookiesOf(contents, record.agentId, args)));
          }
          case 'storage': {
            const args = parsed.data as BrowserAgentArgs<'storage'>;
            return ok(await runner.run(request, args.tab, (contents, record) => deps.storage.storageOf(contents, record.agentId, args)));
          }
          case 'close': {
            const args = parsed.data as BrowserAgentArgs<'close'>;
            return ok(await runner.run(request, args.tab, (contents, record) => closeOf(request, contents, record, args), { changes: true }));
          }
          case 'downloads': {
            // Без страницы, как `tabs`: список и папка сессии запроса.
            const workKey = workKeyOf(request.ref.projectPath, request.ref.workId);
            return ok({ dir: deps.downloads.dirOf(workKey, request.ref.sessionId), downloads: deps.downloads.list(workKey, request.ref.sessionId), notes: [] } satisfies BrowserAgentDownloadsResult);
          }
          default:
            // Остаётся защитой от операции новее окна.
            return failure('unsupported', `This window does not run ${String(request.op)} yet.`);
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
      // «Pause agents» посреди операции: идущие операции панели обрываются, как при Stop.
      if (e.kind === 'paused' && e.paused) runner.stopPanel(e.workKey, e.owner, new AgentOpError('access_denied', PAUSED));
    },
    captureReady(id) {
      capture.captureReady(id);
    },
    stop(webContentsId) {
      const record = registry.pauseFor(webContentsId);
      if (record !== null) runner.stopPanel(record.workKey, record.owner, new AgentOpError('access_denied', STOPPED));
    },
    focusReady(id, ok) {
      focus.focusReady(id, ok);
    },
    accessChanged(allowed) {
      runner.accessChanged(allowed);
    },
  };
}
