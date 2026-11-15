import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateInfo, UpdateResult, UpdateState } from '../shared/bridge.js';
import { isNewerVersion, type UpdateFetch } from './update-check.js';
import {
  APP_FILE,
  runAttempt,
  systemClock,
  type Attempt,
  type AttemptClock,
  type AttemptDeps,
  type AttemptInput,
  type RunningProcess,
} from './update-download.js';
import { formatResult, helperScript } from './update-helper.js';
import type { QuitIntent } from './quit-intent.js';
import { HANDOFF_FILE } from './update-startup.js';
import {
  besideApp,
  bundleOf,
  installRefusal,
  probeLockf,
  stagingDir,
  type Bundle,
} from './update-target.js';

/**
 * Самообновление: установщик (спека self-update §5.1, §5.4). Держит состояние `UpdateState`, ведёт попытки загрузки
 * (`update-download.ts`) и решает, запустится ли сценарий замены на выходе: «Restart now» запоминает намерение и
 * вызывает «свой» `app.quit()` (`quit-intent.ts`), а слушатель события `quit` запускает сценарий, только если
 * намерение дожило до конца выхода.
 *
 * Окно ничего не передаёт: версию и адрес берёт установщик из релиза, найденного проверкой (`onFound`).
 */

/** Имя сценария в каталоге подготовки (§5.4, п. 2). */
export const HELPER_FILE = 'helper.sh';

/** Намерение «Restart now» (§5.4, клик, п. 3): всё, что нужно слушателю `quit`. */
export interface SwapIntent {
  version: string;
  /** Путь приложения. */
  app: string;
  /** Путь подготовленного приложения. */
  staged: string;
  /** Путь сценария. */
  helper: string;
  /** Путь файла итога рядом с приложением. */
  result: string;
}

