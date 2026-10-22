import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '@parley/core';
import type { ProviderEntry } from '@parley/core';
import type { HostContext } from '../context.js';
import type { ExitInfo, PtyLaunch, PtyProcess } from '../pty/pty-process.js';
import { accountEntry, authCommands, createAuthService } from './auth-service.js';
import type { AuthExec, AuthService, AuthServiceOptions, PtySpawn } from './auth-service.js';

const ID = 'custom-claude-2';
const OTHER = 'custom-claude-3';
const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max', orgName: 'Secret Org' });
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });

let home = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['PARLEY_HOME', 'PARLEY_CLAUDE_BIN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'];
let stoppers: Array<() => void> = [];

const folder = (id: string): string => path.join(home, 'providers', id);

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-auth-'));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env['PARLEY_HOME'] = home;
  process.env['PARLEY_CLAUDE_BIN'] = '/stub/claude';
  // Унаследованное хостом: срезается из окружения команд.
  process.env['ANTHROPIC_API_KEY'] = 'sk-host-key';
  process.env['ANTHROPIC_AUTH_TOKEN'] = 'host-token';
  process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'host-oauth';
  process.env['CLAUDE_CONFIG_DIR'] = '/host/claude';
  await writeFile(
    path.join(home, 'custom-providers.json'),
    JSON.stringify({
      version: 1,
      providers: [
        { kind: 'claude-account', id: ID, label: 'Claude Code 2', link: false },
        { kind: 'claude-account', id: OTHER, label: 'Claude Code 3', link: false },
      ],
    }),
  );
  stoppers = [];
});

