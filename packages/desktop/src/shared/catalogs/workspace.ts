import type { NeedKind } from '@parley/core';
import { STATE_WORDS } from '@parley/core/session-state';
import { appI18n } from '../app-locale.js';
import { ruCount, ruNumber, type LocalizedMessages } from './desktop-messages.js';
import { pilotText, sessionCountText } from './session-pilot.js';

const en = {
  recipeMode: 'Mode',
  time: {
    now: 'now',
    yesterday: 'yesterday',
    minutes: (n: number): string => `${n}m`,
    hours: (n: number): string => `${n}h`,
    /** `3h` → `3h ago` во фразе «last event …» (`lib/relative-time.ts#relativeTimeAgo`). */
    ago: (relative: string): string => `${relative} ago`,
  },
  /** Общие подписи кнопок, переиспользуемые в нескольких диалогах. */
  common: {
    cancel: 'Cancel',
    close: 'Close',
    delete: 'Delete',
    done: 'Done',
    retry: 'Retry',
    copy: 'Copy',
    send: 'Send',
  },

  /** Очередь отправки окна (спека 2026-10-16, 4): серые элементы Chat и комнаты. */
  outbox: {
    sending: 'Sending…',
    waiting: 'Waiting',
    sendNow: 'Send now',
    notSent: 'Not sent',
    remove: 'Remove',
  },

  /**
   * Девять слов состояния сессии (спека 4.2): таблица живёт в core по решению о паритете статусов —
   * одна для окна, помощника и брифа агентов. Строчными — так их пишет строка сессии
   * (спека окна 2026-09-29, 1.2): `working`, `needs you`, `done · unseen`…; те же слова — имена
   * значков для скринридера и слово итога в тултипе.
   */
  states: STATE_WORDS,

  /**
   * Чего сессия ждёт от человека — `SessionNeed` (спека застрявших 7.3, спека подписок 7). Слова видов (`approval`,
   * `limit`, `starting`…) живут в core (`needWord`, `@parley/core/session-state`) и приходят параметром `word`; здесь —
   * только обрамление вокруг них (`attention/derive.ts` собирает слово, время и обрамление вместе).
   */
  need: {
    /** Метка с временем сброса лимита: `limit · 19:27`, не сегодня — `limit · Oct 14, 19:27`. */
    withTime: (word: string, when: string): string => `${word} · ${when}`,
    /** Метка лимита, время сброса которого прошло. */
    reset: (word: string): string => `${word} · reset`,
    /** Подсказка метки: чего ждёт сессия (`detail` добавляется после двоеточия). */
    lead: {
      approval: (word: string): string => `Waiting for ${word}`,
      question: (word: string): string => `Has a ${word}`,
      limit: (word: string): string => `Usage ${word} reached`,
      'sign-in': (word: string): string => `Needs ${word}`,
      startup: (word: string): string => `Waiting while ${word}`,
    } satisfies Record<NeedKind, (word: string) => string>,
    /** Вместо `lead['sign-in']`, когда проблема в аккаунте или оплате (`account: 'account'`), а не во входе. */
    accountLead: 'Account problem',
    withDetail: (lead: string, detail: string): string => `${lead}: ${detail}`,
    /** Уведомление о лимите (спека застрявших 7.1): один заголовок на аккаунт, `provider` — его имя (`providerName`). */
    limitTitle: (provider: string): string => `${provider} usage limit reached`,
    /**
     * Тело уведомления о лимите: ярлыки ждущих сессий этого аккаунта и до какого часа. Часа нет — сброс неизвестен.
     * `tags` — `S01, S03`; число решает глагол.
     */
    limitBody: (tags: readonly string[], until: string | null): string => {
      const who = tags.join(', ');
      if (until === null) return `${who} ${tags.length === 1 ? 'waits' : 'wait'} for the limit reset (time unknown)`;
      return `${who} ${tags.length === 1 ? 'waits' : 'wait'} until ${until}`;
    },
    /** Хвост тела уведомления для сессии в комнате (спека застрявших 7.1): `· room Backend`. */
    inRoom: (room: string): string => `· room ${room}`,
    /** Текст строки доставки под сообщением, когда письмо не забрано из-за застрявшей сессии (`MailWait` `stuck`). */
    mail: {
      approval: (word: string): string => `waiting for your ${word}`,
      question: (word: string): string => `asked you a ${word}`,
      limit: (word: string): string => `usage ${word}`,
      limitUntil: (word: string, when: string): string => `usage ${word} until ${when}`,
      limitReset: (word: string): string => `usage ${word} has reset`,
      signedOut: 'signed out',
      /** Вместо `signedOut`, когда проблема в аккаунте или оплате (`account: 'account'`), а не во входе (`needReason`: «Account problem in …»). */
      accountProblem: 'account problem',
      startup: 'waiting at startup',
    },
    continueOn: 'Continue on…',
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
    get addWorkspace(): string { return pilotText('sidebar.addWorkspace'); },
    /** Заголовок секции закреплённых работ (спека 6.1). */
    get pinned(): string { return pilotText('sidebar.pinned'); },
    /** Верх сайдбара — палитра; подпись ⌘J (кусок 6.1b), прежняя палитра до 6.2. */
    get search(): string { return pilotText('sidebar.search'); },
    /** `aria-label` и тултип «+» заголовка проекта: проект называется (спека окна 2026-09-29, 1.2). */
    newWorkspaceInProject: (project: string): string => `New workspace in ${project}`,
    sessionCount: sessionCountText,
    hideClosed: 'Hide closed',
    /** Ссылка под строками карточки: архивные комнаты работы спрятаны под ней; «Hide archived rooms» прячет раскрытые. */
    archivedRooms: 'Archived rooms',
    hideArchivedRooms: 'Hide archived rooms',
    /** Ссылка внизу группы проекта: архивные работы проекта спрятаны под ней; «Hide archived» прячет раскрытые. */
    archivedWorks: (n: number): string => `${n} archived`,
    hideArchivedWorks: 'Hide archived',
    /** Пункт меню «⋯» проекта: убрать проект из списка (ничего не удаляет), `ui.json.hiddenProjects`. */
    removeFromList: 'Remove from list…',
    /** Тултип выключенного пункта: у проекта ещё есть неархивные работы. */
    removeFromListBlocked: 'Archive its workspaces first',
    removeProjectTitle: (folder: string): string => `Remove "${folder}" from the list?`,
    removeProjectDescription: 'Its workspaces stay on disk. The project comes back when a workspace is created in it.',
    removeProjectConfirm: 'Remove',
    /** Тултип `✉N` карточки: непрочитанные человеком письма работы. */
    unreadMail: (n: number): string => (n === 1 ? '1 unread message to you' : `${n} unread messages to you`),
    /** Тултип `#N` карточки: комнаты с непрочитанным сообщением. */
    roomsWithUnread: (n: number): string => (n === 1 ? '1 room with unread messages' : `${n} rooms with unread messages`),
    /** Тултип значка ветки в строке сессии со своим worktree; ветка — данные, идёт как есть. */
    ownWorktree: (branch: string, base: string): string => `Own worktree · ${branch} ← ${base}`,
    trustWaitTooltip: 'Not responding since launch — may be waiting for folder trust',
    /** Тултип ⚠ строки сессии Codex, что за срок после запуска не показала статус: вход или доверие к папке — за человеком. */
    startupWaitTooltip: 'Waiting at startup — Codex may need sign-in or folder trust in its terminal',
    /** Тултип и `aria-label` мигающего значка письма в строке сессии: агенту пришли письма, он их ещё не прочёл. */
    agentUnread: 'Has new messages',
    /** Переключатель меню «⋯» заголовка секции (спека 6.1, кусок 3.4). */
    showDone: 'Show done',
    /** `aria-label` кнопки «⋯» заголовка секции. */
    sectionMenu: 'Section options',
    openParleyMd: 'Open PARLEY.md',
    createParleyMd: 'Create PARLEY.md',
    parleyMdCreated: 'Parley added PARLEY.md — team rules for your agents',
    parleyMdOpen: 'Open',
    /** `aria-label` кнопки `#`/`#N` карточки — меню комнат работы (спека 6.3). */
    roomsMenu: 'Rooms',
    /** `aria-label` поля переименования на месте (спека 6.4). */
    renameField: 'Workspace name',
    /** `aria-label` того же поля в строке комнаты (`RoomRowMenu` → «Rename»). */
    roomRenameField: 'Room name',
    /** `aria-label` того же поля в строке сессии (`SessionRowMenu` → «Rename»). */
    sessionRenameField: 'Session name',
    /** aria-label списка карточек — дерево «работа → сессии» для клавиатуры (спека 6.5). */
    get workspaceList(): string { return pilotText('sidebar.workspaceList'); },
    /** Шеврон строки комнаты (спека окна 2026-09-29, 1.2) — `sidebar/RoomRow.tsx`. */
    showAgents: 'Show agents',
    hideAgents: 'Hide agents',
    /** Слово строки комнаты, пока решение ждёт человека; `{n} new` — сообщения комнаты, не прочитанные человеком. */
    roomDecision: 'decision',
    /** Слово строки комнаты, где человека назвали (`@human`): `@you · {n} new`, `n` — все непрочитанные сообщения комнаты. */
    roomMentioned: '@you',
    /** Тултип значка провайдера свёрнутой комнаты: `2 Claude Code agents`; имя провайдера — `providerName`. */
    roomAgents: (n: number, provider: string): string => `${n} ${provider} ${n === 1 ? 'agent' : 'agents'}`,
    /** Тултип `★` у ведущего в строке участника развёрнутой комнаты. */
    lead: 'Lead',
    /**
     * Тултип строки комнаты: `Room · lead S01 · S01, S02, S03, S04`. Ведущего нет (в комнате не осталось
     * живых участников) — без его части; участники — короткие номера сессий.
     */
    roomTooltip: (lead: string | null, members: readonly string[]): string =>
      ['Room', ...(lead === null ? [] : [`lead ${lead}`]), ...(members.length === 0 ? [] : [members.join(', ')])].join(' · '),
    /** Строка под строками активной карточки: открывает диалог «New session or room» (⌘T); «+» рисует значок. */
    get newSessionOrRoom(): string { return pilotText('action.newSession'); },
    /** «Couldn't <действие>: …» тоста, когда бросок сессии на строку комнаты (`rooms.addMember`) не удался. */
    addToRoomAction: 'add the session to the room',
    sessionMenu: {
      open: 'Open',
      /** Первый пункт меню: поле на месте ярлыка, `sessions.rename` (спека архива комнат, часть 2, 15). */
      rename: 'Rename',
      /** Кусок 3.4: сплит вправо с вкладкой терминала сессии. */
      openBeside: 'Open to the side',
      /** Кусок 3.4: только у сессии со своим worktree. */
      copyWorktreePath: 'Copy worktree path',
      resume: 'Resume',
      stop: 'Stop',
      closeEllipsis: 'Close…',
      changes: 'Changes',
      stopConfirmTitle: (label: string): string => `Stop "${label}"?`,
      closeConfirmTitle: (label: string): string => `Close "${label}"?`,
      closeConfirmDescription: 'Session will no longer receive mail',
      deleteConfirmTitle: (label: string): string => `Delete "${label}"?`,
      /** Участник развёрнутой комнаты, не ведущий и не закрытый: `rooms.setLead`. */
      makeLead: 'Make lead',
      keepAwake: 'Keep awake',
      continueElsewhere: 'Continue on another provider…',
    },
    /** Меню строки комнаты по правой кнопке — `sidebar/RoomRowMenu.tsx`. */
    roomMenu: {
      assignOwner: 'Assign owner',
      changeOwner: 'Change owner',
      ownerLabel: (name: string): string => `${name} · Owner`,
      clearOwner: 'Clear owner',
      ownerChangeFailed: 'Could not change the room owner.',
      rename: 'Rename',
      archiveEllipsis: 'Archive…',
      /** Пункт меню архивной комнаты и кнопка подтверждения архивации. */
      reopen: 'Reopen',
      archive: 'Archive',
      archiveConfirmTitle: (title: string): string => `Archive room "${title}"?`,
      archiveConfirmDescription:
        'The room moves under "archived rooms" at the bottom of the workspace. Its feed stays readable; nobody can write to it until you reopen it.',
      /** Дополнение к описанию, когда у комнаты ждёт ответа решение и/или идёт живой план: архивация их закрывает. */
      archiveConfirmOpenWork: (decision: boolean, plan: boolean): string =>
        decision && plan
          ? ' Its pending decision will be dismissed and its plan cancelled.'
          : decision
            ? ' Its pending decision will be dismissed.'
            : ' Its plan will be cancelled.',
      /** Флажок подтверждения, включён по умолчанию: остановить агентов, у которых нет другой открытой комнаты. Остановка обратима. */
      archiveStopAgents: (n: number): string => `Also stop its ${n} ${n === 1 ? 'agent that is' : 'agents that are'} in no other room`,
      deleteEllipsis: 'Delete…',
      deleteConfirmTitle: (title: string): string => `Delete room "${title}"?`,
      deleteConfirmDescription: 'The room and its feed will be deleted. Its sessions keep running as regular sessions of the workspace.',
      /** Флажок подтверждения, снят по умолчанию: удалить и сессии комнаты, как пункт «Delete» строки сессии. */
      deleteSessions: (n: number): string => `Also delete its ${n} ${n === 1 ? 'session' : 'sessions'}`,
    },
    closedSessions: 'Closed sessions',
    archivedWork: 'Archived',
    asleepSession: 'Asleep',
    autoSleepTooltip: 'Asleep to free memory. A message or Resume wakes it.',
    queuedTooltip: 'Waiting for a free agent slot on this machine. It starts by itself when a slot frees.',
    providerRemoved: 'Provider removed',
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
    archiveConfirmDescription: 'Running agents will be stopped. Find it under "archived" at the bottom of its project, then "Reopen" it to resume them.',
    deleteConfirmTitle: (title: string): string => `Delete "${title}"?`,
    deleteConfirmDescription: (sessions: number): string =>
      `${sessions === 1 ? '1 session' : `${sessions} sessions`} will be deleted. Running agents will be stopped.`,
    closeFinished: 'Agents close finished sessions',
    closeFinishedHint: "Agents in this workspace close their own sessions once their part is accepted, and a room lead closes the room's finished members. Sessions you start yourself still wait for you.",
  },

  /** Общие диалоги, не привязанные к своей области (mail/rooms/settings/…). */
  dialogs: {
    /** Название комнаты, если человек его не ввёл (диалоги 1.5 и 1.6, 2.1): по числу комнат работы. */
    defaultRoomTitle: (n: number): string => `Room ${n}`,
    /**
     * Диалог «New session or room» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.5) —
     * `components/dialogs/NewSessionOrRoomDialog.tsx`: один агент — сессия, два и больше — комната с ведущим или, при
     * выключенном «Put them in a room», отдельные сессии.
     */
    newSession: {
      get roleField(): string { return pilotText('dialog.role'); },
      get noRole(): string { return pilotText('dialog.noRole'); },
      get titleSession(): string { return pilotText('dialog.title'); },
      titleRoom: 'New room',
      titleSessions: 'New sessions',
      get hintSession(): string { return pilotText('dialog.hint'); },
      hintSessions: 'Each agent starts as its own session in the workspace, with no room.',
      hintRoom: 'The agents discuss the task you write in the room. The lead brings you a decision.',
      get workspaceField(): string { return pilotText('dialog.workspace'); },
      /** Пункт списка работ: название работы и папка проекта — данные, идут как есть. */
      workspaceOption: (title: string, project: string): string => `${title} · ${project}`,
      get noWorkspaces(): string { return pilotText('dialog.noWorkspaces'); },
      get sessionNameField(): string { return pilotText('dialog.sessionName'); },
      get sessionNamePlaceholder(): string { return pilotText('dialog.namePlaceholder'); },
      roomNameField: 'Room name',
      roomNamePlaceholder: 'What the agents will discuss',
      get agentsField(): string { return pilotText('dialog.agents'); },
      /** Имя для скринридера группы провайдеров одной строки агента: `Agent 2`. */
      agentGroup: (n: number): string => pilotText('dialog.agentGroup', { number: appI18n.formatNumber(n) }),
      get modelField(): string { return pilotText('dialog.model'); },
      /** Первый пункт списка моделей: без флага `--model`, модель CLI по умолчанию (решение 5). */
      get modelDefault(): string { return pilotText('dialog.default'); },
      get effortField(): string { return pilotText('dialog.effort'); },
      /** Первый пункт списка уровней: без флага `--effort` — CLI берёт уровень, сохранённый у себя (нормалайзер 2026-10-06). */
      get effortDefault(): string { return pilotText('dialog.default'); },
      /** Прежние три уровня: старый хост и свои списки без уровней (`LEGACY_EFFORTS`, `lib/effort-choices.ts`). */
      effortLow: 'Low',
      effortMedium: 'Medium',
      effortHigh: 'High',
      /** Тултип звезды: `Lead` у ведущего, `Make lead` у прочих. */
      lead: 'Lead',
      makeLead: 'Make lead',
      removeAgent: 'Remove agent',
      get addAgent(): string { return pilotText('dialog.addAgent'); },
      get inOwnWorktree(): string { return pilotText('dialog.worktree'); },
      /** Переключатель при двух агентах и больше: включён — комната, выключен — отдельные сессии. */
      putInRoom: 'Put them in a room',
      /** Одиночная сессия человека по умолчанию не lean; участники комнаты берут настройку `leanAgents`. */
      get leanSession(): string { return pilotText('dialog.lean'); },
      /** Знак «?» у поля: имя кнопки для скринридера — `About Mode`; текст подсказки — в `hints`. */
      hintLabel: (field: string): string => pilotText('dialog.aboutField', { field }),
      /** Подсказки полей диалога по наведению на «?»: что это за поле, без деталей реализации. */
      hints: {
        recipe: 'A saved room setup: roles, providers, models, the mode, worktrees and the lead, plus a playbook that only the lead gets. Built-in recipes and your own from .parley/recipes. Everything it fills stays editable.',
        workspace: 'The workspace the new agents join. A workspace is one task in a project: its sessions and rooms share one map and know about each other.',
        roomName: 'The room’s title in the sidebar and on its tab. If empty, the room is called “Room 1”, “Room 2” and so on.',
        sessionName: 'The session’s name in the sidebar and on its tab. If empty, the session gets a name by its number — Ralph, Anatoly, Ruslan and so on. Rename it any time from its menu.',
        agents: 'One agent starts a session; two or more make a room, or separate sessions if you switch “Put them in a room” off.\nRole — optional ready-made instructions with a default provider, model and effort; what you pick in the row wins. Builtin roles come with Parley; “·\u00A0Claude” and “·\u00A0Codex” are your own agents from that CLI and run only there.\n🔒 — a read-only role: the CLI does not let the agent edit files.\nModel and effort — which model runs and how hard it thinks; Default keeps the CLI’s own setting.\nIn a room, ★ picks the lead, who collects the positions and brings you the decision; the branch icon gives one agent its own worktree.',
        putInRoom: 'On: the agents discuss your task in one room and the lead brings you a decision. Off: each agent works as its own session.',
        worktree: 'Each agent works in its own Git worktree: a separate folder on a new branch, so agents do not overwrite each other’s edits. You review and merge the work in the Changes tab. Needs a Git repository.',
        leanSession: 'Starts the agent without your plugins, other MCP servers and auto-memory — about a third less context per turn on Claude Code. Parley’s own tools and hooks, your skills and the project CLAUDE.md stay. Other MCP servers are not connected to lean sessions. The box starts from Settings → Agents → “Lean agent sessions”; agents of a room always follow that setting.',
        /** Перед строками режимов — `S.plans.modes` и `S.plans.modeHelp`, те же, что в панели плана комнаты. */
        mode: 'How the room tracks the work. You can change it later in the room.',
      },
      summarySession: (work: string): string => pilotText('dialog.summary', { work }),
      summaryRoom: (agents: number, work: string): string => `Room with ${agents} agents in ${work}`,
      summarySessions: (agents: number, work: string): string => `${agents} separate sessions in ${work}`,
      /** Выбран рецепт или режим, а комнаты не будет: переключатель выключен. */
      separateDropsRecipe: 'A recipe and a mode apply to rooms. With “Put them in a room” off this starts separate sessions without them.',
      get cancel(): string { return pilotText('dialog.cancel'); },
      get submitSession(): string { return pilotText('dialog.start'); },
      submitSessions: 'Start sessions',
      submitRoom: 'Create room',
      selectWorkRequired: 'No workspace selected',
      providerUnavailable: (name: string): string => `${name} is unavailable. Connect it or choose another agent.`,
      /** Итог запуска по агенту при частичном сбое; тег — короткий номер сессии `S05`. */
      agentStarted: (tag: string): string => `${tag} started`,
      /** Бюджет работы (P37): строка в подвале — что занято и сколько запусков осталось в часе. */
      budgetLine: (running: number, limit: number, startsLeft: number): string =>
        pilotText('dialog.budget', {
          running: appI18n.formatNumber(running), limit: appI18n.formatNumber(limit), startsLeft: appI18n.formatNumber(startsLeft),
        }),
      /** Старт не поместится: нужно столько-то слотов, осталось меньше; кнопка неактивна, расширяет лимит человек. */
      budgetBlockedSlots: (needed: number, remaining: number): string =>
        `This start needs ${needed} session slots, ${remaining} left. Stop a session or raise the limits in Settings → Agents.`,
      budgetBlockedStarts: (needed: number, remaining: number): string =>
        `This start needs ${needed} launches, ${remaining} left this hour. Wait or raise the limits in Settings → Agents.`,
      budgetBlockedRoom: (needed: number, limit: number): string =>
        `A room runs at most ${limit} sessions at once; this one has ${needed}. Remove an agent or raise the limit in Settings → Agents.`,
      modelTyped: 'Model id (empty: Default)',
    },
    /** Диалог «New room» из двух сессий (1.6) — `components/dialogs/MergeRoomDialog.tsx`. */
    mergeRoom: {
      title: 'New room',
      /** `S02 бэкенд and S03 ревью move into the room.` — ярлыки сессий идут как есть. */
      movingInto: (first: string, second: string): string => `${first} and ${second} move into the room.`,
      nameField: 'Name',
      namePlaceholder: 'What the agents will discuss',
      leadField: 'Lead',
      submit: 'Create room',
    },
    /**
     * Диалог «New workspace» (1.7) — `sidebar/NewWorkComposer.tsx` (спека Orca-UI 6.6 — поведение, 1.7 — поля): работа и,
     * по желанию, агенты в ней (строки — как в «New session or room», тексты — `newSession`).
     */
    newWork: {
      title: 'New workspace',
      chooseFolder: 'Choose a folder…',
      titleField: 'Title',
      titlePlaceholder: 'Taken from the first prompt if empty',
      /** Агентов нет — первого промпта нет, название обязательно. */
      titlePlaceholderRequired: 'Name the workspace',
      promptField: 'First prompt',
      promptPlaceholder: 'What should the agent do?',
      submit: 'Create workspace',
      selectFolderRequired: 'Select a project folder',
      projectField: 'Project',
      titleLength: 'Title: 1–120 characters',
      /** Ни названия, ни первого промпта: названию не из чего взяться. */
      titleOrPromptRequired: 'Enter a title or a first prompt',
      /** Агентов нет — первого промпта тоже, и названию не из чего взяться. */
      titleRequired: 'Enter a title',
      /** Комната создана, а первый промпт в неё не ушёл: «Retry» повторяет только его. */
      firstPromptNotSent: 'The room is ready, but the first prompt was not sent.',
      promptTooLong: 'First prompt: up to 20,000 characters',
      agentRequired: 'Select an agent',
    },
    /**
     * Диалог «Trust <папка> for agents?» (спека 2026-10-21, 4.2) — `components/dialogs/TrustFolderDialog.tsx`: в композере
     * новой работы и по карточке согласия, которую хост держит за запуск Codex (`ConsentPrompt`).
     */
    trustFolder: {
      title: (folder: string): string => `Trust ${folder} for agents?`,
      /** Кто просил (карточка согласия): «S03 Ruslan · create_session». */
      requestedBy: (who: string): string => `Requested by ${who}.`,
      body:
        "Codex in this folder and its worktrees starts without its own trust screen, gets write access to the working folder (workspace-write) and runs the repository's own .codex/ configuration — config, hooks, rules and MCP servers. The consent lasts until you revoke it in Settings → Projects. For Claude Code nothing changes yet.",
      confirm: 'Trust',
      /** Чем запуск попал в карточку: `agent` — `create_session` агента. */
      via: { agent: 'create_session', resume: 'resume', launch: 'launch' },
    },
    /**
     * Снимок работ не принёс созданное за 10 с — вкладка не открыта вслепую (`lib/open-when-listed.ts`):
     * по виду того, что создали.
     */
    notListedYet: {
      work: 'Workspace created — it will appear in the sidebar shortly',
      session: 'Session started — it will appear in the sidebar shortly',
      room: 'Room created — it will appear in the sidebar shortly',
    },
    switchAgent: {
      title: 'Continue on another provider',
      description: (label: string): string => `${label} keeps its place in Parley; only the agent behind it changes.`,
      loading: 'Loading providers…',
      targetGroup: 'Provider',
      modelField: 'Model',
      modelDefault: 'Default',
      effortField: 'Effort',
      effortDefault: 'Default',
      carryField: 'Carry',
      carryHandover: 'Handover summary (any provider)',
      carryTranscript: 'Continue the conversation (same Claude account family)',
      transcriptHint: 'The first turn on the new account rewrites the whole context into its cache.',
      keeps: 'Keeps',
      lead: (rooms: readonly string[]): string => `lead of ${rooms.join(', ')}`,
      owner: (rooms: readonly string[]): string => `owner of ${rooms.join(', ')}`,
      children: (n: number): string => `${n} child ${n === 1 ? 'session' : 'sessions'}`,
      worktree: (branch: string): string => `worktree ${branch}`,
      unread: (n: number): string => `${n} unread`,
      blockers: 'Cannot continue right now',
      busyTitle: 'The agent is not at its prompt',
      busyHint: 'Stopping it interrupts what it is doing now.',
      continue: 'Continue',
      stopAndContinue: 'Stop and continue',
      held: 'Waiting for folder trust',
      failed: 'Could not continue the session',
      limitsFive: (percent: number): string => `5h ${Math.round(percent)}%`,
      limitsWeek: (percent: number): string => `week ${Math.round(percent)}%`,
      current: 'current',
    },
    projectMcp: {
      title: (repo: string): string => `Enable MCP servers for ${repo}?`,
      body: 'These servers come from the .mcp.json of the project and run code on your machine. Nothing is enabled unless you switch it on; the session starts either way.',
      switchLabel: (name: string): string => `Enable ${name}`,
      enable: 'Enable selected',
      rejectAll: 'Reject all',
      stale: 'The server list changed — review again',
    },
    agentSwitch: {
      title: 'Continue on another provider?',
      asks: (who: string, target: string, provider: string, reason: string): string => `${who} asks to continue ${target} on ${provider}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Allow stops ${target} now and continues it there.`,
      allow: 'Allow',
      deny: 'Deny',
    },
  },

  /**
   * Отказ `works.list` — баннер `components/WorksErrorBanner.tsx` (раунд lane-r5). `unreadable` —
   * причина хоста `works-unreadable`: первое чтение работ не удалось, снимка нет до перезапуска хоста.
   */
  works: {
    unreadable: "Host couldn't read the workspace list (works-index.json may be damaged). Fix the file, then restart the host.",
    /** Причина хоста `snapshot-too-large`: даже компактный снимок не влезает в кадр (P35). */
    tooLarge: 'Workspace data is too large to load. Delete or archive old workspaces, then restart the host.',
    syncLoading: (items: number): string => items === 0 ? 'Loading workspaces…' : `Loading workspaces… ${items.toLocaleString()} items received`,
    syncUpdating: 'Updating workspaces…',
    syncStale: 'Workspace updates have stalled. Showing the last complete data.',
    syncError: 'Workspace updates are unavailable. Showing the last complete data.',
    mailRepair: 'Refreshing unread counts and messages…',
    mailRepairFailed: 'Unread counts and messages could not be refreshed. Showing the last complete data.',
  },

  /**
   * Баннер прерванных сессий — `components/InterruptedBanner.tsx`. `interrupted` — начало строки перед чипами сессий,
   * `interruptedHint` — её подсказка (что значит «прервана»), `dismiss` — «×» (прячет показанные сессии).
   */
  banners: {
    interrupted: 'Interrupted mid-turn:',
    interruptedHint: 'These sessions were working when the host stopped. They are asleep now; resume them to let them finish the turn.',
    resumeAll: 'Resume all',
    dismiss: 'Dismiss',
  },

  /** Оболочка окна (`shell/AppShell.tsx`) — заголовки `ErrorBoundary` вокруг сайдбара и раскладки. */
  shell: {
    sidebarError: "Couldn't show workspace sidebar",
    rightSidebarError: "Couldn't show right sidebar",
    layoutError: "Couldn't show layout",
  },

  /** Заголовки действий реестра клавиш (`shared/keybindings.ts`, спека 9.6): пункты меню и строки палитры. */
  actions: {
    askAssistant: 'Ask the assistant',
    capabilities: 'Capabilities…',
    get commandPalette(): string { return pilotText('palette.title'); },
    toggleDictation: 'Toggle dictation',
    goToFile: 'Go to file',
    findInFiles: 'Find in files',
    newWorkspace: 'New workspace',
    // «New session or room» (спека окна 2026-09-29, 1.9): диалог 1.5, как ⌘T; «New room» — тот же диалог, открытый
    // сразу с двумя агентами (комнатой).
    get newSession(): string { return pilotText('action.newSession'); },
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
    showAgents: 'Show agents',
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
    toggleChatTerminal: 'Toggle chat / terminal',
    settings: 'Settings',
    nextNeedsYou: 'Next session that needs you',
    // Реестр берёт pause; палитра подменяет на resume по wakePaused (6.2).
    pauseAutoWake: 'Pause auto-wake',
    resumeAutoWake: 'Resume auto-wake',
    restartHost: 'Restart host…',
    diagnostics: 'Save diagnostics…',
    themeSystem: 'Theme: system',
    themeDark: 'Theme: dark',
    themeLight: 'Theme: light',
    newBrowserTab: 'New browser tab',
    findInPage: 'Find in page',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    actualSize: 'Actual size',
    selectElement: 'Select element',
    annotatePage: 'Annotate page',
    toggleDevtools: 'Toggle console and network',
    showConsole: 'Show console',
    findInChat: 'Find in chat',
  },
  workSwarm: {
    swarm: 'Swarm',
    rowTitle: (tag: string, status: string): string => `Swarm [${tag}] · ${status}`,
    status: {
      running: 'running',
      collecting: 'collecting',
      done: 'done',
      failed: 'failed',
      cancelled: 'cancelled',
    },
    role: {
      queen: 'Queen',
      drone: (n: number): string => `Drone ${n}`,
      verifier: 'Verifier',
    },
    queen: {
      cutting: 'cutting the task…',
      waiting: 'waiting for hand-ins…',
      collecting: 'collecting…',
      handed: 'handed in ✓',
    },
    member: {
      drone: 'reading…',
      verifier: 'verifying…',
      waiting: 'waiting',
      handed: 'handed in ✓',
      partial: 'partial',
      failed: 'failed',
      closed: 'closed',
    },
    memberName: (title: string, slice: string | null): string => (slice === null ? title : `${title} · ${slice}`),
    memberAria: (title: string, slice: string | null, word: string): string => (slice === null ? `${title}: ${word}` : `${title}, ${slice}: ${word}`),
    counter: (handed: number, total: number): string => (total === 0 ? '…' : `${handed}/${total}`),
    counterLabel: (handed: number, total: number): string => `${handed} of ${total} handed in`,
    activeSwarms: (n: number): string => (n === 1 ? '1 swarm running' : `${n} swarms running`),
    readySwarms: (n: number): string => (n === 1 ? '1 swarm result to see' : `${n} swarm results to see`),
    inSwarm: (tag: string): string => `in swarm ${tag}`,
    openQueen: 'Open the queen',
    result: 'Result',
    failure: (reason: string): string => `Stopped: ${reason}`,
    noResult: 'No summary was handed in.',
    menu: {
      open: 'Open the queen',
      cancel: 'Cancel swarm',
      cancelTitle: (tag: string): string => `Cancel swarm ${tag}?`,
      cancelDescription: 'The queen stays; the drones and verifiers still running are closed.',
      markSeen: 'Mark as seen',
    },
    island: {
      swarmsTitle: 'Swarms',
      capsule: (handed: number, total: number): string => `Swarm ${handed}/${total}`,
      row: (tag: string, handed: number, total: number): string => `${tag} ${total === 0 ? '…' : `${handed}/${total}`}`,
    },
  },
};

