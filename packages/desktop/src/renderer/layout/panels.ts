/**
 * Панели браузера хозяев в раскладке работы (спека браузера 3.10, 4.11; этап B2, часть 1). Чистые функции над
 * `WorkLayout`, как `layout/tree.ts`: новая раскладка или та же ссылка, если менять нечего; отказ предела страниц —
 * `OpResult` с ошибкой, а не исключение.
 *
 * Панель — это `WorkLayout.panels[ownerKey(owner)]`. Её создаёт первая добавленная страница (панели без страниц нет),
 * уносит последняя закрытая; закрытая вкладка хозяина панель не трогает, исчезнувший хозяин — стирает (`prunePanels`).
 * Разбор с диска — в `tree.ts#parseWorkLayout` рядом с разбором вкладок.
 */

import type { ViewportSpec } from '../../shared/browser-devtools.js';
import type { BrowserOwner, BrowserPanelPage, BrowserPanelSpec, WorkLayout } from '../../shared/layout-types.js';
import { ownerKey, ownerOfKey } from './ids.js';
import { PANEL_LIMITS, type OpResult } from './tree.js';

/** Поля страницы без id: адрес и размер; размер `null` — снять поле (Fit), как у вкладки (`TabPatch`). */
export type PanelPagePatch = { url?: string; viewport?: ViewportSpec | null };

export function panelOf(layout: WorkLayout, owner: BrowserOwner): BrowserPanelSpec | undefined {
  return layout.panels?.[ownerKey(owner)];
}

function withPanel(layout: WorkLayout, owner: BrowserOwner, panel: BrowserPanelSpec): WorkLayout {
  return { ...layout, panels: { ...layout.panels, [ownerKey(owner)]: panel } };
}

/** Хозяин панели, в которой стоит страница `pageId` (id страниц уникальны на всё окно); такой страницы нет — `null`. */
export function ownerOfPage(layout: WorkLayout, pageId: string): BrowserOwner | null {
  for (const [key, panel] of Object.entries(layout.panels ?? {})) {
    if (panel.pages.some((page) => page.id === pageId)) return ownerOfKey(key);
  }
  return null;
}

/** Раскладка с этими панелями; ни одной — без поля `panels`, раскладка снова как до панелей. */
function withPanels(layout: WorkLayout, entries: Array<[string, BrowserPanelSpec]>): WorkLayout {
  if (entries.length > 0) return { ...layout, panels: Object.fromEntries(entries) };
  const next = { ...layout };
  delete next.panels;
  return next;
}

/**
 * Страница в панель хозяина, активная; панель создаётся и открывается (так видит человек и страницу агента, и свою
 * новую). Пять страниц уже есть — `too-many-pages`, раскладка прежняя. Id страницы выбирает вызывающий (`panelPageId`).
 */
export function addPanelPage(layout: WorkLayout, owner: BrowserOwner, page: BrowserPanelPage): OpResult {
  const panel = panelOf(layout, owner);
  if ((panel?.pages.length ?? 0) >= PANEL_LIMITS.pages) return { layout, error: 'too-many-pages' };
  const next: BrowserPanelSpec = {
    open: true,
    width: panel?.width ?? PANEL_LIMITS.defaultWidth,
    pages: [...(panel?.pages ?? []), page],
    active: page.id,
  };
  return { layout: withPanel(layout, owner, next), error: null };
}

/** Показать или спрятать панель; страницы остаются. Панели нет или страниц нет (открывать нечего) — та же раскладка. */
export function setPanelOpen(layout: WorkLayout, owner: BrowserOwner, open: boolean): WorkLayout {
  const panel = panelOf(layout, owner);
  if (panel === undefined || panel.open === open || (open && panel.pages.length === 0)) return layout;
  return withPanel(layout, owner, { ...panel, open });
}

/** Поставить агентов панели на паузу или снять её; поле снимается целиком. Панели нет или состояние то же — та же раскладка. */
export function setPanelPaused(layout: WorkLayout, owner: BrowserOwner, paused: boolean): WorkLayout {
  const panel = panelOf(layout, owner);
  if (panel === undefined || (panel.paused === true) === paused) return layout;
  if (paused) return withPanel(layout, owner, { ...panel, paused: true });
  return withPanel(layout, owner, { open: panel.open, width: panel.width, pages: panel.pages, active: panel.active });
}

/**
 * Закрыть страницу. Активной становится сосед — справа, иначе слева, как у вкладок. Последняя страница уносит панель:
 * закрывать в ней нечего, а ширина без страниц ничего не стоит.
 */
export function closePanelPage(layout: WorkLayout, owner: BrowserOwner, pageId: string): WorkLayout {
  const panel = panelOf(layout, owner);
  const index = panel?.pages.findIndex((page) => page.id === pageId) ?? -1;
  if (panel === undefined || index === -1) return layout;
  const pages = panel.pages.filter((page) => page.id !== pageId);
  if (pages.length === 0) return withPanels(layout, Object.entries(layout.panels ?? {}).filter(([key]) => key !== ownerKey(owner)));
  const neighbor = pages[index] ?? pages[index - 1];
  const active = panel.active === pageId ? (neighbor?.id ?? null) : panel.active;
  return withPanel(layout, owner, { ...panel, pages, active });
}

export function activatePanelPage(layout: WorkLayout, owner: BrowserOwner, pageId: string): WorkLayout {
  const panel = panelOf(layout, owner);
  if (panel === undefined || panel.active === pageId || !panel.pages.some((page) => page.id === pageId)) return layout;
  return withPanel(layout, owner, { ...panel, active: pageId });
}

/** Адрес и размер страницы; адрес не изменился — та же раскладка (поверхность пишет адрес на каждый переход). */
export function updatePanelPage(layout: WorkLayout, owner: BrowserOwner, pageId: string, patch: PanelPagePatch): WorkLayout {
  const panel = panelOf(layout, owner);
  const index = panel?.pages.findIndex((page) => page.id === pageId) ?? -1;
  const current = panel?.pages[index];
  if (panel === undefined || current === undefined) return layout;
  if (patch.viewport === undefined && (patch.url === undefined || patch.url === current.url)) return layout;
  const next: BrowserPanelPage = { ...current, url: patch.url ?? current.url };
  if (patch.viewport === null) delete next.viewport;
  else if (patch.viewport !== undefined) next.viewport = patch.viewport;
  return withPanel(layout, owner, { ...panel, pages: panel.pages.map((page) => (page.id === pageId ? next : page)) });
}

/** Ширина панели, не меньше 320; верхний предел (70 % вида) — дело вида: ему известна его ширина. */
export function setPanelWidth(layout: WorkLayout, owner: BrowserOwner, width: number): WorkLayout {
  const panel = panelOf(layout, owner);
  if (panel === undefined || !Number.isFinite(width)) return layout;
  const next = Math.max(Math.round(width), PANEL_LIMITS.minWidth);
  return next === panel.width ? layout : withPanel(layout, owner, { ...panel, width: next });
}

/** Панели хозяев, которых больше нет (сессию удалили, комнату удалили или убрали в архив), уходят вместе со страницами. */
export function prunePanels(layout: WorkLayout, alive: (owner: BrowserOwner) => boolean): WorkLayout {
  const panels = layout.panels;
  if (panels === undefined) return layout;
  const kept = Object.entries(panels).filter(([key]) => {
    const owner = ownerOfKey(key);
    return owner !== null && alive(owner);
  });
  return kept.length === Object.keys(panels).length ? layout : withPanels(layout, kept);
}
