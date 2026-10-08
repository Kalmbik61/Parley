// packages/desktop/src/renderer/browser/stage.ts
/**
 * Геометрия поверхности вкладки браузера (спека 2026-10-07-browser-devtools-agent-design.md, 4.2, 4.3).
 * - При эмуляции размера страница стоит по центру нейтрального поля, над ней — подпись «375 × 812 · 2x». Не влезает —
 *   уменьшена по `scale` из main, в подписи процент.
 * - Высота панели Console | Network — сохранённая или 40 % вкладки, не ниже 120 px; странице над панелью остаётся место.
 */
import { viewportSize, type ViewportSpec } from '../../shared/browser-devtools.js';
import { S } from '../../shared/strings.js';
import { DEVTOOLS_PANEL } from '../../shared/ui-types.js';

/** Поля вокруг страницы и строка подписи над ней, CSS-пиксели окна. */
export const STAGE = { pad: 16, label: 20 } as const;
/** Строка над страницей — `h-9` в `BrowserChrome`. */
export const CHROME_PX = 36;
/** Над панелью странице остаётся не меньше этого. */
export const MIN_PAGE_PX = 80;

export interface FieldSize {
  width: number;
  height: number;
}

export interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

/** Место под страницу: поле без полей по краям и строки подписи; не меньше 1×1 — main ждёт положительные числа. */
export function fitArea(field: FieldSize): FieldSize {
  return {
    width: Math.max(1, Math.floor(field.width - 2 * STAGE.pad)),
    height: Math.max(1, Math.floor(field.height - 2 * STAGE.pad - STAGE.label)),
  };
}

/** Где стоит страница размера `spec`, уменьшенная по `scale`, и что написано над ней. */
export function stageBox(field: FieldSize, spec: ViewportSpec, scale: number): StageBox {
  const size = viewportSize(spec);
  const width = Math.floor(size.width * scale);
  const height = Math.floor(size.height * scale);
  const area = fitArea(field);
  return {
    left: Math.max(0, Math.round((field.width - width) / 2)),
    top: STAGE.pad + STAGE.label + Math.max(0, Math.round((area.height - height) / 2)),
    width,
    height,
    label: S.browser.viewport.label(size.width, size.height, size.dpr, scale < 1 ? Math.round(scale * 100) : null),
  };
}

/** Высота панели: сохранённая или 40 % вкладки, не ниже 120 и не выше, чем оставляет место странице. */
export function panelHeight(saved: number | null, rootHeight: number): { height: number; max: number } {
  const max = Math.max(DEVTOOLS_PANEL.minHeight, Math.floor(rootHeight - CHROME_PX - MIN_PAGE_PX));
  const wanted = saved ?? Math.round(rootHeight * DEVTOOLS_PANEL.defaultShare);
  return { height: Math.min(Math.max(wanted, DEVTOOLS_PANEL.minHeight), max), max };
}
