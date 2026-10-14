/**
 * Каналы острова в main (спека 2026-10-12, 5.1). Каждый слушает только окно острова (`controller.isIsland`):
 * чужое окно с тем же именем канала ничего не двигает. Данные проверяются по форме: видимость — булево, точка — два
 * числа, область под мышь — `null` или четыре конечных числа (размеры не отрицательны, значения не больше
 * `MAX_HIT_RECT_VALUE`), цель — `isFocusTarget`, как у уведомлений, «просмотрено» — от 1 до `MAX_SEEN_REFS` ссылок на сессии
 * (`sessionRef` протокола).
 */

import type { IpcMain } from 'electron';
import { sessionRef, type SessionRef } from '@parley/protocol';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandConfig, IslandHitRect, IslandPoint } from '../../shared/island.js';
import { isFocusTarget, withIpcError } from '../ipc.js';
import type { IslandController, IslandWindowLike } from './window.js';

export interface IslandIpcOptions {
  ipcMain: Pick<IpcMain, 'on' | 'handle'>;
  controller: Pick<IslandController<IslandWindowLike>, 'isIsland' | 'setHitRect' | 'setVisible' | 'dragStart' | 'dragMove' | 'dragEnd'>;
  config(): Promise<IslandConfig>;
  /** Место могло смениться (другой монитор — другой отступ под чёлку): отдать острову настройки заново. */
  pushConfig(): void;
  openTarget(target: FocusTarget): void;
  beep(): void;
  /** Clear на острове: сессии просмотрены — хосту уходит `activity.seen` по каждой (список уже проверен). */
  markSeen(refs: SessionRef[]): void;
  /** Отрисовка острова упала (`IslandErrorBoundary`): окно больше не показывает запросы. */
  onFailed(): void;
}

function isPoint(value: unknown): value is IslandPoint {
  if (typeof value !== 'object' || value === null) return false;
  const { screenX, screenY } = value as Record<string, unknown>;
  return typeof screenX === 'number' && Number.isFinite(screenX) && typeof screenY === 'number' && Number.isFinite(screenY);
}

/** Верхняя граница чисел области под мышь: кадр окна — 480×520, всё, что заметно больше, — мусор. */
const MAX_HIT_RECT_VALUE = 2000;

function isHitRect(value: unknown): value is IslandHitRect {
  if (typeof value !== 'object' || value === null) return false;
  const { x, y, width, height } = value as Record<string, unknown>;
  const fits = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n <= MAX_HIT_RECT_VALUE;
  return fits(x) && fits(y) && fits(width) && width >= 0 && fits(height) && height >= 0;
}

/** Сколько сессий Clear отмечает за раз: строк Done на острове немного, всё, что больше, — мусор. */
const MAX_SEEN_REFS = 50;

/** Список ссылок для «просмотрено»: каждая прошла `sessionRef` (лишние поля срезаны) или `null`, если форма негодна. */
function parseSeenRefs(value: unknown): SessionRef[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SEEN_REFS) return null;
  const refs: SessionRef[] = [];
  for (const item of value) {
    const parsed = sessionRef.safeParse(item);
    if (!parsed.success) return null;
    refs.push(parsed.data);
  }
  return refs;
}

export function registerIslandIpc(options: IslandIpcOptions): void {
  const { ipcMain, controller } = options;
  const fromIsland = (event: unknown): boolean => controller.isIsland((event as { sender?: unknown }).sender);

  ipcMain.handle(
    'island:config',
    withIpcError(async (event) => {
      if (!fromIsland(event)) throw new Error('island:config is for the island window only');
      return options.config();
    }),
  );
  ipcMain.on('island:hit-rect', (event, rect: unknown) => {
    if (fromIsland(event) && (rect === null || isHitRect(rect))) controller.setHitRect(rect);
  });
  ipcMain.on('island:visible', (event, visible: unknown) => {
    if (fromIsland(event) && typeof visible === 'boolean') controller.setVisible(visible);
  });
  ipcMain.on('island:drag-start', (event, point: unknown) => {
    if (fromIsland(event) && isPoint(point)) controller.dragStart(point);
  });
  ipcMain.on('island:drag-move', (event, point: unknown) => {
    if (fromIsland(event) && isPoint(point)) controller.dragMove(point);
  });
  ipcMain.on('island:drag-end', (event, point: unknown) => {
    if (!fromIsland(event) || !isPoint(point)) return;
    controller.dragEnd(point);
    options.pushConfig();
  });
  ipcMain.on('island:open', (event, target: unknown) => {
    if (fromIsland(event) && isFocusTarget(target)) options.openTarget(target);
  });
  ipcMain.on('island:beep', (event) => {
    if (fromIsland(event)) options.beep();
  });
  ipcMain.on('island:mark-seen', (event, refs: unknown) => {
    if (!fromIsland(event)) return;
    const parsed = parseSeenRefs(refs);
    if (parsed !== null) options.markSeen(parsed);
  });
  ipcMain.on('island:failed', (event) => {
    if (fromIsland(event)) options.onFailed();
  });
}