const ru = {
  recipeMode: 'Режим',
  time: {
    now: 'сейчас', yesterday: 'вчера',
    minutes: (n) => `${ruNumber(n)} мин`,
    hours: (n) => `${ruNumber(n)} ч`,
    ago: (relative) => `${relative} назад`,
  },
  common: { cancel: 'Отмена', close: 'Закрыть', delete: 'Удалить', done: 'Готово', retry: 'Повторить', copy: 'Копировать', send: 'Отправить' },
  outbox: { sending: 'Отправляем…', waiting: 'Ожидает', sendNow: 'Отправить сейчас', notSent: 'Не отправлено', remove: 'Убрать' },
  states: {
    working: 'работает', blocked: 'ждёт вас', unseen: 'завершено · не просмотрено', idle: 'простаивает',
    pending: 'ожидает запуска', asleep: 'спит', closed: 'закрыта', done: 'готово', failed: 'сбой',
  },
  need: {
    withTime: (word, when) => `${word} · ${when}`,
    reset: (word) => `${word} · сброшен`,
    lead: {
      approval: (word) => `Ожидает · ${word}`,
      question: (word) => `Нужен ваш ответ · ${word}`,
      limit: (word) => `Достигнут ${word} использования`,
      'sign-in': (word) => `Требуется ${word}`,
      startup: (word) => `Ожидает · ${word}`,
    },
    accountLead: 'Проблема с аккаунтом',
    withDetail: (lead, detail) => `${lead}: ${detail}`,
    limitTitle: (provider) => `${provider} · достигнут лимит использования`,
    limitBody: (tags, until) => {
      const who = tags.join(', ');
      return until === null
        ? `${who} · ожидается сброс лимита, время неизвестно`
        : `${who} · ${tags.length === 1 ? 'ожидает' : 'ожидают'} до ${until}`;
    },
    inRoom: (room) => `· комната «${room}»`,
    mail: {
      approval: (word) => `ожидает вашего ответа · ${word}`,
      question: (word) => `нужен ваш ответ · ${word}`,
      limit: (word) => `${word} использования`,
      limitUntil: (word, when) => `${word} использования до ${when}`,
      limitReset: (word) => `${word} использования сброшен`,
      signedOut: 'вышел из аккаунта', accountProblem: 'проблема с аккаунтом', startup: 'ожидает при запуске',
    },
    continueOn: "Продолжить у…",
  },
  landing: { newWorkspace: 'Новая работа', palette: 'Палитра команд' },
  titlebar: { toggleSidebar: 'Боковая панель работ', back: 'Назад', forward: 'Вперёд', search: 'Поиск', rightSidebar: 'Правая панель' },
  sidebar: {
    get addWorkspace() { return pilotText('sidebar.addWorkspace'); },
    get pinned() { return pilotText('sidebar.pinned'); },
    get search() { return pilotText('sidebar.search'); },
    newWorkspaceInProject: (project) => `Новая работа в проекте «${project}»`,
    sessionCount: sessionCountText,
    hideClosed: 'Скрыть закрытые',
    archivedRooms: "Архивные комнаты",
    hideArchivedRooms: 'Скрыть комнаты в архиве',
    archivedWorks: (n) => `В архиве: ${ruNumber(n)}`, hideArchivedWorks: 'Скрыть архивные',
    removeFromList: 'Убрать из списка…', removeFromListBlocked: 'Сначала отправьте работы проекта в архив',
    removeProjectTitle: (folder) => `Убрать «${folder}» из списка?`,
    removeProjectDescription: 'Работы останутся на диске. Проект появится в списке при создании новой работы в нём.',
    removeProjectConfirm: 'Убрать',
    unreadMail: (n) => `Вам: ${ruCount(n, ['непрочитанное письмо', 'непрочитанных письма', 'непрочитанных писем'])}`,
    roomsWithUnread: (n) => ruCount(n, ['комната с непрочитанными письмами', 'комнаты с непрочитанными письмами', 'комнат с непрочитанными письмами']),
    ownWorktree: (branch: string, base: string): string => `Своё рабочее дерево · ${branch} ← ${base}`,
    trustWaitTooltip: 'Агент не отвечает после запуска. Возможно, нужно разрешить доступ к папке.',
    startupWaitTooltip: 'Агент ожидает при запуске. Возможно, нужно войти в Codex или разрешить доступ к папке в его терминале.',
    agentUnread: 'Есть новые письма', showDone: 'Показать завершённые', sectionMenu: 'Настройки раздела',
    openParleyMd: 'Открыть PARLEY.md', createParleyMd: 'Создать PARLEY.md',
    parleyMdCreated: 'Parley добавил PARLEY.md с правилами команды для агентов', parleyMdOpen: 'Открыть',
    roomsMenu: 'Комнаты', renameField: 'Название работы', roomRenameField: 'Название комнаты', sessionRenameField: 'Название сессии',
    get workspaceList() { return pilotText('sidebar.workspaceList'); },
    showAgents: 'Показать агентов', hideAgents: 'Скрыть агентов', roomDecision: 'решение', roomMentioned: "@вы",
    roomAgents: (n, provider) => `${ruCount(n, ['агент', 'агента', 'агентов'])} · ${provider}`,
    lead: 'Ведущий',
    roomTooltip: (lead, members) =>
      ['Комната', ...(lead === null ? [] : [`ведущий ${lead}`]), ...(members.length === 0 ? [] : [members.join(', ')])].join(' · '),
    get newSessionOrRoom() { return pilotText('action.newSession'); },
    addToRoomAction: 'добавить сессию в комнату',
    sessionMenu: {
      open: 'Открыть', rename: 'Переименовать', openBeside: 'Открыть сбоку',
      copyWorktreePath: 'Скопировать путь рабочего дерева', resume: 'Возобновить', stop: 'Остановить',
      closeEllipsis: 'Закрыть…', changes: 'Изменения',
      stopConfirmTitle: (label) => `Остановить «${label}»?`, closeConfirmTitle: (label) => `Закрыть «${label}»?`,
      closeConfirmDescription: 'Сессия перестанет получать почту',
      deleteConfirmTitle: (label) => `Удалить «${label}»?`, makeLead: 'Назначить ведущим',
      keepAwake: "Не усыплять",
      continueElsewhere: "Продолжить у другого провайдера…",
    },
    roomMenu: {
      assignOwner: 'Назначить владельца', changeOwner: 'Сменить владельца',
      ownerLabel: (name) => `${name} · Владелец`,
      clearOwner: 'Снять владельца', rename: 'Переименовать', archiveEllipsis: 'В архив…', reopen: 'Открыть снова', archive: 'В архив',
      ownerChangeFailed: 'Не удалось сменить владельца комнаты.',
      archiveConfirmTitle: (title) => `Отправить комнату «${title}» в архив?`,
      archiveConfirmDescription: 'Комната появится в списке архивных внизу работы. Лента останется доступной для чтения. Чтобы снова писать в комнату, откройте её.',
      archiveConfirmOpenWork: (decision, plan) =>
        decision && plan ? ' Ожидающее решение будет снято, а план отменён.'
          : decision ? ' Ожидающее решение будет снято.' : ' План будет отменён.',
      archiveStopAgents: (n) => `Также остановить агентов, которые больше не состоят в комнатах (${ruNumber(n)})`,
      deleteEllipsis: 'Удалить…', deleteConfirmTitle: (title) => `Удалить комнату «${title}»?`,
      deleteConfirmDescription: 'Комната и её лента будут удалены. Сессии продолжат работать как отдельные сессии этой работы.',
      deleteSessions: (n) => `Также удалить сессии комнаты (${ruNumber(n)})`,
    },
    closedSessions: "Закрытые сессии",
    archivedWork: "В архиве",
    asleepSession: "Спит",
    autoSleepTooltip: "Сессия уснула, чтобы освободить память. Её разбудит сообщение или команда «Возобновить».",
    queuedTooltip: "Сессия ждёт свободного места для агента на этом компьютере и запустится автоматически.",
    providerRemoved: "Провайдер удалён",
  },
  cardMenu: {
    pin: 'Закрепить', unpin: 'Открепить', newSession: 'Новая сессия', newRoom: 'Новая комната', openMail: 'Открыть почту',
    rename: 'Переименовать', reveal: 'Показать в Finder', copyPath: 'Скопировать путь', markDone: 'Отметить завершённой',
    reopen: 'Открыть снова', archive: 'В архив', deleteEllipsis: 'Удалить…',
    archiveConfirmTitle: (title) => `Отправить «${title}» в архив?`,
    archiveConfirmDescription: 'Работающие агенты остановятся. Найдите работу в архиве внизу проекта и откройте её снова, чтобы возобновить их.',
    deleteConfirmTitle: (title) => `Удалить «${title}»?`,
    deleteConfirmDescription: (sessions) => `Сессий к удалению: ${ruNumber(sessions)}. Работающие агенты остановятся.`,
    closeFinished: "Агенты закрывают завершённые сессии",
    closeFinishedHint: "Агенты в этой рабочей области закрывают свои сессии после приёмки работы. Ведущий закрывает завершённые сессии участников комнаты. Сессии, которые вы запустили сами, ждут вашего решения.",
  },
  dialogs: {
    defaultRoomTitle: (n) => `Комната ${ruNumber(n)}`,
    newSession: {
      get roleField() { return pilotText('dialog.role'); },
      get noRole() { return pilotText('dialog.noRole'); },
      get titleSession() { return pilotText('dialog.title'); },
      titleRoom: 'Новая комната', titleSessions: 'Новые сессии',
      get hintSession() { return pilotText('dialog.hint'); },
      hintSessions: 'Каждый агент запустится отдельной сессией в работе без комнаты.',
      hintRoom: 'Агенты обсудят задачу, которую вы напишете в комнате. Ведущий предложит вам решение.',
      get workspaceField() { return pilotText('dialog.workspace'); },
      workspaceOption: (title, project) => `${title} · ${project}`,
      get noWorkspaces() { return pilotText('dialog.noWorkspaces'); },
      get sessionNameField() { return pilotText('dialog.sessionName'); },
      get sessionNamePlaceholder() { return pilotText('dialog.namePlaceholder'); },
      roomNameField: 'Название комнаты', roomNamePlaceholder: 'Что будут обсуждать агенты',
      get agentsField() { return pilotText('dialog.agents'); },
      agentGroup: (n) => pilotText('dialog.agentGroup', { number: ruNumber(n) }),
      get modelField() { return pilotText('dialog.model'); },
      get modelDefault() { return pilotText('dialog.default'); },
      get effortField() { return pilotText('dialog.effort'); },
      get effortDefault() { return pilotText('dialog.default'); },
      effortLow: 'Низкое', effortMedium: 'Среднее', effortHigh: 'Высокое',
      lead: 'Ведущий', makeLead: 'Назначить ведущим', removeAgent: 'Убрать агента',
      get addAgent() { return pilotText('dialog.addAgent'); },
      get inOwnWorktree() { return pilotText('dialog.worktree'); },
      putInRoom: 'Объединить в комнату',
      get leanSession() { return pilotText('dialog.lean'); },
      hintLabel: (field) => pilotText('dialog.aboutField', { field }),
      hints: {
        recipe: 'Сценарий заполняет настройки комнаты: роли, провайдеров, модели, режим, рабочие деревья и ведущего. Инструкцию сценария получает только ведущий. Можно выбрать встроенный сценарий или свой из .parley/recipes и затем изменить настройки.',
        workspace: 'Работа, к которой присоединятся новые агенты. В каждой работе сессии и комнаты используют общую карту.',
        roomName: 'Название комнаты в боковой панели и на вкладке. Можно оставить поле пустым, и тогда Parley выберет название по номеру комнаты.',
        sessionName: 'Название сессии в боковой панели и на вкладке. Если поле пустое, сессия получит имя по номеру, например Ralph, Anatoly или Ruslan. Переименовать сессию можно через её меню.',
        agents: 'Один агент запускается в отдельной сессии. Два и больше образуют комнату. Чтобы запустить их отдельными сессиями, выключите «Объединить в комнату».\nРоль задаёт инструкцию и значения по умолчанию для провайдера, модели и усилия. Параметры в строке агента имеют приоритет. Parley поставляет встроенные роли, а пометки «·\u00A0Claude» и «·\u00A0Codex» обозначают роли соответствующей CLI.\n🔒 обозначает роль с доступом только для чтения.\n«По умолчанию» оставляет настройку CLI. В комнате ★ назначает ведущего, а значок ветки даёт агенту отдельное рабочее дерево.',
        putInRoom: 'Включено: агенты обсуждают задачу вместе, и ведущий предлагает решение. Выключено: каждый агент работает в своей сессии.',
        worktree: 'Агент работает в отдельной папке Git на новой ветке. Результат можно проверить и объединить на вкладке «Изменения». Нужен репозиторий Git.',
        leanSession: "Агент запустится без ваших плагинов, сторонних MCP-серверов и автопамяти. В Claude Code это сокращает контекст хода примерно на треть. Инструменты и хуки Parley, ваши навыки и CLAUDE.md проекта останутся. Начальное значение берётся из пункта «Облегчённые сессии» в «Настройки → Агенты». Агенты комнаты всегда следуют этой настройке.",
        mode: 'Определяет, как комната отслеживает работу. Режим можно изменить в комнате.',
      },
      summarySession: (work) => pilotText('dialog.summary', { work }),
      summaryRoom: (agents, work) => `Комната · ${ruCount(agents, ['агент', 'агента', 'агентов'])} · работа «${work}»`,
      summarySessions: (agents, work) =>
        `${ruCount(agents, ['отдельная сессия', 'отдельные сессии', 'отдельных сессий'])} в работе «${work}»`,
      separateDropsRecipe: 'Сценарий и режим применяются к комнатам. Если выключить «Объединить в комнату», сессии запустятся отдельно.',
      get cancel() { return pilotText('dialog.cancel'); },
      get submitSession() { return pilotText('dialog.start'); },
      submitSessions: 'Запустить сессии', submitRoom: 'Создать комнату', selectWorkRequired: 'Выберите работу',
      providerUnavailable: (name) => `Провайдер «${name}» недоступен. Подключите его или выберите другого агента.`,
      agentStarted: (tag) => `Запущено: ${tag}`,
      budgetLine: (running, limit, startsLeft) =>
        pilotText('dialog.budget', { running: ruNumber(running), limit: ruNumber(limit), startsLeft: ruNumber(startsLeft) }),
      budgetBlockedSlots: (needed, remaining) =>
        `Нужно мест для сессий: ${ruNumber(needed)}. Доступно: ${ruNumber(remaining)}. Остановите сессию или увеличьте лимит в разделе «Настройки → Агенты».`,
      budgetBlockedStarts: (needed, remaining) =>
        `Нужно запусков: ${ruNumber(needed)}. Доступно в этом часу: ${ruNumber(remaining)}. Подождите или увеличьте лимит в разделе «Настройки → Агенты».`,
      budgetBlockedRoom: (needed, limit) =>
        `Лимит сессий в комнате: ${ruNumber(limit)}. Выбрано: ${ruNumber(needed)}. Уберите агента или увеличьте лимит в разделе «Настройки → Агенты».`,
      modelTyped: "Идентификатор модели (пусто — по умолчанию)",
    },
    mergeRoom: {
      title: 'Новая комната', movingInto: (first, second) => `В комнату перейдут «${first}» и «${second}».`,
      nameField: 'Название', namePlaceholder: 'Что будут обсуждать агенты', leadField: 'Ведущий', submit: 'Создать комнату',
    },
    newWork: {
      title: 'Новая работа', chooseFolder: 'Выбрать папку…', titleField: 'Название',
      titlePlaceholder: 'Если поле пустое, название будет взято из первого запроса',
      titlePlaceholderRequired: 'Назовите работу', promptField: 'Первый запрос', promptPlaceholder: 'Что должен сделать агент?',
      submit: 'Создать работу', selectFolderRequired: 'Выберите папку проекта', projectField: 'Проект',
      titleLength: 'Название: от 1 до 120 символов', titleOrPromptRequired: 'Введите название или первый запрос',
      titleRequired: 'Введите название', firstPromptNotSent: 'Комната создана, но первый запрос не отправлен.',
      promptTooLong: 'Первый запрос: до 20 000 символов', agentRequired: 'Выберите агента',
    },
    trustFolder: {
      title: (folder) => `Разрешить агентам доступ к папке «${folder}»?`,
      requestedBy: (who) => `Запрос от «${who}».`,
      body: 'В этой папке и её рабочих деревьях Codex запускается без собственного запроса на доверие. Он получает право записи в рабочую папку (workspace-write) и использует конфигурацию .codex/ репозитория, включая настройки, хуки, правила и серверы MCP. Разрешение можно отозвать в разделе «Настройки → Проекты». Поведение Claude Code не меняется.',
      confirm: 'Разрешить',
      via: { agent: 'создание сессии', resume: 'возобновление', launch: 'запуск' },
    },
    notListedYet: {
      work: 'Работа создана и скоро появится в боковой панели',
      session: 'Сессия запущена и скоро появится в боковой панели',
      room: 'Комната создана и скоро появится в боковой панели',
    },
    switchAgent: {
      title: "Продолжить у другого провайдера",
      description: (label: string): string => `${label} сохранит своё место в Parley, сменится только агент.`,
      loading: "Загрузка провайдеров…",
      targetGroup: "Провайдер",
      modelField: "Модель",
      modelDefault: "По умолчанию",
      effortField: "Усилие",
      effortDefault: "По умолчанию",
      carryField: "Что перенести",
      carryHandover: "Резюме для передачи (любой провайдер)",
      carryTranscript: "Продолжить разговор (аккаунты одного семейства Claude)",
      transcriptHint: "В первом ходе на новом аккаунте весь контекст заново записывается в кэш.",
      keeps: "Сохраняется",
      lead: (rooms: readonly string[]): string => `ведущий: ${rooms.join(', ')}`,
      owner: (rooms: readonly string[]): string => `владелец: ${rooms.join(', ')}`,
      children: (n: number): string => `Дочерних сессий: ${n}`,
      worktree: (branch: string): string => `рабочее дерево ${branch}`,
      unread: (n: number): string => `Непрочитанных: ${n}`,
      blockers: "Сейчас продолжить нельзя",
      busyTitle: "Агент ещё не ждёт ввода",
      busyHint: "Остановка прервёт его текущую работу.",
      continue: "Продолжить",
      stopAndContinue: "Остановить и продолжить",
      held: "Ожидает разрешения для папки",
      failed: "Не удалось продолжить сессию",
      limitsFive: (percent: number): string => `5h ${Math.round(percent)}%`,
      limitsWeek: (percent: number): string => `неделя ${Math.round(percent)}%`,
      current: "текущий",
    },
    projectMcp: {
      title: (repo: string): string => `Включить MCP-серверы для ${repo}?`,
      body: "Серверы из файла .mcp.json проекта запускают код на вашем компьютере. Они включаются только по вашему решению. Сессия запустится при любом выборе.",
      switchLabel: (name: string): string => `Включить ${name}`,
      enable: "Включить выбранные",
      rejectAll: "Отклонить все",
      stale: "Список серверов изменился. Проверьте его ещё раз",
    },
    agentSwitch: {
      title: "Продолжить у другого провайдера?",
      asks: (who: string, target: string, provider: string, reason: string): string => `${who} просит продолжить ${target} у провайдера ${provider}: ${reason}${/[.!?]$/.test(reason) ? '' : '.'} Если разрешить, ${target} остановится и продолжится у него.`,
      allow: "Разрешить",
      deny: "Отказать",
    },
  },
  works: {
    unreadable: 'Хост не смог прочитать список работ. Возможно, повреждён works-index.json. Исправьте файл, затем перезапустите хост.',
    tooLarge: 'Слишком много данных для загрузки. Удалите старые работы или отправьте их в архив, затем перезапустите хост.',
    syncLoading: (items: number): string => items === 0 ? "Загрузка рабочих областей…" : `Загрузка рабочих областей… Получено элементов: ${ruNumber(items)}`,
    syncUpdating: "Обновление рабочих областей…",
    syncStale: "Обновления рабочих областей остановились. Показаны последние полные данные.",
    syncError: "Обновления рабочих областей недоступны. Показаны последние полные данные.",
    mailRepair: "Обновление сообщений и счётчиков непрочитанного…",
    mailRepairFailed: "Не удалось обновить сообщения и счётчики непрочитанного. Показаны последние полные данные.",
  },
  banners: {
    interrupted: 'Прервались во время хода:',
    interruptedHint: 'Эти сессии работали до остановки хоста. Возобновите их, чтобы они могли закончить ход.',
    resumeAll: 'Возобновить все', dismiss: 'Скрыть',
  },
  shell: {
    sidebarError: 'Не удалось показать боковую панель работ',
    rightSidebarError: 'Не удалось показать правую панель',
    layoutError: 'Не удалось показать раскладку окна',
  },
  actions: {
    askAssistant: 'Спросить помощника', capabilities: 'Возможности…',
    get commandPalette() { return pilotText('palette.title'); },
    toggleDictation: 'Включить или выключить диктовку', goToFile: 'Перейти к файлу', findInFiles: 'Найти в файлах',
    newWorkspace: 'Новая работа', get newSession() { return pilotText('action.newSession'); },
    newRoom: 'Новая комната', workspaceNumber: (n) => `Работа ${ruNumber(n)}`,
    previousWorkspace: 'Предыдущая работа', nextWorkspace: 'Следующая работа',
    showArchivedWorkspaces: 'Показать работы в архиве', back: 'Назад', forward: 'Вперёд',
    toggleWorkspaceSidebar: 'Показать или скрыть панель работ', toggleRightSidebar: 'Показать или скрыть правую панель',
    showFiles: 'Показать файлы', showChanges: 'Показать изменения', showAgents: 'Показать агентов',
    splitRight: 'Разделить вправо', splitDown: 'Разделить вниз', previousGroup: 'Предыдущая группа', nextGroup: 'Следующая группа',
    closeTab: 'Закрыть вкладку', reopenClosedTab: 'Открыть закрытую вкладку', previousTab: 'Предыдущая вкладка',
    nextTab: 'Следующая вкладка', nextRecentTab: 'Следующая недавняя вкладка', previousRecentTab: 'Предыдущая недавняя вкладка',
    tabNumber: (n) => `Вкладка ${ruNumber(n)}`, find: 'Найти', clearTerminal: 'Очистить терминал',
    toggleChatTerminal: 'Переключить чат и терминал', settings: 'Настройки', nextNeedsYou: 'Следующая сессия, которая ждёт вас',
    pauseAutoWake: 'Приостановить будильник', resumeAutoWake: 'Возобновить будильник',
    restartHost: 'Перезапустить хост…', diagnostics: 'Сохранить диагностику…',
    themeSystem: 'Тема: как в системе', themeDark: 'Тема: тёмная', themeLight: 'Тема: светлая',
    newBrowserTab: 'Новая вкладка браузера', findInPage: 'Найти на странице',
    zoomIn: 'Увеличить масштаб', zoomOut: 'Уменьшить масштаб', actualSize: 'Фактический размер',
    selectElement: 'Выбрать элемент', annotatePage: 'Добавить аннотацию', toggleDevtools: 'Показать или скрыть консоль и сеть',
    showConsole: 'Показать консоль',
    findInChat: "Найти в чате",
  },
  workSwarm: {
    swarm: "Рой",
    rowTitle: (tag: string, status: string): string => `Рой [${tag}] · ${status}`,
    status: {
      running: "работает",
      collecting: "собирает результаты",
      done: "готово",
      failed: "сбой",
      cancelled: "отменено",
    },
    role: {
      queen: "Королева",
      drone: (n: number): string => `Трутень ${n}`,
      verifier: "Проверяющий",
    },
    queen: {
      cutting: "разбивает задачу…",
      waiting: "ждёт результатов…",
      collecting: "собирает результаты…",
      handed: "сдано ✓",
    },
    member: {
      drone: "читает…",
      verifier: "проверяет…",
      waiting: "ожидает",
      handed: "сдано ✓",
      partial: "частично",
      failed: "сбой",
      closed: "закрыто",
    },
    memberName: (title: string, slice: string | null): string => (slice === null ? title : `${title} · ${slice}`),
    memberAria: (title: string, slice: string | null, word: string): string => (slice === null ? `${title}: ${word}` : `${title}, ${slice}: ${word}`),
    counter: (handed: number, total: number): string => (total === 0 ? '…' : `${handed}/${total}`),
    counterLabel: (handed: number, total: number): string => `Сдано ${handed} из ${total}`,
    activeSwarms: (n: number): string => (n === 1 ? "Работает 1 рой" : `Роев в работе: ${n}`),
    readySwarms: (n: number): string => (n === 1 ? "Доступен результат 1 роя" : `Доступно результатов роя: ${n}`),
    inSwarm: (tag: string): string => `в рое ${tag}`,
    openQueen: "Открыть сессию королевы",
    result: "Результат",
    failure: (reason: string): string => `Остановлено: ${reason}`,
    noResult: "Итоговое резюме не сдано.",
    menu: {
      open: "Открыть сессию королевы",
      cancel: "Отменить рой",
      cancelTitle: (tag: string): string => `Отменить рой ${tag}?`,
      cancelDescription: "Королева останется. Сессии трутней и проверяющих, которые всё ещё работают, закроются.",
      markSeen: "Отметить просмотренным",
    },
    island: {
      swarmsTitle: "Рои",
      capsule: (handed: number, total: number): string => `Рой ${handed}/${total}`,
      row: (tag: string, handed: number, total: number): string => `${tag} ${total === 0 ? '…' : `${handed}/${total}`}`,
    },
  },
} satisfies LocalizedMessages<typeof en>;

export const workspaceStrings = { en, ru };

export const russianNeedWords: Readonly<Record<NeedKind, string>> = {
  approval: 'подтверждение', question: 'вопрос', limit: 'лимит', 'sign-in': 'вход', startup: 'запуск',
};

// IDs and descriptions returned by providers remain unchanged.
export const effortLabels: ReadonlyMap<string, readonly [english: string, russian: string]> = new Map([
  ['low', ['Low', ru.dialogs.newSession.effortLow]],
  ['medium', ['Medium', ru.dialogs.newSession.effortMedium]],
  ['high', ['High', ru.dialogs.newSession.effortHigh]],
  ['xhigh', ['Extra high', 'Очень высокое']],
  ['max', ['Max', 'Максимальное']],
  ['ultra', ['Ultra', 'Ультра']],
  ['minimal', ['Minimal', 'Минимальное']],
  ['none', ['None', 'Без усилия']],
]);
