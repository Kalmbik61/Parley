/**
 * Уведомления macOS окна (кусок 4.3, спека 7.4): переход сессии в «ждёт тебя» или «закончил
 * ход», новое прямое письмо человеку, уведомления хоста о запуске сессии; с куска 8 «Organic» —
 * решение ведущего, которое ждёт человека в комнате (спека окна 2026-09-29, 1.10). Тексты — из
 * `shared/strings.ts`; название работы, ярлык, задача, итог и письмо — данные, идут как есть.
 * Русский `HostNotice.text` сюда не попадает: его пишет в консоль `store/notices.ts`.
 */

import type { Proposal, Room, SessionActivity, WorkEntry, WorkSession } from '@parley/core';
import { refKey, type HostNotice, type SessionRef } from '@parley/protocol';
import { clampNoteText } from '../../shared/app-note.js';
import type { AppNote, FocusTarget, ParleyBridge } from '../../shared/bridge.js';
import { noticeText, S } from '../../shared/strings.js';
import type { UiFile } from '../../shared/ui-types.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { sessionRowLabel, sessionTag, workTitleText } from '../lib/participant.js';
import { workKey } from '../lib/tree-order.js';
import { useActivityStore } from '../store/activity.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { humanUnreadLetters, roomAwaitsDecision, roomDecisionReturned, sessionAttention, type Attention } from './derive.js';
import { visibleSessions } from './seen.js';
import { useWindowNotesStore, type WindowNote } from './window-notes.js';

