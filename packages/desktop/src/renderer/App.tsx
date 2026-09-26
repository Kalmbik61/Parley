import { useEffect, useState } from 'react';
import { getHostClient } from './host-client.js';
import type { HostStatus } from '../shared/bridge.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { NewSessionDialog } from './components/dialogs/NewSessionDialog.js';
import { SettingsDialog } from './components/settings/SettingsDialog.js';
import { wireNotifications } from './notifications.js';
import { useActivityStore } from './store/activity.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';
import { applyTheme } from './theme/apply-theme.js';

/**
 * Оболочка окна: сайдбар слева, справа — место терминала (кусок 1.11).
 * Пока хост не подключён (или не совпала версия), сайдбара нет вовсе —
 * показывать список работ, которые ещё нечем наполнить, бессмысленно.
 */
export function App(): JSX.Element {
  const bridge = getHostClient();
  const [status, setStatus] = useState<HostStatus>({ state: 'connecting' });

  const selectedRef = useUiStore((state) => state.selectedRef);
  const wakePaused = useUiStore((state) => state.wakePaused);
  const toggleWake = useUiStore((state) => state.toggleWake);
  const newSessionOpen = useUiStore((state) => state.dialogs.newSession.open);
  const newSessionParent = useUiStore((state) => state.dialogs.newSession.parentSessionId);
  const openNewSessionDialog = useUiStore((state) => state.openNewSessionDialog);
  const closeNewSessionDialog = useUiStore((state) => state.closeNewSessionDialog);
  const settingsOpen = useUiStore((state) => state.dialogs.settings);
  const openSettingsDialog = useUiStore((state) => state.openSettingsDialog);
  const closeSettingsDialog = useUiStore((state) => state.closeSettingsDialog);
  const notices = useNoticesStore((state) => state.notices);

  useEffect(() => getHostClient().onStatus(setStatus), []);

  // Хранилища и уведомления живут только пока связь с хостом есть: без неё
  // `works.list`/`settings.get` всё равно отвечать некому.
  useEffect(() => {
    if (status.state !== 'connected') return;

    const disposers = [
      useWorksStore.getState().init(bridge),
      useActivityStore.getState().init(bridge),
      useUiStore.getState().init(bridge),
      useNoticesStore.getState().init(bridge),
      wireNotifications(bridge, {
        isVisible: (ref) => {
          const ui = useUiStore.getState();
          return (
            ui.windowFocused &&
            ui.selectedRef !== null &&
            ui.selectedRef.projectPath === ref.projectPath &&
            ui.selectedRef.workId === ref.workId &&
            ui.selectedRef.sessionId === ref.sessionId
          );
        },
        getSessionLabel: (ref) => {
          const entry = useWorksStore
            .getState()
            .entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
          return entry?.map.sessions.find((session) => session.id === ref.sessionId)?.label ?? ref.sessionId;
        },
      }),
      bridge.app.onMenu((action) => {
        if (action === 'settings') openSettingsDialog();
        if (action === 'new-session') openNewSessionDialog(useUiStore.getState().selectedRef?.sessionId ?? null);
      }),
    ];

    bridge
      .call('settings.get', {})
      .then(({ config }) => applyTheme(config.theme))
      .catch(() => {
        // Без темы окно остаётся на дефолтной палитре — не повод падать.
      });

    return () => {
      for (const dispose of disposers) dispose();
    };
    // `bridge` стабилен на весь жизненный цикл окна (один `window.harnas`) —
    // достаточно перезапускать подписки только при смене статуса связи.
  }, [status.state]);

  const handleRestart = (): void => {
    void bridge.app.restartHost();
  };

  if (status.state === 'mismatch') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 text-neutral-200">
        <p>Хост старой версии. Перезапустить? Живых сессий: {status.liveSessions ?? '—'}.</p>
        <button type="button" className="rounded bg-neutral-700 px-4 py-2" onClick={handleRestart}>
          Перезапустить
        </button>
      </div>
    );
  }

  if (status.state === 'connecting') {
    return <div className="flex h-screen items-center justify-center text-neutral-400">Подключение к хосту…</div>;
  }

  if (status.state === 'disconnected') {
    return (
      <div className="flex h-screen items-center justify-center text-neutral-400">
        Нет связи с хостом: {status.reason}
      </div>
    );
  }

  const newSessionWork = selectedRef ?? null;

  return (
    <div className="flex h-screen flex-col bg-[var(--h-base)] text-[var(--h-text)]">
      <div className="flex min-h-0 flex-1">
        <Sidebar bridge={bridge} />
        <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-[var(--h-muted)]">
          {selectedRef === null ? 'Выберите или создайте сессию слева' : 'Панель терминала — кусок 1.11'}
        </div>
      </div>
      <StatusBar
        status={status}
        lastNotice={notices[0] ?? null}
        wakePaused={wakePaused}
        onToggleWake={() => void toggleWake(bridge)}
      />
      <NewSessionDialog
        open={newSessionOpen}
        bridge={bridge}
        projectPath={newSessionWork?.projectPath ?? ''}
        workId={newSessionWork?.workId ?? null}
        selectedSessionId={newSessionParent}
        onOpenChange={(open) => (open ? openNewSessionDialog(selectedRef?.sessionId ?? null) : closeNewSessionDialog())}
      />
      <SettingsDialog
        open={settingsOpen}
        bridge={bridge}
        onOpenChange={(open) => (open ? openSettingsDialog() : closeSettingsDialog())}
        onConfigChange={(config) => applyTheme(config.theme)}
      />
    </div>
  );
}
