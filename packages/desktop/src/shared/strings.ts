/**
 * Единственная таблица видимых текстов окна (кусок E.1, решение пользователя
 * 2026-09-27: интерфейс — только английский, как у Orca). И main, и рендерер
 * читают её отсюда — `shared/` входит в `tsconfig.node.json` и
 * `tsconfig.web.json` разом. `@harnas/protocol` — единственный пакет в
 * `references` ОБОИХ тсконфигов, поэтому типы `HostNotice`/`NoticeKind` (для
 * `noticeText`) взяты оттуда; `@harnas/core` main не резолвит вовсе — таблицы
 * вроде кодов слияния держат ключ обычной строкой, а не типом этого пакета,
 * тот же приём, что и у `STATUS_LABEL`/`MERGE_FAIL_TEXT` в `ChangesPanel.tsx`
 * до этого куска.
 *
 * Перевод — по глоссарию индекса плана (`docs/specs/2026-09-26-desktop-orca-ui-plan.md`,
 * «Сквозные ограничения» → «Язык интерфейса»): работа → workspace, почта →
 * mail, письмо → message, будильник → auto-wake и т. д. Группы ниже по
 * областям окна; параметризованные тексты — функции.
 */
import type { HostNotice, NoticeKind } from '@harnas/protocol';

