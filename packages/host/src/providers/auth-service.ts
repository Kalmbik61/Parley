/**
 * Служба входа в аккаунты подписки (спека подписок 5.5, К5, К14, К17): состояние входа берётся у самого CLI
 * (`claude auth status --json`), вход идёт в своём маленьком PTY (`claude auth login --claudeai` печатает ссылку и ждёт
 * на stdin код из браузера), выход — `claude auth logout`. Parley не читает ни связку ключей, ни `.credentials.json`:
 * вся работа с входом — команды CLI в окружении аккаунта (`providerLaunchEnv` без ключа, `CLAUDE_CONFIG_DIR` папки).
 *
 * Это не `PtyManager` сессий (К14): у входа нет `SessionRef`, а слушатели активности, ленты и будильника не должны
 * видеть его вывод — он идёт окну отдельным событием `providers.signInOutput`. Замок входа свой (К17), а не очередь
 * `serialized` своих провайдеров: та держит и подготовку папок при каждом запуске, десять минут входа остановили бы
 * все запуски.
 */

import { execFile } from 'node:child_process';
import { commandBinary, isManagedProviderId, loadProviders } from '@parley/core';
import type { ProviderEntry } from '@parley/core';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { spawnPty } from '../pty/pty-process.js';
import type { ExitInfo, PtyLaunch, PtyProcess } from '../pty/pty-process.js';
import { providerLaunchEnv } from '../sessions/provider-env.js';

/** Тот же спавн node-pty, что у сессий; подмена — в тестах. */
export type PtySpawn = (launch: PtyLaunch, size: { cols: number; rows: number }) => PtyProcess;

/** Одноразовая команда CLI (не PTY): код возврата и stdout. Не запустилась или не уложилась в срок — отказ. */
export type AuthExec = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<{ code: number; stdout: string }>;

export interface AuthServiceOptions {
  spawn?: PtySpawn;
  exec?: AuthExec;
  now?: () => number;
  /** Сколько ждать входа, мс; потом процесс убивается, как по `cancel`. По умолчанию десять минут (спека подписок 5.5). */
  timeoutMs?: number;
  /** Не чаще одной проверки состояния на аккаунт за это время, мс (К5). По умолчанию 30 секунд. */
  minGapMs?: number;
  /** Сколько ждать выхода после SIGHUP, мс, прежде чем добить процесс входа SIGKILL. По умолчанию 3 секунды, как у сессий. */
  killGraceMs?: number;
}