export interface NotifyDeps {
  notify(note: AppNote): void;
  prefs(): UiFile['notifications'];
  isTargetVisible(target: FocusTarget): boolean;
  /** Снимок работ окна: название работы, сессия (ярлык, задача, summary), письма. */
  entries(): readonly WorkEntry[];
  /**
   * Окно в фокусе и на экране (`windowFocused` и `documentVisible` стора окна): решение показывается карточкой
   * в самом окне (1.10), а не уведомлением macOS — человек и так за окном.
   */
  windowActive(): boolean;
  /** Карточка в окне (1.10): `Open` / `Later`, скрытие через 8 с. */
  showInWindow(note: WindowNote): void;
  /** Решение отвечено: его карточка в окне, если ещё стоит, уходит — `Open` вёл бы к уже принятому. */
  hideInWindow(tag: string): void;
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

/** Тег решения (1.10): один на комнату — и у уведомления macOS, и у карточки в окне. */
const decisionTag = (key: string, roomId: string): string => `proposal:${key}:${roomId}`;

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
  /**
   * Новые прямые письма человеку (isHumanUnread) и решения ведущих, ждущие человека в комнатах (новое — по новому `id`,
   * переделанное — по выросшему `rev` или по новому `id` после возврата на доработку); первый снимок — база.
   */
  onWorks(entries: readonly WorkEntry[]): void;
  /** trust-wait, launch-failed, resume-failed; ref: null или сессии нет в снимке — без уведомления. */
  onHostNotice(notice: HostNotice): void;
} {
  const levels = new Map<string /* refKey */, Attention>();
  /** Письма прошлого снимка (`workKey` + id: id писем уникальны только в работе); null — снимка ещё не было. */
  let knownLetters: Set<string> | null = null;
  /**
   * Решения комнат, о которых окно знает: `workKey` + id комнаты → решение (`id`, `rev`) и ждёт ли оно ещё; null —
   * снимка ещё не было. Записи не удаляются, пока живёт уведомитель: `id` решения не переиспользуется, и работа, на миг
   * выпавшая из снимка, не даст уведомления о том же решении второй раз.
   */
  let knownDecisions: Map<string, { id: string; rev: number; waiting: boolean }> | null = null;

  const send = (note: Omit<AppNote, 'silent'>): void => {
    if (deps.isTargetVisible(note.target)) return;
    deps.notify({
      ...note,
      title: clampNoteText(note.title),
      body: clampNoteText(note.body),
      silent: !deps.prefs().sound,
    });
  };

  /**
   * Решение ждёт человека (1.10). Окно в фокусе — карточка в самом окне, иначе уведомление macOS; вкладка комнаты видна —
   * ничего, как у прочих целей (7.2). Тег один на комнату: новое уведомление заменяет прежнее и там, и там.
   */
  const sendDecision = (note: Omit<AppNote, 'silent' | 'title'>): void => {
    if (deps.isTargetVisible(note.target)) return;
    const title = clampNoteText(S.notifications.decisionTitle);
    const body = clampNoteText(note.body);
    if (deps.windowActive()) {
      deps.showInWindow({ tag: note.tag, title, body, target: note.target });
      return;
    }
    deps.notify({ ...note, title, body, silent: !deps.prefs().sound });
  };

  const notifyDecision = (entry: WorkEntry, room: Room, proposal: Proposal, change: 'new' | 'revised'): void => {
    // Решение — «нужен ты» (2.7), как `blocked`: тот же ключ настроек.
    if (!deps.prefs().needsYou) return;
    // Ведущий — короткий ярлык `S01`, как в подписях `lead S01` окна и в тексте handoff (`dark-01`).
    const lead = sessionTag(proposal.from);
    sendDecision({
      body: (change === 'new' ? S.notifications.decisionNew : S.notifications.decisionRevised)(room.title, lead),
      tag: decisionTag(workKey(entry.projectPath, entry.map.work.id), room.id),
      target: { kind: 'room', projectPath: entry.projectPath, workId: entry.map.work.id, roomId: room.id },
    });
  };

  /**
   * Сравнивает решения снимка с теми, что окно уже знает. Новый `id` в комнате — «collected positions», а если прежнее
   * решение человек вернул на доработку (`roomDecisionReturned`) — «revised»: ведущий принёс исправленное, и новый `id`
   * тут не признак нового решения. Тот же `id` с выросшим `rev` — тоже «revised» (замена до ответа); то же самое
   * решение (`id` и `rev`) молчит. Первый снимок — база: решения, что уже ждали на старте окна или после переподключения
   * к хосту, не уведомляют второй раз (как письма, спека 7.4).
   */
  const trackDecisions = (entries: readonly WorkEntry[]): void => {
    const isBase = knownDecisions === null;
    const known = (knownDecisions ??= new Map());
    for (const entry of entries) {
      const key = workKey(entry.projectPath, entry.map.work.id);
      for (const room of entry.map.rooms) {
        const slot = `${key}\u0000${room.id}`;
        const before = known.get(slot);
        if (!roomAwaitsDecision(room)) {
          // Решение отвечено: карточка о нём в окне больше не нужна.
          if (before?.waiting === true) {
            known.set(slot, { ...before, waiting: false });
            deps.hideInWindow(decisionTag(key, room.id));
          }
          continue;
        }
        const proposal = room.proposal as Proposal;
        known.set(slot, { id: proposal.id, rev: proposal.rev, waiting: true });
        if (isBase) continue;
        if (before === undefined || before.id !== proposal.id) {
          notifyDecision(entry, room, proposal, roomDecisionReturned(entry.map, room.id) ? 'revised' : 'new');
        } else if (proposal.rev > before.rev) notifyDecision(entry, room, proposal, 'revised');
      }
    }
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
          workTitleText(entry.map.work.title),
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
      trackDecisions(entries);
      // Письма, которые уже были на старте окна, не уведомляют.
      if (known === null || !deps.prefs().mail) return;
      for (const entry of entries) {
        const key = workKey(entry.projectPath, entry.map.work.id);
        const fresh = humanUnreadLetters(entry.map).filter((message) => !known.has(`${key}\u0000${message.id}`));
        // Одно уведомление на работу (тег `mail:<workKey>`): новее — последнее письмо.
        const latest = fresh.at(-1);
        if (latest === undefined) continue;
        send({
          title: S.notifications.mailTitle(workTitleText(entry.map.work.title), latest.kind, sessionTag(latest.from)),
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
        title: S.notifications.sessionTitle(workTitleText(entry.map.work.title), sessionRowLabel(session.id, session.label), event),
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
 * Окно в фокусе и на экране — то же условие, при котором вкладка комнаты или почты вообще может быть видна
 * (`isTargetVisible`, спека 7.2). Читается в момент вызова.
 */
export function isWindowActive(): boolean {
  const ui = useUiStore.getState();
  return ui.windowFocused && ui.documentVisible;
}

/**
 * Подписки App: useActivityStore (живые события и повтор после подключения), useWorksStore (первый снимок —
 * ответ works.list), host.notice моста. Каждый вызов — новый уведомитель с пустыми базами: App зовёт его
 * на каждый переход в connected. Карточки в окне (1.10) — стор `window-notes.ts`, который рисует `WindowNotes`.
 * Возвращает отписку.
 */
export function wireAttentionNotifications(
  bridge: ParleyBridge,
  deps: Omit<NotifyDeps, 'notify' | 'windowActive' | 'showInWindow' | 'hideInWindow'>,
): () => void {
  const notifier = createAttentionNotifier({
    ...deps,
    notify: (note) => bridge.app.notify(note),
    windowActive: isWindowActive,
    showInWindow: (note) => useWindowNotesStore.getState().show(note),
    hideInWindow: (tag) => useWindowNotesStore.getState().dismiss(tag),
  });
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