export const S = {
  /** Общие подписи кнопок, переиспользуемые в нескольких диалогах. */
  common: {
    cancel: 'Cancel',
    create: 'Create',
    close: 'Close',
    delete: 'Delete',
    done: 'Done',
    retry: 'Retry',
  },

  /**
   * Девять слов состояния сессии (спека 4.2): ключи — те же, что отдаёт
   * `dot-state.ts#stateWord` (`exited` расщеплён на `asleep`/`closed` по
   * `lifecycle`, как и в прежней русской таблице).
   */
  states: {
    working: 'Working',
    blocked: 'Needs you',
    unseen: 'Done · unseen',
    idle: 'Idle',
    pending: 'Not started',
    asleep: 'Asleep',
    closed: 'Closed',
    done: 'Done',
    failed: 'Failed',
  },

  /** Экран пустого окна (нет ни одной работы) — `shell/Landing.tsx`. */
  landing: {
    /** Совпадает с заголовком диалога новой работы — один текст на обе кнопки. */
    newWorkspace: 'New workspace',
    palette: 'Palette',
  },

  /** Заголовок окна — `shell/Titlebar.tsx`. */
  titlebar: {
    toggleSidebar: 'Workspace sidebar',
    back: 'Back',
    forward: 'Forward',
    search: 'Search',
    rightSidebar: 'Right sidebar',
  },

  /** Сайдбар работ и дерево сессий — `Sidebar.tsx`, `SessionTree.tsx`, `SessionMenu.tsx`. */
  sidebar: {
    heading: 'Workspaces',
    addWorkspace: '+ workspace',
    empty: 'No workspaces yet',
    trustWaitTooltip: 'Not responding since launch — may be waiting for folder trust',
    sessionMenu: {
      open: 'Open',
      resume: 'Resume',
      stop: 'Stop',
      closeEllipsis: 'Close…',
      createRoomWith: 'Create room with…',
      changes: 'Changes',
      stopConfirmTitle: (label: string): string => `Stop "${label}"?`,
      closeConfirmTitle: (label: string): string => `Close "${label}"?`,
      closeConfirmDescription: 'Session will no longer receive mail',
      deleteConfirmTitle: (label: string): string => `Delete "${label}"?`,
    },
  },

  /** Строка статуса — `shell/StatusBar.tsx`. */
  statusBar: {
    wakePaused: 'Auto-wake paused',
    wakeOn: 'Auto-wake on',
  },

  /** Общие диалоги, не привязанные к своей области (mail/rooms/settings/…). */
  dialogs: {
    newSession: {
      title: 'New session',
      providerPlaceholder: 'Provider…',
      labelField: 'Label',
      taskField: 'Task',
      taskPlaceholder: 'Empty — quiet start; the agent gets the task as its first message',
      childOfSelected: 'Child of selected',
      inOwnWorktree: 'In its own worktree',
      selectWorkRequired: 'No workspace selected',
      submit: 'Launch',
    },
    newWork: {
      title: 'New workspace',
      chooseFolderPlaceholder: 'Choose a folder…',
      titleField: 'Title',
      goalField: 'Goal',
      selectFolderRequired: 'Select a project folder',
    },
  },

  /** «Вся почта работы» и лента писем — `mail/*`, строка сайдбара, вкладка панели, палитра. */
  mail: {
    allWorkspaceMail: 'All workspace mail',
    headerPrefix: 'All mail',
    decisionsHeading: 'Decisions',
    decisionsEarlier: (count: number): string => `+${count} earlier`,
    unreadAriaLabel: 'unread',
    kindSuffixQuestion: ' · question',
    kindSuffixDecision: ' · decision',
    messageWord: (count: number): string => (count === 1 ? 'message' : 'messages'),
  },

  /** Комнаты — `rooms/*`. */
  rooms: {
    fallbackTitle: 'Room',
    notFound: 'Room not found',
    everyone: 'everyone',
    kindLabels: {
      note: 'Note',
      question: 'Question',
      decision: 'Decision',
    },
    composerPlaceholder: '⌘Enter to send',
    send: 'Send',
    createTitle: (label: string): string => `Create room with ${label}`,
    nameField: 'Name',
    moreParticipants: 'More participants',
    nameRequired: 'Name is required',
  },

  /** Настройки — `settings/SettingsDialog.tsx`. */
  settings: {
    title: 'Settings',
    sections: {
      appearance: 'Appearance',
      terminal: 'Terminal',
      agents: 'Agents',
      notifications: 'Notifications',
    },
    lockedBy: (value: string): string => `(set by ${value})`,
    appearanceSystem: 'System',
    appearanceDark: 'Dark',
    appearanceLight: 'Light',
    terminalFont: 'Terminal font',
    terminalFontSize: 'Terminal font size (8…32)',
    silenceThreshold: 'Silence threshold, ms',
    messageCap: 'Message cap per hour',
    resumeRate: 'Session wake-ups per hour (0…60)',
    autoLaunchPending: 'Auto-launch pending sessions',
    worktreeRoot: 'Worktree root',
    notifyNeedsYou: 'needs you',
    notifyFinished: 'finished',
    notifyMail: 'mail to you',
    notifySound: 'sound',
  },

  /** ⌘K — `palette/CommandPalette.tsx`, часть команд в `lib/commands.ts`. */
  palette: {
    searchPlaceholder: 'Workspace, session, or action…',
    empty: 'Nothing found',
    workspaceHint: 'workspace',
    pauseAutoWake: 'Pause auto-wake',
    resumeAutoWake: 'Resume auto-wake',
  },

  /** ⌘D/⇧⌘D — `palette/SessionPicker.tsx`. */
  picker: {
    title: 'Session into new panel',
    empty: 'Every session here already has a panel',
  },

  /** «Изменения» — `changes/ChangesPanel.tsx`, `changes/DiffView.tsx`. */
  changes: {
    /** Буква статуса git → слово; неизвестная буква печатается как есть (см. вызов). */
    fileStatus: {
      A: 'Added',
      M: 'Modified',
      D: 'Deleted',
      R: 'Renamed',
    } as Record<string, string>,
    mergeBlockedBaseDirty: 'Base is dirty: its working copy has uncommitted changes',
    mergeBlockedUncommitted: 'Worktree has uncommitted changes — commit first',
    /**
     * Причина отказа `worktrees.merge()` — ключи те же четыре, что и в
     * `Exclude<MergeResult, { ok: true }>['reason']` (`@harnas/core`), но без
     * импорта самого типа (шапка файла: `shared/` не тянет типы пакетов,
     * которых нет в `references` `tsconfig.node.json`). Без каста в
     * `Record<string, string>` — доступ по известному ключу остаётся `string`,
     * а не `string | undefined`, и `ChangesPanel.tsx` присваивает объект прямо
     * в свой строго типизированный `MERGE_FAIL_TEXT` без доп. проверок.
     */
    mergeFailReason: {
      base_not_checked_out: 'Base is not checked out anywhere',
      base_dirty: 'Base is dirty',
      uncommitted: 'Worktree has uncommitted changes',
      conflict: 'Merge conflict',
    },
    loading: 'Loading…',
    noFiles: 'No files',
    commitMessagePlaceholder: 'Commit message',
    commitAll: 'Commit all',
    mergeInto: (base: string): string => `Merge into ${base}`,
    discard: 'Discard',
    conflictLabel: (files: string): string => `Conflict: ${files}`,
    messageSent: 'Message sent',
    assignToAgent: 'Assign to agent',
    discardConfirmTitle: (label: string): string => `Discard "${label}"?`,
    discardAllConfirmTitle: 'Uncommitted changes will be lost',
    discardAllConfirm: 'Discard anyway',
    mergeConflictMessage: (label: string, files: string): string =>
      `Merge ${label} hit a conflict: ${files}. Resolve and commit.`,
    binaryFile: 'Binary file',
    noChanges: 'No changes',
  },

  /** Панель терминала — `terminal/TerminalPanel.tsx`. */
  terminal: {
    findPlaceholder: 'Find…',
  },

  /** Баннер прерванных сессий — `components/InterruptedBanner.tsx`. */
  banners: {
    interrupted: (labels: string): string => `Interrupted mid-turn: ${labels}`,
    resumeAll: 'Resume all',
  },

  /** Экраны связи с хостом — `App.tsx`, короткие варианты — `shell/StatusBar.tsx`. */
  connection: {
    connectingScreen: 'Connecting to host…',
    mismatchScreen: (liveSessions: number | null): string =>
      `Host is an older version. Restart? Live sessions: ${liveSessions ?? '—'}.`,
    restart: 'Restart',
    disconnectedScreen: (reason: string): string => `No connection to host: ${reason}`,
    statusConnecting: 'Connecting…',
    statusConnected: (hostVersion: string): string => `Host ${hostVersion}`,
    statusMismatch: 'Host version mismatch',
    statusDisconnected: (reason: string): string => `No connection: ${reason}`,
    /** `main/index.ts` — login-shell не нашёл системный `node`. */
    reasonNodeNotFound: 'node not found in login-shell PATH',
    /** `main/host-connection.ts` — сокет закрылся, ждём переподключения. */
    reasonClosed: 'Connection to host closed',
  },

  /** Меню macOS — `main/menu.ts`; часть пунктов переиспользует палитра (`lib/commands.ts`). */
  menu: {
    edit: 'Edit',
    session: 'Session',
    newSession: 'New session',
    newWork: 'New workspace',
    closePanel: 'Close panel',
    splitRight: 'Split right',
    splitDown: 'Split down',
    prevPanel: 'Previous panel',
    nextPanel: 'Next panel',
    commandPalette: 'Command palette',
    find: 'Find',
    settings: 'Settings',
    workspaceNumber: (n: string): string => `Workspace ${n}`,
    view: 'View',
    workspaceSidebar: 'Workspace sidebar',
  },

  /** Уведомления macOS — `App.tsx` (trust-wait), `renderer/notifications.ts` (тревога сессии). */
  notifications: {
    trustWaitTitle: 'Waiting for folder trust',
    /** Суффикс заголовка `"S03 " + suffix` — не то же самое, что `states.blocked` (третье лицо, спека 4.2 их и раньше различала). */
    alertSuffixBlocked: 'needs a reply',
    alertSuffixUnseen: 'is done',
  },

  /** Тексты общих участников переписки — `lib/participant-tag.ts`. */
  participants: {
    human: 'You',
    system: 'System',
    deletedSuffix: '(deleted)',
  },

  /** Действия для `errorText(code, action)` — фраза подставляется в «Couldn't <action>: …». */
  errors: {
    actions: {
      loadProviders: 'load providers',
      createSession: 'create session',
      createWorkspace: 'create workspace',
      loadChanges: 'load changes',
      commit: 'commit',
      merge: 'merge',
      assignToAgent: 'send to agent',
      discard: 'discard changes',
      createRoom: 'create room',
      loadSettings: 'load settings',
      saveSettings: 'save settings',
    },
    /** Панель пережила исчезновение своей работы/сессии из снимка (`panel-registry.tsx`, план «На что смотреть на ревью», п. 3). */
    workspaceClosed: 'Workspace closed',
    noWorktree: 'This session has no worktree of its own',
  },

  /** Оболочка окна (`shell/AppShell.tsx`) — заголовки `ErrorBoundary` вокруг сайдбара и раскладки. */
  shell: {
    sidebarError: "Couldn't show workspace sidebar",
    layoutError: "Couldn't show layout",
  },
};

