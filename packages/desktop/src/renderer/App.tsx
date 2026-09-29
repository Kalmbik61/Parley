import { useEffect, useState } from 'react';
import { refKey, type SessionRef } from '@harnas/protocol';
import type { HarnasConfig } from '@harnas/core';
import type { FocusTarget, HarnasBridge } from '../shared/bridge.js';
import { getHostClient } from './host-client.js';
import { sessionAttention } from './attention/derive.js';
import { createSeenTracker, visibleSessions } from './attention/seen.js';
import { attentionTotals, badgeCount } from './attention/store.js';
import { applyFocusTarget, buildFocusTargetDeps } from './attention/focus-target.js';
import { isTargetVisible, wireAttentionNotifications } from './attention/notify.js';
import { hostMethods } from './lib/capabilities.js';
import { useSidebarSectionsStore } from './sidebar/use-sidebar-sections.js';
import { S } from '../shared/strings.js';
import { selectedSessionOf, useLayoutStore } from './layout/store.js';
import { WindowCloseQuestion } from './files/SaveChangesDialog.js';
import { AppShell } from './shell/AppShell.js';
import { NewSessionDialog } from './components/dialogs/NewSessionDialog.js';
import { SettingsDialog } from './components/settings/SettingsDialog.js';
import { useActivityStore } from './store/activity.js';
import { useHostStore } from './store/host.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';
import { workKey } from './lib/tree-order.js';
import { Toaster } from './ui/sonner.js';
import { toast } from 'sonner';

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

/**
 * Бейдж Dock (кусок 4.2, спека 7.3): `badgeCount` по итогам секций сайдбара, в `app.setBadge`
 * только когда число сменилось. Подписка на стор, а не хук: `App` не должен перерисовываться
 * на каждое изменение внимания.
 */
function wireBadge(bridge: HarnasBridge): () => void {
  let last: number | null = null;
  const push = (): void => {
    const { sections, attention } = useSidebarSectionsStore.getState();
    const count = badgeCount(attentionTotals(sections, attention));
    if (count === last) return;
    last = count;
    bridge.app.setBadge(count);
  };
  push();
  return useSidebarSectionsStore.subscribe(push);
}

/**
 * «Просмотрено» (кусок 4.2, спека 7.2): видимые терминалы сессий в `unseen` через 1 с уходят
 * хосту уведомлением `activity.seen`. Пересчёт — на каждое изменение видимых поверхностей,
 * фокуса, видимости документа, активности и снимка работ.
 */
