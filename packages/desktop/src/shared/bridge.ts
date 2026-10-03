import type {
  EventData,
  EventName,
  MethodName,
  NotificationName,
  Params,
  Result,
  SessionRef,
} from '@parley/protocol';
import type { BrowserApi } from './browser-types.js';
import type {
  DiffFile,
  DirEntry,
  FileChangedEvent,
  FileList,
  FileRoot,
  FileStat,
  GitStatusLetter,
  GrepQuery,
  GrepResult,
  Located,
  TextFile,
  TreeChangedEvent,
  WriteResult,
} from './files-types.js';
import type { ActionId } from './keybindings.js';
import type { WorkLayout } from './layout-types.js';
import type { NotesFile } from './notes-types.js';
import type { Appearance, UiFile } from './ui-types.js';

/** Состояние связи окна с хостом — источник для диалогов и строки статуса. */
export type HostStatus =
  | { state: 'connecting' }
  /** `methods: null` — хост до этапа 3: ответ `hello` без списка методов (спека 3.2). */
  | { state: 'connected'; hostVersion: string; methods: string[] | null }
  | { state: 'mismatch'; hostVersion: string; liveSessions: number | null }
  | { state: 'disconnected'; reason: string };

/**
 * Куда ведёт клик по уведомлению (спека 3.3, 7.4): вкладка сессии, почты или комнаты.
 * Main шлёт её окну событием `app:focus-target`; окну, которое ещё грузится, — через
 * отложенную (`app:take-focus-target`).
 */
export type FocusTarget =
  | { kind: 'session'; ref: SessionRef }
  | { kind: 'mail'; projectPath: string; workId: string }
  | { kind: 'room'; projectPath: string; workId: string; roomId: string };

/** Уведомление macOS (спека 3.3, 7.4): одно на тег — новое закрывает прежнее. */
export interface AppNote {
  title: string;
  body: string;
  tag: string;
  target: FocusTarget;
  silent: boolean;
}

/**
 * Релиз новее запущенной версии, который нашла проверка main (`main/update-check.ts`, V6 плана релиза 0.1.0):
 * `version` — `X.Y.Z` без `v`, `url` — страница релиза на GitHub (`html_url`; main пропускает только https).
 */
export interface UpdateInfo {
  version: string;
  url: string;
}

/**
 * Ответ окна на `app:confirm-close` (кусок 7.3a): `close` — «Don't save» или «Save all», у
 * которого удались все записи; `cancel` — «Cancel» или ошибка записи, окно остаётся.
 */
export type CloseAnswer = 'close' | 'cancel';

/**
 * Единственный мост между рендерером и хостом. Рендерер не видит ни Node, ни
 * Electron напрямую — только это, отданное прелоадом через `contextBridge`.
 */
