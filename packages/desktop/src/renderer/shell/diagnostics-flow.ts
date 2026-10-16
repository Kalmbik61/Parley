/**
 * Сохранение архива диагностики из окна (спека диагностики хоста 2026-10-16, A1, A6): один вызов `app.saveDiagnostics`
 * для сегмента строки статуса и действия палитры `host.diagnostics`. Архив собирает и показывает в Finder main; окно
 * сообщает итог тостом. Отказ — тостом по коду ошибки, без необработанного отказа промиса.
 */

import { toast } from 'sonner';
import type { DiagnosticsSaveResult, ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';

/** Длина записи профиля хоста: столько секунд идёт отсчёт в сегменте (хост: `PROFILE_DEFAULT_SECONDS`). */
export const PROFILE_SECONDS = 20;

/** Сборка, которая идёт прямо сейчас: сегмент и палитра делят её, второй вызов не запускает вторую (и не показывает второй тост). */
let inFlight: Promise<DiagnosticsSaveResult | null> | null = null;

/** Для тестов: сбрасывает «идущую» сборку, чтобы не зависнуть на отложенном ответе предыдущего теста. */
export function resetDiagnosticsFlowForTests(): void {
  inFlight = null;
}

async function save(bridge: ParleyBridge, options: { profile: boolean }): Promise<DiagnosticsSaveResult | null> {
  try {
    const result = await bridge.app.saveDiagnostics(options);
    toast(S.diagnostics.saved, {
      action: {
        label: S.diagnostics.showInFinder,
        onClick: () => {
          bridge.app.showInFinder(result.file).catch((error: unknown) => {
            console.warn('[parley] app.showInFinder', error);
          });
        },
      },
    });
    return result;
  } catch (error) {
    console.error('[parley] save diagnostics', error);
    toast(errorText(decodeIpcError(error).code, S.errors.actions.saveDiagnostics));
    return null;
  }
}

/**
 * Собирает архив; успех — тост с «Show in Finder» и результат, ошибка — тост и `null`. Одна сборка за раз: пока она
 * идёт, повторный вызов (сегмент и палитра, двойной клик) получает тот же промис, а тост показывает только первый.
 */
export function runSaveDiagnostics(
  bridge: ParleyBridge,
  options: { profile: boolean },
): Promise<DiagnosticsSaveResult | null> {
  if (inFlight !== null) return inFlight;
  const running = save(bridge, options).finally(() => {
    if (inFlight === running) inFlight = null;
  });
  inFlight = running;
  return running;
}
