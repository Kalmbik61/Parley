/**
 * Уведомления macOS окна (кусок 4.3, спека 7.4): переход сессии в «ждёт тебя» или «закончил
 * ход», новое прямое письмо человеку, уведомления хоста о запуске сессии. Тексты — из
 * `shared/strings.ts`; название работы, ярлык, задача, итог и письмо — данные, идут как есть.
 * Русский `HostNotice.text` сюда не попадает: его пишет в консоль `store/notices.ts`.
 */

import type { SessionActivity, WorkEntry, WorkSession } from '@harnas/core';
import { refKey, type HostNotice, type SessionRef } from '@harnas/protocol';
import { clampNoteText } from '../../shared/app-note.js';
import type { AppNote, FocusTarget, HarnasBridge } from '../../shared/bridge.js';
import { noticeText, S } from '../../shared/strings.js';
import type { UiFile } from '../../shared/ui-types.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { sessionRowLabel, sessionTag } from '../lib/participant.js';
import { workKey } from '../lib/tree-order.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { humanUnreadLetters, sessionAttention, type Attention } from './derive.js';
import { visibleSessions } from './seen.js';

export interface NotifyDeps {
  notify(note: AppNote): void;
  prefs(): UiFile['notifications'];
  isTargetVisible(target: FocusTarget): boolean;
  /** Снимок работ окна: название работы, сессия (ярлык, задача, summary), письма. */
  entries(): readonly WorkEntry[];
}

/** Уведомления хоста, которые ведут к сессии (таблица спеки 7.4), и событие их заголовка. */
const NOTICE_EVENT: Partial<Record<HostNotice['kind'], string>> = {
  'trust-wait': S.notifications.trustWait,
  'launch-failed': S.notifications.launchFailed,
  'resume-failed': S.notifications.resumeFailed,
};

/**
 * Сессии нет в снимке — уровень по активности, как у живой: `sessionAttention` смотрит только
 * на `lifecycle`, остальные поля ему не нужны.
 */
const LIVE_SESSION = { lifecycle: 'active' } as WorkSession;

/** Первая непустая строка: задача или письмо могут начинаться с пустой строки. */
function firstLine(text: string | null): string {
  if (text === null) return '';
  return text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
}

function findSession(entries: readonly WorkEntry[], ref: SessionRef): { entry: WorkEntry; session: WorkSession } | null {
  const entry = entries.find((item) => item.projectPath === ref.projectPath && item.map.work.id === ref.workId);
  const session = entry?.map.sessions.find((item) => item.id === ref.sessionId);
  return entry === undefined || session === undefined ? null : { entry, session };
}

