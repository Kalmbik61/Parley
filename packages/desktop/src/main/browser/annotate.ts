// packages/desktop/src/main/browser/annotate.ts
/**
 * Аннотации в main (спека браузера 4.7): скрипт меток `guest-annotate.js` (после помощников `guest-dom.js`) в
 * изолированном мире 1001, проверка его данных, роль, имя и React для меток на элементах (как у Select, по точке
 * документа), перерисовка меток по лотку окна и снимок видимой части страницы с номерами (этап 0, 0.7: снимок всей
 * страницы двоит фиксированный заголовок и теряет метки). Всё, что вернул скрипт, — данные страницы: форма и длины
 * проверяются здесь (`validateAnnotationPick`).
 */

import type { InputEvent, NativeImage, WebContents } from 'electron';
import type {
  AnnotationElementTarget,
  AnnotationPick,
  AnnotationPin,
  AnnotationPosition,
  AnnotationRegionTarget,
  PickViewport,
  ViewportFraction,
} from '../../shared/browser-types.js';
import { CONTEXT_LIMITS } from '../../shared/context-markdown.js';
import { S } from '../../shared/strings.js';
import { PICK_LIMITS, PICK_WORLD_ID } from './design-mode.js';
import { elementInfo, withTimeout, type CdpSender, type ElementInfo } from './element-info.js';
import { cutCodePoints, documentPoint, finite, isRecord, readPoint, readRect, type Point } from './guest-data.js';

/** Ключевые стили метки на элементе (спека 4.7) — тот же список, что у `guest-annotate.js`. */
const ANNOTATION_STYLE_KEYS = new Set(['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'font-weight']);
/** Ключ цели в мире скрипта: `a` и номер. Метки уходят в код скрипта JSON-ом — ключ только такой. */
const PIN_KEY = /^a\d{1,6}$/;
/** До трёх элементов под рамкой (спека 4.7). */
const MAX_UNDER = 3;
const CANCEL_SCRIPT = 'globalThis.__parleyAnnotate?.cancel()';
const UNHOVER_SCRIPT = 'globalThis.__parleyAnnotate?.unhover()';
// Перед снимком: подсветка под курсором снята (на снимке ей не место), затем счёт меток.
const COUNT_SCRIPT = `${UNHOVER_SCRIPT}, globalThis.__parleyAnnotate?.count() ?? 0`;

/** Ответ скрипта после проверки: у метки на элементе — ещё точка и прокрутка для CDP (в окно не уходят). */
type ValidAnnotationPick = AnnotationRegionTarget | (AnnotationElementTarget & { point: Point | null; scroll: Point }) | { kind: 'edit'; n: number };

function readViewport(value: unknown): PickViewport | null {
  if (!isRecord(value)) return null;
  const { width, height, dpr } = value;
  if (!finite(width) || !finite(height) || !finite(dpr) || width <= 0 || height <= 0 || dpr <= 0) return null;
  return { width, height, dpr };
}

function readFraction(value: unknown): ViewportFraction | null {
  if (!isRecord(value) || !finite(value.fx) || !finite(value.fy)) return null;
  const clamp = (part: number): number => Math.min(Math.max(part, 0), 1);
  return { fx: clamp(value.fx), fy: clamp(value.fy) };
}

function readText(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? cutCodePoints(value, limit).text : null;
}

function isPinNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CONTEXT_LIMITS.annotations;
}

export function validateAnnotationPick(raw: unknown): ValidAnnotationPick | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'edit') return isPinNumber(raw.n) ? { kind: 'edit', n: raw.n } : null;
  const { key } = raw;
  const anchor = readFraction(raw.anchor);
  const viewport = readViewport(raw.viewport);
  if (typeof key !== 'string' || !PIN_KEY.test(key) || anchor === null || viewport === null) return null;
  if (raw.kind === 'region') {
    const rect = readRect(raw.rect);
    if (rect === null || !Array.isArray(raw.elements)) return null;
    const elements = raw.elements.slice(0, MAX_UNDER).flatMap((item: unknown) => {
      if (!isRecord(item)) return [];
      const selector = readText(item.selector, PICK_LIMITS.selector);
      const text = readText(item.text, PICK_LIMITS.text);
      return selector === null || text === null ? [] : [{ selector, text }];
    });
    return { kind: 'region', key, rect, elements, anchor, viewport };
  }
  if (raw.kind !== 'element' || !isRecord(raw.styles) || typeof raw.html !== 'string') return null;
  const selector = readText(raw.selector, PICK_LIMITS.selector);
  const text = readText(raw.text, PICK_LIMITS.text);
  if (selector === null || text === null) return null;
  const html = cutCodePoints(raw.html, CONTEXT_LIMITS.annotationHtml);
  const styles: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.styles)) {
    if (ANNOTATION_STYLE_KEYS.has(name) && typeof value === 'string') styles[name] = cutCodePoints(value, PICK_LIMITS.text).text;
  }
  return {
    kind: 'element',
    key,
    selector,
    text,
    html: html.cut ? html.text + S.contextFile.truncated : html.text,
    styles,
    anchor,
    viewport,
    point: readPoint(raw.point),
    scroll: readPoint(raw.scroll) ?? { x: 0, y: 0 },
  };
}

