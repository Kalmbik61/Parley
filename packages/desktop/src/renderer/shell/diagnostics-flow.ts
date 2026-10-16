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

/** Собирает архив; успех — тост с «Show in Finder» и результат, ошибка — тост и `null`. */
export async function runSaveDiagnostics(
  bridge: ParleyBridge,
  options: { profile: boolean },
): Promise<DiagnosticsSaveResult | null> {
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