/** Английский текст по коду ошибки протокола (`ErrorCode` из `@harnas/protocol`, плюс наш `'failed'`). */
const ERROR_REASON: Record<string, string> = {
  unauthorized: 'not authorized',
  protocol_mismatch: 'host protocol mismatch',
  bad_request: 'invalid request',
  unknown_method: 'not supported by this host version',
  not_found: 'not found',
  conflict: 'conflicting state',
  internal: 'host error',
  failed: 'failed',
};

const DEFAULT_REASON = 'failed';

/**
 * Текст ошибки хоста для человека по коду протокола (`IpcErrorInfo.code`,
 * `shared/ipc-error.ts`); `action` — короткая фраза действия («create
 * session», «merge») уточняет смысл, если он есть. Неизвестный код падает в
 * общий текст `'failed'`, не пустую строку.
 */
export function errorText(code: string, action?: string): string {
  const reason = ERROR_REASON[code] ?? DEFAULT_REASON;
  if (action === undefined) return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`;
  return `Couldn't ${action}: ${reason}.`;
}

/**
 * Английский смысл каждого `NoticeKind` (`@harnas/protocol`) — раунд
 * исправлений 1 куска E.1: `HostNotice.text` хост пишет свободным русским
 * текстом (например, `packages/host/src/activity/activity-service.ts:217,248`,
 * `packages/host/src/sessions/sessions-service.ts:174,215`,
 * `packages/host/src/wake/wake-service.ts:208,224,243,320,331`,
 * `packages/host/src/works/works-service.ts:85,140`) — он приходит рантаймом
 * по сокету, а не литералом в этом пакете, поэтому страж `english-ui` его не
 * ловит. Смысл каждого вида взят из этих мест хоста, сам текст — нет: хост не
 * трогаем (сквозное правило), `notice.text` остаётся только в `console.warn`
 * у вызывающей стороны (`store/notices.ts`).
 */