/** Дочерний процесс сценария: ровно то, что установщик у него читает. */
export interface HelperChild {
  pid?: number | undefined;
  on(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}

export interface InstallerFs {
  /** Есть ли по пути каталог (без перехода по ссылке). */
  isDir(target: string): boolean;
  /** Пишет сценарий, права `0700`; ошибка — исключение. */
  writeScript(file: string, text: string): void;
  /** Создаёт пустой файл `handoff`, существующий не принимает; ошибка — исключение. */
  createEmpty(file: string): void;
  /** Пишет файл итога, существующий не затирает (флаг `wx`); ошибка — исключение. */
  writeNew(file: string, text: string): void;
}

function fileCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Файловые операции установщика на настоящей файловой системе. */
export const nodeInstallerFs: InstallerFs = {
  isDir(target) {
    try {
      return lstatSync(target).isDirectory();
    } catch {
      return false;
    }
  },
  writeScript(file, text) {
    writeFileSync(file, text, { mode: 0o700 });
  },
  createEmpty(file) {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  },
  writeNew(file, text) {
    writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  },
};

export interface InstallerDeps {
  /** Версия запущенной сборки: ниже или равную неё установщик не принимает. */
  version: string;
  /** `process.arch` запущенной сборки. */
  arch: string;
  /** Pid этого процесса main. */
  pid: number;
  /** Каталог загрузок в доме Parley (`<parleyHome>/desktop/updates`): у попытки `n` своя папка `<n>`. */
  updatesDir: string;
  /** Приложение, которое можно заменить (§5.2), или `null`: можно ли заменить себя прямо сейчас. */
  target(): Promise<Bundle | null>;
  fetch: UpdateFetch;
  run(command: string, args: string[]): RunningProcess;
  clock?: AttemptClock;
  fs: InstallerFs;
  intent: QuitIntent<SwapIntent>;
  /** `app.quit()` (ровно он: «свой» вызов оборачивает установщик). */
  quit(): void;
  spawn(command: string, args: string[], options: { detached: true; stdio: 'ignore' }): HelperChild;
  /** Итог замены, прочитанный стартом окна; отдаётся один раз (`takeResult`). */
  startupResult: UpdateResult | null;
  log(message: string, error?: unknown): void;
  /** Подмена попытки загрузки: только в тестах. */
  runAttempt?: (deps: AttemptDeps, input: AttemptInput) => Attempt;
}

export interface UpdateInstaller {
  /** Проверка нашла релиз (§5.1, «Проверка нашла релиз»). Не бросает. */
  onFound(info: UpdateInfo): Promise<void>;
  /** Переключатель «Check for updates» выключили: `idle`, попытка отменяется, готовая удаляется. */
  checksDisabled(): Promise<void>;
  /** Из `available` (с `canInstall`) и `failed` — загрузка. Из прочих — ничего. */
  download(): Promise<void>;
  /** Из `downloading` и `verifying` — отмена, `available` с последней найденной версией. */
  cancel(): Promise<void>;
  /** Из `ready` — «Restart now» (§5.4); состояние остаётся `ready`. Из прочих — ничего. */
  install(): Promise<void>;
  state(): UpdateState;
  /** Слушатель каждого изменения состояния (текущее состояние сразу не отдаётся); возвращает отписку. */
  onState(listener: (state: UpdateState) => void): () => void;
  /** Слушатель события `quit`: синхронный, срабатывает один раз (§5.4, «Событие `quit`»). */
  onQuit(): void;
  /** Итог замены для тоста при старте: один раз, потом `null`. */
  takeResult(): UpdateResult | null;
}

interface Selected {
  id: number;
  info: UpdateInfo;
  attempt: Attempt | null;
  /** Подготовленное приложение попытки (`<каталог подготовки>/Parley.app`); известно, когда попытка запущена. */
  staged: string | null;
}

export function createUpdateInstaller(deps: InstallerDeps): UpdateInstaller {
  const clock = deps.clock ?? systemClock;
  const startAttempt = deps.runAttempt ?? runAttempt;
  const listeners = new Set<(state: UpdateState) => void>();

  let current: UpdateState = { phase: 'idle' };
  /** Последний релиз, найденный проверкой: к нему возвращает отмена. */
  let latest: UpdateInfo | null = null;
  /** Релиз, выбранный кликом: пока он не установлен, не отменён или не отказал, находки его не меняют. */
  let selected: Selected | null = null;
  let counter = 0;
  let installing = false;
  let started = false;
  let startupResult = deps.startupResult;

  const setState = (next: UpdateState): void => {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        deps.log('self-update: state listener failed', error);
      }
    }
  };

  const safeTarget = async (): Promise<Bundle | null> => {
    try {
      return await deps.target();
    } catch (error) {
      deps.log('self-update: replace check failed', error);
      return null;
    }
  };

  /** Выбранный релиз снят: его попытка забыта, итог отменённой больше состояния не меняет. */
  const release = (): Attempt | null => {
    const attempt = selected?.attempt ?? null;
    selected = null;
    return attempt;
  };

  const toAvailable = async (info: UpdateInfo, guard: () => boolean): Promise<void> => {
    const canInstall = (await safeTarget()) !== null;
    if (!guard()) return;
    setState({ phase: 'available', version: info.version, url: info.url, canInstall });
  };

  /** Находка меняет состояние только из `idle`, `available` и `failed`, и только если версия другая (§5.1). */
  const takesFound = (info: UpdateInfo): boolean => {
    if (current.phase === 'idle') return true;
    if (current.phase === 'available' || current.phase === 'failed')
      return current.version !== info.version;
    return false;
  };

  const fail = (
    info: UpdateInfo,
    reason: Extract<UpdateState, { phase: 'failed' }>['reason'],
  ): void => {
    setState({ phase: 'failed', version: info.version, url: info.url, reason });
  };

  const run = async (): Promise<void> => {
    const chosen = selected;
    if (chosen === null) return;
    const bundle = await safeTarget();
    // Пока ждали ответа, выбор могли отменить или заменить: итог чужой попытки состояния не меняет.
    if (selected !== chosen) return;
    if (bundle === null) {
      release();
      fail(chosen.info, 'cannot_replace');
      return;
    }
    const { info } = chosen;
    const attempt = startAttempt(
      {
        fetch: deps.fetch,
        clock,
        run: (command, args) => {
          // Первый дочерний процесс (`ditto`) — архив скачан и сверен, началась проверка и распаковка.
          if (selected === chosen && current.phase === 'downloading') {
            setState({ phase: 'verifying', version: info.version, url: info.url });
          }
          return deps.run(command, args);
        },
        onProgress: (received, total) => {
          if (selected !== chosen || current.phase !== 'downloading') return;
          setState({ phase: 'downloading', version: info.version, url: info.url, received, total });
        },
      },
      {
        version: info.version,
        arch: deps.arch,
        downloadDir: path.join(deps.updatesDir, String(chosen.id)),
        stagingDir: stagingDir(bundle, deps.pid, chosen.id),
      },
    );
    chosen.attempt = attempt;
    chosen.staged = path.join(stagingDir(bundle, deps.pid, chosen.id), APP_FILE);
    let outcome;
    try {
      outcome = await attempt.done;
    } catch (error) {
      deps.log('self-update: attempt failed unexpectedly', error);
      outcome = { ok: false as const, reason: 'disk' as const };
    }
    // Итог отменённой и вытесненной попытки состояния не меняет.
    if (selected !== chosen) return;
    if (outcome.ok) {
      setState({ phase: 'ready', version: info.version, url: info.url });
      return;
    }
    if (outcome.reason === 'cancelled') return;
    release();
    fail(info, outcome.reason);
  };

  /** Готовое или идущее удаляется: отмена ждёт конца дочернего процесса и удаления каталогов. */
  const discard = async (attempt: Attempt | null): Promise<void> => {
    try {
      await attempt?.cancel();
    } catch (error) {
      deps.log('self-update: cannot discard the attempt', error);
    }
  };

  const refusal = (swap: SwapIntent): void => {
    try {
      deps.fs.writeNew(
        swap.result,
        `${formatResult({ kind: 'failed', version: swap.version, reason: 'helper' })}\n`,
      );
    } catch (error) {
      // Файл уже есть (флаг `wx`) или не пишется: основной итог важнее, а Parley и так выходит.
      if (fileCode(error) !== 'EEXIST')
        deps.log('self-update: cannot write the helper failure', error);
    }
  };

  return {
    async onFound(info) {
      if (!isNewerVersion(info.version, deps.version)) return;
      latest = info;
      if (!takesFound(info)) return;
      await toAvailable(info, () => latest?.version === info.version && takesFound(info));
    },

    async checksDisabled() {
      latest = null;
      const wasReady = current.phase === 'ready';
      const attempt = release();
      installing = false;
      setState({ phase: 'idle' });
      if (wasReady) deps.intent.clear();
      await discard(attempt);
    },

    async download() {
      if (selected !== null) return;
      let info: UpdateInfo;
      if (current.phase === 'available' && current.canInstall) {
        info = { version: current.version, url: current.url };
      } else if (current.phase === 'failed') {
        info = { version: current.version, url: current.url };
      } else {
        return;
      }
      counter += 1;
      selected = { id: counter, info, attempt: null, staged: null };
      setState({
        phase: 'downloading',
        version: info.version,
        url: info.url,
        received: 0,
        total: null,
      });
      await run();
    },

    async cancel() {
      if (current.phase !== 'downloading' && current.phase !== 'verifying') return;
      const attempt = release();
      const info = latest ?? { version: current.version, url: current.url };
      // Загрузка начиналась только там, где заменить себя можно; точное значение пересчитывается следом.
      setState({ phase: 'available', version: info.version, url: info.url, canInstall: true });
      void toAvailable(
        info,
        () => current.phase === 'available' && current.version === info.version,
      );
      await discard(attempt);
    },

    async install() {
      const chosen = selected;
      if (current.phase !== 'ready' || chosen === null || installing) return;
      installing = true;
      try {
        const info = chosen.info;
        const bundle = await safeTarget();
        // Пока ждали, готовое могли отменить (переключатель): тогда делать нечего.
        if (selected !== chosen || current.phase !== 'ready') return;
        const stagedApp = chosen.staged;
        if (bundle === null || stagedApp === null || !deps.fs.isDir(stagedApp)) {
          const attempt = release();
          fail(info, 'cannot_replace');
          await discard(attempt);
          return;
        }
        const dir = path.dirname(stagedApp);
        const helper = path.join(dir, HELPER_FILE);
        try {
          deps.fs.writeScript(helper, helperScript());
        } catch (error) {
          deps.log('self-update: cannot write the helper', error);
          const attempt = release();
          fail(info, 'disk');
          await discard(attempt);
          return;
        }
        deps.intent.arm({
          version: info.version,
          app: bundle.app,
          staged: stagedApp,
          helper,
          result: besideApp(bundle).result,
        });
        deps.intent.ownQuit(() => deps.quit());
      } finally {
        installing = false;
      }
    },

    state: () => current,

    onState(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    onQuit() {
      if (started) return;
      started = true;
      const swap = deps.intent.take();
      if (swap === null) return;
      // 1. Каталог подготовки отдан сценарию: с этого мига старт окна его не удаляет (§5.4).
      try {
        deps.fs.createEmpty(path.join(path.dirname(swap.staged), HANDOFF_FILE));
      } catch (error) {
        deps.log('self-update: cannot create the handoff file', error);
        refusal(swap);
        return;
      }
      // 2. Сценарий: сразу слушатель `error`, затем `unref`. Отказ, видный сразу, — в файл итога.
      try {
        const child = deps.spawn(
          '/bin/sh',
          [swap.helper, String(deps.pid), swap.app, swap.staged, swap.version, swap.result],
          { detached: true, stdio: 'ignore' },
        );
        child.on('error', (error) => deps.log('self-update: the helper failed to run', error));
        child.unref();
        if (child.pid === undefined) refusal(swap);
      } catch (error) {
        deps.log('self-update: cannot start the helper', error);
        refusal(swap);
      }
    },

    takeResult() {
      const result = startupResult;
      startupResult = null;
      return result;
    },
  };
}