/**
 * Метки окна для `sync`: до 20, номер 1…20, ключ `a<число>` без повторов; иначе null — канал ответит `bad_request`.
 * Ключ уникален лишь в пределах документа: повтор значит, что в список попали метки двух документов.
 */
export function parseAnnotationPins(value: unknown): AnnotationPin[] | null {
  if (!Array.isArray(value) || value.length > CONTEXT_LIMITS.annotations) return null;
  const pins: AnnotationPin[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || !isPinNumber(item.n) || typeof item.key !== 'string' || !PIN_KEY.test(item.key) || keys.has(item.key)) return null;
    keys.add(item.key);
    pins.push({ n: item.n, key: item.key });
  }
  return pins;
}

/**
 * Гость, которому можно слать скрипты: не закрыт и не упал. На упавшем кадре промис скрипта не завершается никогда
 * (Electron 44, проба с `forcefullyCrashRenderer()`), поэтому такого гостя не трогает ни один из четырёх входов.
 */
function usable(contents: WebContents | null): contents is WebContents {
  return contents !== null && !contents.isDestroyed() && !contents.isCrashed();
}

function readPositions(raw: unknown, pins: readonly AnnotationPin[]): AnnotationPosition[] {
  const answers: unknown[] = Array.isArray(raw) ? raw : [];
  return pins.map(({ n }) => {
    const found = answers.find((item) => isRecord(item) && item.n === n);
    return { n, rect: isRecord(found) ? readRect(found.rect) : null };
  });
}