function wireSeenTracker(bridge: HarnasBridge): () => void {
  const tracker = createSeenTracker({
    send: (ref) => {
      // Метод проверяется в момент отправки: значение при монтировании устарело бы после
      // перезапуска хоста другой версией.
      if (hostMethods(useHostStore.getState().status).has('activity.seen')) bridge.notify('activity.seen', { ref });
    },
    now: () => Date.now(),
    // Обёртки, а не сами `setTimeout`/`clearTimeout`: вызванные методом объекта, они в
    // Chromium бросают «Illegal invocation».
    setTimer: (handler, ms) => setTimeout(handler, ms),
    clearTimer: (timer) => clearTimeout(timer),
  });
  const recompute = (): void => {
    const visible = visibleSessions(useUiStore.getState());
    const unseen = new Map<string, SessionRef>();
    if (visible.size > 0) {
      const byRef = useActivityStore.getState().byRef;
      for (const entry of useWorksStore.getState().entries) {
        for (const session of entry.map.sessions) {
          const ref: SessionRef = { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id };
          const key = refKey(ref);
          if (visible.has(key) && sessionAttention(session, byRef[key]?.activity ?? null) === 'unseen') unseen.set(key, ref);
        }
      }
    }
    tracker.update(visible, unseen);
  };
  recompute();
  const unsubscribers = [
    useUiStore.subscribe((state, prev) => {
      if (
        state.windowFocused !== prev.windowFocused ||
        state.documentVisible !== prev.documentVisible ||
        state.visibleSessionRefs !== prev.visibleSessionRefs
      ) {
        recompute();
      }
    }),
    useActivityStore.subscribe(recompute),
    useWorksStore.subscribe((state, prev) => {
      if (state.entries !== prev.entries) recompute();
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    tracker.dispose();
  };
}

/**
 * Клик по уведомлению (кусок 4.3, спека 7.4): цель приходит событием `app:focus-target`.
 * Цель до первого снимка работ ждёт ответа `works.list` — иначе клик при закрытом окне
 * кончался бы тостом «уже удалены»: подписки заводятся в connected, а снимок ещё в пути.
 * Цели нет — тост: это ответ на действие человека (спека 7.5).
 */
function wireFocusTargets(bridge: HarnasBridge): () => void {
  let waiting: FocusTarget | null = null;
  let offWorks: (() => void) | null = null;
  // Ожидания показа вкладки снимаются вместе с подписками — их опрос не переживает App.
  const unmounted = new AbortController();

  const apply = (target: FocusTarget): void => {
    const applied = applyFocusTarget(target, buildFocusTargetDeps(unmounted.signal));
    if (!applied) toast(S.notifications.targetGone);
  };

  const offTarget = bridge.app.onFocusTarget((target) => {
    if (!useWorksStore.getState().loading) {
      apply(target);
      return;
    }
    // Новая цель заменяет прежнюю, как у отложенной цели main.
    waiting = target;
    offWorks ??= useWorksStore.subscribe((state) => {
      if (state.loading) return;
      offWorks?.();
      offWorks = null;
      const next = waiting;
      waiting = null;
      if (next !== null) apply(next);
    });
  });
  return () => {
    offTarget();
    offWorks?.();
    unmounted.abort();
  };
}

export function App(): JSX.Element {
  const bridge = getHostClient();
  // Статус связи — в `store/host.ts`: его читает и `useHostSupports` (кусок 3.1).
  const status = useHostStore((state) => state.status);
  const everConnected = useHostStore((state) => state.everConnected);
  // Конфигурация хранится здесь ради терминала — панелям нужны живые
  // `fontFamily`/`fontSize` как значения, а не как CSS-переменные: xterm
  // красит канвой. Тему окна (тёмная/светлая) панели берут из `useUiStore`
  // напрямую (кусок 1.3 плана окна, спека 4.7).
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
      // Бейдж и «просмотрено» (кусок 4.2) — рядом, оба по вниманию.
      wireBadge(bridge),
      wireSeenTracker(bridge),
      // Уведомления macOS и переход по ним (кусок 4.3). Пометка trust-wait в строке сессии —
      // `sidebar/SessionRow.tsx` по стору уведомлений хоста.
      wireAttentionNotifications(bridge, {
        prefs: () => useUiStore.getState().ui.notifications,
        isTargetVisible,
        entries: () => useWorksStore.getState().entries,
      }),
      // Меню и клавиши — одна точка `run(id)` в `AppShell` (кусок 6.1b), и `settings.open` с
      // `session.new` тоже: своего `onMenu` у `App` нет.
      wireFocusTargets(bridge),
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

  // Экраны связи: буферы файлов (7.3a) переживают потерю связи, и вопрос при закрытии окна
  // должен кто-то задать — в оболочке это делает `AppShell`.
  if (status.state === 'mismatch') {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 text-foreground">
        <p>{S.connection.mismatchScreen(status.liveSessions)}</p>
        <button type="button" className="rounded bg-secondary px-4 py-2 text-secondary-foreground" onClick={handleRestart}>
          {S.connection.restart}
        </button>
        <WindowCloseQuestion bridge={bridge} />
      </div>
    );
  }

  if (status.state === 'connecting') {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        {S.connection.connectingScreen}
        <WindowCloseQuestion bridge={bridge} />
      </div>
    );
  }

  // Обрыв после связи — окно на месте (раунд lane-r3, п. 2): main переподключается сам, а
  // терминалы на это время показывают «Disconnected — reconnecting…» и не принимают ввод.
  // Экран — только если связи не было ни разу.
  // Main и сам повторяет подключение с нарастающей паузой (fix-final-b, M4); кнопки — не ждать.
  // Отказ кнопки — только в консоль: причину показывает сам экран.
  if (status.state === 'disconnected' && !everConnected) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 text-muted-foreground">
        <p>{S.connection.disconnectedScreen(status.reason)}</p>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-secondary px-4 py-2 text-secondary-foreground"
            onClick={() => void bridge.app.reconnect().catch((error: unknown) => console.warn('[harnas] reconnect', error))}
          >
            {S.common.retry}
          </button>
          <button
            type="button"
            className="rounded bg-secondary px-4 py-2 text-secondary-foreground"
            onClick={() => void bridge.app.restartHost().catch((error: unknown) => console.warn('[harnas] restart host', error))}
          >
            {S.connection.restartHost}
          </button>
        </div>
        <WindowCloseQuestion bridge={bridge} />
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