export interface ParleyBridge {
  call<M extends MethodName>(method: M, params: Params<M>): Promise<Result<M>>;
  notify<N extends NotificationName>(method: N, params: Params<N>): void;
  on<E extends EventName>(event: E, listener: (data: EventData<E>) => void): () => void;
  onStatus(listener: (status: HostStatus) => void): () => void;
  /**
   * Последняя активность каждой сессии, которую main видел на текущем
   * подключении, — в том числе повтор хоста после `hello`, пришедший раньше
   * подписки рендерера (`main/host-connection.ts#activitySnapshot`).
   */
  activitySnapshot(): Promise<Array<EventData<'activity.changed'>>>;
  app: {
    openExternal(url: string): Promise<void>;
    notify(note: AppNote): void;
    /** При подписке отдаёт слушателю отложенную цель: сначала ту, что держит прелоад, иначе из app:take-focus-target. */
    onFocusTarget(listener: (target: FocusTarget) => void): () => void;
    setBadge(count: number): void;
    chooseFolder(): Promise<string | null>;
    /** Диалог выбора файлов для вложений поля ввода «Chat»: пути выбранных, [] — отмена. */
    chooseFiles(): Promise<string[]>;
    /**
     * Версия окна (`app.getVersion()`, 0.2.0): с ней страница сверяет версию хоста — хост другой сборки
     * перезапускают. `null` — окно не собрано (`pnpm dev`, E2E), и сверять нечего.
     */
    version(): Promise<string | null>;
    restartHost(): Promise<void>;
    /** «Retry» экрана «No connection to host»: подключение заново, с короткой паузой (fix-final-b). */
    reconnect(): Promise<void>;
    /** Клик мышью по пункту меню (кусок 6.1b): `ActionId` реестра, канал `menu:action` прежний. */
    onMenu(listener: (id: ActionId) => void): () => void;
    /** Фокус окна macOS (BrowserWindow focus/blur): при фокусе в странице DOM-события окна его не показывают. */
    onWindowFocus(listener: (focused: boolean) => void): () => void;
    /**
     * Раскладка работы в `layouts.json` (`main/layout-store.ts`, формат v2 —
     * по одной `WorkLayout` на `workKey`, спека 5.8). Файл пишет не только
     * это окно, поэтому рендерер всё равно проверяет прочитанное
     * (`layout/tree.ts#parseWorkLayout`).
     */
    loadLayout(workKey: string): Promise<WorkLayout | null>;
    saveLayout(workKey: string, layout: WorkLayout): Promise<void>;
    /** Работа исчезла из снимка — стирает её раскладку из `layouts.json` (спека 5.8). */
    removeLayout(workKey: string): Promise<void>;
    /** Первый снимок после старта: раскладки работ, которых в нём нет, стираются (спека 5.8). */
    retainLayouts(workKeys: string[]): Promise<void>;
    /** `ui.json` (кусок 1.1 плана окна, спека 3.4) — хранилище в `main/ui-store.ts`. */
    loadUi(): Promise<UiFile>;
    saveUi(patch: Partial<Omit<UiFile, 'version'>>): Promise<UiFile>;
    /**
     * Заметки к диффу сессии (кусок 8.4a, спека 11.4), `main/notes-store.ts`. Битый файл — пустые
     * заметки, а corruptedTo — имя, под которым его сохранили рядом: путь `notes/` лежит вне корней
     * работы и в окно не уходит (спека 15.2).
     */
    loadNotes(workKey: string, sessionId: string): Promise<{ file: NotesFile; corruptedTo: string | null }>;
    saveNotes(workKey: string, sessionId: string, notes: NotesFile): Promise<void>;
    /** Меняет `nativeTheme.themeSource` в главном процессе и пишет `ui.json` (спека 4.7). */
    setAppearance(mode: Appearance): Promise<void>;
    /** Системная тёмность подхватывается при `nativeTheme.on('updated')` (спека 4.7). */
    onAppearance(listener: (dark: boolean) => void): () => void;
    /**
     * `nativeTheme.shouldUseDarkColors` main — синхронно (`app:is-dark`), чтобы `.dark` встал до
     * первого кадра и на каждой перезагрузке страницы (раунд main-r2, п. 1).
     */
    isDark(): boolean;
    /** Двойной клик по пустому месту заголовка (кусок 2.3, спека 5.1). */
    titlebarDoubleClick(): void;
    /**
     * «Reveal in Finder» (кусок 3.4): main сверяет работу с `works.list` и показывает
     * папку проекта; незнакомая работа — отказ с кодом `not_found`.
     */
    revealWork(projectPath: string, workId: string): Promise<void>;
    /** Main-only status/exclusive creation in a known project's root. */
    openBacklog: (projectPath: string) => Promise<{ opened: boolean }>;
    parleyMd(projectPath: string, create: boolean): Promise<{ exists: boolean; created: boolean }>;
    /**
     * Только внутри корней любой работы; открывается только белый список, остальное
     * показывается в Finder (кусок 5.2, спека 10.8). Вне корней — отказ `files:denied`.
     */
    openPath(absPath: string): Promise<'opened' | 'revealed'>;
    /** Только внутри корней любой работы, иначе отказ `files:denied`; `~` раскрывает main. */
    showInFinder(absPath: string): Promise<void>;
    /**
     * Пункт «Paste» меню терминала (кусок 5.3, спека 8.4). Main: webContents.paste() окна — то же
     * событие paste, что у ⌘V; execCommand('paste') в песочнице не работает.
     */
    paste(): void;
    /**
     * Путь файла на диске, брошенного на терминал (кусок 5.4, спека 8.5): `webUtils.getPathForFile`
     * прелоада — в песочнице рендерер пути `File` не видит. '' — у `File` нет пути (синтетический).
     */
    pathForFile(file: File): string;
    /**
     * Картинка буфера обмена → PNG в `~/.parley/desktop/drops` (кусок 5.4). Источник — только
     * 'clipboard'; null — картинки нет или в буфере есть текст.
     */
    saveDropImage(source: 'clipboard'): Promise<string | null>;
    /**
     * Миниатюра картинки-вложения «Chat» для чипов поля ввода и ленты (`main/image-thumbnail.ts`): data-URL не шире
     * 320 px. `null` — не картинка (расширение, не обычный файл, больше 20 МБ) или файл не читается. Путь любой:
     * вложения лежат где угодно, не только в корнях работ.
     */
    imageThumbnail(path: string): Promise<string | null>;
    /**
     * Число несохранённых буферов редактора → main (`app:dirty-buffers`, кусок 7.3a) при каждом
     * изменении: на закрытии окна и ⌘Q main спрашивает, только если оно больше нуля.
     */
    setDirtyBuffers(count: number): void;
    /** Main отложил закрытие окна или выход (`app:confirm-close`): окно спрашивает и отвечает `answerClose`. */
    onConfirmClose(listener: () => void): () => void;
    /** Ответ на `app:confirm-close` (`app:close-answer`). */
    answerClose(answer: CloseAnswer): void;
    /**
     * Новая версия на GitHub (V6 плана релиза 0.1.0). При подписке отдаёт слушателю уже найденное (`app:get-update`:
     * main мог найти релиз, пока окно грузилось или показывало «Connecting…»), дальше — каждое событие
     * `app:update-available` от проверки main; одна и та же версия может прийти не раз (проверка — раз в сутки).
     * Проверка выключена переключателем или `PARLEY_UPDATE_CHECK=off` — не приходит ничего.
     */
    onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void;
  };
  /**
   * Файловый API main (спека 10.7): `stat` и `locate` — с этапа 5, `list`, `readText`,
   * `readBytes` и `write` — с 7.1a, git, поиск и слежение — с 7.1b. Отказы — коды
   * `files:denied`, `files:too-large`, `files:watch-failed`, `not_found`, `bad_request`
   * (`decodeIpcError`).
   */
  files: {
    /** До 200 путей; `null` — пути нет или он вне корня. */
    stat(root: FileRoot, paths: string[]): Promise<Array<FileStat | null>>;
    /** До 200 путей; корень ищется только среди корней работы workKey; `~` раскрывает main. */
    locate(workKey: string, absPaths: string[]): Promise<Array<Located | null>>;
    /** dir относительный, '' — корень; без `.git` и каталога состояния (`.parley`, `.harnas`), только файлы, папки и симлинки. */
    list(root: FileRoot, dir: string): Promise<DirEntry[]>;
    /** Больше 20 МБ — `files:too-large`; не обычный файл — `bad_request`. */
    readText(root: FileRoot, path: string): Promise<TextFile>;
    /** limit — 1 байт … 20 МБ, по умолчанию 20 МБ; больше — `files:too-large`. */
    readBytes(root: FileRoot, path: string, limit?: number): Promise<Uint8Array>;
    /** expectedMtimeMs: null — файла быть не должно: создать; уже есть — conflict. */
    write(root: FileRoot, path: string, text: string, expectedMtimeMs: number | null): Promise<WriteResult>;
    /** id подписки; path '' — дерево корня. Не запустилось — `files:watch-failed`. */
    watch(root: FileRoot, path: string): Promise<string>;
    unwatch(id: string): Promise<void>;
    /** Файл подписки изменился: дроссель 100 мс; `deleted` — файла нет. */
    onChanged(listener: (e: FileChangedEvent) => void): () => void;
    /** Пачка раз в 300 мс; rootKey — `shared/work-keys.ts`. */
    onTreeChanged(listener: (e: TreeChangedEvent) => void): () => void;
    /** Для ⌘P: git — отслеживаемые и новые без игнорируемых; не git — обход до 50 000. */
    lsFiles(root: FileRoot): Promise<FileList>;
    /** До 2000 совпадений и 200 файлов; отменён, остановлен по пределу — найденное с truncated. */
    grep(root: FileRoot, query: GrepQuery, signalId: string): Promise<GrepResult>;
    cancel(signalId: string): Promise<void>;
    /** rev — HEAD или 7–40 hex с ^; null — файла или ревизии нет. */
    gitShow(root: FileRoot, rev: string, path: string): Promise<TextFile | null>;
    /** Файлы коммита от первого родителя (у merge-коммита тоже), у корневого — от пустого дерева (8.3). */
    gitCommitFiles(root: FileRoot, hash: string): Promise<DiffFile[]>;
    /** Пути от папки корня; не git — {}. */
    gitStatus(root: FileRoot): Promise<Record<string, GitStatusLetter>>;
  };
  /**
   * Встроенный браузер (кусок 9.1, спека 12.5): main пускает только живого гостя `<webview>`
   * раздела `BROWSER_PARTITION`, иначе отказ `bad_request`.
   */
  browser: BrowserApi;
}

declare global {
  interface Window {
    parley: ParleyBridge;
  }
}
