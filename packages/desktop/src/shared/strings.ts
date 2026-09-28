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
    copy: 'Copy',
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

  /**
   * Сайдбар карточек (куски 3.3–3.5): `sidebar/WorkSidebar.tsx`, `WorkCard.tsx`,
   * `ProjectGroup.tsx`, `SessionRow.tsx` и меню строки `SessionRowMenu.tsx`.
   */
  sidebar: {
    /** Кнопка верха сайдбара; «+» рисует значок рядом, в тексте его нет (раунд 1 куска 3.3). */
    addWorkspace: 'New workspace',
    /** Заголовок секции закреплённых работ (спека 6.1). */
    pinned: 'Pinned',
    /** Верх сайдбара — палитра; подпись ⌘J (кусок 6.1b), прежняя палитра до 6.2. */
    search: 'Search',
    /** `aria-label` «+» заголовка проекта. */
    newWorkspaceInProject: 'New workspace in project',
    sessionCount: (n: number): string => (n === 1 ? '1 session' : `${n} sessions`),
    /** Строка под сессиями карточки: сколько закрытых спрятано. */
    moreClosed: (n: number): string => `+${n} closed`,
    trustWaitTooltip: 'Not responding since launch — may be waiting for folder trust',
    /** Переключатель меню «⋯» заголовка секции (спека 6.1, кусок 3.4). */
    showDone: 'Show done',
    /** `aria-label` кнопки «⋯» заголовка секции. */
    sectionMenu: 'Section options',
    /** `aria-label` кнопки `#`/`#N` карточки — меню комнат работы (спека 6.3). */
    roomsMenu: 'Rooms',
    /** `aria-label` поля переименования на месте (спека 6.4). */
    renameField: 'Workspace name',
    /** aria-label списка карточек — дерево «работа → сессии» для клавиатуры (спека 6.5). */
    workspaceList: 'Workspaces',
    sessionMenu: {
      open: 'Open',
      /** Кусок 3.4: сплит вправо с вкладкой терминала сессии. */
      openBeside: 'Open to the side',
      /** Кусок 3.4: только у сессии со своим worktree. */
      copyWorktreePath: 'Copy worktree path',
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

  /** Меню карточки работы — `sidebar/CardMenu.tsx` (спека 6.4, кусок 3.4). */
  cardMenu: {
    pin: 'Pin',
    unpin: 'Unpin',
    newSession: 'New session',
    newRoom: 'New room',
    openMail: 'Open mail',
    rename: 'Rename',
    reveal: 'Reveal in Finder',
    copyPath: 'Copy path',
    markDone: 'Mark as done',
    reopen: 'Reopen',
    archive: 'Archive',
    deleteEllipsis: 'Delete…',
    archiveConfirmTitle: (title: string): string => `Archive "${title}"?`,
    deleteConfirmTitle: (title: string): string => `Delete "${title}"?`,
    deleteConfirmDescription: (sessions: number): string =>
      `${sessions === 1 ? '1 session' : `${sessions} sessions`} will be deleted. Running agents will be stopped.`,
  },

  /** Относительное время карточек и строк сессий — `lib/relative-time.ts` (спека 6.3). */
  time: {
    now: 'now',
    yesterday: 'yesterday',
    minutes: (n: number): string => `${n}m`,
    hours: (n: number): string => `${n}h`,
  },

  /** Строка статуса — `shell/StatusBar.tsx`. */
  statusBar: {
    wakePaused: 'Auto-wake paused',
    wakeOn: 'Auto-wake on',
    /** Хосту не хватает методов этой сборки окна (спека 3.2, 5.9). */
    hostOutdated: 'Host is outdated — restart',
    restartHostTitle: 'Restart host?',
    restartHostDescription: 'Live agents will be interrupted and come back with --resume.',
    /** «N ждут тебя · M не просмотрено» (кусок 4.2, спека 7.3): нулевая часть не пишется, обе нулевые — ''. */
    attention: (needsYou: number, unseen: number): string =>
      [needsYou > 0 ? `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you` : '', unseen > 0 ? `${unseen} unseen` : '']
        .filter((part) => part !== '')
        .join(' · '),
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
      /** Форма новой работы — `sidebar/NewWorkComposer.tsx` (кусок 3.5, спека 6.6). */
      projectField: 'Project',
      startSession: 'Start a session',
      agentField: 'Agent',
      createMore: 'Create more',
      titleLength: 'Title: 1–120 characters',
      goalTooLong: 'Goal: up to 4,000 characters',
      labelTooLong: 'Label: up to 40 characters',
      taskTooLong: 'Task: up to 20,000 characters',
      agentRequired: 'Select an agent',
      agentPlaceholder: 'Agent…',
      /** Снимок работ не принёс новую работу за 10 с — вкладка не открыта вслепую. */
      notListedYet: 'Workspace created — it will appear in the sidebar shortly',
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
    /** «Новая комната» из меню карточки — без обязательного участника (кусок 3.4). */
    newRoomTitle: 'New room',
  },

  /** Настройки — `settings/SettingsDialog.tsx`. */
  settings: {
    title: 'Settings',
    sections: {
      appearance: 'Appearance',
      terminal: 'Terminal',
      agents: 'Agents',
      notifications: 'Notifications',
      browser: 'Browser',
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
    /** Electron на macOS не сообщает о запрете уведомлений — подсказка стоит всегда (спека 7.4). */
    notificationsHint: 'Not getting notifications? System Settings → Notifications → Harnas',
    /** Секция «Браузер» (кусок 9.1): куки, хранилища и кеш раздела встроенного браузера. */
    clearBrowserData: 'Clear browser data',
  },

  /**
   * Палитра ⌘J — `renderer/palette/Palette.tsx` (кусок 6.2, спека 9.3). Заголовок диалога для
   * скринридера — `S.actions.commandPalette`, «Open mail» — `S.cardMenu.openMail`.
   */
  palette: {
    placeholder: 'Search tabs, workspaces, sessions, rooms, and actions…',
    /** Заголовок режимов splitRight и splitDown. */
    splitTitle: 'Open in new group',
    sections: { tabs: 'Tabs', works: 'Workspaces', sessions: 'Sessions', rooms: 'Rooms', actions: 'Actions', files: 'Files' },
    more: (n: number): string => `${n} more`,
    createWorkspace: (query: string): string => `Create workspace "${query}"`,
    footer: '↑↓ select · Enter open · ⌘Enter open to the side · Esc close',
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

  /** Поверхность терминала — `terminal/TerminalSurface.tsx`. */
  terminal: {
    findPlaceholder: 'Find…',
    /** Меню терминала (кусок 5.3, спека 8.4): Copy — `S.common.copy`, Find и Split — `S.menu`. */
    paste: 'Paste',
    selectAll: 'Select all',
    clear: 'Clear',
    /** `aria-label` полосы поиска ⌘F (спека 8.2); × — `S.common.close`. */
    matchCase: 'Match case',
    useRegex: 'Use regular expression',
    previousMatch: 'Previous match',
    nextMatch: 'Next match',
    /** Картинка из буфера больше предела main (`drops.ts`, 20 МБ) — не сохранена и не отправлена. */
    imageTooLarge: 'Image is larger than 20 MB — not sent',
    /** Связь окна с хостом оборвалась (раунд lane-r3, п. 2): терминал ввод не принимает. */
    disconnected: 'Disconnected — reconnecting…',
  },

  /**
   * Тосты отправки агенту (кусок 5.4, спека 8.6); `session` — `sessionTag`: 'S02'. Copy —
   * `S.common.copy`, Retry — `S.common.retry`, Resume — `S.sidebar.sessionMenu.resume`.
   */
  send: {
    sent: (session: string): string => `Sent to ${session}`,
    insertedDraft: (session: string): string => `Inserted into ${session} without Enter — your draft is in the input`,
    insertedInput: (session: string): string => `Inserted into ${session} without Enter — you were typing in the terminal`,
    insertedRestarted: (session: string): string => `Inserted into ${session} without Enter — the session restarted`,
    blocked: (session: string): string => `${session} is waiting for your answer — text not inserted`,
    busy: (session: string): string => `${session} is busy with another message — retry in a second`,
    noPasteMode: (session: string): string => `${session} doesn't accept multi-line paste`,
    notRunning: (session: string): string => `${session} isn't running`,
    openSession: (session: string): string => `Open ${session}`,
  },

  /**
   * Меню ссылки терминала (кусок 5.3, спека 8.3): «Reveal in Finder» и «Copy path» —
   * `S.cardMenu.reveal` и `copyPath`; «Open in editor» — вкладка файла (кусок 7.3b).
   */
  links: {
    openInEditor: 'Open in editor',
    openInDefaultApp: 'Open in default app',
    /** Вкладка встроенного браузера (с 9.2b; до него — системный браузер). */
    openInBrowser: 'Open in browser',
    openInSystemBrowser: 'Open in system browser',
    copyLink: 'Copy link',
  },

  /** Раскладка: строка вкладок и тела вкладок — `layout/*` (кусок 2.4, спека 5.3, 5.8, 5.10). */
  tabs: {
    /** `aria-label` строки вкладок (`role="tablist"`) — раунд исправлений 1 куска 2.4. */
    tablist: 'Tabs',
    mail: 'Mail',
    /** `Changes S02` без коммита, `Changes S02 · a1b2c3d` — с ним (первые 7 hex, спека 5.2). */
    diffTitle: (sessionTag: string, shortHash: string | null): string =>
      shortHash === null ? `Changes ${sessionTag}` : `Changes ${sessionTag} · ${shortHash}`,
    openTab: 'Open…',
    emptyGroup: 'Open a session from the sidebar, ⌘T for a new session',
    closedToast: 'Tab closed — ⌘⇧T to reopen',
    tooSmall: 'Not enough room for another group',
    tooManyGroups: 'No more than 8 groups per workspace',
    missingSession: 'Session deleted',
    missingRoom: 'Room deleted',
    closeOthers: 'Close others',
    closeToRight: 'Close to the right',
    /** `aria-label` точки «не сохранён» вкладки файла (кусок 7.3a). */
    unsaved: 'Unsaved changes',
  },

  /**
   * Вкладка браузера — `renderer/browser/*` (кусок 9.2a, спека 12.1, 12.4). Назад и вперёд —
   * `S.actions.back` и `forward`; «Новая вкладка браузера» — `S.actions.newBrowserTab`. Адрес и
   * заголовок страницы — данные, идут как есть.
   */
  browser: {
    /** Заголовок вкладки без адреса. */
    newTab: 'New tab',
    /** `aria-label` адресной строки. */
    address: 'Address',
    /** Ошибка `'not-an-address'` у `normalizeUrl`. */
    notAnAddress: "Enter an address — search isn't supported",
    /** Ошибка `'local-file'` у `normalizeUrl`. */
    localFile: "Local files can't be opened here",
    reload: 'Reload',
    stop: 'Stop',
    devTools: 'DevTools',
    pageCrashed: 'Page crashed',
    tooManyTabs: 'No more than 10 browser tabs per workspace',
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

  /**
   * Названия меню macOS — `main/menu.ts` (кусок 6.1a, спека 9.6). Пункты — заголовки действий
   * реестра, `S.actions`: их же берут палитра, меню вкладки и меню терминала.
   */
  menu: {
    edit: 'Edit',
    view: 'View',
    workspace: 'Workspace',
    tab: 'Tab',
    terminal: 'Terminal',
  },

  /** Заголовки действий реестра клавиш (`shared/keybindings.ts`, спека 9.6): пункты меню и строки палитры. */
  actions: {
    commandPalette: 'Command palette',
    goToFile: 'Go to file',
    findInFiles: 'Find in files',
    newWorkspace: 'New workspace',
    newSession: 'New session',
    newRoom: 'New room',
    workspaceNumber: (n: number): string => `Workspace ${n}`,
    previousWorkspace: 'Previous workspace',
    nextWorkspace: 'Next workspace',
    showArchivedWorkspaces: 'Show archived workspaces',
    back: 'Back',
    forward: 'Forward',
    toggleWorkspaceSidebar: 'Toggle workspace sidebar',
    toggleRightSidebar: 'Toggle right sidebar',
    showFiles: 'Show files',
    showChanges: 'Show changes',
    splitRight: 'Split right',
    splitDown: 'Split down',
    previousGroup: 'Previous group',
    nextGroup: 'Next group',
    closeTab: 'Close tab',
    reopenClosedTab: 'Reopen closed tab',
    previousTab: 'Previous tab',
    nextTab: 'Next tab',
    nextRecentTab: 'Next recent tab',
    previousRecentTab: 'Previous recent tab',
    tabNumber: (n: number): string => `Tab ${n}`,
    find: 'Find',
    clearTerminal: 'Clear terminal',
    settings: 'Settings',
    nextNeedsYou: 'Next session that needs you',
    // Реестр берёт pause; палитра подменяет на resume по wakePaused (6.2).
    pauseAutoWake: 'Pause auto-wake',
    resumeAutoWake: 'Resume auto-wake',
    restartHost: 'Restart host…',
    themeSystem: 'Theme: system',
    themeDark: 'Theme: dark',
    themeLight: 'Theme: light',
    newBrowserTab: 'New browser tab',
    findInPage: 'Find in page',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    actualSize: 'Actual size',
  },

  /**
   * Уведомления macOS — `renderer/attention/notify.ts` (кусок 4.3, спека 7.4). Название работы,
   * ярлык сессии и отправитель — данные, идут как есть.
   */
  notifications: {
    /** «<работа> · <ярлык> — <событие>». */
    sessionTitle: (workspace: string, session: string, event: string): string => `${workspace} · ${session} — ${event}`,
    needsYou: 'needs you',
    finished: 'finished',
    trustWait: 'waiting for folder trust',
    launchFailed: "couldn't launch",
    resumeFailed: "couldn't resume",
    /** «<работа> · письмо | вопрос | решение от S01» по `Message.kind`. */
    mailTitle: (workspace: string, kind: 'note' | 'question' | 'decision', from: string): string =>
      `${workspace} · ${kind === 'question' ? 'question' : kind === 'decision' ? 'decision' : 'message'} from ${from}`,
    /** Тост: клик по уведомлению, чью работу или сессию успели удалить (спека 7.5). */
    targetGone: 'Workspace or session no longer exists',
  },

  /** Тексты общих участников переписки — `lib/participant-tag.ts`. */
  participants: {
    human: 'You',
    system: 'System',
    deletedSuffix: '(deleted)',
    /** Ярлык сессии, созданной без названия (`NEW_LABEL` core) — `lib/participant.ts`. */
    newSession: 'New session',
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
      renameWorkspace: 'rename workspace',
      markWorkspaceDone: 'mark workspace as done',
      reopenWorkspace: 'reopen workspace',
      archiveWorkspace: 'archive workspace',
      deleteWorkspace: 'delete workspace',
      revealWorkspace: 'reveal workspace in Finder',
      openFile: 'open file',
      revealInFinder: 'reveal in Finder',
      saveScreenshot: 'save screenshot',
      toggleAutoWake: 'toggle auto-wake',
      restartHost: 'restart host',
      closeTab: 'close tab',
      readFolder: 'read folder',
      resumeSession: 'resume session',
      saveFile: 'save file',
      clearBrowserData: 'clear browser data',
      openDevTools: 'open DevTools',
    },
    noWorktree: 'This session has no worktree of its own',
    /** Действие работы (⌘T, ⌘W, разделение…) без активной работы — тост (кусок 6.3). */
    noActiveWorkspace: 'No active workspace',
    /** ⌘L, ⌘⇧E или кнопка заголовка, когда правому сайдбару нет места рядом с центром (раунд main-r2). */
    noRoomForRightSidebar: 'Not enough room for the right sidebar',
  },

  /**
   * Файлы и пути (кусок 5.2, спека 10.8): main текста для человека не пишет — окно
   * показывает `denied` по коду `files:denied`, `revealedInFinder` — по ответу
   * `'revealed'` у `app.openPath` (тосты 5.3 и 7.x).
   */
  files: {
    denied: 'Path is outside the workspace folders',
    revealedInFinder: "This file type doesn't open here — revealed in Finder",
    /** Вкладка правого сайдбара и её дерево (кусок 7.2, спека 10.1). */
    panel: 'Files',
    project: 'Project',
    /** Корень-worktree в `RootPicker`: ярлык сессии и ветка — данные, идут как есть. */
    worktreeRoot: (tag: string, branch: string): string => `⎇ ${tag} · ${branch}`,
    rootGone: 'Session folder no longer exists',
    refresh: 'Refresh',
    showIgnored: 'Show ignored files',
    copyRelativePath: 'Copy relative path',
    /** Вопрос о несохранённом буфере (кусок 7.3a, спека 10.4); Cancel — `S.common.cancel`. */
    saveChanges: (name: string): string => `Save changes to ${name}?`,
    save: 'Save',
    dontSave: "Don't save",
    /** Тот же вопрос при закрытии окна и ⌘Q — по всем грязным буферам. */
    saveChangesCount: (count: number): string => `Save changes to ${count} files?`,
    saveAll: 'Save all',
    saveAllFailed: "Couldn't save all files — the window stays open",
    /**
     * Тело вкладки файла (кусок 7.3b, спека 10.4, 10.5, 13): плашки только чтения — по коду
     * `readOnlyReason`, тела — по коду ошибки `readText`. «Open in default app» —
     * `S.links.openInDefaultApp`, «Reveal in Finder» — `S.cardMenu.reveal`, Close и Retry —
     * `S.common`; «Session folder no longer exists» — `rootGone`.
     */
    readOnlyTooLarge: 'Large file — editing disabled',
    readOnlyNotUtf8: 'Not UTF-8 — editing disabled',
    tooLarge: 'File is larger than 20 MB',
    binary: 'Binary file',
    notFound: 'File not found',
    editorFailed: "Editor didn't load",
    reloadedFromDisk: 'Reloaded from disk',
    changedOnDisk: 'File changed on disk (probably by the agent)',
    deletedOnDisk: 'File deleted on disk',
    reload: 'Reload',
    compare: 'Compare',
    keepMine: 'Keep mine',
    saveAgain: 'Save again',
    overwrite: 'Overwrite',
    overwriteQuestion: 'File changed on disk after you opened it. Overwrite the changes on disk?',
  },

  /** Оболочка окна (`shell/AppShell.tsx`) — заголовки `ErrorBoundary` вокруг сайдбара и раскладки. */
  shell: {
    sidebarError: "Couldn't show workspace sidebar",
    rightSidebarError: "Couldn't show right sidebar",
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
 * (`shell/StatusBar.tsx`, любой `NoticeKind`) и тело macOS-уведомлений
 * хоста (`renderer/attention/notify.ts`, без ярлыка — он в заголовке). `label` — ярлык сессии по `notice.ref`, если
 * вызывающая сторона его знает (рендерер ищет по снимку работ через
 * `lib/participant.ts#sessionLabelFor`; main, у которого снимка нет, зовёт
 * без него или с тем, что есть); без ярлыка — просто фраза с большой буквы.
 */
export function noticeText(notice: HostNotice, label?: string): string {
  const detail = NOTICE_DETAIL[notice.kind];
  if (label === undefined) return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
  return `${label}: ${detail}.`;
}