const NOTICE_DETAIL: Record<NoticeKind, string> = {
  'map-lock': 'workspace map is locked — try again in a moment',
  'map-corrupt': "workspace map couldn't be read",
  'hooks-missing': 'Claude Code hooks did not report — falling back to log-based status',
  'launch-failed': "couldn't launch this session",
  'pointer-timeout': 'no response after the wake-up nudge',
  'pointer-cancelled': 'wake-up nudge cancelled by your input',
  'resume-failed': "couldn't resume this session",
  'resume-limit': 'hourly resume limit reached — mail is waiting',
  'trust-wait': 'not responding since launch — may be waiting for folder trust',
};

/**
 * Английский текст уведомления хоста для человека — строка статуса
 * (`shell/StatusBar.tsx`, любой `NoticeKind`) и тело macOS-уведомления
 * trust-wait (`App.tsx`). `label` — ярлык сессии по `notice.ref`, если
 * вызывающая сторона его знает (рендерер ищет по снимку работ через
 * `lib/participant.ts#sessionLabelFor`; main, у которого снимка нет, зовёт
 * без него или с тем, что есть); без ярлыка — просто фраза с большой буквы.
 */
export function noticeText(notice: HostNotice, label?: string): string {
  const detail = NOTICE_DETAIL[notice.kind];
  if (label === undefined) return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
  return `${label}: ${detail}.`;
}
