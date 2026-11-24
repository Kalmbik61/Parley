import type { NoticeKind } from '@parley/protocol';
import { appI18n } from '../app-locale.js';
import { ruNumber, type LocalizedMessages } from './desktop-messages.js';

const en = {

  /** Выход из приложения останавливает хост (решение 2026-10-16): вопрос системным диалогом. */
  quit: {
    title: 'Quit Parley?',
    detail: (count: number | null): string =>
      count === null
        ? "The host isn't responding. It will be stopped together with all its sessions. They won't restart on their own — the next launch lists them so you can bring them back."
        : `The host will stop and ${count} running ${count === 1 ? 'session' : 'sessions'} will be terminated. They won't restart on their own — the next launch lists them so you can bring them back.`,
    stop: (count: number | null): string =>
      count === null ? 'Stop host and Quit' : `Stop ${count} ${count === 1 ? 'session' : 'sessions'} and Quit`,
  },

  /** Тост о новой версии — `renderer/update/update-notice.ts` (V6 плана релиза 0.1.0). */
  update: {
    available: (version: string): string => `Parley ${version} is available`,
    /** Открывает страницу релиза в браузере: без подписи Apple окно само не обновляется. */
    download: 'Download',
    later: 'Later',
    update: 'Update',
    cancel: 'Cancel',
    restartNow: 'Restart now',
    restartToUpdate: 'Restart to update',
    tryAgain: 'Try again',
    downloading: (version: string, percent: number | null): string =>
      percent === null ? `Downloading Parley ${version}…` : `Downloading Parley ${version}… ${percent}%`,
    checking: (version: string): string => `Checking Parley ${version}…`,
    ready: (version: string): string => `Parley ${version} is ready`,
    readyHint: 'Restarting stops running agents',
    failed: (version: string, reason: string): string => `Couldn't update to ${version}: ${reason}`,
    updated: (version: string): string => `Parley updated to ${version}`,
    failedAfterRestart: (version: string, reason: string): string =>
      `Couldn't update to ${version}: ${reason}. The previous version is still installed.`,
    row: {
      available: (version: string): string => `Parley ${version} is available`,
      downloading: (version: string, percent: number | null): string =>
        percent === null ? `Downloading ${version}…` : `Downloading ${version} — ${percent}%`,
      checking: (version: string): string => `Checking ${version}…`,
      ready: (version: string): string => `${version} is ready to install`,
      failed: (reason: string): string => `Couldn't update: ${reason}`,
    },
    failure: {
      network: 'GitHub did not answer, check your connection',
      too_large: 'the download is larger than a Parley release should be',
      checksum: 'the download does not match its checksum',
      bad_archive: 'the download is not a valid Parley release',
      disk: 'Parley could not write the update next to the app',
      cannot_replace: 'Parley can no longer replace itself where it is installed',
    },
    resultFailure: {
      still_running: 'the old Parley did not quit in time',
      no_app: 'the installed app could not be found',
      swap_failed: 'the new version could not be put in place',
      restore_failed: 'the new version could not be put in place and the old one was not restored',
      launch_failed: 'the new version did not start',
      helper: 'the update helper could not be started',
    },
  },

  /** Экраны связи с хостом — `App.tsx`, короткие варианты — `shell/StatusBar.tsx`. */
  connection: {
    connectingScreen: 'Connecting to host…',
    mismatchScreen: (liveSessions: number | null): string =>
      `Host is an older version. Restart? Live sessions: ${liveSessions ?? '—'}.`,
    restart: 'Restart',
    disconnectedScreen: (reason: string): string => `No connection to host: ${reason}`,
    /** Кнопка экрана «No connection to host» (fix-final-b); «Retry» — `common.retry`. */
    restartHost: 'Restart host',
    statusConnecting: 'Connecting…',
    statusConnected: (hostVersion: string): string => `Host ${hostVersion}`,
    /** Тост «хост от другой сборки» (0.2.0, `update/host-build-notice.ts`). */
    hostOtherBuild: (hostVersion: string, appVersion: string): string =>
      `The host is still from Parley ${hostVersion}, the window is ${appVersion}. Restart the host to finish the update.`,
    statusMismatch: 'Host version mismatch',
    statusDisconnected: (reason: string): string => `No connection: ${reason}`,
    /** `main/index.ts` — login-shell не нашёл системный `node`. */
    reasonNodeNotFound: 'node not found in login-shell PATH',
    /** `main/host-connection.ts` — сокет закрылся, ждём переподключения. */
    reasonClosed: 'Connection to host closed',
    /** `main/host-connection.ts` — запущенный процесс хоста жив, а сокета нет дольше срока старта (lane-r4). */
    reasonHostNotAnswering: 'Host process is running but not answering',
    /** `main/host-connection.ts` — хост до P35 прислал строку длиннее предела кадра: переподключение её не уменьшит. */
    reasonOversize: 'The host sent a response over the 8 MiB limit (an older host build). Restart the host to update it.',
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

  /**
   * Уведомления macOS — `renderer/attention/notify.ts` (кусок 4.3, спека 7.4). Название работы,
   * ярлык сессии и отправитель — данные, идут как есть.
   */
  notifications: {
    /** «<работа> · <ярлык> — <событие>». */
    sessionTitle: (workspace: string, session: string, event: string): string => `${workspace} · ${session} — ${event}`,
    needsYou: 'needs you',
    sessionFinished: (workspace: string, name: string): string => appI18n.t('pilot.sessionFinished', { workspace, name }),
    launchFailed: "couldn't launch",
    resumeFailed: "couldn't resume",
    /** Заголовок уведомления хоста `limit-return-blocked` (спека застрявших 7.1): лимит сброшен, а сессию вернуть не вышло. */
    limitReturnBlocked: 'limit has reset',
    /** «<работа> · письмо | вопрос | решение от S01» по `Message.kind`. */
    mailTitle: (workspace: string, kind: 'note' | 'question' | 'decision', from: string): string =>
      `${workspace} · ${kind === 'question' ? 'question' : kind === 'decision' ? 'decision' : 'message'} from ${from}`,
    /** Агент назвал человека в комнате (`@human`): «S02 mentioned you in Mobile APP». `from` — короткий ярлык, комната — данные. */
    mentionTitle: (from: string, room: string): string => `${from} mentioned you in ${room}`,
    /** Тост: клик по уведомлению, чью работу или сессию успели удалить (спека 7.5). */
    targetGone: 'Workspace or session no longer exists',
    /**
     * Решение ведущего ждёт человека (спека окна 2026-09-29, 1.10). Один заголовок на оба случая — новое решение и
     * переделанное; различает их тело. `lead` — короткий ярлык ведущего (`S01`), как в подписях `lead S01` окна.
     */
    decisionTitle: 'Decision waiting for you',
    decisionNew: (room: string, lead: string): string => `${room} · ${lead} collected positions`,
    /** Ведущий заменил текст, пока человек не ответил (`rev` вырос), или принёс исправленное после `Return for rework`. */
    decisionRevised: (room: string, lead: string): string => `${room} · ${lead} revised the decision`,
    /** Строка «что спрашивают» в теле уведомления «нужен ты»: команда, правка, вопрос, план — `renderer/attention/ask-summary.ts`. */
    askRun: (command: string): string => `Run: ${command}`,
    /** «Edit: src/app.ts» — имя инструмента и путь (относительный, если файл внутри проекта). */
    askTool: (tool: string, path: string): string => `${tool}: ${path}`,
    askFetch: (url: string): string => `Fetch: ${url}`,
    askQuestion: (question: string): string => `Question: ${question}`,
    askPlan: 'Plan ready for review',
    /** Вторая строка тела: проект и сколько ещё сессий ждут человека. */
    waitingLine: (project: string, more: number): string => (more > 0 ? `${project} · ${more} more waiting` : project),
    /** Кнопки уведомления в самом окне (1.10): вкладка комнаты или скрыть. */
    open: 'Open',
    later: 'Later',
  },

  /** Диагностика хоста (спека 2026-10-16-host-diagnostics-and-load-design.md): сегмент строки статуса (A1) и `README.txt` внутри zip (A2). */
  diagnostics: {
    segment: 'Diagnostics',
    save: 'Save diagnostics',
    profile: 'Record 20-second profile, then save',
    saving: 'Saving…',
    profiling: (left: number): string => `Profiling ${left} s…`,
    hint: 'Includes host logs, process list and timings. No message text, terminal output or keys. The file is saved to Downloads; attach it to a GitHub issue.',
    hostOutdated: 'Host is outdated — restart it for full diagnostics',
    saved: 'Diagnostics saved',
    showInFinder: 'Show in Finder',
    readme: [
      'Parley diagnostics bundle',
      '',
      'Contents: host.log and host.log.1 (host journal), host.err (host stderr), host-info.json (host versions, health sample, live sessions), app-info.json (app and OS versions), processes.txt (host process tree: pid, cpu, memory, executable name only), actions.jsonl (recent window-to-host calls with timings), host-*.cpuprofile (CPU profiles, open in Chrome DevTools > Performance > Load profile).',
      '',
      'Privacy: project paths and session or room names are included. Message text, terminal output, provider keys and environment variables are not.',
      '',
      'Send: attach this file to a GitHub issue at https://github.com/Kalmbik61/Parley/issues or to your message to the author.',
    ].join('\n'),
  },
};

const ru = {
  quit: {
    title: 'Выйти из Parley?',
    detail: (count) => count === null
      ? 'Хост не отвечает. При выходе остановятся хост и все его сессии. После нового запуска вы сможете возобновить их из списка.'
      : `При выходе остановятся хост и работающие сессии (${ruNumber(count)}). После нового запуска вы сможете возобновить их из списка.`,
    stop: (count) => count === null ? 'Остановить хост и выйти' : `Остановить сессии (${ruNumber(count)}) и выйти`,
  },
  update: { available: (version) => `Доступен Parley ${version}`, download: 'Скачать', later: 'Позже' ,
    update: "Обновить",
    cancel: "Отмена",
    restartNow: "Перезапустить сейчас",
    restartToUpdate: "Перезапустить для обновления",
    tryAgain: "Повторить",
    downloading: (version: string, percent: number | null): string =>
      percent === null ? `Скачивание Parley ${version}…` : `Скачивание Parley ${version}… ${percent}%`,
    checking: (version: string): string => `Проверка Parley ${version}…`,
    ready: (version: string): string => `Parley ${version} готова к установке`,
    readyHint: "Перезапуск остановит работающих агентов",
    failed: (version: string, reason: string): string => `Не удалось обновить до ${version}: ${reason}`,
    updated: (version: string): string => `Parley обновлён до ${version}`,
    failedAfterRestart: (version: string, reason: string): string =>
      `Не удалось обновить до ${version}: ${reason}. Установлена прежняя версия.`,
    row: {
      available: (version: string): string => `Доступна версия Parley ${version}`,
      downloading: (version: string, percent: number | null): string =>
        percent === null ? `Скачивание ${version}…` : `Скачивание ${version} — ${percent}%`,
      checking: (version: string): string => `Проверка ${version}…`,
      ready: (version: string): string => `Версия ${version} готова к установке`,
      failed: (reason: string): string => `Не удалось обновить: ${reason}`,
    },
    failure: {
      network: "GitHub не ответил. Проверьте подключение",
      too_large: "скачанный файл больше ожидаемого размера выпуска Parley",
      checksum: "контрольная сумма скачанного файла не совпадает",
      bad_archive: "скачанный файл не является выпуском Parley",
      disk: "не удалось записать обновление рядом с приложением",
      cannot_replace: "Parley больше не может заменить себя в папке установки",
    },
    resultFailure: {
      still_running: "старая версия Parley не завершилась вовремя",
      no_app: "установленное приложение не найдено",
      swap_failed: "не удалось установить новую версию",
      restore_failed: "не удалось установить новую версию и восстановить прежнюю",
      launch_failed: "новая версия не запустилась",
      helper: "не удалось запустить помощник обновления",
    },
  },
  connection: {
    connectingScreen: 'Подключаемся к хосту…',
    mismatchScreen: (liveSessions) => `У хоста устаревшая версия. Перезапустить? Работающих сессий: ${liveSessions === null ? '—' : ruNumber(liveSessions)}.`,
    restart: 'Перезапустить', disconnectedScreen: (reason) => `Нет связи с хостом: ${reason}`,
    restartHost: 'Перезапустить хост', statusConnecting: 'Подключение…', statusConnected: (hostVersion) => `Хост ${hostVersion}`,
    hostOtherBuild: (hostVersion, appVersion) => `Версия хоста Parley — ${hostVersion}, версия окна — ${appVersion}. Перезапустите хост, чтобы завершить обновление.`,
    statusMismatch: 'Несовместимая версия хоста', statusDisconnected: (reason) => `Нет соединения: ${reason}`,
    reasonNodeNotFound: 'node не найден в PATH оболочки входа', reasonClosed: 'Соединение с хостом закрыто',
    reasonHostNotAnswering: 'Процесс хоста запущен, но не отвечает',
    reasonOversize: 'Ответ хоста превысил предел 8 МиБ. Перезапустите хост, чтобы обновить его.',
  },
  menu: { edit: 'Правка', view: 'Вид', workspace: 'Работа', tab: 'Вкладка', terminal: 'Терминал' },
  notifications: {
    sessionTitle: (workspace, session, event) => `${workspace} · ${session} — ${event}`,
    needsYou: 'ждёт вас', sessionFinished: (workspace, name) => appI18n.t('pilot.sessionFinished', { workspace, name }),
    launchFailed: 'не удалось запустить', resumeFailed: 'не удалось возобновить', limitReturnBlocked: 'лимит сброшен',
    mailTitle: (workspace, kind, from) =>
      `${workspace} · ${kind === 'question' ? 'вопрос' : kind === 'decision' ? 'решение' : 'письмо'} от «${from}»`,
    mentionTitle: (from, room) => `«${from}» упоминает вас в комнате «${room}»`,
    targetGone: 'Работа или сессия больше не существует', decisionTitle: 'Решение ждёт вас',
    decisionNew: (room, lead) => `${room} · Ведущий «${lead}» собрал мнения`,
    decisionRevised: (room, lead) => `${room} · Ведущий «${lead}» обновил решение`,
    askRun: (command) => `Запустить: ${command}`, askTool: (tool, path) => `${tool}: ${path}`,
    askFetch: (url) => `Получить: ${url}`, askQuestion: (question) => `Вопрос: ${question}`,
    askPlan: 'План ждёт рассмотрения', waitingLine: (project, more) => more > 0 ? `${project} · ждут ещё: ${ruNumber(more)}` : project,
    open: 'Открыть', later: 'Позже',
  },
  diagnostics: {
    segment: 'Диагностика', save: 'Сохранить диагностику', profile: 'Записать профиль за 20 секунд и сохранить',
    saving: 'Сохраняем…', profiling: (left) => `Записываем профиль, осталось ${ruNumber(left)} с…`,
    hint: 'Включает журнал хоста, список процессов и длительность операций. В архиве нет текста сообщений, вывода терминала и ключей. Архив сохраняется в «Загрузки», откуда его можно приложить к задаче в GitHub.',
    hostOutdated: 'Хост устарел. Перезапустите его, чтобы получить полную диагностику.',
    saved: 'Диагностика сохранена', showInFinder: 'Показать в Finder',
    readme: [
      'Архив диагностики Parley', '',
      'Содержимое: host.log и host.log.1 (журнал хоста), host.err (stderr хоста), host-info.json (версия, состояние и работающие сессии хоста), app-info.json (версии приложения и ОС), processes.txt (дерево процессов хоста, PID, загрузка CPU, память и имя программы), actions.jsonl (недавние вызовы хоста из окна и их длительность), host-*.cpuprofile (профили CPU, их можно открыть в Chrome DevTools через Performance → Load profile).',
      '', 'В архив входят пути проектов и названия сессий или комнат. Текст сообщений, вывод терминала, ключи провайдеров и переменные среды не включаются.',
      '', 'Приложите архив к задаче на https://github.com/Kalmbik61/Parley/issues или к письму автору.',
    ].join('\n'),
  },
} satisfies LocalizedMessages<typeof en>;

export const systemStrings = { en, ru };

const nativeEn = {
  about: 'About Parley', quit: 'Quit Parley', undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All',
  islandTitle: 'Parley Island', windowStarting: "Parley's window is still starting: try again in a moment.",
};
const nativeRu = {
  about: 'О Parley', quit: 'Выйти из Parley', undo: 'Отменить', redo: 'Повторить', cut: 'Вырезать', copy: 'Копировать',
  paste: 'Вставить', selectAll: 'Выбрать всё', islandTitle: 'Остров Parley',
  windowStarting: 'Окно Parley ещё запускается. Повторите попытку через несколько секунд.',
} satisfies LocalizedMessages<typeof nativeEn>;

export const nativeWindowStrings = { en: nativeEn, ru: nativeRu };

export const russianNoticeDetails: Readonly<Record<NoticeKind, string>> = {
  'kimi-history-partial': 'Kimi продолжил сессию, но в чате удалось восстановить только часть истории',
  'global-parley-md-unreadable': 'не удалось прочитать глобальный PARLEY.md в папке Parley',
  'global-parley-md-truncated': 'взяты первые 32 КБ глобального PARLEY.md. Сократите правила, чтобы они поместились целиком',
  'map-lock': 'карта работы заблокирована. Повторите попытку через несколько секунд',
  'map-corrupt': 'не удалось прочитать карту работы',
  'map-migration-failed': 'не удалось перенести работу в новое хранилище. Она осталась в прежнем файле',
  'hooks-missing': 'нет данных от хуков Claude Code. Статус определяется по журналу',
  'launch-failed': 'не удалось запустить сессию',
  'pointer-timeout': 'нет ответа на уведомление о почте',
  'pointer-cancelled': 'ваш ввод прервал уведомление о почте',
  'resume-failed': 'не удалось возобновить сессию',
  'resume-limit': 'достигнут часовой лимит возобновлений. Письма ждут',
  'trust-wait': 'нет ответа после запуска. Возможно, нужно разрешить доступ к папке',
  'startup-wait': 'ожидание при запуске. Возможно, в терминале Codex нужно войти или разрешить доступ к папке',
  'limit-return-blocked': 'лимит сброшен, но сессия не возобновилась. Проверьте терминал',
  'codex-call-wait': 'операция инструмента Codex ещё не завершена. Проверьте разрешения и результат перед повтором',
  'skill-foreign': 'навык агента не установлен. Путь уже занят файлом, который создал не Parley',
  'parley-md-created': 'Parley добавил PARLEY.md с правилами команды для агентов',
  'parley-md-unreadable': 'не удалось прочитать PARLEY.md. Сессия запускается без правил проекта',
  'parley-md-truncated': 'взяты первые 32 КБ PARLEY.md. Сократите правила, чтобы они поместились целиком',
  'provider-override-gap': 'в пользовательской команде Codex отсутствует настройка инструкций Parley. Восстановите команду по умолчанию',
  'role-missing': 'сохранённая роль недоступна. Сессия запускается без её параметров',
  'memory-truncated': 'взяты первые 12 КиБ памяти проекта. Сократите memory.md, чтобы включить остальные сведения',
  'memory-unreadable': 'не удалось прочитать память проекта. Устраните конфликты или ошибки доступа к memory.md',
  'project-context-unavailable': 'не удалось проверить репозиторий Git этого проекта. Память проекта пропущена. Проверьте git worktree list',
  'swarm-done': 'рой завершил работу',
  'swarm-failed': 'рой не завершил работу',
  'machine-over-limit': 'сессия запущена сверх лимита этого компьютера',
  'deps-clone-unavailable': 'не удалось скопировать зависимости в новое рабочее дерево',
  'deps-clone-mismatch': 'скопированные зависимости не совпадают с файлом блокировки',
  'plan-effect-failed': 'доставка или экспорт плана ждут. Устраните конфликт и повторите операцию из плана',
  'role-truncated': 'взяты первые 32 КБ текста роли. Сократите текст, чтобы он поместился целиком',
  'recipe-playbook-truncated': 'взяты первые 32 КБ инструкции сценария. Сократите её, чтобы включить остальной текст',
  'compact-cancelled': 'сжатие контекста отменено. Агент остановился',
  'compact-failed': 'не удалось сжать контекст. Проверьте терминал агента',
  'snapshot-too-large': 'данных работ слишком много для отображения. Удалите старые работы или отправьте их в архив',
  'codex-auto-unsupported': 'эта версия Codex не поддерживает автопроверку разрешений. Пока запросы появятся в терминале. Обновите Codex',
  'git-connectivity-failed': 'проверка связности репозитория Git завершилась сбоем. Откройте журнал хоста',
};
