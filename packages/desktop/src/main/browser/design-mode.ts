/**
 * Select в main (спека браузера 3.8, 4.6; прежде Design Mode, кусок 9.3a): выбор элемента страницы кликом человека.
 *
 * Скрипт выбора (`guest-pick.js` после помощников `guest-dom.js`) исполняется в изолированном мире гостя; всё, что он
 * вернул, — данные недоверенной страницы. Поэтому main сам проверяет форму и длины (`validatePick`), адрес берёт у
 * `getURL()`, а снимок делает сам (`snapshot`, спайк 0.7 и решения 2026-10-08): основной — `capturePage()` видимой
 * части и вырезка по множителю «ширина картинки / ширина вьюпорта»; обрезка CDP `Page.captureScreenshot` в
 * координатах документа × масштаб страницы, высотой не больше поверхности вида (выше Chromium повторяет первую
 * поверхность), — только для элемента больше вьюпорта, которого видимая часть не вместит: в `<webview>` она порой
 * отдаёт не тот участок (пробы настоящего Electron), поэтому помещающемуся элементу её не зовут. По точке документа main
 * дочитывает роль, имя и компонент React (`element-info.ts`).
 *
 * Снимок видимой части (`snapshot`, `cropRect`) — адаптация Orca `src/main/browser/browser-grab-screenshot.ts`
 * (stablyai/orca b1cd858, MIT): множитель не вычисляется из масштаба и эмуляции, а измеряется по картинке. Изменено:
 * ширина вьюпорта — из проверенного выбора (`pick.viewport.width`), без запроса к странице; оверлей не прячется —
 * `guest-pick.js` снимает его сам и ждёт два кадра; вырезка — пересечением с картинкой; наружу — PNG в `drops/`, а не
 * data-URL; потолка 2 МиБ нет — предел файла у `saveImage`. Copyright (c) 2026 Lovecast Inc.; полный текст лицензии — в
 * NOTICE в корне репозитория.
 */
import type { NativeImage, WebContents } from 'electron';
import type { PickResult, Rect } from '../../shared/browser-types.js';
import { S } from '../../shared/strings.js';
import { elementInfo, withTimeout, type CdpSender, type ElementInfo } from './element-info.js';
import { cutCodePoints, documentPoint, finite, isRecord, readPoint, readRect } from './guest-data.js';

/** Мир скрипта выбора: не 0 (мир страницы) и не занятые Electron. */
export const PICK_WORLD_ID = 1001;

/**
 * Пределы данных элемента (спека 12.3, «Числа» плана; спека браузера 8). `selector` спека ограничивает только звеньями,
 * а одно звено (класс или id) пишет страница — длина своя (fix-9). `captureSide` — сторона обрезки снимка в
 * CSS-пикселях: выбранный `body` длинной страницы не превращается в PNG на десятки мегабайт. `viewportSlack` — допуск
 * «больше вьюпорта» в CSS-пикселях (`exceedsViewport`). `infoMs` — сколько ждём роль и React: страница в бесконечном цикле
 * не держит выбор. `scriptMs` — сколько ждём ответ страницы на служебный вызов аннотаций (перерисовка, счёт и снятие
 * меток) и на снимок с метками: упавший или замёрзший гость не отвечает вовсе, скрытый не отдаёт снимок, и без предела окно
 * ждало бы вечно. Зеркало первых четырёх — `guest-dom.js` (`LIMITS`).
 */
export const PICK_LIMITS = { html: 4096, text: 500, selectorLinks: 12, selector: 1024, captureSide: 4096, viewportSlack: 1, infoMs: 2000, scriptMs: 3000 } as const;

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
const CANCEL_SCRIPT = 'globalThis.__parleyPickCancel?.()';

export type ValidPick = Pick<PickResult, 'selector' | 'text' | 'html' | 'styles' | 'point' | 'shift' | 'viewport'> & {
  rect: Rect;
  scroll: { x: number; y: number };
};

/**
 * Проверка формы данных из гостя: лишние поля выкинуты, строки обрезаны (html — с S.contextFile.truncated),
 * неверная форма → null. Битая точка — не повод отвергать выбор: без неё нет только роли и React.
 */