export interface AuthService {
  /** Кэш последней проверки: `true` вошёл, `false` нет, `null` — ещё не проверяли. */
  status(id: string): boolean | null;
  /** Подпись входа из ответа CLI (`e-mail · план`); `null` — нет данных или не вошёл. */
  detail(id: string): string | null;
  /** Процесс входа этого аккаунта жив. */
  signingIn(id: string): boolean;
  /**
   * Команда статуса, не чаще раза в `minGapMs` на аккаунт (К5), иначе кэш. Не отказывает; не аккаунт — `false`.
   * `force` — мимо кэша: эпизод `sign-in` у сессии говорит, что вход слетел, и 30 секунд старого `true` не нужны.
   */
  refresh(id: string, force?: boolean): Promise<boolean>;
  /** `refresh` для каждого аккаунта реестра: старт хоста и ручное обновление. Не отказывает. */
  refreshAll(): Promise<void>;
  /** Поднимает PTY входа; `conflict`, если вход (любого аккаунта) уже идёт. Возвращается сразу после старта процесса. */
  signIn(id: string, size?: { cols: number; rows: number }): Promise<void>;
  /** Вставка кода из браузера в терминал входа; нет входа этого аккаунта — ничего. */
  input(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Убивает процесс входа этого аккаунта; выход идёт обычным путём. */
  cancel(id: string): void;
  /** `logout` CLI, затем свежая проверка. */
  signOut(id: string): Promise<void>;
  /**
   * `logout` CLI перед удалением аккаунта (спека подписок 10, решение 12): вход лежит в связке ключей под именем папки, и
   * новый аккаунт на том же id унаследовал бы его. Не смотрит на кэш состояния (оно могло устареть или быть `null`), идущий
   * вход этого аккаунта обрывает; не отказывает — сбой попадает в журнал по коду, удаление идёт дальше.
   */
  logout(id: string): Promise<void>;
  /** Аккаунт удалён: кэш забыт, идущая проверка его не запишет, идущий вход прерван. */
  forget(id: string): void;
  stop(): void;
}

export interface AuthCommands {
  status: string[];
  login: string[];
  logout: string[];
  /** Вошёл ли аккаунт по ответу команды `status`. */
  parse(code: number, stdout: string): boolean;
  /** Подпись для карточки: `e-mail · план`, если CLI их назвал. */
  detail(stdout: string): string | null;
}

const SIGN_IN_TIMEOUT_MS = 600_000;
const STATUS_MIN_GAP_MS = 30_000;
/** Одноразовая команда CLI не должна висеть дольше этого: сеть у `auth status` не нужна, но CLI мог зависнуть. */
const EXEC_TIMEOUT_MS = 30_000;
/** Через сколько после SIGHUP процесс входа добивается SIGKILL (как `PtyManager.stop`, спека 4.1). */
const KILL_GRACE_MS = 3000;
/** Ссылка входа длинная; окно присылает свой размер через `providers.signInResize`. */
const DEFAULT_SIZE = { cols: 100, rows: 24 };

function statusJson(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** Команды входа семейства CLI (спека подписок 5.5). Codex — этап 3: до него записей Codex у хоста нет. */
export function authCommands(entry: ProviderEntry): AuthCommands {
  if (entry.family !== 'claude') throw new Error(`no sign-in commands for ${entry.id}`);
  return {
    status: ['auth', 'status', '--json'],
    login: ['auth', 'login', '--claudeai'],
    logout: ['auth', 'logout'],
    // Не вошедший CLI отвечает JSON с `loggedIn: false` и ненулевым кодом: решает поле, а не код.
    parse: (code, stdout) => statusJson(stdout)?.['loggedIn'] === true,
    detail: (stdout) => {
      const json = statusJson(stdout);
      const parts = [textOf(json?.['email']), textOf(json?.['subscriptionType'])].filter((part) => part !== null);
      return parts.length === 0 ? null : parts.join(' · ');
    },
  };
}

/** Аккаунт подписки из реестра или `undefined`: id чужого вида, встроенный провайдер и удалённая запись — не аккаунты. */
async function findAccount(id: string): Promise<ProviderEntry | undefined> {
  if (!isManagedProviderId(id)) return undefined;
  const registry = await loadProviders();
  const entry = Object.hasOwn(registry, id) ? registry[id] : undefined;
  return entry?.account === undefined ? undefined : entry;
}

/** То же для методов окна: не аккаунт — `bad_request`. */
export async function accountEntry(id: string): Promise<ProviderEntry> {
  const entry = await findAccount(id);
  if (entry === undefined) throw new HostError('bad_request', `${id} is not an account`);
  return entry;
}

/** Команда, папка и окружение аккаунта: без ключей и токена хоста, с `CLAUDE_CONFIG_DIR` его папки (спека подписок 5.3). */
function launchOf(entry: ProviderEntry): { binary: string; cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = entry.runner.configDir;
  if (cwd === undefined) throw new HostError('internal', 'The account has no folder');
  return { binary: commandBinary(entry.runner.command), cwd, env: providerLaunchEnv(entry, process.env, {}, null) };
}

const execCli: AuthExec = (command, args, env, cwd) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { env, cwd, timeout: EXEC_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error === null) return resolve({ code: 0, stdout });
        // Ненулевой выход CLI (`auth status` без входа) — ответ, а не сбой запуска; не запустился или убит по таймауту — сбой.
        if (typeof error.code === 'number' && error.killed !== true) return resolve({ code: error.code, stdout });
        reject(error);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });

/** Выход по сигналу (отмена, таймаут) не должен выглядеть успехом: сигнал — как в оболочке, 128 + номер. */
const exitCodeOf = ({ exitCode, signal }: ExitInfo): number => (signal !== null && signal !== 0 ? 128 + signal : exitCode);

/**
 * Для журнала хоста: код, флаги и первая строка сообщения. Ошибка `execFile` несёт ещё и stderr команды, а он в журнал
 * не идёт (в нём может оказаться что угодно, что напечатал CLI).
 */
