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
 *
 * Самообновление (спека self-update §4.1): тост один и сменяет состояния на месте — найден релиз («Update» или
 * «Download»), загрузка с процентом, проверка, готово («Restart now»), отказ («Download»). «Update» версию закрытой
 * не записывает, а «Update», «Cancel» и «Restart now» тост не закрывают (`event.preventDefault()`: sonner иначе
 * закрывает тост на кнопке действия) — отказ выхода вопросом оставляет «готово» на месте. Смахнутый тост о версии
 * больше не появляется, загрузка идёт дальше, а состояние видно в настройках. Итог замены после перезапуска (§4.3)
 * показывается один раз при подключении.
 */

import { toast } from 'sonner';
import type { ParleyBridge, UpdateState } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useUiStore } from '../store/ui.js';

export const UPDATE_TOAST_ID = 'update-available';
/** Тост об итоге замены после перезапуска: свой, чтобы не затереть тост о найденной версии. */
export const UPDATE_RESULT_TOAST_ID = 'update-result';

/** Целый процент загрузки; `null` — размер неизвестен. */
export function updatePercent(received: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
}

/** Кнопка тоста, которая не должна закрывать тост: sonner закрывает его, если не отменить действие по умолчанию. */
type ClickEvent = { preventDefault(): void } | undefined;

export function wireUpdateNotice(bridge: ParleyBridge): () => void {
  // Последнее состояние кроме `idle`: найденное до загрузки `ui.json` показывается, когда решать уже есть чем.
  let state: UpdateState = { phase: 'idle' };
  let shown = false;
  let disposed = false;

  const dismiss = (version: string): void => {
    const { ui } = useUiStore.getState();
    // Переключатель выключен: тост снят нами же (`toast.dismiss` ниже), а его `onDismiss` — не решение человека.
    // Запись «закрыто» спрятала бы версию и после того, как он включит проверку обратно.
    if (!ui.checkForUpdates) return;
    // Повтор того же значения не пишется: `patchUi` на каждое закрытие слал бы файл заново.
    if (ui.dismissedUpdate === version) return;
    useUiStore.getState().patchUi({ dismissedUpdate: version });
  };

  const run = (what: string, call: () => Promise<void>): void => {
    call().catch((error: unknown) => console.warn(`[parley] ${what}`, error));
  };

  /** Страница релиза в браузере; версия закрывается: человек получил ссылку. */
  const openRelease = (version: string, url: string): void => {
    dismiss(version);
    run('openExternal', () => bridge.app.openExternal(url));
  };

  const show = (): void => {
    const { ui, uiLoaded } = useUiStore.getState();
    if (state.phase === 'idle' || !uiLoaded || !ui.checkForUpdates) return;
    const { version, url } = state;
    if (ui.dismissedUpdate === version) return;
    // sonner сливает параметры с прежними того же `id`: все поля задаются явно, чтобы кнопки прошлого состояния
    // не оставались в новом.
    const options = {
      id: UPDATE_TOAST_ID,
      duration: Infinity,
      description: undefined as string | undefined,
      action: undefined as { label: string; onClick: (event?: ClickEvent) => void } | undefined,
      cancel: undefined as { label: string; onClick: () => void } | undefined,
      // Смахивание тоста: кнопки sonner `onDismiss` не зовёт — у них свои обработчики.
      onDismiss: () => dismiss(version),
    };
    // Только закрыть: sonner закрывает тост сам. Версия не записывается — «позже» не «никогда».
    const later = { label: S.update.later, onClick: () => {} };
    const cancelDownload = {
      label: S.update.cancel,
      onClick: (event?: ClickEvent) => {
        event?.preventDefault();
        run('cancelUpdateDownload', () => bridge.app.cancelUpdateDownload());
      },
    };
    const download = { label: S.update.download, onClick: () => openRelease(version, url) };
    let message: string;
    switch (state.phase) {
      case 'available':
        message = S.update.available(version);
        options.action = state.canInstall
          ? {
              label: S.update.update,
              // «Update» версию закрытой не записывает; тост остаётся и сменяется загрузкой на месте.
              onClick: (event) => {
                event?.preventDefault();
                run('downloadUpdate', () => bridge.app.downloadUpdate());
              },
            }
          : download;
        options.cancel = later;
        break;
      case 'downloading':
        message = S.update.downloading(version, updatePercent(state.received, state.total));
        options.action = cancelDownload;
        break;
      case 'verifying':
        message = S.update.checking(version);
        options.action = cancelDownload;
        break;
      case 'ready':
        message = S.update.ready(version);
        options.description = S.update.readyHint;
        options.action = {
          label: S.update.restartNow,
          // Выход может быть отменён вопросом: тост «готово» тогда остаётся на месте.
          onClick: (event) => {
            event?.preventDefault();
            run('installUpdate', () => bridge.app.installUpdate());
          },
        };
        options.cancel = later;
        break;
      case 'failed':
        message = S.update.failed(version, S.update.failure[state.reason]);
        options.action = download;
        options.cancel = later;
        break;
    }
    shown = true;
    toast(message, options);
  };

  const off = bridge.app.onUpdateState((next) => {
    state = next;
    if (next.phase === 'idle') {
      // Проверку выключили или попытку сняли: стоящий тост убирается, но это не решение человека.
      if (shown) toast.dismiss(UPDATE_TOAST_ID);
      shown = false;
      return;
    }
    show();
  });
  // Итог прошлой замены отдаётся один раз (`takeUpdateResult`); main уже сверил версию с запущенной.
  bridge.app
    .takeUpdateResult()
    .then((result) => {
      if (disposed || result === null) return;
      toast(
        result.kind === 'updated'
          ? S.update.updated(result.version)
          : S.update.failedAfterRestart(result.version, S.update.resultFailure[result.reason]),
        // Отказ стоит, пока его не закроют: это единственная весть о том, почему версия прежняя.
        result.kind === 'failed'
          ? { id: UPDATE_RESULT_TOAST_ID, duration: Infinity }
          : { id: UPDATE_RESULT_TOAST_ID },
      );
    })
    .catch((error: unknown) => console.warn('[parley] takeUpdateResult', error));
  // `ui.json` приходит после подписки: версия, найденная раньше, показывается, когда решать уже есть чем.
  const offUi = useUiStore.subscribe((uiState, prev) => {
    if (uiState.uiLoaded && !prev.uiLoaded) show();
    if (uiState.ui.checkForUpdates === prev.ui.checkForUpdates) return;
    // Переключатель «Check for updates»: выключили — стоящий тост снимается, включили — найденное снова на виду.
    if (uiState.ui.checkForUpdates) show();
    else toast.dismiss(UPDATE_TOAST_ID);
  });
  return () => {
    disposed = true;
    off();
    offUi();
  };
}
