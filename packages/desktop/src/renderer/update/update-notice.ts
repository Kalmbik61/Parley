/**
 * Тост о новой версии (V6 плана релиза 0.1.0): main нашёл на GitHub релиз новее запущенного
 * (`main/update-check.ts`), окно говорит «Parley X.Y.Z is available» с кнопками «Download» (страница релиза в
 * браузере) и «Later». Без подписи Apple окно само не обновляется — только сообщает.
 *
 * Тост один на окно (`UPDATE_TOAST_ID`): та же версия приходит не раз — проверка идёт раз в сутки, а подписка
 * после обрыва связи заводится заново, — и повтор обновляет стоящий тост на месте. Стоит, пока человек его не
 * закроет: у `Infinity` нет таймера. Версия записывается в `ui.json` (`dismissedUpdate`), и о ней тост больше не
 * появится (о более новой — появится), когда человек её закрыл: «Download» (он получил ссылку) или смахнул тост.
 * «Later» — только закрыть тост: он вернётся со следующей проверкой, при новом запуске или после переподключения
 * к хосту. Записанное «Later» значило бы «никогда», хотя кнопка обещает обратное.
 *
 * Решает по зеркалу `ui.json` (`store/ui.ts`): пока оно не загружено (`uiLoaded`), решать нечем — иначе уже
 * закрытая версия показалась бы на миг до ответа `app.loadUi()`. Переключатель «Check for updates» выключен —
 * тоста нет, даже если main успел найти релиз; выключили при стоящем тосте — он снимается, включили — найденное
 * снова на виду (main при этом проверяет сразу, `settingsChanged`).
 */

import { toast } from 'sonner';
import type { ParleyBridge, UpdateInfo } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';

export const UPDATE_TOAST_ID = 'update-available';

export function wireUpdateNotice(bridge: ParleyBridge): () => void {
  let info: UpdateInfo | null = null;

  const dismiss = (version: string): void => {
    const { ui } = useUiStore.getState();
    // Переключатель выключен: тост снят нами же (`toast.dismiss` ниже), а его `onDismiss` — не решение человека.
    // Запись «закрыто» спрятала бы версию и после того, как он включит проверку обратно.
    if (!ui.checkForUpdates) return;
    // Повтор того же значения не пишется: `patchUi` на каждое закрытие слал бы файл заново.
    if (ui.dismissedUpdate === version) return;
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
      // Только закрыть: sonner закрывает тост сам. Версия не записывается — «позже» не «никогда».
      cancel: { label: S.update.later, onClick: () => {} },
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
    if (state.ui.checkForUpdates === prev.ui.checkForUpdates) return;
    // Переключатель «Check for updates»: выключили — стоящий тост снимается, включили — найденное снова на виду.
    if (state.ui.checkForUpdates) show();
    else toast.dismiss(UPDATE_TOAST_ID);
  });
  return () => {
    off();
    offUi();
  };
}