export function createAttentionNotifier(deps: NotifyDeps): {
  /** Переход — по sessionAttention (3.2); первое значение сессии — база без уведомления. */
  onActivity(ref: SessionRef, activity: SessionActivity): void;
  /** Новые прямые письма человеку (isHumanUnread); первый снимок — база. */
  onWorks(entries: readonly WorkEntry[]): void;
  /** trust-wait, launch-failed, resume-failed; ref: null или сессии нет в снимке — без уведомления. */
  onHostNotice(notice: HostNotice): void;
} {
  const levels = new Map<string /* refKey */, Attention>();
  /** Письма прошлого снимка (`workKey` + id: id писем уникальны только в работе); null — снимка ещё не было. */
  let knownLetters: Set<string> | null = null;

  const send = (note: Omit<AppNote, 'silent'>): void => {
    if (deps.isTargetVisible(note.target)) return;
    deps.notify({
      ...note,
      title: clampNoteText(note.title),
      body: clampNoteText(note.body),
      silent: !deps.prefs().sound,
    });
  };

  return {
    onActivity(ref, activity) {
      const key = refKey(ref);
      const found = findSession(deps.entries(), ref);
      const level = sessionAttention(found?.session ?? LIVE_SESSION, activity);
      const previous = levels.get(key);
      levels.set(key, level);
      // Первое значение после подписки — база: хост повторяет новому клиенту активность всех
      // сессий, и без базы каждое подключение давало бы пачку уведомлений (спека 7.4).
      if (previous === undefined || previous === level || found === null) return;
      if (level !== 'needs-you' && level !== 'unseen') return;
      const prefs = deps.prefs();
      if (level === 'needs-you' ? !prefs.needsYou : !prefs.finished) return;
      const { entry, session } = found;
      send({
        title: S.notifications.sessionTitle(
          entry.map.work.title,
          sessionRowLabel(session.id, session.label),
          level === 'needs-you' ? S.notifications.needsYou : S.notifications.finished,
        ),
        // В `result` только done или failed, текста там нет — итог хода в `summary`.
        body: firstLine(level === 'needs-you' ? session.task : session.summary),
        tag: `session:${key}`,
        target: { kind: 'session', ref },
      });
    },

    onWorks(entries) {
      const current = new Set<string>();
      for (const entry of entries) {
        const key = workKey(entry.projectPath, entry.map.work.id);
        for (const message of entry.map.messages) current.add(`${key}\u0000${message.id}`);
      }
      const known = knownLetters;
      knownLetters = current;
      // Письма, которые уже были на старте окна, не уведомляют.
      if (known === null || !deps.prefs().mail) return;
      for (const entry of entries) {
        const key = workKey(entry.projectPath, entry.map.work.id);
        const fresh = humanUnreadLetters(entry.map).filter((message) => !known.has(`${key}\u0000${message.id}`));
        // Одно уведомление на работу (тег `mail:<workKey>`): новее — последнее письмо.
        const latest = fresh.at(-1);
        if (latest === undefined) continue;
        send({
          title: S.notifications.mailTitle(entry.map.work.title, latest.kind, sessionTag(latest.from)),
          body: firstLine(latest.text),
          tag: `mail:${key}`,
          target: { kind: 'mail', projectPath: entry.projectPath, workId: entry.map.work.id },
        });
      }
    },

    onHostNotice(notice) {
      const event = NOTICE_EVENT[notice.kind];
      if (event === undefined || notice.ref === null) return;
      // Сессии нет в снимке — вести некуда и заголовок не из чего собрать.
      const found = findSession(deps.entries(), notice.ref);
      if (found === null) return;
      const { entry, session } = found;
      send({
        title: S.notifications.sessionTitle(entry.map.work.title, sessionRowLabel(session.id, session.label), event),
        // Без ярлыка: он уже в заголовке.
        body: noticeText(notice),
        tag: `notice:${notice.kind}:${refKey(notice.ref)}`,
        target: { kind: 'session', ref: notice.ref },
      });
    },
  };
}

/**
 * Видимость цели по правилам 4.2 (спека 7.2): сессия — её терминал виден (`visibleSessions`);
 * почта и комната — их вкладка активна в своей группе активной работы при фокусе окна и
 * видимом документе. Сторы читаются в момент вызова.
 */
export function isTargetVisible(target: FocusTarget): boolean {
  const ui = useUiStore.getState();
  if (target.kind === 'session') return visibleSessions(ui).has(refKey(target.ref));
  if (!ui.windowFocused || !ui.documentVisible) return false;
  const layoutState = useLayoutStore.getState();
  const key = workKey(target.projectPath, target.workId);
  const layout = layoutState.layouts[key];
  if (layoutState.activeWorkKey !== key || layout === undefined) return false;
  const id = target.kind === 'mail' ? tabId.mail() : tabId.room(target.roomId);
  return groups(layout).some((group) => group.activeTabId === id);
}

/**
 * Подписки App: useActivityStore (живые события и повтор после подключения), useWorksStore (первый снимок —
 * ответ works.list), host.notice моста. Каждый вызов — новый уведомитель с пустыми базами: App зовёт его
 * на каждый переход в connected. Возвращает отписку.
 */
export function wireAttentionNotifications(bridge: HarnasBridge, deps: Omit<NotifyDeps, 'notify'>): () => void {
  const notifier = createAttentionNotifier({ ...deps, notify: (note) => bridge.app.notify(note) });
  // Активность — из стора, а не прямо из `activity.changed`: повтор после подключения,
  // пришедший раньше подписки рендерера, попадает в стор снимком main (раунд исправлений 3.1).
  // Новое значение сессии — новая запись в `byRef`, повтор того же события — тоже новая.
  const offActivity = useActivityStore.subscribe((state, prev) => {
    for (const [key, entry] of Object.entries(state.byRef)) {
      if (prev.byRef[key] !== entry) notifier.onActivity(entry.ref, entry.activity);
    }
  });
  const offWorks = useWorksStore.subscribe((state, prev) => {
    if (state.entries !== prev.entries) notifier.onWorks(state.entries);
  });
  const offNotice = bridge.on('host.notice', (notice) => notifier.onHostNotice(notice));
  return () => {
    offActivity();
    offWorks();
    offNotice();
  };
}