export function validatePick(raw: unknown): ValidPick | null {
  if (!isRecord(raw)) return null;
  const { selector, text, html, styles, viewport, devicePixelRatio: dpr } = raw;
  if (typeof selector !== 'string' || typeof text !== 'string' || typeof html !== 'string' || !isRecord(styles)) {
    return null;
  }
  const rect = readRect(raw.rect);
  if (rect === null || !isRecord(viewport)) return null;
  const { width: viewWidth, height: viewHeight } = viewport;
  if (!finite(viewWidth) || !finite(viewHeight) || viewWidth <= 0 || viewHeight <= 0 || !finite(dpr) || dpr <= 0) return null;

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
    html: cutHtml.cut ? cutHtml.text + S.contextFile.truncated : cutHtml.text,
    styles: cleanStyles,
    rect,
    viewport: { width: viewWidth, height: viewHeight, dpr },
    point: readPoint(raw.point),
    shift: raw.shift === true,
    scroll: readPoint(raw.scroll) ?? { x: 0, y: 0 },
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

/** Обрезка CDP `Page.captureScreenshot`: прямоугольник в CSS-пикселях документа × масштаб страницы. */
export interface CaptureClip extends Rect {
  scale: 1;
}

/**
 * Элемент больше вьюпорта: шире или выше больше чем на `viewportSlack` (1 CSS-пиксель). Видимая часть его не вместит, и для
 * снимка нужна обрезка CDP за краем вьюпорта. Остальные — и помещающиеся, и частью за краем (скрипт выбора прокручивает
 * такой в видимую часть) — снимаются вырезкой из `capturePage()`: она надёжнее. Допуск нужен, потому что при дробном
 * масштабе страницы или DPR блок «во всю ширину» измеряется шире вьюпорта на доли пикселя; без допуска он уходил бы в
 * обрезку CDP, которая в `<webview>` порой отдаёт не тот участок.
 */
export function exceedsViewport(rect: Rect, viewport: { width: number; height: number }): boolean {
  return rect.width > viewport.width + PICK_LIMITS.viewportSlack || rect.height > viewport.height + PICK_LIMITS.viewportSlack;
}

/**
 * Обрезка CDP (спайк 0.7, решение 2026-10-08): прямоугольник вьюпорта плюс прокрутка — координаты документа, — умноженный
 * на масштаб страницы `zoom` (`getZoomFactor()`: без него при масштабе 2 обрезка пуста). Высота — не больше поверхности
 * вида `surface` (CSS-пиксели): выше Chromium повторяет первую поверхность. Сторона — не больше `captureSide`.
 */
export function captureClip(pick: Pick<ValidPick, 'rect' | 'scroll'>, zoom: number, surface: number): CaptureClip | null {
  const width = Math.min(pick.rect.width, PICK_LIMITS.captureSide);
  const height = Math.min(pick.rect.height, PICK_LIMITS.captureSide, surface);
  if (width < 1 || height < 1) return null;
  return {
    x: Math.max(0, pick.rect.x + pick.scroll.x) * zoom,
    y: Math.max(0, pick.rect.y + pick.scroll.y) * zoom,
    width: width * zoom,
    height: height * zoom,
    scale: 1,
  };
}

/**
 * Снимок видимой части по Orca: прямоугольник элемента в пикселях картинки `capturePage()` всей видимой части. Множитель
 * измеряется — ширина картинки / ширина вьюпорта: он уже учитывает DPR экрана, масштаб страницы и уменьшение под поле
 * при эмуляции. Края — наружу, по пересечению с картинкой; элемент вне видимой части — null.
 */
export function cropRect(rect: Rect, viewport: { width: number }, bitmap: { width: number; height: number }): Rect | null {
  const scale = bitmap.width / viewport.width;
  const left = Math.max(0, Math.floor(rect.x * scale));
  const top = Math.max(0, Math.floor(rect.y * scale));
  const right = Math.min(bitmap.width, Math.ceil((rect.x + rect.width) * scale));
  const bottom = Math.min(bitmap.height, Math.ceil((rect.y + rect.height) * scale));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
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
  inspector: CdpSender;
}): {
  start(id: number): Promise<PickResult | null>;
  cancel(id: number): Promise<void>;
  downloadStarted(id: number): void;
} {
  // Незавершённый выбор гостя: навигация, падение или закрытие страницы могут оставить промис
  // скрипта навсегда без ответа — тогда отвечает main, иначе карточка зависла бы в «выбираю».
  const pending = new Map<number, (result: PickResult | null) => void>();

  /**
   * Снимок элемента: вырезка из `capturePage()` видимой части по Orca. Элементу больше вьюпорта (`exceedsViewport`)
   * сперва пробуется обрезка CDP за краем вьюпорта, не вышла — та же вырезка. Остальным CDP не зовётся и когда видимая
   * часть не снялась: пустой файл честнее участка не оттуда. Картинка видимой части снимается первой: её высота — мера
   * поверхности вида для обрезки CDP (в CSS-пикселях — делённая на DPR страницы). Не вышло — null: файл уйдёт без снимка.
   */
  async function snapshot(contents: WebContents, id: number, pick: ValidPick): Promise<string | null> {
    const view: NativeImage | null = await contents.capturePage().then(
      (image) => (image.isEmpty() ? null : image),
      (error: unknown) => {
        console.warn('[parley] select: capturePage failed', error);
        return null;
      },
    );
    const size = view === null ? null : view.getSize();
    if (exceedsViewport(pick.rect, pick.viewport)) {
      const surface = size === null ? pick.viewport.height : size.height / pick.viewport.dpr;
      const clip = captureClip(pick, contents.getZoomFactor(), surface);
      if (clip !== null) {
        try {
          const shot = await deps.inspector.send<{ data?: unknown }>(id, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
          if (typeof shot.data === 'string' && shot.data !== '') return await deps.saveImage(Buffer.from(shot.data, 'base64'));
        } catch (error) {
          console.warn('[parley] select: CDP capture failed, falling back to capturePage', error);
        }
      }
    }
    if (view === null || size === null) return null;
    const crop = cropRect(pick.rect, pick.viewport, size);
    if (crop === null) return null;
    try {
      return await deps.saveImage(view.crop(crop).toPNG());
    } catch (error) {
      console.warn('[parley] select capture failed', error);
      return null;
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
          // DOM.getNodeForLocation — в координатах документа (спайк 0.4, 0.6): точка вьюпорта плюс прокрутка.
          const [imagePath, info] = await Promise.all([
            snapshot(contents, id, pick),
            withTimeout<ElementInfo>(elementInfo(deps.inspector, id, documentPoint(pick.point, pick.scroll), pick.selector), PICK_LIMITS.infoMs, {}),
          ]);
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
            imagePath,
            point: pick.point,
            shift: pick.shift,
            viewport: pick.viewport,
            ...info,
          });
        })
        .catch((error: unknown) => {
          if (!done) console.warn('[parley] design mode script failed', error);
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
