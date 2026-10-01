/**
 * Тост о новой версии (V6 плана релиза 0.1.0): main нашёл на GitHub релиз новее запущенного
 * (`main/update-check.ts`), окно говорит «Parley X.Y.Z is available» с кнопками «Download» (страница релиза в
 * браузере) и «Later». Без подписи Apple окно само не обновляется — только сообщает.
 *
 * Тост один на окно (`UPDATE_TOAST_ID`): та же версия приходит не раз — проверка идёт раз в сутки, а подписка
 * после обрыва связи заводится заново, — и повтор обновляет стоящий тост на месте. Стоит, пока человек его не
 * закроет: у `Infinity` нет таймера, а закрытая версия записывается в `ui.json` (`dismissedUpdate`), и о ней тост
 * больше не появится; о более новой — появится. Закрытие — любое: «Later», «Download» (человек получил ссылку) и
 * смахивание самого тоста.
 *
 * Решает по зеркалу `ui.json` (`store/ui.ts`): пока оно не загружено (`uiLoaded`), решать нечем — иначе уже
 * закрытая версия показалась бы на миг до ответа `app.loadUi()`. Переключатель «Check for updates» выключен —
 * тоста нет, даже если main успел найти релиз.
 */

import { toast } from 'sonner';
import type { ParleyBridge, UpdateInfo } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';

export const UPDATE_TOAST_ID = 'update-available';

export function wireUpdateNotice(bridge: ParleyBridge): () => void {
  let info: UpdateInfo | null = null;

  const dismiss = (version: string): void => {
    // Повтор того же значения не пишется: `patchUi` на каждое закрытие слал бы файл заново.
    if (useUiStore.getState().ui.dismissedUpdate === version) return;
    useUiStore.getState().patchUi({ dismissedUpdate: version });
  };

  const show = (): void => {
    const { ui, uiLoaded } = useUiStore.getState();
    if (info === null || !uiLoaded || !ui.checkForUpdates || ui.dismissedUpdate === info.version)
      return;
    const { version, url } = info;
    toast(S.update.available(version), {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      action: {
        label: S.update.download,
        onClick: () => {
          dismiss(version);
          bridge.app
            .openExternal(url)
            .catch((error: unknown) => console.warn('[parley] openExternal', error));
        },
      },
      cancel: { label: S.update.later, onClick: () => dismiss(version) },
      // Смахивание тоста: кнопки sonner `onDismiss` не зовёт — у них свои обработчики выше.
      onDismiss: () => dismiss(version),
    });
  };

  const off = bridge.app.onUpdateAvailable((next) => {
    info = next;
    show();
  });
  // `ui.json` приходит после подписки: версия, найденная раньше, показывается, когда решать уже есть чем.
  const offUi = useUiStore.subscribe((state, prev) => {
    if (state.uiLoaded && !prev.uiLoaded) show();
  });
  return () => {
    off();
    offUi();
  };
}
