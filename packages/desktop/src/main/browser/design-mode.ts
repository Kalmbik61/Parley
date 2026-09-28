/**
 * Design Mode в main (кусок 9.3a, спека 12.3): выбор элемента страницы кликом человека.
 *
 * Скрипт выбора (`guest-pick.js`) исполняется в изолированном мире гостя; всё, что он вернул, —
 * данные недоверенной страницы. Поэтому main сам проверяет форму и длины (`validatePick`), адрес
 * берёт у `getURL()`, а снимок делает сам — `capturePage` по проверенному прямоугольнику.
 */
import type { NativeImage, WebContents } from 'electron';
import type { PickResult } from '../../shared/browser-types.js';
import { S } from '../../shared/strings.js';

/** Мир скрипта выбора: не 0 (мир страницы) и не занятые Electron. */
export const PICK_WORLD_ID = 1001;

/**
 * Пределы данных элемента (спека 12.3, «Числа» плана). `selector` спека ограничивает только звеньями,
 * а одно звено (класс или id) пишет страница — длина своя (fix-9): 12 звеньев обычной длины в неё
 * входят с запасом.
 */
export const PICK_LIMITS = { html: 4096, text: 500, selectorLinks: 12, selector: 1024, thumbnailWidth: 320 } as const;

/** Вычисленные стили, которые уходят агенту (таблица спеки 12.3); остальные ключи выкидываются. */
const STYLE_KEYS = new Set([
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'border',
  'border-radius',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'grid-template-columns',
  'box-shadow',
  'opacity',
]);

/** Отмена выбора в том же изолированном мире: страница эту функцию не видит. */
const CANCEL_SCRIPT = 'globalThis.__harnasPickCancel?.()';

type Rect = { x: number; y: number; width: number; height: number };
type ValidPick = Omit<PickResult, 'url' | 'imagePath' | 'thumbnail'> & {
  rect: Rect;
  viewport: { width: number; height: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Первые `limit` кодовых точек: суррогатная пара эмодзи не рвётся. */
function cutCodePoints(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const points = Array.from(text);
  if (points.length <= limit) return { text, cut: false };
  return { text: points.slice(0, limit).join(''), cut: true };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readRect(value: unknown): Rect | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height) || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/**
 * Проверка формы данных из гостя: лишние поля выкинуты, строки обрезаны (html — с
 * S.designBlock.truncated), неверная форма → null.
 */
export function validatePick(raw: unknown): ValidPick | null {
  if (!isRecord(raw)) return null;
  const { selector, text, html, styles, viewport } = raw;
  if (typeof selector !== 'string' || typeof text !== 'string' || typeof html !== 'string' || !isRecord(styles)) {
    return null;
  }
  const rect = readRect(raw.rect);
  if (rect === null || !isRecord(viewport)) return null;
  const { width: viewWidth, height: viewHeight } = viewport;
  if (!finite(viewWidth) || !finite(viewHeight) || viewWidth <= 0 || viewHeight <= 0) return null;

  // Значения стилей таблица спеки не ограничивает, а их пишет страница (font-family): режем
  // пределом текста — план этого не задал. Селектор — своим пределом (PICK_LIMITS.selector).
  const cleanStyles: Record<string, string> = {};
  for (const [key, value] of Object.entries(styles)) {
    if (STYLE_KEYS.has(key) && typeof value === 'string') cleanStyles[key] = cutCodePoints(value, PICK_LIMITS.text).text;
  }
  const links = selector.split(' > ').slice(-PICK_LIMITS.selectorLinks).join(' > ');
  const cutHtml = cutCodePoints(html, PICK_LIMITS.html);

  return {
    selector: cutCodePoints(links, PICK_LIMITS.selector).text,
    text: cutCodePoints(text, PICK_LIMITS.text).text,
    html: cutHtml.cut ? cutHtml.text + S.designBlock.truncated : cutHtml.text,
    styles: cleanStyles,
    rect,
    viewport: { width: viewWidth, height: viewHeight },
  };
}

/** Адрес для агента из contents.getURL(): origin + pathname — без query, hash и user:pass@ (спека 12.3). */
export function pickUrl(pageUrl: string): string {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return '';
  }
  // У about:blank и data: origin — 'null': адрес без него.
  return url.origin === 'null' ? `${url.protocol}${url.pathname}` : `${url.origin}${url.pathname}`;
}

/** Прямоугольник снимка в DIP: CSS-пиксели × zoomFactor, пересечение с видимой областью. */
export function captureRect(
  rect: Rect,
  viewport: { width: number; height: number },
  zoomFactor: number,
): Rect | null {
  const left = Math.max(rect.x, 0);
  const top = Math.max(rect.y, 0);
  const right = Math.min(rect.x + rect.width, viewport.width);
  const bottom = Math.min(rect.y + rect.height, viewport.height);
  if (right <= left || bottom <= top) return null;
  // capturePage ждёт целые DIP: наружу, чтобы край элемента не срезался.
  const x = Math.floor(left * zoomFactor);
  const y = Math.floor(top * zoomFactor);
  return { x, y, width: Math.ceil(right * zoomFactor) - x, height: Math.ceil(bottom * zoomFactor) - y };
}

/**
 * Оверлей и перехватчики в странице снимает сам скрипт — командой в его мире. Мёртвому гостю не
 * шлётся; ошибка (документ уже уничтожен или сменился) не важна.
 */
function dismissScript(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  return contents
    .executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: CANCEL_SCRIPT }])
    .then(() => undefined)
    .catch(() => undefined);
}

