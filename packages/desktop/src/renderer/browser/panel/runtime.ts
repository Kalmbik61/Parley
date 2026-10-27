/**
 * Что про панели браузера знает только окно, но не раскладка (спека браузера 3.10, раздел 8): какие виды хозяев сейчас на
 * экране и узкие ли они, когда панелью пользовались в последний раз и какие панели держат живой `<webview>`.
 *
 * Предел живых панелей — 6 на окно. Видимые панели живы всегда; остальные — по свежести использования, пока есть места.
 * Прочие помнят адреса в раскладке и грузят их, когда их показывают: страница панели (`BrowserSurface`) на выгруженной
 * панели просто не монтируется. Слои поверхностей трёх последних работ публикуют свои панели сюда, а предел считается на
 * всё окно сразу. Свежесть (`touch`) дают и человек (клик, показ), и агент: просьба `browser_open` освежает панель хозяина
 * (`actions.ts#handleAgentOpenTab`), поэтому панель, с которой агент только что работал, не выгружается первой.
 */

import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import type { BrowserOwner } from '../../../shared/layout-types.js';
import { ownerKey } from '../../layout/ids.js';

/**
 * Сколько панелей окна держат живой `<webview>` (спека браузера 8). Замер 2026-10-14 (`app.getAppMetrics()`, окно с чатом,
 * на каждой панели одна страница-пустышка на 127.0.0.1): без панелей 435 МБ рабочего набора всех процессов Electron, с одной —
 * 541, с тремя — 718, с шестью — 992; гость — отдельный процесс, около 86 МБ на страницу. Живая страница настоящего dev-сервера
 * тяжелее, а у панели их до пяти, поэтому шесть — предел по числу панелей, а не по числу страниц.
 */
export const LIVE_PANELS = 6;

/** Ключ панели в состоянии окна: ключ хозяина повторяется от работы к работе, поэтому с ключом работы. */
export function panelRuntimeKey(workKey: string, owner: BrowserOwner): string {
  return `${workKey}\n${ownerKey(owner)}`;
}

export interface LiveCandidate {
  key: string;
  visible: boolean;
  /** Когда панелью пользовались в последний раз, мс. */
  usedAt: number;
}

/**
 * Живые панели окна: все видимые, затем самые свежие из остальных, всего не больше `limit`. Видимых больше предела (окно
 * разрезано на много групп с открытыми панелями) — живы все они: человек смотрит на них сейчас.
 */
export function selectLive(candidates: readonly LiveCandidate[], limit: number = LIVE_PANELS): Set<string> {
  const visible = candidates.filter((candidate) => candidate.visible);
  const hidden = candidates.filter((candidate) => !candidate.visible).sort((a, b) => b.usedAt - a.usedAt);
  return new Set([...visible, ...hidden.slice(0, Math.max(0, limit - visible.length))].map((candidate) => candidate.key));
}

/** Панель слоя работы: что слой знает о ней и публикует для предела. */
export interface PublishedPanel {
  key: string;
  visible: boolean;
}

export interface PanelRuntimeState {
  /** Виды хозяев на экране (`PanelHost` смонтирован): узкий вид закрывает панель собой целиком. */
  hosts: Record<string, { narrow: boolean; measured: boolean }>;
  usedAt: Record<string, number>;
  published: Record<string /* workKey */, PublishedPanel[]>;
  /** Ключи живых панелей; пока состав тот же, ссылка прежняя. */
  live: ReadonlySet<string>;
  mountHost(key: string, narrow: boolean, measured?: boolean): void;
  unmountHost(key: string): void;
  /** Панелью пользуются (клик, показ): она последняя в очереди на выгрузку. */
  touch(key: string): void;
  publish(workKey: string, panels: PublishedPanel[]): void;
  retract(workKey: string): void;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/** Новый состав живых; не изменился — прежняя ссылка, подписчики не перерисовываются. */
function liveOf(was: ReadonlySet<string>, published: Record<string, PublishedPanel[]>, usedAt: Record<string, number>): ReadonlySet<string> {
  const next = selectLive(Object.values(published).flat().map((panel) => ({ ...panel, usedAt: usedAt[panel.key] ?? 0 })));
  return sameSet(was, next) ? was : next;
}

export const usePanelRuntime: UseBoundStore<StoreApi<PanelRuntimeState>> = create<PanelRuntimeState>((set) => ({
  hosts: {},
  usedAt: {},
  published: {},
  live: new Set(),

  mountHost: (key, narrow, measured = false) =>
    set((state) => (state.hosts[key]?.narrow === narrow && state.hosts[key]?.measured === measured ? state : { hosts: { ...state.hosts, [key]: { narrow, measured } } })),

  unmountHost: (key) =>
    set((state) => {
      if (!(key in state.hosts)) return state;
      const hosts = { ...state.hosts };
      delete hosts[key];
      return { hosts };
    }),

  touch: (key) =>
    set((state) => {
      const usedAt = { ...state.usedAt, [key]: Date.now() };
      return { usedAt, live: liveOf(state.live, state.published, usedAt) };
    }),

  publish: (workKey, panels) =>
    set((state) => {
      const wasVisible = new Set((state.published[workKey] ?? []).filter((panel) => panel.visible).map((panel) => panel.key));
      const now = Date.now();
      const usedAt = { ...state.usedAt };
      // Новая панель и панель, которую только что показали, — последние в очереди на выгрузку.
      for (const panel of panels) {
        if (usedAt[panel.key] === undefined || (panel.visible && !wasVisible.has(panel.key))) usedAt[panel.key] = now;
      }
      const published = { ...state.published, [workKey]: panels };
      return { published, usedAt, live: liveOf(state.live, published, usedAt) };
    }),

  retract: (workKey) =>
    set((state) => {
      if (!(workKey in state.published)) return state;
      const published = { ...state.published };
      delete published[workKey];
      return { published, live: liveOf(state.live, published, state.usedAt) };
    }),
}));