afterEach(async () => {
  for (const stop of stoppers) stop();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------------------------

interface Event {
  event: string;
  data: unknown;
}

function fakeHost(): { host: HostContext; events: Event[]; warnings: string[]; fields: object[] } {
  const events: Event[] = [];
  const warnings: string[] = [];
  const fields: object[] = [];
  const host = {
    log: {
      info: () => {},
      warn: (message: string, data?: object) => (warnings.push(message), fields.push(data ?? {})),
      error: () => {},
    },
    broadcast: (event: string, data: unknown) => events.push({ event, data }),
  } as unknown as HostContext;
  return { host, events, warnings, fields };
}

interface FakeProcess extends PtyProcess {
  launch: PtyLaunch;
  size: { cols: number; rows: number };
  written: string[];
  resizes: Array<[number, number]>;
  kills: number;
  signals: Array<NodeJS.Signals | undefined>;
  emit(data: string): void;
  exit(info?: Partial<ExitInfo>): void;
}

/** `ignoreHup` — процесс не реагирует на SIGHUP и выходит только по SIGKILL (как зависший `claude auth login`). */
function fakeSpawn(options: { ignoreHup?: boolean } = {}): { spawn: PtySpawn; processes: FakeProcess[] } {
  const processes: FakeProcess[] = [];
  const spawn: PtySpawn = (launch, size) => {
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(exit: ExitInfo) => void>();
    const process_: FakeProcess = {
      launch,
      size,
      pid: 4242,
      written: [],
      resizes: [],
      kills: 0,
      signals: [],
      write: (data) => void process_.written.push(data),
      resize: (cols, rows) => void process_.resizes.push([cols, rows]),
      // SIGHUP, как у настоящего node-pty: процесс завершается по сигналу, код 0.
      kill: (signal) => {
        process_.kills += 1;
        process_.signals.push(signal);
        if (signal === 'SIGKILL') process_.exit({ exitCode: 0, signal: 9 });
        else if (options.ignoreHup !== true) process_.exit({ exitCode: 0, signal: 1 });
      },
      onData: (listener) => (dataListeners.add(listener), () => dataListeners.delete(listener)),
      onExit: (listener) => (exitListeners.add(listener), () => exitListeners.delete(listener)),
      emit: (data) => dataListeners.forEach((listener) => listener(data)),
      exit: (info = {}) => exitListeners.forEach((listener) => listener({ exitCode: 0, signal: null, ...info })),
    };
    processes.push(process_);
    return process_;
  };
  return { spawn, processes };
}

type ExecCall = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string };

/** `exec`, отвечающий по очереди; последний ответ повторяется. */
function fakeExec(...replies: Array<{ code?: number; stdout: string } | Error>): { exec: AuthExec; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec: AuthExec = async (command, args, env, cwd) => {
    calls.push({ command, args, env, cwd });
    const reply = replies[Math.min(calls.length, replies.length) - 1] ?? { stdout: SIGNED_OUT };
    if (reply instanceof Error) throw reply;
    return { code: reply.code ?? 0, stdout: reply.stdout };
  };
  return { exec, calls };
}

function boot(options: AuthServiceOptions = {}): { auth: AuthService; events: Event[]; warnings: string[]; fields: object[] } {
  const { host, events, warnings, fields } = fakeHost();
  const auth = createAuthService(host, options);
  stoppers.push(() => auth.stop());
  return { auth, events, warnings, fields };
}

const eventsOf = (events: Event[], name: string): unknown[] => events.filter((item) => item.event === name).map((item) => item.data);

/** Дождаться, пока служба разошлёт `providers.signInExit` (реестр читается с настоящего диска). */
const exited = (events: Event[], count = 1): Promise<void> =>
  vi.waitFor(() => expect(eventsOf(events, 'providers.signInExit')).toHaveLength(count));

// ---------------------------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------------------------

describe('authCommands — команды самого CLI (спека подписок 5.5)', () => {
  const claude = PROVIDERS.claude as ProviderEntry;

  it('claude: status --json, login --claudeai, logout', () => {
    const commands = authCommands(claude);
    expect(commands.status).toEqual(['auth', 'status', '--json']);
    expect(commands.login).toEqual(['auth', 'login', '--claudeai']);
    expect(commands.logout).toEqual(['auth', 'logout']);
  });

  it('parse: вошёл только при loggedIn === true; код возврата не решает, мусор — не вошёл', () => {
    const { parse } = authCommands(claude);
    expect(parse(0, SIGNED_IN)).toBe(true);
    expect(parse(1, SIGNED_OUT)).toBe(false);
    expect(parse(0, '{"loggedIn":"true"}')).toBe(false);
    expect(parse(0, 'not json')).toBe(false);
    expect(parse(0, '')).toBe(false);
    expect(parse(0, 'null')).toBe(false);
  });

  it('detail: e-mail и план через « · »; организация не попадает; нет полей — null', () => {
    const { detail } = authCommands(claude);
    expect(detail(SIGNED_IN)).toBe('me@example.com · max');
    expect(detail('{"loggedIn":true,"email":"me@example.com"}')).toBe('me@example.com');
    expect(detail('{"loggedIn":true,"subscriptionType":"pro"}')).toBe('pro');
    expect(detail('{"loggedIn":true}')).toBeNull();
    expect(detail('not json')).toBeNull();
  });

  it('семейство без команд входа (Codex — этап 3) — отказ, а не молчаливые команды Claude', () => {
    expect(() => authCommands(PROVIDERS.codex as ProviderEntry)).toThrow();
  });
});

describe('accountEntry — только аккаунты подписки', () => {
  it('аккаунт — запись реестра; встроенный, свой с адресом и неизвестный — bad_request', async () => {
    expect((await accountEntry(ID)).account?.id).toBe(ID);
    for (const id of ['claude', 'glm', 'codex', 'custom-nothing', 'codex-codex-2', '__proto__']) {
      await expect(accountEntry(id), id).rejects.toMatchObject({ code: 'bad_request', message: `${id} is not an account` });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Состояние входа
// ---------------------------------------------------------------------------------------------

describe('refresh — состояние входа по команде CLI (К5)', () => {
  it('разбирает loggedIn: status true, detail из ответа, команда — в папке аккаунта и с окружением 5.3', async () => {
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN });
    const { auth, events } = boot({ exec });
    expect(auth.status(ID)).toBeNull();

    expect(await auth.refresh(ID)).toBe(true);

    expect(auth.status(ID)).toBe(true);
    expect(auth.detail(ID)).toBe('me@example.com · max');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: '/stub/claude', args: ['auth', 'status', '--json'], cwd: folder(ID) });
    // Смена статуса null -> true — одно providers.changed.
    expect(eventsOf(events, 'providers.changed')).toEqual([{ provider: ID }]);
  });

  it('окружение команды: без ключей и токена хоста, с CLAUDE_CONFIG_DIR папки аккаунта', async () => {
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN });
    const { auth } = boot({ exec });
    await auth.refresh(ID);

    const env = calls[0]!.env;
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env['CLAUDE_CONFIG_DIR']).toBe(folder(ID));
    // Ни ключа хоста, ни его токена нет ни в одном значении.
    expect(JSON.stringify(env)).not.toContain('sk-host-key');
    expect(JSON.stringify(env)).not.toContain('host-oauth');
  });

  it('повторный refresh раньше 30 с exec не зовёт — отдаёт кэш; через 30 с зовёт снова', async () => {
    let clock = 1_000_000;
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN }, { stdout: SIGNED_OUT });
    const { auth } = boot({ exec, now: () => clock });

    expect(await auth.refresh(ID)).toBe(true);
    clock += 29_999;
    expect(await auth.refresh(ID)).toBe(true);
    expect(calls).toHaveLength(1);

    clock += 1;
    expect(await auth.refresh(ID)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(auth.status(ID)).toBe(false);
  });

  it('параллельные refresh одного аккаунта делят одну команду; аккаунты не мешают друг другу', async () => {
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN });
    const { auth } = boot({ exec });
    await Promise.all([auth.refresh(ID), auth.refresh(ID), auth.refresh(OTHER)]);
    expect(calls.map((call) => call.cwd).sort()).toEqual([folder(ID), folder(OTHER)].sort());
  });

  it('не вошёл (loggedIn false, код 1): status false; providers.changed только при смене', async () => {
    let clock = 0;
    const { exec } = fakeExec({ code: 1, stdout: SIGNED_OUT });
    const { auth, events } = boot({ exec, now: () => clock });
    expect(await auth.refresh(ID)).toBe(false);
    expect(auth.status(ID)).toBe(false);
    expect(auth.detail(ID)).toBeNull();
    clock += 60_000;
    await auth.refresh(ID);
    // null -> false (первая проверка) — одно событие; false -> false — ни одного.
    expect(eventsOf(events, 'providers.changed')).toEqual([{ provider: ID }]);
  });

  it('команда не запустилась (exec отказал): статус прежний, refresh не отказывает, окно повторится сразу', async () => {
    const { exec, calls } = fakeExec(new Error('spawn ENOENT'), { stdout: SIGNED_IN });
    const { auth, warnings } = boot({ exec });
    expect(await auth.refresh(ID)).toBe(false);
    expect(auth.status(ID)).toBeNull();
    expect(warnings).toHaveLength(1);
    // Сбой не занимает окно в 30 с: следующая проверка идёт сразу.
    expect(await auth.refresh(ID)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('не аккаунт или удалённый id: false без команды', async () => {
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN });
    const { auth } = boot({ exec });
    expect(await auth.refresh('claude')).toBe(false);
    expect(await auth.refresh('custom-nothing')).toBe(false);
    expect(calls).toHaveLength(0);
    expect(auth.status('claude')).toBeNull();
  });

  it('refreshAll: только аккаунты реестра', async () => {
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN });
    const { auth } = boot({ exec });
    await auth.refreshAll();
    expect(calls.map((call) => call.cwd).sort()).toEqual([folder(ID), folder(OTHER)].sort());
    expect(auth.status(ID)).toBe(true);
    expect(auth.status(OTHER)).toBe(true);
  });

  it('forget во время чтения реестра тоже отменяет запись исхода', async () => {
    const { auth } = boot({ exec: fakeExec({ stdout: SIGNED_IN }).exec });
    const pending = auth.refresh(ID);
    // Проверка уже началась и ждёт реестр с диска, команда ещё не запущена.
    await Promise.resolve();
    await Promise.resolve();
    auth.forget(ID);
    expect(await pending).toBe(false);
    expect(auth.status(ID)).toBeNull();
  });

  it('журнал: код и первая строка сообщения, без stderr команды', async () => {
    const failure = Object.assign(new Error('Command failed: /stub/claude auth status --json\nsecret stderr text'), { code: 2, killed: false });
    const { exec } = fakeExec(failure);
    const { auth, fields } = boot({ exec });
    await auth.refresh(ID);
    const logged = JSON.stringify(fields);
    expect(logged).toContain('Command failed');
    expect(logged).not.toContain('secret stderr text');
    expect(fields[0]).toMatchObject({ id: ID, code: 2, killed: false });
  });

  it('forget: кэш забыт; идущая проверка уже не запишет устаревший исход (id мог получить новую папку)', async () => {
    let release!: (reply: { code: number; stdout: string }) => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const exec: AuthExec = () => {
      started();
      return new Promise((resolve) => (release = resolve));
    };
    const { auth } = boot({ exec });
    const pending = auth.refresh(ID);
    await running;
    auth.forget(ID);
    release({ code: 0, stdout: SIGNED_IN });
    await pending;
    expect(auth.status(ID)).toBeNull();

    const { exec: second } = fakeExec({ stdout: SIGNED_IN });
    const next = boot({ exec: second });
    await next.auth.refresh(ID);
    expect(next.auth.status(ID)).toBe(true);
    next.auth.forget(ID);
    expect(next.auth.status(ID)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------------------------

describe('signIn — свой маленький PTY (К14, К17)', () => {
  it('поднимает claude auth login --claudeai в папке аккаунта; вывод — providers.signInOutput; signingIn, пока жив', async () => {
    const { spawn, processes } = fakeSpawn();
    const { exec } = fakeExec({ stdout: SIGNED_OUT });
    const { auth, events } = boot({ spawn, exec });
    expect(auth.signingIn(ID)).toBe(false);

    await auth.signIn(ID, { cols: 90, rows: 20 });

    expect(processes).toHaveLength(1);
    const run = processes[0]!;
    expect(run.launch).toMatchObject({ command: '/stub/claude', args: ['auth', 'login', '--claudeai'], cwd: folder(ID) });
    expect(run.size).toEqual({ cols: 90, rows: 20 });
    expect(run.launch.env['CLAUDE_CONFIG_DIR']).toBe(folder(ID));
    expect(run.launch.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(run.launch.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(auth.signingIn(ID)).toBe(true);
    expect(auth.signingIn(OTHER)).toBe(false);
    // Окну: `signingIn` стал true.
    expect(eventsOf(events, 'providers.changed')).toEqual([{ provider: ID }]);

    run.emit('Opening browser to sign in…\r\n');
    run.emit('Paste code here if prompted > ');
    expect(eventsOf(events, 'providers.signInOutput')).toEqual([
      { provider: ID, data: 'Opening browser to sign in…\r\n' },
      { provider: ID, data: 'Paste code here if prompted > ' },
    ]);
  });

  it('размер по умолчанию задан; input и resize доходят до процесса только своего аккаунта', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    await auth.signIn(ID);
    const run = processes[0]!;
    expect(run.size.cols).toBeGreaterThanOrEqual(20);
    expect(run.size.rows).toBeGreaterThanOrEqual(5);

    auth.input(ID, 'abc-code\r');
    auth.resize(ID, 120, 30);
    auth.input(OTHER, 'чужой код');
    auth.resize(OTHER, 10, 10);
    expect(run.written).toEqual(['abc-code\r']);
    expect(run.resizes).toEqual([[120, 30]]);
  });

  it('input и resize без идущего входа — тихо ничего не делают', () => {
    const { auth } = boot({ spawn: fakeSpawn().spawn });
    expect(() => {
      auth.input(ID, 'x');
      auth.resize(ID, 80, 24);
      auth.cancel(ID);
    }).not.toThrow();
  });

  it('после выхода: свежий refresh (даже внутри окна 30 с) и providers.signInExit с signedIn из него', async () => {
    const { spawn, processes } = fakeSpawn();
    const { exec, calls } = fakeExec({ stdout: SIGNED_OUT }, { stdout: SIGNED_IN });
    const { auth, events } = boot({ spawn, exec, now: () => 5_000 });
    await auth.refresh(ID);
    expect(auth.status(ID)).toBe(false);
    await auth.signIn(ID);
    events.length = 0;

    processes[0]!.exit({ exitCode: 0 });
    await exited(events);

    // Вторая проверка прошла, хотя часы не двигались: после входа кэш не годится.
    expect(calls).toHaveLength(2);
    expect(auth.status(ID)).toBe(true);
    expect(auth.signingIn(ID)).toBe(false);
    expect(eventsOf(events, 'providers.signInExit')).toEqual([{ provider: ID, exitCode: 0, signedIn: true }]);
    // Порядок: смена статуса, затем выход, затем итоговое providers.changed (signingIn стал false).
    expect(events.map((item) => item.event)).toEqual(['providers.changed', 'providers.signInExit', 'providers.changed']);
  });

  it('вход прерван без входа: signedIn false, код — 128 + номер сигнала', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth, events } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    await auth.signIn(ID);
    processes[0]!.exit({ exitCode: 0, signal: 15 });
    await exited(events);
    expect(eventsOf(events, 'providers.signInExit')).toEqual([{ provider: ID, exitCode: 143, signedIn: false }]);
  });

  it('второй signIn при живом процессе — conflict, любого аккаунта; после выхода замок свободен', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    await auth.signIn(ID);

    const conflict = { code: 'conflict', message: 'another sign-in is running' };
    await expect(auth.signIn(ID)).rejects.toMatchObject(conflict);
    await expect(auth.signIn(OTHER)).rejects.toMatchObject(conflict);
    expect(processes).toHaveLength(1);

    // Замок снимается сразу на выходе, до свежей проверки.
    processes[0]!.exit();
    await auth.signIn(OTHER);
    expect(processes).toHaveLength(2);
    expect(auth.signingIn(OTHER)).toBe(true);
  });

  it('два signIn подряд без ожидания: один входит, второй — conflict (замок занят до первого await)', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    const results = await Promise.allSettled([auth.signIn(ID), auth.signIn(OTHER)]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(processes).toHaveLength(1);
  });

  it('не аккаунт — bad_request, замок не занят; процесс не стартует', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    await expect(auth.signIn('claude')).rejects.toMatchObject({ code: 'bad_request', message: 'claude is not an account' });
    expect(processes).toHaveLength(0);
    await auth.signIn(ID);
    expect(processes).toHaveLength(1);
  });

  it('процесс не запустился: internal без подробностей, замок свободен', async () => {
    let attempts = 0;
    const spawn: PtySpawn = (launch, size) => {
      attempts += 1;
      if (attempts === 1) throw new Error('posix_spawnp failed: /Users/secret/path');
      return fakeSpawn().spawn(launch, size);
    };
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    const error = await auth.signIn(ID).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'internal', message: 'Unable to start the sign-in' });
    expect(String((error as Error).message)).not.toContain('secret');
    await auth.signIn(ID);
    expect(auth.signingIn(ID)).toBe(true);
  });

  it('cancel убивает процесс; выход идёт обычным путём', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth, events } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    await auth.signIn(ID);
    auth.cancel(OTHER);
    expect(processes[0]!.kills).toBe(0);

    auth.cancel(ID);
    await exited(events);

    expect(processes[0]!.kills).toBe(1);
    expect(auth.signingIn(ID)).toBe(false);
    expect(eventsOf(events, 'providers.signInExit')).toEqual([{ provider: ID, exitCode: 129, signedIn: false }]);
  });

  it('cancel: SIGHUP, а процесс не вышел — через killGraceMs SIGKILL; замок держится до выхода и снимается на нём', async () => {
    const { spawn, processes } = fakeSpawn({ ignoreHup: true });
    const { auth, events } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec, killGraceMs: 40 });
    await auth.signIn(ID);

    auth.cancel(ID);
    expect(processes[0]!.signals).toEqual(['SIGHUP']);
    // Процесс игнорирует SIGHUP: вход всё ещё идёт, другой вход невозможен.
    expect(auth.signingIn(ID)).toBe(true);
    await expect(auth.signIn(OTHER)).rejects.toMatchObject({ code: 'conflict' });

    await exited(events);
    expect(processes[0]!.signals).toEqual(['SIGHUP', 'SIGKILL']);
    expect(eventsOf(events, 'providers.signInExit')).toEqual([{ provider: ID, exitCode: 137, signedIn: false }]);
    expect(auth.signingIn(ID)).toBe(false);
    await auth.signIn(OTHER);
    expect(auth.signingIn(OTHER)).toBe(true);
  });

  it('штатный выход после SIGHUP гасит SIGKILL: позже процесс не добивается', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth, events } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec, killGraceMs: 30 });
    await auth.signIn(ID);
    auth.cancel(ID);
    await exited(events);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(processes[0]!.signals).toEqual(['SIGHUP']);
  });

  it('stop тоже добивает процесс, не реагирующий на SIGHUP; после stop signIn отказан', async () => {
    const { spawn, processes } = fakeSpawn({ ignoreHup: true });
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec, killGraceMs: 30 });
    await auth.signIn(ID);
    auth.stop();
    expect(processes[0]!.signals).toEqual(['SIGHUP']);
    await vi.waitFor(() => expect(processes[0]!.signals).toEqual(['SIGHUP', 'SIGKILL']));
    await expect(auth.signIn(ID)).rejects.toMatchObject({ code: 'conflict', message: 'the host is shutting down' });
  });

  it('таймаут = cancel', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec, timeoutMs: 30 });
    await auth.signIn(ID);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(processes[0]!.kills).toBe(1);
    expect(auth.signingIn(ID)).toBe(false);
  });

  it('штатный выход гасит таймаут: позже процесс не убивается', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_IN }).exec, timeoutMs: 40 });
    await auth.signIn(ID);
    processes[0]!.exit();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(processes[0]!.kills).toBe(0);
  });

  it('stop убивает идущий вход и ничего не рассылает после', async () => {
    const { spawn, processes } = fakeSpawn();
    const { auth, events } = boot({ spawn, exec: fakeExec({ stdout: SIGNED_OUT }).exec });
    await auth.signIn(ID);
    events.length = 0;
    auth.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(processes[0]!.kills).toBe(1);
    expect(auth.signingIn(ID)).toBe(false);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Выход
// ---------------------------------------------------------------------------------------------

describe('signOut — claude auth logout, затем проверка', () => {
  it('зовёт [auth, logout] в папке аккаунта и затем status (внутри окна 30 с — тоже)', async () => {
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN }, { stdout: 'Successfully logged out' }, { code: 1, stdout: SIGNED_OUT });
    const { auth, events } = boot({ exec, now: () => 1 });
    await auth.refresh(ID);
    expect(auth.status(ID)).toBe(true);
    events.length = 0;

    await auth.signOut(ID);

    expect(calls.map((call) => call.args)).toEqual([['auth', 'status', '--json'], ['auth', 'logout'], ['auth', 'status', '--json']]);
    expect(calls[1]).toMatchObject({ command: '/stub/claude', cwd: folder(ID) });
    expect(calls[1]!.env['CLAUDE_CONFIG_DIR']).toBe(folder(ID));
    expect(calls[1]!.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(auth.status(ID)).toBe(false);
    expect(eventsOf(events, 'providers.changed')).toEqual([{ provider: ID }]);
  });

  it('logout не запустился: internal, но статус всё равно перепроверен', async () => {
    const { exec, calls } = fakeExec(new Error('spawn ENOENT /Users/secret'), { stdout: SIGNED_IN });
    const { auth } = boot({ exec });
    const error = await auth.signOut(ID).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'internal', message: 'Unable to sign out' });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(['auth', 'status', '--json']);
    expect(auth.status(ID)).toBe(true);
  });

  it('не аккаунт — bad_request, команд нет; при идущем входе этого аккаунта — conflict', async () => {
    const { spawn } = fakeSpawn();
    const { exec, calls } = fakeExec({ stdout: SIGNED_IN });
    const { auth } = boot({ exec, spawn });
    await expect(auth.signOut('glm')).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(0);

    await auth.signIn(ID);
    await expect(auth.signOut(ID)).rejects.toMatchObject({ code: 'conflict' });
    expect(calls).toHaveLength(0);
  });
});
