import { useEffect, useState } from 'react';
import type { HarnasConfig } from '@harnas/core';
import { getHostClient } from './host-client.js';
import type { HostStatus } from '../shared/bridge.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TerminalPanel } from './components/terminal/TerminalPanel.js';
import { NewSessionDialog } from './components/dialogs/NewSessionDialog.js';
import { SettingsDialog } from './components/settings/SettingsDialog.js';
import { workKey, treeOrder } from './lib/tree-order.js';
import { wireNotifications } from './notifications.js';
import { useActivityStore } from './store/activity.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { orderedWorks, useWorksStore } from './store/works.js';
import { applyTheme } from './theme/apply-theme.js';

/**
 * Оболочка окна: сайдбар слева, справа — место терминала (кусок 1.11).
 * Пока хост не подключён (или не совпала версия), сайдбара нет вовсе —
 * показывать список работ, которые ещё нечем наполнить, бессмысленно.
 */
export function App(): JSX.Element {
  const bridge = getHostClient();
  const [status, setStatus] = useState<HostStatus>({ state: 'connecting' });
  // Тема применяется сразу к CSS-переменным (`applyTheme`), а сама конфигурация
  // хранится ещё и здесь — панели терминала нужны живые `theme`/`fontFamily`/
  // `fontSize` как значения, а не как CSS-переменные: xterm красит канвой.
  const [config, setConfig] = useState<HarnasConfig | null>(null);

  const selectedRef = useUiStore((state) => state.selectedRef);
  const wakePaused = useUiStore((state) => state.wakePaused);
  const toggleWake = useUiStore((state) => state.toggleWake);
  const closePanel = useUiStore((state) => state.closePanel);
  const selectSession = useUiStore((state) => state.selectSession);
  const newSessionOpen = useUiStore((state) => state.dialogs.newSession.open);
  const newSessionParent = useUiStore((state) => state.dialogs.newSession.parentSessionId);
  const openNewSessionDialog = useUiStore((state) => state.openNewSessionDialog);
  const closeNewSessionDialog = useUiStore((state) => state.closeNewSessionDialog);
  const settingsOpen = useUiStore((state) => state.dialogs.settings);
  const openSettingsDialog = useUiStore((state) => state.openSettingsDialog);
  const closeSettingsDialog = useUiStore((state) => state.closeSettingsDialog);
  const notices = useNoticesStore((state) => state.notices);

  // ⌘1…⌘9 — n-я по порядку создания работа и её последняя открытая сессия
  // (`store/ui.ts#lastSessionByWork`), иначе первая по дереву. Нет работы под
  // этим номером или в ней ещё нет сессий — нажатие без последствий.
  const selectWorkByNumber = (n: number): void => {
    const work = orderedWorks(useWorksStore.getState().entries)[n - 1];
    if (work === undefined) return;
    const key = workKey(work.projectPath, work.map.work.id);
    const lastSessionId = useUiStore.getState().lastSessionByWork[key];
    const sessionId =
      lastSessionId !== undefined && work.map.sessions.some((session) => session.id === lastSessionId)
        ? lastSessionId
        : treeOrder(work.map.sessions)[0]?.session.id;
    if (sessionId === undefined) return;
    selectSession(key, { projectPath: work.projectPath, workId: work.map.work.id, sessionId });
  };

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
        if (action === 'close-panel') closePanel();
        if (action.startsWith('work-')) selectWorkByNumber(Number(action.slice('work-'.length)));
      }),
    ];

    bridge
      .call('settings.get', {})
      .then((result) => {
        setConfig(result.config);
        applyTheme(result.config.theme);
      })
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
        {selectedRef === null ? (
          <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-[var(--h-muted)]">
            Выберите или создайте сессию слева
          </div>
        ) : (
          <TerminalPanel
            key={`${selectedRef.projectPath}\u0000${selectedRef.workId}\u0000${selectedRef.sessionId}`}
            bridge={bridge}
            sessionRef={selectedRef}
            theme={config?.theme ?? 'mocha'}
            fontFamily={config?.fontFamily ?? 'Menlo'}
            fontSize={config?.fontSize ?? 13}
          />
        )}
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
        onConfigChange={(next) => {
          setConfig(next);
          applyTheme(next.theme);
        }}
      />
    </div>
  );
}