/** Что нужно, чтобы решить, можно ли заменить себя (§5.2). */
export interface ReplaceEnv {
  platform: string;
  packaged: boolean;
  /** Путь исполняемого файла после `realpath`; может бросить. */
  exePath(): string;
  canWrite(target: string): boolean;
  /** Пробный вызов `lockf` (`probeLockf` на файле в каталоге загрузок); вызывается не больше раза. */
  probeLockf(): Promise<boolean>;
}

/**
 * Приложение, которое можно заменить, по условиям §5.2 без пробы `lockf`; `null` — нельзя. Для старта окна: там
 * ответ `lockf` не нужен (§5.6), хватает платформы, сборки, пути и права записи.
 */
export function replaceBundle(env: ReplaceEnv): Bundle | null {
  let exePath: string;
  try {
    exePath = env.exePath();
  } catch {
    return null;
  }
  const refused = installRefusal({
    platform: env.platform,
    packaged: env.packaged,
    exePath,
    canWrite: env.canWrite,
    lockfWorks: true,
  });
  return refused === null ? bundleOf(exePath) : null;
}

/**
 * «Можно ли заменить себя» целиком, с пробой `lockf`: проба идёт один раз за запуск и только когда прочие условия
 * выполнены; ответ запоминается.
 */
export function createReplaceTarget(env: ReplaceEnv): () => Promise<Bundle | null> {
  let probe: Promise<boolean> | null = null;
  return async () => {
    const bundle = replaceBundle(env);
    if (bundle === null) return null;
    probe ??= Promise.resolve()
      .then(() => env.probeLockf())
      .catch(() => false);
    return (await probe) ? bundle : null;
  };
}

/** Код выхода программы; `null` — запуск не удался. Для `probeLockf`. */
export function runExitCode(file: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { stdio: 'ignore' });
      child.once('error', () => resolve(null));
      child.once('close', (code) => resolve(code));
    } catch {
      resolve(null);
    }
  });
}

/** `ReplaceEnv` на настоящей системе; пробный файл `lockf` лежит в каталоге загрузок. */
export function systemReplaceEnv(options: {
  packaged: boolean;
  exePath(): string;
  updatesDir: string;
}): ReplaceEnv {
  return {
    platform: process.platform,
    packaged: options.packaged,
    exePath: () => realpathSync(options.exePath()),
    canWrite: (target) => {
      try {
        accessSync(target, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    probeLockf: () => {
      mkdirSync(options.updatesDir, { recursive: true });
      return probeLockf(runExitCode, path.join(options.updatesDir, 'lockf-probe'));
    },
  };
}
