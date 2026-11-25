import type { ContextKind } from '../context-markdown.js';
import { ruCount, ruNumber, type LocalizedMessages } from './desktop-messages.js';
import { pilotText, sessionCountText } from './session-pilot.js';

const CONTEXT_NOUNS: Record<ContextKind | 'mixed', readonly [string, string]> = {
  element: ['element', 'elements'],
  console: ['console message', 'console messages'],
  request: ['request', 'requests'],
  errors: ['error list', 'error lists'],
  annotations: ['annotation', 'annotations'],
  mixed: ['item', 'items'],
};

const en = {

  /**
   * Палитра ⌘J — `renderer/palette/Palette.tsx` (кусок 6.2, спека 9.3). Заголовок диалога для
   * скринридера — `S.actions.commandPalette`, «Open mail» — `S.cardMenu.openMail`.
   */
  palette: {
    // Подсказка поля — дословно по handoff (спека окна 2026-09-29, 1.9).
    get placeholder(): string { return pilotText('palette.placeholder'); },
    /** Заголовок режимов splitRight и splitDown. */
    splitTitle: 'Open in new group',
    sections: { tabs: 'Tabs', works: 'Workspaces', sessions: 'Sessions', rooms: 'Rooms', get actions(): string { return pilotText('palette.actions'); }, files: 'Files' },
    /** Без запроса секция вкладок называется «Open tabs» (1.9): это последние открытые, а не найденные. */
    openTabs: 'Open tabs',
    more: (n: number): string => `${n} more`,
    createWorkspace: (query: string): string => `Create workspace “${query}”`,
    /** Подвал: подсказки клавиш по одной, разделённые зазором; «⌘Enter» — открыть сбоку (спека 9.3). */
    get footerHints(): string[] {
      return [pilotText('palette.select'), pilotText('palette.open'), pilotText('palette.openSide'), pilotText('palette.pick'), pilotText('palette.close')];
    },
    /** Подписи строк (снимок dark-03): вид строки и работа, слово состояния и провайдер у сессии. */
    tabSubtitle: (work: string): string => `Tab · ${work}`,
    roomSubtitle: (work: string): string => `Room · ${work}`,
    sessionSubtitle: (work: string, word: string, provider: string): string => `${work} · ${word} · ${provider}`,
    workSubtitle: (project: string, sessions: number, branch: string | null): string =>
      `${project} · ${sessionCountText(sessions)}${branch === null ? '' : ` · ${branch}`}`,
    get actionSubtitle(): string { return pilotText('palette.actionSubtitle'); },
  },
  changes: {
    /** Буква статуса git → слово; неизвестная буква печатается как есть (см. вызов). */
    fileStatus: {
      A: 'Added',
      M: 'Modified',
      D: 'Deleted',
      R: 'Renamed',
    } as Record<string, string>,
    loading: 'Loading…',
    commitMessagePlaceholder: 'Commit message',
    mergeInto: (base: string): string => `Merge into ${base}`,
    discard: 'Discard',
    discardAllConfirmTitle: 'Uncommitted changes will be lost',
    discardAllConfirm: 'Discard anyway',
    noChanges: 'No changes',
    /** Тело «Изменений» по `data.reason` ошибки git (кусок 8.2a, спека 13): `review/state.ts#changesErrorText`. */
    gitMissing: 'Git not found',
    notARepo: 'This folder is not a git repository',
    /** `.git` worktree подменён — хост git в нём не запускает (раунд fix-final-a, C1). */
    worktreeCorrupt: "This worktree's .git no longer points to the project — git isn't run here",
    /** Тост ответа `worktrees.merge` (спека 11.2) — `review/state.ts#mergeResultText`. */
    merged: (base: string): string => `Merged into ${base}`,
    mergeFailed: {
      baseNotCheckedOut: (base: string): string => `${base} isn't checked out anywhere — check it out in the project folder`,
      baseDirty: (base: string): string => `${base} has uncommitted changes — commit or stash them`,
      uncommitted: 'The worktree has uncommitted changes — commit first',
      conflict: (files: string): string => `Merge conflict in ${files}`,
    },
    /** Текст агенту «Попросить агента разрешить» (спека 11.2): между строками — `- <путь>` на файл. */
    askAgentIntro: (branch: string, base: string): string => `Branch ${branch} has merge conflicts with ${base} in:`,
    askAgentInstruction: (base: string): string =>
      `Merge ${base} into your branch (git merge ${base}), resolve the conflicts, commit, and tell me what you did.`,
    /** Вкладка «Изменения» правого сайдбара (кусок 8.2b, спека 11.1, 11.2) — `review/*.tsx`. */
    panel: 'Changes',
    headerMenu: 'Changes options',
    sessionPicker: 'Session',
    noSession: 'Choose a session to see its changes',
    commitCount: (n: number): string => (n === 1 ? '1 commit' : `${n} commits`),
    projectFolder: (branch: string | null): string => `${branch ?? 'Detached HEAD'} (project folder)`,
    projectFolderWarning: "A commit takes every change in the folder, not only this session's",
    worktreePending: 'The worktree will be created when the session starts',
    /** Сессия, чей worktree отброшен из этого окна: `worktrees.diff` ей уже нечего отвечать. */
    worktreeDiscarded: 'The worktree was discarded',
    sections: { conflicts: 'Conflicts', uncommitted: 'Uncommitted', branchChanges: 'Branch changes', commits: 'Branch commits' },
    /** Неотслеживаемые сверх предела хоста (раунд fix-final-c, п. 1): без строк и чисел. */
    moreUntracked: (n: number): string => `+${n} more untracked`,
    moreUntrackedHint: 'Too many untracked files to list. A commit still takes them.',
    commit: 'Commit',
    commitProject: 'Commit all in folder',
    askAgent: 'Ask agent to resolve',
    commitConfirmTitle: (branch: string): string => `Commit to ${branch}?`,
    /** Несохранённые буферы корня сессии в вопросе коммита (раунд fix-final-c, п. 4). */
    unsavedFiles: (n: number): string => `${n === 1 ? '1 unsaved file' : `${n} unsaved files`} — unsaved edits are not in the commit`,
    saveAllAndCommit: 'Save all and commit',
    commitAnyway: 'Commit anyway',
    saveBeforeCommitFailed: "Couldn't save all files — nothing was committed",
    mergeConfirmTitle: (branch: string, base: string): string => `Merge ${branch} into ${base}?`,
    mergeConfirmDescription: (commits: number, additions: number, deletions: number, base: string, checkout: string): string =>
      `${commits === 1 ? '1 commit' : `${commits} commits`}, +${additions} −${deletions}. ${base} is checked out in ${checkout}.`,
    agentStillWorking: 'The agent is still working — changes may be incomplete',
    askAgentTitle: (session: string): string => `Ask ${session} to resolve conflicts`,
    discardWorktreeEllipsis: 'Discard worktree…',
    discardWorktreeTitle: (session: string): string => `Discard the worktree of ${session}?`,
    discardWorktreeDescription: 'The session will be stopped and closed. Its worktree folder and branch will be deleted.',
    /**
     * Вкладка диффа (кусок 8.3, спека 11.3) — `review/DiffTab.tsx` и соседи. Двоичный файл —
     * `S.files.binary`, сбой Monaco — `S.files.editorFailed`, заголовок вкладки — `S.tabs.diffTitle`.
     */
    inline: 'Inline',
    sideBySide: 'Side by side',
    collapseAll: 'Collapse all',
    /** Секций вкладки диффа больше предела (раунд fix-final-c, п. 1). */
    showMore: (n: number): string => `Show ${n} more`,
    expandAll: 'Expand all',
    wrapLines: 'Wrap lines',
    collapse: 'Collapse',
    expand: 'Expand',
    list: 'List',
    tree: 'Tree',
    fileTooLarge: 'File is larger than 1 MB',
    showAnyway: 'Show anyway',
    copyRemoved: (branch: string): string => `The worktree folder was removed. Its branch ${branch} is kept.`,
    branchMergedDeleted: 'The branch was merged, and Parley deleted it together with the worktree folder.',
    discardBranchDescription: 'The session will be closed. Its branch will be deleted.',
  },

  /**
   * Заметки к строкам диффа (кусок 8.4a, спека 11.4): шаблон текста агенту (`review/notes/format.ts`)
   * и тост битого файла заметок (спека 13). Путь и текст заметки — данные, идут как есть. Меню
   * получателя `SendMenu` сделал 9.3b для Design Mode; остальные строки заметок добавит 8.4b.
   */
  notes: {
    header: (session: string, branch: string | null): string =>
      branch === null ? `Review notes for ${session}:` : `Review notes for ${session} (branch ${branch}):`,
    file: (path: string): string => `File: ${path}`,
    line: (n: number): string => `Line: ${n}`,
    lines: (from: number, to: number): string => `Lines: ${from}-${to}`,
    sideOriginal: 'Side: original',
    note: (body: string): string => `Note: ${body}`,
    corrupted: (name: string): string => `Session notes were damaged — saved as ${name}`,
    /** Отказ чтения файла заметок (fix-8.4a, пункт 1): правки сессии живут в окне, файл не пишется. */
    loadFailed: "Couldn't load review notes — changes to them won't be saved",
    /** Отказ записи файла заметок (fix-8.4a, пункт 2): заметки остаются в окне, следующая правка пишет снова. */
    saveFailed: "Couldn't save review notes",
    /** `aria-label` «▾» у `SendMenu`. */
    chooseRecipient: 'Choose recipient',
    /** Подпись неактивной сессии в `SendMenu`: lifecycle не `active`. */
    notRunning: 'not running',
    /**
     * Заметки во вкладке диффа (кусок 8.4b): «+» гаттера, поле, карточка и кнопки отправки. Автор —
     * `S.participants.human`, Send — `S.common.send`, Save — `S.files.save`, Delete и Cancel — `S.common`.
     */
    add: 'Add note',
    placeholder: 'Note for the agent — ⌘Enter to save',
    edit: 'Edit',
    sendFile: 'Send file notes',
    sendAllUnsent: 'Send all unsent',
    sent: (session: string, time: string): string => `Sent to ${session} · ${time}`,
    stale: 'Outdated',
    /** Полоса заметок старой стороны в одной колонке: `Original · line 7`, `Original · lines 10-14`. */
    original: (from: number, to: number): string => (from === to ? `Original · line ${from}` : `Original · lines ${from}-${to}`),
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
    /** Пустая группа (спека окна 2026-09-29, 1.8): заголовок и подсказка под ним. */
    noOpenTabs: 'No open tabs',
    emptyGroup: 'Open a session from the sidebar, or find anything with ⌘J.',
    closedToast: 'Tab closed — ⌘⇧T to reopen',
    tooSmall: 'Not enough room for another group',
    tooManyGroups: 'No more than 8 groups per workspace',
    missingSession: 'Session deleted',
    missingRoom: 'Room deleted',
    closeOthers: 'Close others',
    closeToRight: 'Close to the right',
    /** `aria-label` точки «не сохранён» вкладки файла (кусок 7.3a). */
    unsaved: 'Unsaved changes',
    /**
     * Файл и метка корня (раунд fix-live, D5): `app.ts · S02`, `src/app.ts · Project`. Заголовок —
     * когда один путь открыт из разных корней; подсказка и вопросы о файле — всегда так же.
     */
    fileWithRoot: (name: string, root: string): string => `${name} · ${root}`,
    board: 'Board',
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
    pageCrashed: 'Page crashed',
    /** Главный фрейм не загрузился (`did-fail-load`, fix-9). */
    loadFailed: "Couldn't load page",
    tooManyTabs: 'No more than 10 browser tabs per workspace',
    /** ⌖ Select (спека браузера 4.6). */
    select: {
      button: 'Select',
      title: 'Select an element — ⇧-click to keep selecting (⌘⇧C)',
    },
    /** ✎ Annotate (спека браузера 4.7): кнопка, редактор комментария и лоток. */
    annotate: {
      button: 'Annotate',
      title: 'Annotate the page — click an element or drag over an area (⌘⌥A)',
      tray: (count: number): string => `${count} annotation${count === 1 ? '' : 's'}`,
      region: (width: number, height: number): string => `Region ${width} × ${height}`,
      gone: 'element gone',
      noComment: 'No comment',
      comment: (n: number): string => `Comment for annotation ${n}`,
      placeholder: 'What is wrong here, or what should change?',
      save: 'Save',
      delete: 'Delete',
      edit: (n: number): string => `Edit annotation ${n}`,
      remove: (n: number): string => `Delete annotation ${n}`,
      clear: 'Clear',
      addToChat: 'Add to chat',
      collapse: 'Hide annotations',
      expand: 'Show annotations',
      limit: 'No more than 20 annotations — add these to chat or clear them first',
    },
    /** Цель «To» (спека браузера 4.1, 4.5): кнопка строки вкладки, меню и тост добавления. */
    target: {
      button: (name: string): string => `To: ${name}`,
      noTarget: 'To: —',
      /** Подсказка кнопки «To». */
      choose: 'Where page context goes',
      sessions: 'Sessions',
      rooms: 'Rooms',
      /** Как ляжет вложение у сессии: чипом в Chat или строкой в ввод CLI. */
      chat: 'chat',
      terminal: 'terminal',
      added: (count: number, kind: ContextKind | 'mixed', target: string): string => {
        const [one, many] = CONTEXT_NOUNS[kind];
        return `${count} ${count === 1 ? one : many} added to ${target}`;
      },
      open: 'Open',
      undo: 'Undo',
      nowhere: 'No session or room to add page context to',
      fellBack: (name: string): string => `The chosen session or room is gone — page context now goes to ${name}`,
      fellBackNowhere: 'The chosen session or room is gone, and there is no other one',
    },
    /**
     * Панель Console | Network и кнопка строки (спека 2026-10-07-browser-devtools-agent-design.md, 4.1, 4.3, 4.4).
     * Сообщения, адреса, заголовки и тела страницы — данные, идут как есть.
     */
    devtools: {
      toggle: 'Console and network',
      console: 'Console',
      network: 'Network',
      more: 'More browser actions',
      openFull: 'Open full DevTools',
      clearAll: 'Clear console and network',
      preserveLog: 'Preserve log',
      clear: 'Clear',
      close: 'Close panel',
      resize: 'Resize panel',
      levels: { error: 'Errors', warning: 'Warnings', info: 'Info', debug: 'Debug' },
      filterConsole: 'Filter',
      filterUrl: 'Filter URL',
      kinds: { all: 'All', fetch: 'Fetch/XHR', doc: 'Doc', js: 'JS', css: 'CSS', img: 'Img', other: 'Other' },
      failedOnly: 'Failed only',
      errors: (count: number): string => `${count} ${count === 1 ? 'error' : 'errors'}`,
      warnings: (count: number): string => `${count} ${count === 1 ? 'warning' : 'warnings'}`,
      repeated: (count: number): string => `×${count}`,
      expand: 'Show stack',
      collapse: 'Hide stack',
      /** Слоты этапа B (спека 4.3–4.5): кнопки есть, только когда передан колбэк доставки. */
      addToChat: 'Add to chat',
      addErrorsToChat: 'Add errors to chat',
      navigatedTo: (url: string): string => `Navigated to ${url}`,
      navigated: 'Navigated to a new page',
      empty: 'No messages',
      emptyNetwork: 'No requests',
      late: 'Reload to capture earlier requests',
      unavailable: 'Capture unavailable — reload the page',
      columns: { status: 'Status', method: 'Method', name: 'Name', type: 'Type', size: 'Size', time: 'Time' },
      status: { cors: 'CORS', blocked: 'blocked', failed: 'failed', canceled: '(canceled)', pending: '(pending)' },
      fromCache: '(cache)',
      bytes: (bytes: number): string =>
        bytes < 1024 ? `${bytes} B` : bytes < 1_048_576 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1_048_576).toFixed(1)} MB`,
      ms: (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`),
      details: {
        headers: 'Headers',
        payload: 'Payload',
        response: 'Response',
        general: 'General',
        responseHeaders: 'Response headers',
        requestHeaders: 'Request headers',
        url: 'URL',
        method: 'Method',
        status: 'Status',
        remoteAddress: 'Remote address',
        query: 'Query',
        body: 'Body',
        noPayload: 'No payload',
        loadResponse: 'Load response',
        loading: 'Loading…',
        bodyGone: 'Body is no longer available',
        truncated: (limit: string): string => `Showing the first ${limit}`,
        binary: (size: string, type: string): string => (type === '' ? `Binary data, ${size}` : `Binary data, ${size}, ${type}`),
        copyUrl: 'Copy URL',
        close: 'Close details',
      },
    },
    /** Меню размера вкладки и подпись поля (спека 2026-10-07, 4.2). */
    viewport: {
      menu: 'Viewport size',
      fit: 'Fit',
      presets: {
        'mobile-s': 'Mobile S',
        'mobile-m': 'Mobile M',
        'mobile-l': 'Mobile L',
        tablet: 'Tablet',
        laptop: 'Laptop',
        desktop: 'Desktop',
      },
      size: (width: number, height: number): string => `${width}×${height}`,
      custom: 'Custom…',
      rotate: 'Rotate',
      dpr: (dpr: number): string => `${dpr}x`,
      width: 'Width',
      height: 'Height',
      apply: 'Apply',
      customRange: (min: number, maxWidth: number, maxHeight: number): string =>
        `Width ${min}–${maxWidth}, height ${min}–${maxHeight}`,
      label: (width: number, height: number, dpr: number, percent: number | null): string =>
        `${width} × ${height} · ${dpr}x${percent === null ? '' : ` · ${percent}%`}`,
      /** Касания включаются с новым документом (спайк 0.3). */
      touchReload: 'Reload to apply touch',
    },
    /**
     * Панель браузера хозяина — справа от вида сессии или комнаты (спека браузера 3.10, 4.11). Заголовок хозяина и названия
     * страниц — данные (ярлык сессии, название комнаты, заголовок и адрес страницы), идут как есть.
     */
    panel: {
      /** Кнопка у вида хозяина (подпись для читалки экрана и подсказка). */
      toggle: 'Browser',
      toggleTitle: 'Show or hide the browser panel',
      /** `aria-label` полоски страниц. */
      pages: 'Browser pages',
      /** Страница без адреса и без заголовка. */
      newPage: 'New page',
      addPage: 'Add a page',
      closePage: (title: string): string => `Close ${title}`,
      closePanel: 'Close the browser panel',
      /** Узкий вид (уже 560 px): панель закрывает вид собой, кнопка возвращает к нему. */
      backToChat: 'Back to chat',
      backToRoom: 'Back to room',
      resize: 'Resize the browser panel',
      tooManyPages: 'No more than 5 pages in a browser panel',
      /** Пункт «⋯» вкладки браузера человека: страница переезжает в браузер сессии или комнаты. */
      moveTo: 'Move to browser of…',
      moved: (name: string): string => `Moved to the browser of ${name}`,
      /** Тост, когда агент открыл страницу, а вид хозяина не на экране; «Show» переводит человека к ней. */
      agentOpened: (session: string, address: string): string => `${session} opened ${address}`,
      agentShow: 'Show',
      /** Пункты «⋯» страницы панели: пауза агентов этого браузера (спека 4.8). */
      pauseAgents: 'Pause agents',
      resumeAgents: 'Resume agents',
      /** Подпись на странице, пока агент снимает её в чужом размере (спека 4.8). */
      agentCapture: (width: number, height: number): string => `Agent capture ${width}×${height}`,
      /** Значок агента в строке страницы (этап D): кто работает на странице и кнопка Stop. */
      agentActing: (session: string): string => `${session} is using this page`,
      agentStop: 'Stop',
      agentStopHint: 'Stop the agent and pause agents in this browser',
      agentRecent: (recent: string[]): string => `Recent: ${recent.join(', ')}`,
    },
    auth: {
      title: 'Sign in',
      proxyTitle: 'Proxy sign-in',
      proxy: 'Proxy',
      requiredBy: (host: string): string => `${host} requires a username and password`,
      realm: (realm: string): string => `Realm: ${realm}`,
      username: 'Username',
      password: 'Password',
      signIn: 'Sign in',
      cancel: 'Cancel',
      wrong: 'Wrong username or password. Try again.',
      sendFailed: "Couldn't send the credentials. Try again or cancel.",
    },
    cert: {
      title: (host: string): string => `${host} asks for a certificate that identifies you.`,
      requestedBy: (pageHost: string): string => `Requested by the page ${pageHost}.`,
      issuer: (name: string): string => `Issued by ${name}`,
      expires: (date: string): string => `Valid until ${date}`,
      serial: (serial: string): string => `Serial ${serial}`,
      remember: "Remember for this site. Agents working in Parley's browser will be identified by it too.",
      keyAccess: 'macOS may then ask for access to the key. Choose "Always Allow", or agents will stop at that window.',
      use: 'Use certificate',
      notNow: 'Not now',
      sendFailed: "Couldn't send the choice. Try again or cancel.",
    },
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
    /** Работа удалена не из этого окна (другой клиент), а правки её файлов не сохранены (fix-7.3 п. 1). Название — данные. */
    workDeleted: (title: string, count: number): string =>
      `Workspace “${title}” was deleted — unsaved changes in ${count} ${count === 1 ? 'file' : 'files'}`,
    discard: 'Discard',
    notSaved: (names: string): string => `Couldn't save: ${names}`,
    /** Нативный вопрос main: вопрос о закрытии ждёт, а страница зависла (fix-7.3 п. 5). */
    unresponsive: "Parley isn't responding. Unsaved changes may be lost.",
    quitAnyway: 'Quit anyway',
    wait: 'Wait',
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
    /**
     * ⌘P и поиск в файлах (кусок 7.4, спека 10.2, 10.3). «Aa» и «.*» — `S.terminal.matchCase` и
     * `useRegex`; отказ `lsFiles` — `S.errors.actions.readFolder`, `grep` — `searchFiles`.
     */
    searchPlaceholder: 'Search in files',
    matchWholeWord: 'Match whole word',
    /** n — число совпадений в ответе `grep` с `truncated`. */
    truncated: (n: number): string => `Showing first ${n} matches`,
    /** n — число путей в ответе `lsFiles` с `truncated`. */
    filesTruncated: (n: number): string => `Showing first ${n} files`,
    refineQuery: 'Refine your query',
    noFiles: 'No matching files',
    loadingFiles: 'Loading files…',
    /** Ответ `bad_request` на запрос в режиме «.*»: ERE git или `RegExp` не разобрали регулярку. */
    invalidRegex: 'Invalid regular expression',
    noResults: 'No results',
    /** Поиск идёт дольше порога показа (раунд fix-7.4, п. 5). */
    searching: 'Searching…',
    /**
     * Git этой машины без PCRE: регулярка на git-корне искалась как POSIX ERE (раунд fix-7.4, п. 3).
     * Подсказка — в `title` строки.
     */
    posixRegex: 'POSIX regex',
    posixRegexHint: 'Git on this machine has no PCRE: \\d, \\w and \\s do not work here. Use [0-9], [[:alnum:]_] and [[:space:]].',
    /**
     * Превью (кусок 7.5, спека 10.6): переключатели шапки тела — «Code / Preview» у Markdown,
     * «Table / Code» у CSV и TSV; «Fit / 100%» картинки. Поиск ⌘F в PDF — строки полосы поиска
     * терминала (`S.terminal.findPlaceholder`, `previousMatch`, `nextMatch`), × — `S.common.close`.
     */
    code: 'Code',
    preview: 'Preview',
    table: 'Table',
    fit: 'Fit',
    actualSize: '100%',
    imageSize: (width: number, height: number): string => `${width} × ${height} px`,
    rowsTruncated: 'Showing first 10,000 rows',
    columnsTruncated: 'Showing first 200 columns',
    external: 'External',
    readOnlyExternal: 'Read-only: this file is outside the workspace',
  },
};

