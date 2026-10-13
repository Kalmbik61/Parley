/**
 * Каналы острова в main (спека 2026-10-12, 5.1). Каждый слушает только окно острова (`controller.isIsland`):
 * чужое окно с тем же именем канала ничего не двигает. Данные проверяются по форме: видимость и интерактивность —
 * булевы, точка — два числа, цель — `isFocusTarget`, как у уведомлений.
 */

import type { IpcMain } from 'electron';
import type { FocusTarget } from '../../shared/bridge.js';
import type { IslandConfig, IslandPoint } from '../../shared/island.js';
import { isFocusTarget, withIpcError } from '../ipc.js';
import type { IslandController, IslandWindowLike } from './window.js';

export interface IslandIpcOptions {
  ipcMain: Pick<IpcMain, 'on' | 'handle'>;
  controller: Pick<IslandController<IslandWindowLike>, 'isIsland' | 'setInteractive' | 'setVisible' | 'dragStart' | 'dragMove' | 'dragEnd'>;
  config(): Promise<IslandConfig>;
  /** Место могло смениться (другой монитор — другой отступ под чёлку): отдать острову настройки заново. */
  pushConfig(): void;
  openTarget(target: FocusTarget): void;
  beep(): void;
  markHintShown(): void;
  /** Отрисовка острова упала (`IslandErrorBoundary`): окно больше не показывает запросы. */
  onFailed(): void;
}

function isPoint(value: unknown): value is IslandPoint {
  if (typeof value !== 'object' || value === null) return false;
  const { screenX, screenY } = value as Record<string, unknown>;
  return typeof screenX === 'number' && Number.isFinite(screenX) && typeof screenY === 'number' && Number.isFinite(screenY);
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
  ipcMain.on('island:interactive', (event, interactive: unknown) => {
    if (fromIsland(event) && typeof interactive === 'boolean') controller.setInteractive(interactive);
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
  ipcMain.on('island:hint-shown', (event) => {
    if (fromIsland(event)) options.markHintShown();
  });
  ipcMain.on('island:failed', (event) => {
    if (fromIsland(event)) options.onFailed();
  });
}