function describeFailure(error: unknown): { code?: unknown; killed?: unknown; signal?: unknown; message: string } {
  if (typeof error !== 'object' || error === null) return { message: String(error).split('\n')[0]!.slice(0, 200) };
  const { code, killed, signal, message } = error as { code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  return { code, killed, signal, message: String(message ?? error).split('\n')[0]!.slice(0, 200) };
}

interface SignInRun {
  id: string;
  /** `null`, пока реестр читается и процесс ещё не запущен: замок уже занят (два `signIn` подряд не пройдут оба). */
  process: PtyProcess | null;
  /** Таймаут входа. */
  timer: NodeJS.Timeout | undefined;
  /** SIGKILL после SIGHUP, если процесс не вышел. */
  killTimer: NodeJS.Timeout | undefined;
  exited: boolean;
}

export function createAuthService(host: HostContext, options: AuthServiceOptions = {}): AuthService {
  const spawn: PtySpawn = options.spawn ?? spawnPty;
  const exec = options.exec ?? execCli;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
  const minGapMs = options.minGapMs ?? STATUS_MIN_GAP_MS;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

  const states = new Map<string, { signedIn: boolean; detail: string | null; at: number }>();
  const inflight = new Map<string, Promise<boolean>>();
  /** Счётчик забвений: проверка, начатая до `forget`, уже ничего не запишет. */
  const generations = new Map<string, number>();
  const generation = (id: string): number => generations.get(id) ?? 0;
  /** Один вход на весь хост (К17): у `codex login` порт обратного вызова один, второй вход упал бы. */
  let lock: SignInRun | null = null;
  let stopped = false;

  /** Одна проверка: команда статуса в окружении аккаунта; `providers.changed` только при смене состояния. */
  async function run(id: string): Promise<boolean> {
    // До чтения реестра: `forget` во время чтения тоже должен отменить запись исхода.
    const started = generation(id);
    const entry = await findAccount(id);
    if (entry === undefined) {
      states.delete(id);
      return false;
    }
    if (stopped) return states.get(id)?.signedIn ?? false;
    const commands = authCommands(entry);
    const { binary, cwd, env } = launchOf(entry);
    const result = await exec(binary, commands.status, env, cwd);
    if (stopped || started !== generation(id)) return false;
    const signedIn = commands.parse(result.code, result.stdout);
    const before = states.get(id)?.signedIn ?? null;
    states.set(id, { signedIn, detail: signedIn ? commands.detail(result.stdout) : null, at: now() });
    if (before !== signedIn) host.broadcast('providers.changed', { provider: id });
    return signedIn;
  }

  /**
   * `force` — после входа и выхода: кэш в этот момент заведомо устарел. Идущую проверку обычный вызов делит, а
   * принудительный ждёт её конца и спрашивает заново (та началась до входа и могла увидеть старое). Не отказывает.
   */
  function check(id: string, force: boolean): Promise<boolean> {
    const running = inflight.get(id);
    if (running !== undefined && !force) return running;
    const cached = states.get(id);
    if (!force && cached !== undefined && now() - cached.at < minGapMs) return Promise.resolve(cached.signedIn);
    const started = generation(id);
    const next: Promise<boolean> = (running ?? Promise.resolve(false))
      .then(() => run(id))
      .catch((error: unknown) => {
        // Команда не запустилась или не уложилась в срок: состояние прежнее, окно в 30 с не занимается — повтор сразу.
        host.log.warn('вход аккаунта: проверка состояния не удалась', { id, ...describeFailure(error) });
        // Первая проверка не удалась: «не знаем» навсегда не оставляем — `false`, чтобы окно показало состояние и Sign in
        // (спека подписок 10); `at` в далёком прошлом, поэтому следующая проверка не ждёт 30 с.
        if (!stopped && started === generation(id) && !states.has(id)) {
          states.set(id, { signedIn: false, detail: null, at: Number.NEGATIVE_INFINITY });
          host.broadcast('providers.changed', { provider: id });
        }
        return states.get(id)?.signedIn ?? false;
      })
      .finally(() => {
        if (inflight.get(id) === next) inflight.delete(id);
      });
    inflight.set(id, next);
    return next;
  }

  async function finishSignIn(finished: SignInRun, exit: ExitInfo): Promise<void> {
    finished.exited = true;
    clearTimeout(finished.timer);
    clearTimeout(finished.killTimer);
    if (lock === finished) lock = null;
    if (stopped) return;
    const signedIn = await check(finished.id, true);
    host.broadcast('providers.signInExit', { provider: finished.id, exitCode: exitCodeOf(exit), signedIn });
    // `signingIn` стал false, даже если состояние входа не изменилось (отмена): окно перечитывает строку провайдера.
    host.broadcast('providers.changed', { provider: finished.id });
  }

  /**
   * SIGHUP, а не вышел за `killGraceMs` — SIGKILL (как `PtyManager.stop`): замок снимается только на выходе процесса, и
   * `claude auth login`, не реагирующий на SIGHUP, держал бы его до перезапуска хоста.
   */
  function terminate(target: SignInRun): void {
    const child = target.process;
    if (child === null || target.exited) return;
    child.kill('SIGHUP');
    if (target.killTimer !== undefined) return;
    target.killTimer = setTimeout(() => {
      if (!target.exited) child.kill('SIGKILL');
    }, killGraceMs);
    target.killTimer.unref();
  }

  function cancel(id: string): void {
    const current = lock;
    if (current === null || current.id !== id) return;
    // Процесс ещё не запущен (читается реестр): замок снят, `signIn` увидит это после await и откажется.
    if (current.process === null) {
      lock = null;
      return;
    }
    terminate(current);
  }

  return {
    status: (id) => states.get(id)?.signedIn ?? null,
    detail: (id) => states.get(id)?.detail ?? null,
    signingIn: (id) => lock !== null && lock.id === id && lock.process !== null,
    refresh: (id, force = false) => check(id, force),

    async refreshAll() {
      try {
        const registry = await loadProviders();
        if (stopped) return;
        await Promise.all(
          Object.values(registry)
            .filter((entry) => entry.account !== undefined)
            .map((entry) => check(entry.id, false)),
        );
      } catch (error) {
        host.log.warn('вход аккаунтов: реестр не прочитался', describeFailure(error));
      }
    },

    async signIn(id, size = DEFAULT_SIZE) {
      if (stopped) throw new HostError('conflict', 'the host is shutting down');
      // Замок занимается до первого await: два вызова подряд не пройдут оба.
      if (lock !== null) throw new HostError('conflict', 'another sign-in is running');
      const started: SignInRun = { id, process: null, timer: undefined, killTimer: undefined, exited: false };
      lock = started;
      let child: PtyProcess;
      try {
        const entry = await accountEntry(id);
        if (lock !== started) throw new HostError('conflict', 'the sign-in was cancelled');
        const { binary, cwd, env } = launchOf(entry);
        child = spawn({ command: binary, args: authCommands(entry).login, cwd, env }, size);
      } catch (error) {
        if (lock === started) lock = null;
        if (error instanceof HostError) throw error;
        host.log.warn('вход аккаунта: процесс не запустился', { id, ...describeFailure(error) });
        throw new HostError('internal', 'Unable to start the sign-in');
      }
      started.process = child;
      started.timer = setTimeout(() => cancel(id), timeoutMs);
      started.timer.unref();
      // Вывод входа — ссылка и поле кода — в журнал не пишется.
      child.onData((data) => host.broadcast('providers.signInOutput', { provider: id, data }));
      child.onExit((exit) => void finishSignIn(started, exit));
      // `signingIn` стал true.
      host.broadcast('providers.changed', { provider: id });
    },

    input(id, data) {
      if (lock === null || lock.id !== id) return;
      try {
        lock.process?.write(data);
      } catch {
        // Гонка с выходом процесса: запись в закрытый PTY — не ошибка, выход придёт своим событием.
      }
    },

    resize(id, cols, rows) {
      if (lock === null || lock.id !== id) return;
      lock.process?.resize(cols, rows);
    },

    cancel,

    async signOut(id) {
      const entry = await accountEntry(id);
      if (lock !== null && lock.id === id) throw new HostError('conflict', 'a sign-in is running for this account');
      const commands = authCommands(entry);
      const { binary, cwd, env } = launchOf(entry);
      try {
        await exec(binary, commands.logout, env, cwd);
      } catch (error) {
        host.log.warn('вход аккаунта: logout не удался', { id, ...describeFailure(error) });
        throw new HostError('internal', 'Unable to sign out');
      } finally {
        // Что бы ни случилось с `logout`, правду говорит свежая проверка.
        await check(id, true);
      }
    },

    async logout(id) {
      try {
        const entry = await accountEntry(id);
        // Идущий вход дописал бы вход в связку ключей после выхода.
        cancel(id);
        const { binary, cwd, env } = launchOf(entry);
        const result = await exec(binary, authCommands(entry).logout, env, cwd);
        if (result.code !== 0) host.log.warn('вход аккаунта: logout перед удалением вернул ошибку', { id, code: result.code });
      } catch (error) {
        host.log.warn('вход аккаунта: logout перед удалением не удался', { id, ...describeFailure(error) });
      }
    },

    forget(id) {
      generations.set(id, generation(id) + 1);
      states.delete(id);
      inflight.delete(id);
      cancel(id);
    },

    stop() {
      stopped = true;
      const current = lock;
      lock = null;
      if (current === null) return;
      clearTimeout(current.timer);
      terminate(current);
    },
  };
}
