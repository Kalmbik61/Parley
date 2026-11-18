// packages/desktop/src/main/browser/agent-actions.ts
/**
 * Действия агента на странице, `browser_action` (этап D, задача 17; спека 5.1, 4.8): клик, двойной клик, наведение,
 * ввод, клавиши, прокрутка, выбор в `<select>`, флажки, перетаскивание и загрузка файла в поле.
 *
 * Ввод — только через `AgentInput` (прямых `send('Input.…')` здесь нет); перед каждым шагом `AgentInput` зовёт
 * `guard.check()`. Точку клика рисует окно: сюда приходит событие `step` с точкой в пикселях `<webview>`. Переход, начатый
 * действием, дожидается `withNavigation`; заметки окна операции (скачивание, выбор файла) уходят в ответ.
 */
import { realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import type { BrowserAgentActionResult, BrowserAgentArgs, BrowserAgentOpEvent } from '@parley/protocol';
import type { AgentActivity } from '../../shared/browser-types.js';
import { AgentOpError } from './agent-errors.js';
import type { AgentDom } from './agent-dom.js';
import { changeOf } from './agent-settle.js';
import type { AgentSettle, BrowserAgentChange, PageProbe } from './agent-settle.js';
import { inputPoint, keySpec, modifierMask, viewPoint } from './agent-input.js';
import type { AgentInput, InputGuard, MouseStep } from './agent-input.js';
import type { PageRecord } from './agent-pages.js';
import { urlForAgent } from './agent-url.js';
import type { AgentWindow } from './agent-window.js';
import { BASIC_AUTH_HINT, type BasicAuth } from './basic-auth.js';
import { CLIENT_CERT_HINT, humanWait, type ClientCert } from './client-cert.js';
import type { Emulation } from './emulation.js';
import type { Inspector } from './inspector.js';
import { HIT_TEST_FN, SELECT_OPTION_FN } from './page-fns.js';
import { cutCodePoints } from '../../shared/code-points.js';
import { fence } from '../../shared/context-markdown.js';
import { S } from '../../shared/strings.js';

/** Один шаг списка `steps` (поля действия без `tab`). */
type BrowserAgentStep = NonNullable<BrowserAgentArgs<'action'>['steps']>[number];
type StepResult = NonNullable<BrowserAgentActionResult['steps']>[number];

/** Итог одного исполненного шага: что сделано, переход, дождана ли загрузка, что изменилось. */
interface StepOutcome {
  done: string;
  navigated: boolean;
  loaded: boolean;
  change: BrowserAgentChange;
  pageData?: string;
}

export interface AgentActions {
  actionOf(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentArgs<'action'>, guard: InputGuard): Promise<BrowserAgentActionResult>;
}

/** Папки от домашней, откуда Parley не загружает файлы (решение владельца 4). */
export const UPLOAD_SECRET_DIRS: readonly string[] = ['.ssh', '.aws', '.gnupg', '.config/gh', '.docker', '.kube', 'Library/Keychains', '.parley', '.claude', '.codex'];

/** Имена секретных файлов где угодно (`.pub` у ключей — можно). */
export const UPLOAD_SECRET_NAMES: readonly RegExp[] = [/^\.netrc$/, /^\.npmrc$/, /^\.pypirc$/, /^\.git-credentials$/, /^\.env(\..+)?$/, /^id_(rsa|ed25519|ecdsa|dsa)$/];

const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter((part) => part !== '');

/**
 * Секретное ли место (решение владельца 4): `real` — путь после `realpath`. Сравнение по сегментам и без учёта регистра
 * (`~/.sshx/a` — не секретное место); домашняя папка сверяется и в написании `home`, и в `realHome` (она может быть симлинком).
 */
export function secretUploadPath(real: string, home: string, realHome?: string): boolean {
  const parts = segmentsOf(real.toLowerCase());
  const name = parts.at(-1) ?? '';
  if (UPLOAD_SECRET_NAMES.some((pattern) => pattern.test(name))) return true;
  for (const base of new Set([home, realHome ?? home])) {
    const prefix = segmentsOf(base.toLowerCase());
    if (prefix.length > parts.length || prefix.some((part, index) => parts[index] !== part)) continue;
    const rest = parts.slice(prefix.length);
    if (UPLOAD_SECRET_DIRS.some((dir) => {
      const dirParts = segmentsOf(dir.toLowerCase());
      return dirParts.length <= rest.length && dirParts.every((part, index) => rest[index] === part);
    })) return true;
  }
  return false;
}

export const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Ждёт конец загрузки до `ms`; `true` — дождались, `false` — срок вышел или гость умер. Обрыв — отказ с причиной. */
export function settleLoad(contents: WebContents, ms: number, signal: AbortSignal, auth?: Pick<BasicAuth, 'isPending' | 'onPending'>): Promise<boolean> {
  if (!contents.isLoading()) return Promise.resolve(true);
  // Вкладка ждёт логин и пароль человека: загрузка не кончится, пока он не ответит, — агенту отвечаем сразу (`loaded: false`).
  if (auth?.isPending(contents.id) === true) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const offPending = auth?.onPending(contents.id, () => finish(() => resolve(false)));
    const finish = (action: () => void): void => {
      offPending?.();
      clearTimeout(timer);
      contents.off('did-stop-loading', onStop);
      contents.off('destroyed', onGone);
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onStop = (): void => finish(() => resolve(true));
    const onGone = (): void => finish(() => resolve(false));
    const onAbort = (): void => finish(() => reject(signal.reason));
    const timer = setTimeout(() => finish(() => resolve(false)), ms);
    contents.on('did-stop-loading', onStop);
    contents.on('destroyed', onGone);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Шаги страницы и переход, который они начали: его загрузка дожидается до `loadMs` (спека 5.1). Переход на другой
 * документ — главный кадр и не `isSameDocument`. Без `settle` после шагов спим `settleMs`, `change` — `navigated` или
 * `unknown`. С `settle` проба берётся до шагов, после них ждём затишья страницы (спека 3.2), и `change` говорит, что
 * изменилось; проба потеряна — прежние `settleMs` и `unknown`.
 */
export async function withNavigation<T>(
  contents: WebContents,
  run: () => Promise<T>,
  signal: AbortSignal,
  auth?: Pick<BasicAuth, 'isPending' | 'onPending'>,
  settle?: AgentSettle,
): Promise<{ value: T; navigated: boolean; loaded: boolean; change: BrowserAgentChange }> {
  let started = false;
  const onStart = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
    if (details.isMainFrame && !details.isSameDocument) started = true;
  };
  contents.on('did-start-navigation', onStart as never);
  let value: T;
  let before: PageProbe | null = null;
  let after: PageProbe | null = null;
  try {
    if (settle !== undefined) before = await settle.probe(contents);
    value = await run();
    if (settle !== undefined && before !== null) after = await settle.quiet(contents, signal);
    if (after === null) await sleep(AGENT_LIMITS.settleMs, signal);
  } finally {
    contents.off('did-start-navigation', onStart as never);
  }
  const change = changeOf(before, after, started);
  if (!started) return { value, navigated: false, loaded: true, change };
  return { value, navigated: true, loaded: await settleLoad(contents, AGENT_LIMITS.loadMs, signal, auth), change };
}

const SECRET_UPLOAD = 'Parley does not upload files from secret locations (~/.ssh, keychains, .env …).';
const DRAG_STEPS = 10;
/** Подпись опции в ответе — не длиннее, кодовых точек. */
const LABEL_LIMIT = 200;
/** Список опций в тексте отказа — не длиннее, знаков: отказ целиком режется на 2000. */
const OPTIONS_CHARS = 1_500;

const clip = (text: string, limit: number): string => {
  const cut = cutCodePoints(text, limit);
  return cut.cut ? `${cut.text}…` : cut.text;
};

/**
 * Подписи опций `<select>` для текста отказа: данные страницы, а отказ core печатает вне ограды, поэтому ограду и пометку
 * ставит окно (финальная рецензия m2). Длинный список обрезается многоточием.
 */
function optionsData(options: readonly string[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const option of options) {
    const line = clip(option, LABEL_LIMIT / 2);
    if (size + line.length > OPTIONS_CHARS) {
      lines.push('…');
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return `${S.contextFile.pageDataNote}\n\n${fence(lines.join('\n'))}`;
}

export function createAgentActions(deps: {
  inspector: Pick<Inspector, 'send'>;
  input: AgentInput;
  dom: AgentDom;
  emulation: Pick<Emulation, 'fitOf'>;
  window: Pick<AgentWindow, 'take'>;
  activity(e: AgentActivity): void;
  /** Вкладка, ждущая логин человека (`basic-auth.ts`): переход после действия не ждёт загрузку, а отвечает подсказкой. */
  basicAuth?: Pick<BasicAuth, 'isPending' | 'onPending'>;
  /** Вкладка, ждущая выбора сертификата человеком (`client-cert.ts`): так же — подсказка вместо ожидания загрузки. */
  clientCert?: Pick<ClientCert, 'isPending' | 'onPending'>;
  /** Проба страницы и ожидание затишья: без неё ответ без поля `change`, как у окна до этапа 1 точности. */
  settle?: AgentSettle;
  files?: { realpath(p: string): Promise<string>; stat(p: string): Promise<{ isFile(): boolean; size: number }> };
  home?: string;
}): AgentActions {
  const { inspector, input, dom } = deps;
  const files = deps.files ?? { realpath: fsRealpath, stat: fsStat };

  async function runStep(contents: WebContents, record: PageRecord, request: BrowserAgentOpEvent, args: BrowserAgentStep, guard: InputGuard, notes: string[]): Promise<StepOutcome> {
    const id = contents.id;
    const mask = modifierMask(args.modifiers ?? []);
    const fit = deps.emulation.fitOf(id);
    const zoom = contents.getZoomFactor();
    /** Данные страницы к ответу (подпись выбранной опции): core печатает их в ограде. */
    let pageData: string | undefined;
    const ref = args.ref ?? '';

    const send = <T = unknown>(method: string, params: Record<string, unknown>): Promise<T> => {
      guard.check();
      return inspector.send<T>(id, method, params);
    };

    /** Команда DOM по узлу: узла уже нет — `stale_ref`; он не нарисован — `bad_request`. */
    async function onNode<T>(name: string, method: string, params: Record<string, unknown>): Promise<T> {
      try {
        return await send<T>(method, params);
      } catch (error) {
        if (error instanceof AgentOpError) throw error;
        const text = error instanceof Error ? error.message : String(error);
        if (/box model|layout object/i.test(text)) throw new AgentOpError('bad_request', `Element ${name} is not rendered (hidden or display: none).`);
        if (/no node|detached|not found|could not find/i.test(text)) throw new AgentOpError('stale_ref', `Element ${name} is gone from the page: take a new browser_snapshot.`);
        throw error;
      }
    }

    const nodeOf = (name: string): number => dom.nodeOf(contents, record, name);

    /** Центр цели `ref` или `x, y` (CSS-пиксели страницы). */
    async function pointOf(refName: string | undefined, x: number | undefined, y: number | undefined): Promise<{ point: { x: number; y: number }; label: string }> {
      if (refName !== undefined) return { point: await dom.centerOf(contents, nodeOf(refName)), label: refName };
      const point = { x: x ?? 0, y: y ?? 0 };
      return { point, label: `(${Math.round(point.x)}, ${Math.round(point.y)})` };
    }

    /**
     * Спрашивает документ цели, не лежит ли над её центром чужой элемент. Не смогли спросить (узла нет, страница
     * упала, ответ не той формы) — `null`: клик идёт как раньше. Остановка человеком не глотается: `guard.check()`.
     */
    async function hitOf(node: number, recenter: boolean): Promise<{ covered: boolean; by?: string } | null> {
      let objectId: string | undefined;
      try {
        const { object } = await send<{ object: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: node });
        objectId = object.objectId;
        if (objectId === undefined) return null;
        const reply = await send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: HIT_TEST_FN,
          arguments: [{ value: recenter }],
          returnByValue: true,
        });
        const value = reply.result?.value as { covered?: unknown; by?: unknown } | undefined;
        if (typeof value?.covered !== 'boolean') return null;
        return { covered: value.covered, ...(typeof value.by === 'string' ? { by: value.by } : {}) };
      } catch {
        guard.check();
        return null;
      } finally {
        if (objectId !== undefined) await inspector.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    }

    /**
     * Центр цели по ссылке для клика: над ним лежит чужой элемент — цель прокручивается в середину вьюпорта (фиксированная
     * шапка у края уходит) и проверка идёт второй раз; всё ещё перекрыта — отказ `covered`, ничего не нажато.
     */
    async function clearPointOf(name: string): Promise<{ x: number; y: number }> {
      const node = nodeOf(name);
      const point = await dom.centerOf(contents, node);
      const first = await hitOf(node, false);
      if (first === null || !first.covered) return point;
      const second = await hitOf(node, true);
      if (second === null || !second.covered) return dom.centerOf(contents, node);
      const by = second.by === undefined ? '' : `\n${optionsData([second.by])}`;
      throw new AgentOpError('covered', `Element ${name} is covered by another element; nothing was clicked.${by}`);
    }

    /** Точка для CDP — с поправкой на вписывание эмуляции и масштаб страницы. */
    const cdpPoint = (point: { x: number; y: number }): { x: number; y: number } => inputPoint(point, fit, zoom);

    /** Точку клика рисует окно: событие `step` с точкой в пикселях `<webview>`. */
    function showPoint(point: { x: number; y: number }): void {
      deps.activity({ webContentsId: id, session: request.label, op: request.op, phase: 'step', point: viewPoint(point, fit, zoom) });
    }

    /** Фокус элемента без клика: у `<select>` клик открыл бы системное меню. */
    async function focusNode(name: string): Promise<void> {
      const node = nodeOf(name);
      await onNode(name, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: node });
      await onNode(name, 'DOM.focus', { backendNodeId: node });
    }

    async function nodeNameOf(name: string, node: number): Promise<{ nodeName: string; attributes: string[] }> {
      const { node: described } = await onNode<{ node: { nodeName?: string; attributes?: string[] } }>(name, 'DOM.describeNode', { backendNodeId: node });
      return { nodeName: described.nodeName ?? '', attributes: described.attributes ?? [] };
    }

    function clickSteps(at: { x: number; y: number }, clicks: number): MouseStep[] {
      const steps: MouseStep[] = [{ type: 'mouseMoved', x: at.x, y: at.y }];
      for (let count = 1; count <= clicks; count += 1) {
        steps.push({ type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: count });
        steps.push({ type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: count });
      }
      return steps;
    }

    async function clickAt(point: { x: number; y: number }, clicks: number): Promise<void> {
      showPoint(point);
      await input.mouse(contents, clickSteps(cdpPoint(point), clicks), mask, guard);
    }

    async function act(): Promise<string> {
      switch (args.action) {
        case 'click':
        case 'double_click': {
          if (args.ref !== undefined && (await nodeNameOf(ref, nodeOf(ref))).nodeName.toUpperCase() === 'SELECT') {
            throw new AgentOpError('bad_request', 'Use action select for a <select>.');
          }
          const { point, label } = args.ref !== undefined ? { point: await clearPointOf(ref), label: ref } : await pointOf(args.ref, args.x, args.y);
          await clickAt(point, args.action === 'click' ? 1 : 2);
          return args.action === 'click' ? `Clicked ${label}.` : `Double-clicked ${label}.`;
        }
        case 'hover': {
          const { point, label } = await pointOf(args.ref, args.x, args.y);
          await input.mouse(contents, [{ type: 'mouseMoved', ...cdpPoint(point) }], mask, guard);
          return `Moved the pointer over ${label}.`;
        }
        case 'type': {
          const text = args.text ?? '';
          if (args.ref !== undefined) await focusNode(ref);
          await input.text(contents, text, guard);
          if (args.submit === true) await input.key(contents, keySpec('Enter') as NonNullable<ReturnType<typeof keySpec>>, 0, guard);
          return `Typed ${Array.from(text).length} characters${args.ref === undefined ? '' : ` into ${ref}`}${args.submit === true ? ' and pressed Enter' : ''}.`;
        }
        case 'press': {
          const key = args.key ?? '';
          const spec = keySpec(key);
          if (spec === null) throw new AgentOpError('bad_request', `Unknown key ${key}: use a key name such as Enter, Tab, Escape or ArrowDown, or one character.`);
          if (args.ref !== undefined) await focusNode(ref);
          await input.key(contents, spec, mask, guard);
          return `Pressed ${[...(args.modifiers ?? []), key].join('+')}${args.ref === undefined ? '' : ` in ${ref}`}.`;
        }
        case 'scroll': {
          const metrics = await send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {});
          const view = metrics.cssLayoutViewport;
          const direction = args.direction ?? 'down';
          const vertical = direction === 'up' || direction === 'down';
          const amount = args.amount ?? Math.round(vertical ? view.clientHeight : view.clientWidth);
          const sign = direction === 'up' || direction === 'left' ? -1 : 1;
          const point =
            args.ref !== undefined
              ? await dom.centerOf(contents, nodeOf(ref))
              : args.x !== undefined
                ? { x: args.x, y: args.y ?? 0 }
                : { x: view.clientWidth / 2, y: view.clientHeight / 2 };
          const at = cdpPoint(point);
          await input.mouse(contents, [{ type: 'mouseWheel', x: at.x, y: at.y, deltaX: vertical ? 0 : sign * amount, deltaY: vertical ? sign * amount : 0 }], mask, guard);
          return `Scrolled ${direction} by ${amount} px${args.ref === undefined ? '' : ` at ${ref}`}.`;
        }
        case 'select': {
          const node = nodeOf(ref);
          const { object } = await onNode<{ object: { objectId?: string } }>(ref, 'DOM.resolveNode', { backendNodeId: node });
          const objectId = object.objectId;
          if (objectId === undefined) throw new AgentOpError('stale_ref', `Element ${ref} is gone from the page: take a new browser_snapshot.`);
          let answer: { ok: boolean; label?: string; options?: string[] } | undefined;
          try {
            const reply = await send<{ result?: { value?: { ok: boolean; label?: string; options?: string[] } } }>('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: SELECT_OPTION_FN,
              arguments: [{ value: args.value ?? '' }],
              returnByValue: true,
            });
            answer = reply.result?.value;
          } finally {
            await inspector.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
          }
          if (answer?.ok !== true) {
            const options = answer?.options ?? [];
            throw new AgentOpError(
              'bad_request',
              options.length === 0 ? `Element ${ref} is not a <select>.` : `No option "${args.value ?? ''}" in ${ref}. Its options:\n${optionsData(options)}`,
            );
          }
          // Подпись опции — данные страницы: в `done` (вне ограды core) её нет (финальная рецензия m2).
          pageData = `Selected option: ${clip(answer.label ?? args.value ?? '', LABEL_LIMIT)}`;
          return `Selected an option in ${ref}.`;
        }
        case 'check':
        case 'uncheck': {
          const want = args.action === 'check';
          const word = want ? 'checked' : 'unchecked';
          const node = nodeOf(ref);
          const before = await dom.checkedOf(contents, node);
          if (before === null) throw new AgentOpError('bad_request', `Element ${ref} is not a checkbox, radio button or switch.`);
          if (before === want) return `${ref} is already ${word}.`;
          await clickAt(await clearPointOf(ref), 1);
          const after = await dom.checkedOf(contents, node);
          if (after !== want) {
            notes.push(`${ref} did not become ${word} after the click.`);
            return `Clicked ${ref}.`;
          }
          return `${want ? 'Checked' : 'Unchecked'} ${ref}.`;
        }
        case 'drag': {
          const from = await pointOf(args.ref, args.x, args.y);
          const to = await pointOf(args.toRef, args.toX, args.toY);
          const start = cdpPoint(from.point);
          const end = cdpPoint(to.point);
          const steps: MouseStep[] = [
            { type: 'mouseMoved', x: start.x, y: start.y },
            { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1 },
          ];
          for (let index = 1; index <= DRAG_STEPS; index += 1) {
            const share = index / DRAG_STEPS;
            steps.push({ type: 'mouseMoved', x: start.x + (end.x - start.x) * share, y: start.y + (end.y - start.y) * share, button: 'left', buttons: 1 });
          }
          steps.push({ type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1 });
          showPoint(from.point);
          await input.mouse(contents, steps, mask, guard);
          return `Dragged ${from.label} to ${to.label}.`;
        }
        case 'upload': {
          const node = nodeOf(ref);
          const described = await nodeNameOf(ref, node);
          const attr = (name: string): string | undefined => {
            const at = described.attributes.findIndex((item, index) => index % 2 === 0 && item.toLowerCase() === name);
            return at < 0 ? undefined : (described.attributes[at + 1] ?? '');
          };
          if (described.nodeName.toUpperCase() !== 'INPUT' || attr('type')?.toLowerCase() !== 'file') {
            throw new AgentOpError('bad_request', `Element ${ref} is not a file input: take a browser_snapshot and pick the field that takes files.`);
          }
          const wanted = args.files ?? [];
          if (wanted.length > 1 && attr('multiple') === undefined) throw new AgentOpError('bad_request', `Element ${ref} takes one file, got ${wanted.length}.`);
          const home = deps.home ?? homedir();
          const realHome = await files.realpath(home).catch(() => home);
          const resolved: string[] = [];
          // Проверка всех файлов — до первого вызова CDP.
          for (const file of wanted) {
            let real: string;
            try {
              real = await files.realpath(file);
            } catch {
              throw new AgentOpError('bad_request', `File ${file} does not exist.`);
            }
            if (secretUploadPath(real, home, realHome)) throw new AgentOpError('bad_request', SECRET_UPLOAD);
            const info = await files.stat(real).catch(() => null);
            if (info === null || !info.isFile()) throw new AgentOpError('bad_request', `${file} is not a regular file.`);
            if (info.size > AGENT_LIMITS.uploadBytes) throw new AgentOpError('bad_request', `File ${file} is larger than ${Math.round(AGENT_LIMITS.uploadBytes / 1_048_576)} MB.`);
            resolved.push(real);
          }
          await onNode(ref, 'DOM.setFileInputFiles', { files: resolved, backendNodeId: node });
          return `Put ${resolved.length} ${resolved.length === 1 ? 'file' : 'files'} into ${ref}.`;
        }
      }
    }

    const outcome = await withNavigation(contents, act, guard.signal, humanWait(deps.basicAuth, deps.clientCert), deps.settle);
    notes.push(...deps.window.take(`${record.workKey}\n${record.pageId}`));
    const authPending = deps.basicAuth?.isPending(contents.id) === true;
    const certPending = deps.clientCert?.isPending(contents.id) === true;
    if (authPending) notes.push(BASIC_AUTH_HINT);
    if (certPending) notes.push(CLIENT_CERT_HINT);
    if (!authPending && !certPending && outcome.navigated && !outcome.loaded) notes.push('The page is still loading.');
    return { done: outcome.value, navigated: outcome.navigated, loaded: outcome.loaded, change: outcome.change, ...(pageData === undefined ? {} : { pageData }) };
  }

  /** Одиночное действие — список из одного шага: поля шага те же, без `tab`, `steps` и `snapshot`. */
  function singleStep(args: BrowserAgentArgs<'action'>): BrowserAgentStep {
    const step: Record<string, unknown> = { ...args };
    delete step['tab'];
    delete step['steps'];
    delete step['snapshot'];
    return step as BrowserAgentStep;
  }

  return {
    async actionOf(contents, record, request, args, guard) {
      const notes: string[] = [];
      const list = args.steps ?? [singleStep(args)];
      const done: StepResult[] = [];
      let stopped: BrowserAgentActionResult['stopped'];
      let navigated = false;
      let refsStale = false;
      let change: BrowserAgentChange = 'unknown';
      let single: StepOutcome | undefined;
      for (let index = 0; index < list.length; index += 1) {
        const step = list[index] as BrowserAgentStep;
        const at = index + 1;
        if (index > 0) {
          try {
            guard.check();
          } catch (error) {
            if (!(error instanceof AgentOpError)) throw error;
            stopped = { at, reason: 'failed', code: error.code, message: error.message };
            break;
          }
          if (guard.deadline !== undefined && guard.deadline - Date.now() < AGENT_LIMITS.stepReserveMs) {
            stopped = { at, reason: 'time' };
            break;
          }
          if (refsStale && (step.ref !== undefined || step.toRef !== undefined)) {
            stopped = { at, reason: 'navigated' };
            break;
          }
        }
        let outcome: StepOutcome;
        try {
          outcome = await runStep(contents, record, request, step, guard, notes);
        } catch (error) {
          // Отказ первого шага — обычная ошибка операции: ничего не сделано. Дальше — частичный ответ с причиной.
          if (index === 0 || !(error instanceof AgentOpError)) throw error;
          stopped = { at, reason: 'failed', code: error.code, message: error.message };
          break;
        }
        single = outcome;
        navigated ||= outcome.navigated;
        change = outcome.change;
        done.push({ done: outcome.done, ...(deps.settle === undefined ? {} : { change: outcome.change }), ...(outcome.pageData === undefined ? {} : { pageData: outcome.pageData }) });
        if (outcome.navigated) refsStale = true;
        if (outcome.navigated && !outcome.loaded && index + 1 < list.length) {
          stopped = { at: at + 1, reason: 'navigated' };
          break;
        }
      }
      let snapshot: BrowserAgentActionResult['snapshot'];
      if (args.snapshot !== undefined && stopped?.reason !== 'time') {
        try {
          const taken = await dom.snapshotOf(contents, record, { tab: args.tab, interactiveOnly: args.snapshot === 'interactive' });
          snapshot = { text: taken.text, refs: taken.refs, truncated: taken.truncated };
        } catch {
          notes.push('Snapshot failed: call browser_snapshot.');
        }
      }
      const base = { tab: record.agentId, url: urlForAgent(contents.getURL()), notes, ...(snapshot === undefined ? {} : { snapshot }) };
      if (args.steps === undefined) {
        const only = single as StepOutcome;
        return { ...base, done: only.done, navigated: only.navigated, ...(deps.settle === undefined ? {} : { change: only.change }), ...(only.pageData === undefined ? {} : { pageData: only.pageData }) };
      }
      return {
        ...base,
        done: `Ran ${done.length} of ${list.length} steps.`,
        navigated,
        ...(deps.settle === undefined ? {} : { change }),
        steps: done,
        ...(stopped === undefined ? {} : { stopped }),
      };
    },
  };
}
