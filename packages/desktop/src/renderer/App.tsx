import { useEffect, useRef, useState } from 'react';
import { refKey } from '@harnas/protocol';
import type { HarnasConfig } from '@harnas/core';
import { getHostClient } from './host-client.js';
import type { HostStatus } from '../shared/bridge.js';
import { Sidebar } from './components/sidebar/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { Workspace, type WorkspaceHandle } from './components/layout/Workspace.js';
import { InterruptedBanner } from './components/InterruptedBanner.js';
import { NewSessionDialog } from './components/dialogs/NewSessionDialog.js';
import { SettingsDialog } from './components/settings/SettingsDialog.js';
import { sessionRowLabel } from './lib/participant.js';
import { workKey, treeOrder } from './lib/tree-order.js';
import { wireNotifications } from './notifications.js';
import { useActivityStore } from './store/activity.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { orderedWorks, useWorksStore } from './store/works.js';
import { applyTheme } from './theme/apply-theme.js';

/**
 * Запасные `fontFamily`/`fontSize` панели терминала до первого ответа
 * `settings.get` — копия значений по умолчанию `core/src/config.ts`
 * (кусок 1.3 плана окна, спека 4.3): рантайм `core` в песочницу рендерера не
 * собирается, импортировать саму константу нельзя, только типы.
 */
const DEFAULT_FONT_FAMILY = "'SF Mono', Menlo, monospace";
const DEFAULT_FONT_SIZE = 14;

/**
 * Оболочка окна: сайдбар слева, справа — сетка панелей `Workspace` (кусок 2.1
 * плана окна; до него здесь была одна панель терминала на выбранную в
 * сайдбаре сессию). Пока хост не подключён (или не совпала версия), сайдбара
 * нет вовсе — показывать список работ, которые ещё нечем наполнить, бессмысленно.
 */
export function App(): JSX.Element {
  const bridge = getHostClient();
  const [status, setStatus] = useState<HostStatus>({ state: 'connecting' });
  // `applyTheme` остаётся ради палитры TUI (`config.theme`, раздел 4.9 спеки —
  // окно её не показывает и не читает для своего облика, но старые
  // потребители `--h-*` вроде `SettingsDialog.tsx` пока на ней), а сама
  // конфигурация хранится ещё и здесь — панели терминала нужны живые
  // `fontFamily`/`fontSize` как значения, а не как CSS-переменные: xterm
  // красит канвой. Тему терминала (тёмная/светлая) панели берут из
  // `useUiStore` напрямую (кусок 1.3 плана окна, спека 4.7), не отсюда.
  const [config, setConfig] = useState<HarnasConfig | null>(null);

  const workspaceRef = useRef<WorkspaceHandle>(null);
  const entries = useWorksStore((state) => state.entries);

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

  // ⌘1…⌘9 — n-я по порядку создания работа и её последняя открытая сессия
  // (`store/ui.ts#lastSessionByWork`), иначе первая по дереву. Нет работы под
  // этим номером или в ней ещё нет сессий — нажатие без последствий. Открытие
  // (фокус на панель или новая вкладка) — забота `Workspace` (кусок 2.1).
  const selectWorkByNumber = (n: number): void => {
    const work = orderedWorks(useWorksStore.getState().entries)[n - 1];
    if (work === undefined) return;
    const key = workKey(work.projectPath, work.map.work.id);
    const lastSessionId = useUiStore.getState().lastSessionByWork[key];
    const session =
      work.map.sessions.find(
        (item) => lastSessionId !== undefined && item.id === lastSessionId,
      ) ?? treeOrder(work.map.sessions)[0]?.session;
    if (session === undefined) return;
    workspaceRef.current?.openSession(
      { projectPath: work.projectPath, workId: work.map.work.id, sessionId: session.id },
      key,
      sessionRowLabel(session.id, session.label),
    );
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
        // Видна не выбранная в сайдбаре сессия, а та, чья панель терминала
        // сейчас активная вкладка своей группы в сетке (`store/ui.ts#visibleSessionRefs`,
        // пишет `panel-registry.tsx`) — кусок 2.1 плана окна.
        isVisible: (ref) => {
          const ui = useUiStore.getState();
          return ui.windowFocused && refKey(ref) in ui.visibleSessionRefs;
        },
        getSessionLabel: (ref) => {
          const entry = useWorksStore
            .getState()
            .entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
          return entry?.map.sessions.find((session) => session.id === ref.sessionId)?.label ?? ref.sessionId;
        },
      }),
      // trust-wait (кусок 4.3 плана worktree, спека 8.3): сессия в своём
      // worktree не отвечает с запуска — вероятно, ждёт доверия к папке в
      // терминале claude/codex. Пометка строки — `SessionTree.tsx` (тот же
      // стор уведомлений), здесь только macOS-уведомление.
      bridge.on('host.notice', (notice) => {
        if (notice.kind !== 'trust-wait') return;
        bridge.app.notify({ title: 'Ждёт доверия к папке', body: notice.text });
      }),
      // 'close-panel'/'split-right'/'split-down'/'prev-panel'/'next-panel' — у
      // `Workspace` своя подписка на те же события: только он знает про
      // dockview (кусок 2.1 плана окна).
      bridge.app.onMenu((action) => {
        if (action === 'settings') openSettingsDialog();
        if (action === 'new-session') openNewSessionDialog(useUiStore.getState().selectedRef?.sessionId ?? null);
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
    <div className="flex h-screen flex-col bg-background text-foreground">
      <InterruptedBanner bridge={bridge} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          bridge={bridge}
          onOpenSession={(key, ref, session) =>
            workspaceRef.current?.openSession(ref, key, sessionRowLabel(session.id, session.label))
          }
          onOpenMail={(key) => workspaceRef.current?.openMail(key)}
          onOpenRoom={(key, roomId, title) => workspaceRef.current?.openRoom(key, roomId, title)}
          onOpenChanges={(key, ref, session) =>
            workspaceRef.current?.openChanges(ref, key, sessionRowLabel(session.id, session.label))
          }
        />
        <Workspace
          ref={workspaceRef}
          bridge={bridge}
          works={entries}
          fontFamily={config?.fontFamily ?? DEFAULT_FONT_FAMILY}
          fontSize={config?.fontSize ?? DEFAULT_FONT_SIZE}
        />
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
