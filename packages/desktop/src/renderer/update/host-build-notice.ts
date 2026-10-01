/**
 * Тост «хост от другой сборки» (0.2.0). Хост живёт отдельно от окна: после установки новой версии окно
 * подключается к хосту, которого запустило прежнее приложение. Протокол у них тот же, но агенты и git идут от
 * старой копии, а macOS считает копии разными приложениями (подпись ad-hoc у каждой сборки своя) и по кругу
 * спрашивает доступ к папкам. Строка статуса держит сегмент «Host is outdated — restart», а этот тост говорит
 * о том же один раз и громче: в 0.1.1 тихое «Host 0.1.0» в строке статуса не заметили.
 *
 * Тост один на пару версий (`HOST_BUILD_TOAST_ID`): повтор connected (`setHostMethods`) и переподключение к
 * тому же хосту его не множат. Кнопка «Restart host…» открывает то же подтверждение, что и палитра. Хост той же
 * сборки — тост снимается; обрыв связи — нет: пока не известно, кто ответит, решать нечем.
 */

import { toast } from 'sonner';
import { S } from '../../shared/strings.js';
import { otherHostBuild } from '../lib/capabilities.js';
import { useHostStore, type HostState } from '../store/host.js';
import { useUiStore } from '../store/ui.js';

export const HOST_BUILD_TOAST_ID = 'host-other-build';

export function wireHostBuildNotice(): () => void {
  /** Пара версий стоящего тоста; `null` — тоста нет. */
  let shown: string | null = null;

  const check = ({ status, appVersion }: HostState): void => {
    const other = otherHostBuild(status, appVersion);
    if (other === null) {
      if (shown !== null && status.state === 'connected') {
        toast.dismiss(HOST_BUILD_TOAST_ID);
        shown = null;
      }
      return;
    }
    const key = `${other.host}\u0000${other.window}`;
    if (shown === key) return;
    shown = key;
    toast(S.connection.hostOtherBuild(other.host, other.window), {
      id: HOST_BUILD_TOAST_ID,
      duration: Infinity,
      action: {
        label: S.actions.restartHost,
        onClick: () => useUiStore.getState().confirmRestartHost(),
      },
    });
  };

  check(useHostStore.getState());
  return useHostStore.subscribe(check);
}
