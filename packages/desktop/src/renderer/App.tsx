import { useEffect, useState } from 'react';
import { refKey } from '@harnas/protocol';
import type { HarnasConfig } from '@harnas/core';
import { getHostClient } from './host-client.js';
import { noticeText, S } from '../shared/strings.js';
import { selectedSessionOf, useLayoutStore } from './layout/store.js';
import { AppShell } from './shell/AppShell.js';
import { NewSessionDialog } from './components/dialogs/NewSessionDialog.js';
import { SettingsDialog } from './components/settings/SettingsDialog.js';
import { sessionLabelFor, sessionLabelText } from './lib/participant.js';
import { wireNotifications } from './notifications.js';
import { useActivityStore } from './store/activity.js';
import { useHostStore } from './store/host.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';
import { workKey } from './lib/tree-order.js';
import { Toaster } from './ui/sonner.js';

/**
 * Запасные `fontFamily`/`fontSize` панели терминала до первого ответа
 * `settings.get` — копия значений по умолчанию `core/src/config.ts`
 * (кусок 1.3 плана окна, спека 4.3): рантайм `core` в песочницу рендерера не
 * собирается, импортировать саму константу нельзя, только типы.
 */
const DEFAULT_FONT_FAMILY = "'SF Mono', Menlo, monospace";
const DEFAULT_FONT_SIZE = 14;

/**
 * Экраны связи с хостом и общие для всего окна диалоги (кусок 1.10 плана
 * окна; сама рамка окна — `shell/AppShell.tsx` с куска 2.3). Пока хост не
 * подключён (или не совпала версия), оболочки нет вовсе — показывать сайдбар
 * и раскладку, которые ещё нечем наполнить, бессмысленно.
 */
/** Родитель новой сессии — выбранная сессия активной работы, читается в момент вызова. */
function selectedParentId(): string | null {
  return selectedSessionOf(useLayoutStore.getState(), useWorksStore.getState().entries)?.ref.sessionId ?? null;
}

export function App(): JSX.Element {
  const bridge = getHostClient();
  // Статус связи — в `store/host.ts`: его читает и `useHostSupports` (кусок 3.1).
  const status = useHostStore((state) => state.status);
  // Конфигурация хранится здесь ради терминала — панелям нужны живые
  // `fontFamily`/`fontSize` как значения, а не как CSS-переменные: xterm
  // красит канвой. Тему окна (тёмная/светлая) панели берут из `useUiStore`
  // напрямую (кусок 1.3 плана окна, спека 4.7); ключ `config.theme` — это
  // палитра TUI, окно её с куска 1.4 не читает и не показывает (спека 4.9).
  const [config, setConfig] = useState<HarnasConfig | null>(null);

  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  const entries = useWorksStore((state) => state.entries);
  const newSessionOpen = useUiStore((state) => state.dialogs.newSession.open);
  const newSessionParent = useUiStore((state) => state.dialogs.newSession.parentSessionId);
  const newSessionFor = useUiStore((state) => state.dialogs.newSession.work);
  const openNewSessionDialog = useUiStore((state) => state.openNewSessionDialog);
  const closeNewSessionDialog = useUiStore((state) => state.closeNewSessionDialog);
  const settingsOpen = useUiStore((state) => state.dialogs.settings);
  const openSettingsDialog = useUiStore((state) => state.openSettingsDialog);
  const closeSettingsDialog = useUiStore((state) => state.closeSettingsDialog);

  useEffect(() => useHostStore.getState().init(getHostClient()), []);

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
        // Видна не выбранная сессия, а та, чей терминал сейчас активная
        // вкладка своей группы (`store/ui.ts#visibleSessionRefs`, пишет
        // `terminal/TerminalSurface.tsx`, кусок 2.5).
        isVisible: (ref) => {
          const ui = useUiStore.getState();
          return ui.windowFocused && refKey(ref) in ui.visibleSessionRefs;
        },
        getSessionLabel: (ref) => {
          const entry = useWorksStore
            .getState()
            .entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
          const label = entry?.map.sessions.find((session) => session.id === ref.sessionId)?.label;
          return label === undefined ? ref.sessionId : sessionLabelText(label);
        },
      }),
      // trust-wait (кусок 4.3 плана worktree, спека 8.3): сессия в своём
      // worktree не отвечает с запуска — вероятно, ждёт доверия к папке в
      // терминале claude/codex. Пометка строки — `SessionTree.tsx` (тот же
      // стор уведомлений), здесь только macOS-уведомление.
      bridge.on('host.notice', (notice) => {
        if (notice.kind !== 'trust-wait') return;
        const label = sessionLabelFor(useWorksStore.getState().entries, notice.ref);
        bridge.app.notify({ title: S.notifications.trustWaitTitle, body: noticeText(notice, label) });
      }),
      // Меню раскладки, палитры и сайдбара слушает `AppShell` (куски 2.3–2.7);
      // здесь — только диалоги, которые монтирует сам `App`.
      bridge.app.onMenu((action) => {
        if (action === 'settings') openSettingsDialog();
        if (action === 'new-session') openNewSessionDialog(selectedParentId());
      }),
    ];

    bridge
      .call('settings.get', {})
      .then((result) => setConfig(result.config))
      .catch(() => {
        // Без конфигурации терминал остаётся на запасных fontFamily/fontSize — не повод падать.
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
        <p>{S.connection.mismatchScreen(status.liveSessions)}</p>
        <button type="button" className="rounded bg-neutral-700 px-4 py-2" onClick={handleRestart}>
          {S.connection.restart}
        </button>
      </div>
    );
  }

  if (status.state === 'connecting') {
    return <div className="flex h-screen items-center justify-center text-neutral-400">{S.connection.connectingScreen}</div>;
  }

  if (status.state === 'disconnected') {
    return (
      <div className="flex h-screen items-center justify-center text-neutral-400">
        {S.connection.disconnectedScreen(status.reason)}
      </div>
    );
  }

  // ⌘T (кусок 2.7): работа — активная, родитель — выбранная сессия
  // (`selectedSessionOf`), если активна вкладка-терминал. «New session» из меню карточки
  // (кусок 3.4) передаёт свою работу: у неактивной карточки диалог иначе ушёл бы в чужую.
  const newSessionKey =
    newSessionFor === null ? activeWorkKey : workKey(newSessionFor.projectPath, newSessionFor.workId);
  const newSessionWork = entries.find((entry) => workKey(entry.projectPath, entry.map.work.id) === newSessionKey) ?? null;

  return (
    <>
      <AppShell
        bridge={bridge}
        status={status}
        fontFamily={config?.fontFamily ?? DEFAULT_FONT_FAMILY}
        fontSize={config?.fontSize ?? DEFAULT_FONT_SIZE}
      />
      <NewSessionDialog
        open={newSessionOpen}
        bridge={bridge}
        projectPath={newSessionWork?.projectPath ?? ''}
        workId={newSessionWork?.map.work.id ?? null}
        selectedSessionId={newSessionParent}
        onOpenChange={(open) => (open ? openNewSessionDialog(selectedParentId()) : closeNewSessionDialog())}
      />
      <SettingsDialog
        open={settingsOpen}
        bridge={bridge}
        onOpenChange={(open) => (open ? openSettingsDialog() : closeSettingsDialog())}
        onConfigChange={setConfig}
      />
      <Toaster />
    </>
  );
}