const russianContextNouns = {
  element: ['элемент', 'элемента', 'элементов'],
  console: ['сообщение консоли', 'сообщения консоли', 'сообщений консоли'],
  request: ['запрос', 'запроса', 'запросов'],
  errors: ['список ошибок', 'списка ошибок', 'списков ошибок'],
  annotations: ['аннотация', 'аннотации', 'аннотаций'],
  mixed: ['объект', 'объекта', 'объектов'],
} as const satisfies Record<ContextKind | 'mixed', readonly [string, string, string]>;

const ru = {
  palette: {
    get placeholder() { return pilotText('palette.placeholder'); },
    splitTitle: 'Открыть в новой группе',
    sections: {
      tabs: 'Вкладки', works: 'Работы', sessions: 'Сессии', rooms: 'Комнаты',
      get actions() { return pilotText('palette.actions'); }, files: 'Файлы',
    },
    openTabs: 'Открытые вкладки', more: (n) => `Ещё ${ruNumber(n)}`,
    createWorkspace: (query) => `Создать работу «${query}»`,
    get footerHints() { return en.palette.footerHints; },
    tabSubtitle: (work) => `Вкладка · ${work}`, roomSubtitle: (work) => `Комната · ${work}`,
    sessionSubtitle: (work, word, provider) => `${work} · ${word} · ${provider}`,
    workSubtitle: (project, sessions, branch) => `${project} · ${sessionCountText(sessions)}${branch === null ? '' : ` · ${branch}`}`,
    get actionSubtitle() { return pilotText('palette.actionSubtitle'); },
  },
  changes: {
    fileStatus: { A: 'Добавлен', M: 'Изменён', D: 'Удалён', R: 'Переименован' },
    loading: 'Загружаем…', commitMessagePlaceholder: 'Сообщение коммита',
    mergeInto: (base) => `Объединить с «${base}»`, discard: 'Отбросить',
    discardAllConfirmTitle: 'Незакоммиченные изменения будут потеряны',
    discardAllConfirm: 'Всё равно отбросить', noChanges: 'Изменений нет', gitMissing: 'Git не найден',
    notARepo: 'В этой папке нет репозитория Git',
    worktreeCorrupt: 'Файл .git рабочего дерева больше не указывает на проект. Git здесь не запускается.',
    merged: (base) => `Объединено с «${base}»`,
    mergeFailed: {
      baseNotCheckedOut: (base) => `Ветка «${base}» нигде не открыта. Переключитесь на неё в папке проекта.`,
      baseDirty: (base) => `В ветке «${base}» есть незакоммиченные изменения. Сделайте коммит или уберите их в stash.`,
      uncommitted: 'В рабочем дереве есть незакоммиченные изменения. Сначала сделайте коммит.',
      conflict: (files) => `Конфликт слияния: ${files}`,
    },
    // Сообщение агенту использует общий исходный шаблон.
    askAgentIntro: en.changes.askAgentIntro, askAgentInstruction: en.changes.askAgentInstruction,
    panel: 'Изменения', headerMenu: 'Действия с изменениями', sessionPicker: 'Сессия',
    noSession: 'Выберите сессию, чтобы увидеть изменения',
    commitCount: (n) => ruCount(n, ['коммит', 'коммита', 'коммитов']),
    projectFolder: (branch) => `${branch ?? 'Отсоединённый HEAD'} (папка проекта)`,
    projectFolderWarning: 'Коммит включит все изменения в папке проекта, в том числе изменения других сессий.',
    worktreePending: 'Рабочее дерево будет создано при запуске сессии', worktreeDiscarded: 'Рабочее дерево удалено',
    sections: { conflicts: 'Конфликты', uncommitted: 'Без коммита', branchChanges: 'Изменения ветки', commits: 'Коммиты ветки' },
    moreUntracked: (n) => `Ещё неотслеживаемых: ${ruNumber(n)}`,
    moreUntrackedHint: 'В списке показана часть неотслеживаемых файлов. В коммит попадут все.',
    commit: 'Создать коммит', commitProject: 'Закоммитить всю папку', askAgent: 'Попросить агента разрешить конфликт',
    commitConfirmTitle: (branch) => `Создать коммит в ветке «${branch}»?`,
    unsavedFiles: (n) => `Несохранённых файлов: ${ruNumber(n)}. Эти правки не попадут в коммит.`,
    saveAllAndCommit: 'Сохранить всё и сделать коммит', commitAnyway: 'Всё равно сделать коммит',
    saveBeforeCommitFailed: 'Не удалось сохранить все файлы. Коммит не создан.',
    mergeConfirmTitle: (branch, base) => `Объединить «${branch}» с «${base}»?`,
    mergeConfirmDescription: (commits, additions, deletions, base, checkout) =>
      `${ruCount(commits, ['коммит', 'коммита', 'коммитов'])}, +${ruNumber(additions)} −${ruNumber(deletions)}. Ветка «${base}» открыта в «${checkout}».`,
    agentStillWorking: 'Агент ещё работает. Изменения могут быть неполными.',
    askAgentTitle: (session) => `Попросить агента «${session}» разрешить конфликты`,
    discardWorktreeEllipsis: 'Удалить рабочее дерево…',
    discardWorktreeTitle: (session) => `Удалить рабочее дерево сессии «${session}»?`,
    discardWorktreeDescription: 'Сессия будет остановлена и закрыта. Папка рабочего дерева и ветка будут удалены.',
    inline: 'В строках', sideBySide: 'Рядом', collapseAll: 'Свернуть всё',
    showMore: (n) => `Показать ещё ${ruNumber(n)}`, expandAll: 'Развернуть всё', wrapLines: 'Переносить строки',
    collapse: 'Свернуть', expand: 'Развернуть', list: 'Список', tree: 'Дерево',
    fileTooLarge: 'Файл больше 1 МБ', showAnyway: 'Всё равно показать',
    copyRemoved: (branch: string): string => `Папка рабочего дерева удалена. Ветка ${branch} сохранена.`,
    branchMergedDeleted: "Ветка слита. Parley удалил её вместе с папкой рабочего дерева.",
    discardBranchDescription: "Сессия закроется, её ветка будет удалена.",
  },
  notes: {
    // Заголовки и разметка письма агенту используют исходные строки.
    header: en.notes.header, file: en.notes.file, line: en.notes.line, lines: en.notes.lines,
    sideOriginal: en.notes.sideOriginal, note: en.notes.note,
    corrupted: (name) => `Заметки сессии повреждены. Копия сохранена как «${name}».`,
    loadFailed: 'Не удалось загрузить заметки. Правки к ним не будут сохранены.',
    saveFailed: 'Не удалось сохранить заметки', chooseRecipient: 'Выбрать получателя', notRunning: 'не запущена',
    add: 'Добавить заметку', placeholder: 'Заметка для агента · ⌘Enter сохраняет', edit: 'Изменить',
    sendFile: 'Отправить заметки к файлу', sendAllUnsent: 'Отправить всё неотправленное',
    sent: (session, time) => `Отправлено в «${session}» · ${time}`, stale: 'Устарело',
    original: (from, to) => from === to ? `Исходник · строка ${ruNumber(from)}` : `Исходник · строки ${ruNumber(from)}–${ruNumber(to)}`,
  },
  links: {
    openInEditor: 'Открыть в редакторе', openInDefaultApp: 'Открыть в приложении по умолчанию',
    openInBrowser: 'Открыть в браузере', openInSystemBrowser: 'Открыть в системном браузере', copyLink: 'Скопировать ссылку',
  },
  tabs: {
    tablist: 'Вкладки', mail: 'Почта',
    diffTitle: (sessionTag, shortHash) => `Изменения ${sessionTag}${shortHash === null ? '' : ` · ${shortHash}`}`,
    openTab: 'Открыть…', noOpenTabs: 'Нет открытых вкладок',
    emptyGroup: 'Откройте сессию в боковой панели или найдите её в палитре ⌘J.',
    closedToast: 'Вкладка закрыта. ⌘⇧T откроет её снова.', tooSmall: 'Места для ещё одной группы не хватает',
    tooManyGroups: 'В одной работе может быть не более 8 групп', missingSession: 'Сессия удалена', missingRoom: 'Комната удалена',
    closeOthers: 'Закрыть остальные', closeToRight: 'Закрыть справа', unsaved: 'Несохранённые изменения',
    fileWithRoot: (name, root) => `${name} · ${root}`,
    board: "Доска",
  },
  browser: {
    newTab: 'Новая вкладка', address: 'Адрес', notAnAddress: 'Введите адрес. Поиск здесь недоступен.',
    localFile: 'Локальные файлы здесь не открываются', reload: 'Обновить', stop: 'Остановить',
    pageCrashed: 'Страница аварийно завершилась', loadFailed: 'Не удалось загрузить страницу',
    tooManyTabs: 'В одной работе может быть не более 10 вкладок браузера',
    select: { button: 'Выбрать', title: 'Выбрать элемент · ⇧ и клик продолжают выбор (⌘⇧C)' },
    annotate: {
      button: 'Аннотация', title: 'Добавить аннотацию · нажмите элемент или выделите область (⌘⌥A)',
      tray: (count) => ruCount(count, ['аннотация', 'аннотации', 'аннотаций']),
      region: (width, height) => `Область ${ruNumber(width)} × ${ruNumber(height)}`,
      gone: 'элемент исчез', noComment: 'Без комментария',
      comment: (n) => `Комментарий к аннотации ${ruNumber(n)}`, placeholder: 'Что здесь нужно исправить?',
      save: 'Сохранить', delete: 'Удалить', edit: (n) => `Изменить аннотацию ${ruNumber(n)}`,
      remove: (n) => `Удалить аннотацию ${ruNumber(n)}`, clear: 'Очистить', addToChat: 'Добавить в чат',
      collapse: 'Скрыть аннотации', expand: 'Показать аннотации',
      limit: 'Можно добавить до 20 аннотаций. Сначала перенесите текущие в чат или удалите их.',
    },
    target: {
      button: (name) => `Кому: ${name}`, noTarget: 'Кому: —', choose: 'Куда отправится контекст страницы',
      sessions: 'Сессии', rooms: 'Комнаты', chat: 'чат', terminal: 'терминал',
      added: (count, kind, target) => `Добавлено: ${ruCount(count, russianContextNouns[kind])} · «${target}»`,
      open: 'Открыть', undo: 'Отменить', nowhere: 'Нет сессии или комнаты для отправки контекста страницы',
      fellBack: (name) => `Выбранная сессия или комната исчезла. Контекст страницы теперь отправляется в «${name}».`,
      fellBackNowhere: 'Выбранная сессия или комната исчезла. Других получателей нет.',
    },
    devtools: {
      toggle: 'Консоль и сеть', console: 'Консоль', network: 'Сеть', more: 'Другие действия браузера',
      openFull: 'Открыть DevTools', clearAll: 'Очистить консоль и сетевые запросы', preserveLog: 'Сохранять журнал',
      clear: 'Очистить', close: 'Закрыть панель', resize: 'Изменить размер панели',
      levels: { error: 'Ошибки', warning: 'Предупреждения', info: 'Информация', debug: 'Отладка' },
      filterConsole: 'Фильтр', filterUrl: 'Фильтр URL',
      kinds: { all: 'Все', fetch: en.browser.devtools.kinds.fetch, doc: 'Документ', js: en.browser.devtools.kinds.js, css: en.browser.devtools.kinds.css, img: 'Изображение', other: 'Прочее' },
      failedOnly: 'Только сбои', errors: (count) => ruCount(count, ['ошибка', 'ошибки', 'ошибок']),
      warnings: (count) => ruCount(count, ['предупреждение', 'предупреждения', 'предупреждений']),
      repeated: (count) => `×${ruNumber(count)}`,
      expand: 'Показать стек', collapse: 'Скрыть стек',
      addToChat: 'Добавить в чат', addErrorsToChat: 'Добавить ошибки в чат',
      navigatedTo: (url) => `Переход на ${url}`, navigated: 'Переход на новую страницу',
      empty: 'Сообщений нет', emptyNetwork: 'Запросов нет',
      late: 'Обновите страницу, чтобы записать ранние запросы',
      unavailable: 'Запись недоступна. Обновите страницу.',
      columns: { status: 'Статус', method: 'Метод', name: 'Имя', type: 'Тип', size: 'Размер', time: 'Время' },
      status: { cors: en.browser.devtools.status.cors, blocked: 'заблокировано', failed: 'сбой', canceled: '(отменено)', pending: '(ожидает)' },
      fromCache: '(из кеша)',
      bytes: (bytes) => bytes < 1_024 ? `${ruNumber(bytes)} Б`
        : bytes < 1_048_576 ? `${ruNumber(bytes / 1_024, { maximumFractionDigits: 1 })} КБ`
          : `${ruNumber(bytes / 1_048_576, { maximumFractionDigits: 1 })} МБ`,
      ms: (ms) => ms < 1_000 ? `${ruNumber(ms)} мс` : `${ruNumber(ms / 1_000, { maximumFractionDigits: 2 })} с`,
      details: {
        headers: 'Заголовки', payload: 'Данные запроса', response: 'Ответ', general: 'Общее',
        responseHeaders: 'Заголовки ответа', requestHeaders: 'Заголовки запроса', url: en.browser.devtools.details.url,
        method: 'Метод', status: 'Статус', remoteAddress: 'Удалённый адрес', query: 'Параметры запроса', body: 'Тело запроса',
        noPayload: 'Данных запроса нет', loadResponse: 'Загрузить ответ', loading: 'Загружаем…', bodyGone: 'Тело ответа больше недоступно',
        truncated: (limit) => `Показано начало (${limit})`,
        binary: (size, type) => `Двоичные данные, ${size}${type === '' ? '' : `, ${type}`}`,
        copyUrl: 'Скопировать URL', close: 'Закрыть подробности',
      },
    },
    viewport: {
      menu: 'Размер области просмотра', fit: 'По размеру окна',
      presets: {
        'mobile-s': 'Телефон S', 'mobile-m': 'Телефон M', 'mobile-l': 'Телефон L',
        tablet: 'Планшет', laptop: 'Ноутбук', desktop: 'Компьютер',
      },
      size: (width, height) => `${ruNumber(width)}×${ruNumber(height)}`, custom: 'Свой размер…', rotate: 'Повернуть',
      dpr: (dpr) => `${ruNumber(dpr)}×`, width: 'Ширина', height: 'Высота', apply: 'Применить',
      customRange: (min, maxWidth, maxHeight) => `Ширина ${ruNumber(min)}–${ruNumber(maxWidth)}, высота ${ruNumber(min)}–${ruNumber(maxHeight)}`,
      label: (width, height, dpr, percent) =>
        `${ruNumber(width)} × ${ruNumber(height)} · ${ruNumber(dpr)}×${percent === null ? '' : ` · ${ruNumber(percent)}%`}`,
      touchReload: 'Обновите страницу, чтобы включить сенсорное управление',
    },
    panel: {
      toggle: 'Браузер', toggleTitle: 'Показать или скрыть панель браузера', pages: 'Страницы браузера',
      newPage: 'Новая страница', addPage: 'Добавить страницу', closePage: (title) => `Закрыть «${title}»`,
      closePanel: 'Закрыть панель браузера', backToChat: 'Вернуться в чат', backToRoom: 'Вернуться в комнату',
      resize: 'Изменить размер панели браузера', tooManyPages: 'На панели браузера может быть не более 5 страниц',
      moveTo: 'Перенести в браузер…', moved: (name) => `Перенесено в браузер «${name}»`,
      agentOpened: (session, address) => `Агент «${session}» открыл ${address}`,
      agentShow: 'Показать', pauseAgents: 'Приостановить агентов', resumeAgents: 'Возобновить агентов',
      agentCapture: (width, height) => `Снимок агента ${ruNumber(width)}×${ruNumber(height)}`,
      agentActing: (session) => `Агент «${session}» использует эту страницу`,
      agentStop: 'Остановить', agentStopHint: 'Остановить агента и приостановить работу агентов в этом браузере',
      agentRecent: (recent) => `Последние действия: ${recent.join(', ')}`,
    },
    auth: {
      title: "Войти",
      proxyTitle: "Вход на прокси-сервер",
      proxy: "Прокси",
      requiredBy: (host: string): string => `Для ${host} нужны имя пользователя и пароль`,
      realm: (realm: string): string => `Область доступа: ${realm}`,
      username: "Имя пользователя",
      password: "Пароль",
      signIn: "Войти",
      cancel: "Отмена",
      wrong: "Неверное имя пользователя или пароль. Повторите попытку.",
      sendFailed: "Не удалось отправить данные для входа. Повторите попытку или нажмите «Отмена».",
    },
    cert: {
      title: (host: string): string => `${host} запрашивает сертификат для подтверждения вашей личности.`,
      requestedBy: (pageHost: string): string => `Запрос со страницы ${pageHost}.`,
      issuer: (name: string): string => `Кем выдан: ${name}`,
      expires: (date: string): string => `Действителен до ${date}`,
      serial: (serial: string): string => `Серийный номер ${serial}`,
      remember: "Запомнить для этого сайта. Агенты в браузере Parley также будут использовать этот сертификат.",
      keyAccess: "macOS может запросить доступ к ключу. Выберите «Разрешать всегда», иначе агенты остановятся на этом диалоге.",
      use: "Использовать сертификат",
      notNow: "Не сейчас",
      sendFailed: "Не удалось отправить выбор. Повторите попытку или нажмите «Отмена».",
    },
  },
  files: {
    denied: 'Путь находится за пределами папок работы',
    revealedInFinder: 'Файл этого типа открыт в Finder', panel: 'Файлы', project: 'Проект',
    worktreeRoot: (tag, branch) => `⎇ ${tag} · ${branch}`, rootGone: 'Папки сессии больше нет',
    refresh: 'Обновить', showIgnored: 'Показать игнорируемые файлы', copyRelativePath: 'Скопировать относительный путь',
    saveChanges: (name) => `Сохранить изменения в «${name}»?`, save: 'Сохранить', dontSave: 'Не сохранять',
    saveChangesCount: (count) => `Сохранить изменения? Файлов: ${ruNumber(count)}.`,
    saveAll: 'Сохранить всё', saveAllFailed: 'Не удалось сохранить все файлы. Окно остаётся открытым.',
    workDeleted: (title, count) => `Работа «${title}» удалена. Файлов с несохранёнными изменениями: ${ruNumber(count)}.`,
    discard: 'Отбросить', notSaved: (names) => `Не удалось сохранить: ${names}`,
    unresponsive: 'Parley не отвечает. Несохранённые изменения могут быть потеряны.',
    quitAnyway: 'Всё равно выйти', wait: 'Подождать', readOnlyTooLarge: 'Большой файл. Правка отключена.',
    readOnlyNotUtf8: 'Файл не в UTF-8. Правка отключена.', tooLarge: 'Файл больше 20 МБ', binary: 'Двоичный файл',
    notFound: 'Файл не найден', editorFailed: 'Редактор не загрузился', reloadedFromDisk: 'Загружено с диска',
    changedOnDisk: 'Файл изменился на диске, возможно, его изменил агент', deletedOnDisk: 'Файл удалён с диска',
    reload: 'Перезагрузить', compare: 'Сравнить', keepMine: 'Оставить мои правки', saveAgain: 'Сохранить снова',
    overwrite: 'Перезаписать', overwriteQuestion: 'Файл изменился на диске после открытия. Перезаписать изменения на диске?',
    searchPlaceholder: 'Поиск в файлах', matchWholeWord: 'Только целые слова',
    truncated: (n) => `Показаны первые совпадения: ${ruNumber(n)}`,
    filesTruncated: (n) => `Показаны первые файлы: ${ruNumber(n)}`, refineQuery: 'Уточните запрос',
    noFiles: 'Подходящих файлов нет', loadingFiles: 'Загружаем файлы…', invalidRegex: 'Некорректное регулярное выражение',
    noResults: 'Совпадений нет', searching: 'Ищем…', posixRegex: 'Выражения POSIX',
    posixRegexHint: 'В Git на этом компьютере нет PCRE. Используйте [0-9], [[:alnum:]_] и [[:space:]] вместо \\d, \\w и \\s.',
    code: 'Код', preview: 'Просмотр', table: 'Таблица', fit: 'Вписать', actualSize: en.files.actualSize,
    imageSize: (width, height) => `${ruNumber(width)} × ${ruNumber(height)} пикс.`,
    rowsTruncated: 'Показаны первые 10 000 строк', columnsTruncated: 'Показаны первые 200 столбцов',
    external: "Внешний",
    readOnlyExternal: "Только для чтения: файл вне рабочей области",
  },
} satisfies LocalizedMessages<typeof en>;

export const toolsStrings = { en, ru };