export function createDesignMode(deps: {
  fromId(id: number): WebContents | null;
  saveImage(png: Buffer): Promise<string | null>;
  guestScript: string;
}): {
  start(id: number): Promise<PickResult | null>;
  cancel(id: number): Promise<void>;
  downloadStarted(id: number): void;
} {
  // Незавершённый выбор гостя: навигация, падение или закрытие страницы могут оставить промис
  // скрипта навсегда без ответа — тогда отвечает main, иначе карточка зависла бы в «выбираю».
  const pending = new Map<number, (result: PickResult | null) => void>();

  /** Снимок проверенного прямоугольника; не вышло — оба поля null, блок уйдёт без Screenshot. */
  async function snapshot(
    contents: WebContents,
    pick: ValidPick,
  ): Promise<{ imagePath: string | null; thumbnail: string | null }> {
    const none = { imagePath: null, thumbnail: null };
    const rect = captureRect(pick.rect, pick.viewport, contents.getZoomFactor());
    if (rect === null) return none;
    try {
      const image: NativeImage = await contents.capturePage(rect);
      if (image.isEmpty()) return none;
      const imagePath = await deps.saveImage(image.toPNG());
      if (imagePath === null) return none;
      // PNG лежит в drops/ вне корней работы: files.readBytes его не отдаст, file:// окну нельзя —
      // карточке идёт уменьшенная копия data:-адресом.
      const small =
        image.getSize().width > PICK_LIMITS.thumbnailWidth ? image.resize({ width: PICK_LIMITS.thumbnailWidth }) : image;
      return { imagePath, thumbnail: small.toDataURL() };
    } catch (error) {
      console.warn('[harnas] design mode capture failed', error);
      return none;
    }
  }

  function start(id: number): Promise<PickResult | null> {
    const contents = deps.fromId(id);
    if (contents === null || contents.isDestroyed()) return Promise.resolve(null);
    // Новый выбор того же гостя отменяет прежний (скрипт снимет и свой оверлей).
    pending.get(id)?.(null);

    return new Promise((resolve) => {
      let done = false;
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
        if (!details.isMainFrame || details.isSameDocument) return;
        finish(null);
        // Навигация может не смениться документом (скачивание, отменённый переход): тогда оверлей
        // и перехватчики скрипта остались бы на живой странице. В новом документе вызов — пустой.
        dismissScript(contents);
      };
      const onGone = (): void => finish(null);
      const finish = (result: PickResult | null): void => {
        if (done) return;
        done = true;
        contents.off('did-start-navigation', onNavigation);
        contents.off('render-process-gone', onGone);
        contents.off('destroyed', onGone);
        if (pending.get(id) === finish) pending.delete(id);
        resolve(result);
      };
      pending.set(id, finish);
      contents.on('did-start-navigation', onNavigation);
      contents.on('render-process-gone', onGone);
      contents.on('destroyed', onGone);

      contents
        .executeJavaScriptInIsolatedWorld(PICK_WORLD_ID, [{ code: deps.guestScript }])
        .then(async (raw: unknown) => {
          // Поздний ответ после отмены, навигации или падения — отброшен.
          if (done) return;
          const pick = validatePick(raw);
          if (pick === null) {
            finish(null);
            return;
          }
          const shot = await snapshot(contents, pick);
          if (done || contents.isDestroyed()) {
            finish(null);
            return;
          }
          finish({
            url: pickUrl(contents.getURL()),
            selector: pick.selector,
            text: pick.text,
            html: pick.html,
            styles: pick.styles,
            ...shot,
          });
        })
        .catch((error: unknown) => {
          if (!done) console.warn('[harnas] design mode script failed', error);
          finish(null);
        });
    });
  }

  async function cancel(id: number): Promise<void> {
    pending.get(id)?.(null);
    const contents = deps.fromId(id);
    if (contents === null) return;
    await dismissScript(contents);
  }

  /**
   * Загрузка из гостя (will-download раздела, fix-9b). `<a download>` уходит в загрузку без
   * did-start-navigation — выбор снимается здесь тем же путём, что навигация: итог null, скрипт отмены
   * в мир выбора (документ жив). Гость без выбора не трогается — скрипт ему не шлётся.
   */
  function downloadStarted(id: number): void {
    const finish = pending.get(id);
    if (finish === undefined) return;
    finish(null);
    const contents = deps.fromId(id);
    if (contents !== null) void dismissScript(contents);
  }

  return { start, cancel, downloadStarted };
}