export function createAnnotate(deps: {
  fromId(id: number): WebContents | null;
  saveImage(png: Buffer): Promise<string | null>;
  guestScript: string;
  inspector: CdpSender;
}): {
  start(id: number): Promise<AnnotationPick | null>;
  cancel(id: number): Promise<void>;
  sync(id: number, pins: AnnotationPin[]): Promise<AnnotationPosition[]>;
  capture(id: number): Promise<{ path: string | null }>;
} {
  // Незавершённая метка гостя: навигация, падение или закрытие страницы оставили бы промис скрипта без ответа.
  const pending = new Map<number, (result: AnnotationPick | null) => void>();

  function start(id: number): Promise<AnnotationPick | null> {
    const contents = deps.fromId(id);
    if (!usable(contents)) return Promise.resolve(null);
    pending.get(id)?.(null);
    return new Promise((resolve) => {
      let done = false;
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (details.isMainFrame && !details.isSameDocument) finish(null);
      };
      const onGone = (): void => finish(null);
      // Подсветка под курсором (guest-annotate.js) есть, пока скрипт ждёт метку. Ухода курсора с <webview> гость не видит:
      // Chromium не шлёт ему ни mouseout, ни mouseleave (проба Electron 44), а хозяин не видит входа на страницу. Main видит
      // ввод обоих: мышь у окна после движения по странице — подсветка снимается, одним вызовом на уход. Начальное
      // `over = true`: первое движение у окна снимает рамку на всякий случай.
      const host = contents.hostWebContents ?? null;
      let over = true;
      const unhover = (): void => {
        if (!over || !usable(contents)) return;
        over = false;
        void withTimeout<unknown>(contents.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: UNHOVER_SCRIPT }]), PICK_LIMITS.scriptMs, undefined);
      };
      const onGuestInput = (_event: unknown, input: InputEvent): void => {
        if (input.type === 'mouseMove') over = true;
        else if (input.type === 'mouseLeave') unhover();
      };
      const onHostInput = (_event: unknown, input: InputEvent): void => {
        if (input.type.startsWith('mouse')) unhover();
      };
      const finish = (result: AnnotationPick | null): void => {
        if (done) return;
        done = true;
        contents.off('did-start-navigation', onNavigation);
        contents.off('render-process-gone', onGone);
        contents.off('destroyed', onGone);
        contents.off('input-event', onGuestInput);
        host?.off('input-event', onHostInput);
        if (pending.get(id) === finish) pending.delete(id);
        resolve(result);
      };
      pending.set(id, finish);
      contents.on('did-start-navigation', onNavigation);
      contents.on('render-process-gone', onGone);
      contents.on('destroyed', onGone);
      contents.on('input-event', onGuestInput);
      host?.on('input-event', onHostInput);

      contents
        .executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: deps.guestScript }])
        .then(async (raw: unknown) => {
          if (done) return;
          const pick = validateAnnotationPick(raw);
          if (pick === null || pick.kind !== 'element') {
            finish(pick);
            return;
          }
          // DOM.getNodeForLocation — в координатах документа (спайк 0.4, 0.6): точка вьюпорта плюс прокрутка.
          const { point, scroll, ...target } = pick;
          const info = await withTimeout<ElementInfo>(elementInfo(deps.inspector, id, documentPoint(point, scroll), target.selector), PICK_LIMITS.infoMs, {});
          if (done || contents.isDestroyed()) {
            finish(null);
            return;
          }
          finish({ ...target, ...info });
        })
        .catch((error: unknown) => {
          if (!done) console.warn('[parley] annotate script failed', error);
          finish(null);
        });
    });
  }

  async function cancel(id: number): Promise<void> {
    pending.get(id)?.(null);
    const contents = deps.fromId(id);
    if (!usable(contents)) return;
    // Отказ и молчание страницы одинаково не важны: замёрзшую не ждём дольше `scriptMs` — вызов уже ушёл в неё и
    // сработает, когда она оживёт.
    await withTimeout<unknown>(contents.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: CANCEL_SCRIPT }]), PICK_LIMITS.scriptMs, undefined);
  }

  async function sync(id: number, pins: AnnotationPin[]): Promise<AnnotationPosition[]> {
    const gone = pins.map(({ n }) => ({ n, rect: null }));
    const contents = deps.fromId(id);
    if (!usable(contents)) return gone;
    try {
      // Метки проверены parseAnnotationPins: номер и ключ `a<число>` — JSON в коде скрипта безопасен. Страница не
      // ответила за `scriptMs` (замёрзла) — null: все метки пропали, как при отказе.
      const raw = await withTimeout<unknown>(
        contents.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: `globalThis.__parleyAnnotate?.sync(${JSON.stringify(pins)}) ?? null` }]),
        PICK_LIMITS.scriptMs,
        null,
      );
      return readPositions(raw, pins);
    } catch {
      return gone;
    }
  }

  async function capture(id: number): Promise<{ path: string | null }> {
    const contents = deps.fromId(id);
    if (!usable(contents)) return { path: null };
    // Меток на странице нет (новый документ после навигации): снимок без них солгал бы — файл уйдёт без снимка.
    // Страница не ответила за `scriptMs` (замёрзла) — тоже без снимка.
    const count = await withTimeout<unknown>(contents.executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: COUNT_SCRIPT }]), PICK_LIMITS.scriptMs, 0);
    if (typeof count !== 'number' || count < 1) return { path: null };
    try {
      // Только видимая часть (этап 0, 0.7): снимок всей страницы через captureBeyondViewport двоит фиксированный
      // заголовок и теряет метки ниже первой поверхности вида. Скрытый гость на снимок CDP не отвечает вовсе (этап 0,
      // 0.2; инспектор ждёт 10 с): за `scriptMs` не вышло — тот же путь, что при отказе.
      const shot = await withTimeout<{ data?: unknown } | null>(
        deps.inspector.send<{ data?: unknown }>(id, 'Page.captureScreenshot', { format: 'png' }).catch((error: unknown) => {
          console.warn('[parley] annotate: CDP capture failed, falling back to capturePage', error);
          return null;
        }),
        PICK_LIMITS.scriptMs,
        null,
      );
      if (shot !== null && typeof shot.data === 'string' && shot.data !== '') return { path: await deps.saveImage(Buffer.from(shot.data, 'base64')) };
    } catch (error) {
      console.warn('[parley] annotate: CDP capture failed, falling back to capturePage', error);
    }
    try {
      const image = await withTimeout<NativeImage | null>(
        contents.capturePage().catch((error: unknown) => {
          console.warn('[parley] annotate: capturePage failed', error);
          return null;
        }),
        PICK_LIMITS.scriptMs,
        null,
      );
      return { path: image === null || image.isEmpty() ? null : await deps.saveImage(image.toPNG()) };
    } catch (error) {
      console.warn('[parley] annotate capture failed', error);
      return { path: null };
    }
  }

  return { start, cancel, sync, capture };
}
