import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateResult, UpdateState } from '../shared/bridge.js';
import { createQuitIntent } from './quit-intent.js';
import type {
  Attempt,
  AttemptClock,
  AttemptDeps,
  AttemptInput,
  AttemptOutcome,
} from './update-download.js';
import { helperScript } from './update-helper.js';
import {
  createReplaceTarget,
  createUpdateInstaller,
  nodeInstallerFs,
  QUIT_STOP_MS,
  replaceBundle,
  runExitCode,
  type HelperChild,
  type InstallerDeps,
  type ReplaceEnv,
  type SwapIntent,
} from './update-installer.js';
import { HANDOFF_FILE } from './update-startup.js';
import type { Bundle } from './update-target.js';

const BUNDLE: Bundle = { parent: '/Apps', name: 'Parley', app: '/Apps/Parley.app' };
const UPDATES = '/home/parley/desktop/updates';
const PID = 4242;
const A = { version: '1.2.3', url: 'https://github.com/Kalmbik61/Parley/releases/tag/v1.2.3' };
const B = { version: '1.3.0', url: 'https://github.com/Kalmbik61/Parley/releases/tag/v1.3.0' };

/** Подставная попытка: итог и конец отмены держит тест. */
interface FakeAttempt {
  deps: AttemptDeps;
  input: AttemptInput;
  attempt: Attempt;
  settle(outcome: AttemptOutcome): void;
  cancelCalls: number;
  abandonCalls: number;
  /** Дочерний процесс закончился и каталоги удалены: `cancel()` дошёл до конца. */
  cleaned: boolean;
  /** `cancel()` кончается отказом (установщик обязан его проглотить). */
  failCancel(error: Error): void;
  /** Пока не открыто, `cancel()` не возвращается: каталоги ещё удаляются. */
  holdCancel(): () => void;
}

/** Часы, которые двигает тест: нужны пределу ожидания выхода. */
function manualClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: AttemptClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  return {
    clock,
    pending: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

function setup(options: { startupResult?: UpdateResult | null } = {}) {
  const time = manualClock();
  let target: Bundle | null = BUNDLE;
  const attempts: FakeAttempt[] = [];
  const dirs = new Set<string>();
  const written = new Map<string, string>();
  const calls: string[] = [];
  const logs: string[] = [];
  const intent = createQuitIntent<SwapIntent>();
  let writeScriptError: Error | null = null;
  let createEmptyError: Error | null = null;
  let writeNewError: (Error & { code?: string }) | null = null;
  let spawnError: Error | null = null;
  let childPid: number | undefined = 777;
  const children: Array<{ on: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }> = [];

  const quit = vi.fn(() => {
    // Как Electron: `before-quit` порождается синхронно внутри `app.quit()`.
    intent.onBeforeQuit();
  });
  const spawn = vi.fn((command: string, args: string[]): HelperChild => {
    calls.push('spawn');
    if (spawnError) throw spawnError;
    const child = {
      pid: childPid,
      on: vi.fn(() => calls.push('on-error')),
      unref: vi.fn(() => calls.push('unref')),
    };
    children.push(child);
    void command;
    void args;
    return child;
  });

  const runAttempt = (deps: AttemptDeps, input: AttemptInput): Attempt => {
    let resolve: (outcome: AttemptOutcome) => void = () => {};
    const done = new Promise<AttemptOutcome>((r) => {
      resolve = r;
    });
    let release: (() => void) | null = null;
    let held: Promise<void> | null = null;
    let cancelError: Error | null = null;
    const fake: FakeAttempt = {
      deps,
      input,
      cancelCalls: 0,
      abandonCalls: 0,
      cleaned: false,
      failCancel: (error) => {
        cancelError = error;
      },
      settle: (outcome) => resolve(outcome),
      holdCancel: () => {
        held = new Promise<void>((r) => {
          release = r;
        });
        return () => release?.();
      },
      attempt: {
        done,
        async cancel() {
          fake.cancelCalls += 1;
          await held;
          if (cancelError) throw cancelError;
          fake.cleaned = true;
          resolve({ ok: false, reason: 'cancelled' });
        },
        abandon() {
          fake.abandonCalls += 1;
        },
      },
    };
    attempts.push(fake);
    return fake.attempt;
  };

  const installer = createUpdateInstaller({
    version: '1.0.0',
    arch: 'arm64',
    pid: PID,
    updatesDir: UPDATES,
    target: async () => target,
    fetch: vi.fn() as never,
    run: vi.fn(() => ({ exited: Promise.resolve({ code: 0, stdout: '' }), kill: () => {} })),
    clock: time.clock,
    fs: {
      isDir: (p) => dirs.has(p),
      writeScript: (file, text) => {
        if (writeScriptError) throw writeScriptError;
        written.set(file, text);
      },
      createEmpty: (file) => {
        calls.push('handoff');
        if (createEmptyError) throw createEmptyError;
        written.set(file, '');
      },
      writeNew: (file, text) => {
        calls.push('result');
        if (writeNewError) throw writeNewError;
        written.set(file, text);
      },
    },
    intent,
    quit,
    spawn,
    startupResult: options.startupResult ?? null,
    log: (message) => logs.push(message),
    runAttempt,
  } satisfies InstallerDeps);

  const states: UpdateState[] = [];
  installer.onState((s) => states.push(s));

  const last = (): FakeAttempt => {
    const attempt = attempts[attempts.length - 1];
    if (!attempt) throw new Error('no attempt');
    return attempt;
  };

  /** Релиз найден и загружен до `ready`; подготовленное приложение «лежит» на месте. */
  async function readyUp(info = A): Promise<FakeAttempt> {
    await installer.onFound(info);
    const before = attempts.length;
    const pending = installer.download();
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(before));
    const attempt = last();
    // Тест не ждёт `pending`: итог попытки приходит ниже.
    dirs.add(path.join(attempt.input.stagingDir, 'Parley.app'));
    attempt.settle({ ok: true, stagedApp: path.join(attempt.input.stagingDir, 'Parley.app') });
    await pending;
    return attempt;
  }

  return {
    installer,
    time,
    intent,
    quit,
    spawn,
    attempts,
    children,
    dirs,
    written,
    calls,
    logs,
    states,
    last,
    readyUp,
    setTarget: (next: Bundle | null) => {
      target = next;
    },
    failWriteScript: (error: Error) => {
      writeScriptError = error;
    },
    failCreateEmpty: (error: Error) => {
      createEmptyError = error;
    },
    failWriteNew: (error: Error & { code?: string }) => {
      writeNewError = error;
    },
    failSpawn: (error: Error) => {
      spawnError = error;
    },
    setChildPid: (pid: number | undefined) => {
      childPid = pid;
    },
  };
}

const phases = (states: UpdateState[]): string[] => states.map((s) => s.phase);

/** Даёт отработать всем уже готовым продолжениям (цепочки промисов установщика). */
const flushTasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('SU-01: проверка выключена или новой версии нет', () => {
  it('до находки состояние idle и ни одной попытки', () => {
    const t = setup();
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    expect(t.attempts).toHaveLength(0);
  });

  it('версия не новее запущенной (та же, старше, не версия) состояния не меняет', async () => {
    const t = setup();
    await t.installer.onFound({ version: '1.0.0', url: A.url });
    await t.installer.onFound({ version: '0.9.0', url: A.url });
    await t.installer.onFound({ version: 'latest', url: A.url });
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    expect(t.states).toEqual([]);
  });

  it('переключатель выключен: available → idle, загрузки нет', async () => {
    const t = setup();
    await t.installer.onFound(A);
    expect(t.installer.state().phase).toBe('available');
    await t.installer.checksDisabled();
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    await t.installer.download();
    expect(t.attempts).toHaveLength(0);
  });

  it('после выключения старая находка не возвращается: cancel и download ничего не делают, новая находка — available', async () => {
    const t = setup();
    await t.installer.onFound(A);
    await t.installer.checksDisabled();
    await t.installer.cancel();
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    t.installer.checksEnabled();
    await t.installer.onFound(A);
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: A.version });
  });

  it('F7: ответ проверки, пришедший после выключения, находки не даёт: idle, «Update» ничего не качает', async () => {
    const t = setup();
    await t.installer.onFound(A);
    await t.installer.checksDisabled();
    const before = t.states.length;
    // Запрос начат до выключения, ответ пришёл позже.
    await t.installer.onFound(A);
    await t.installer.onFound(B);
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    expect(t.states).toHaveLength(before);
    await t.installer.download();
    expect(t.attempts).toHaveLength(0);
    expect(t.installer.state()).toEqual({ phase: 'idle' });
  });

  it('F7: ответ, начатый до выключения и обрабатываемый в момент выключения, тоже не оставляет available', async () => {
    const t = setup();
    // Находка ждёт ответа «можно ли заменить себя»; пока ждёт, проверку выключают.
    const finding = t.installer.onFound(A);
    await t.installer.checksDisabled();
    await finding;
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    await t.installer.download();
    expect(t.attempts).toHaveLength(0);
  });

  it('F7: после повторного включения та же находка принимается и загрузка идёт', async () => {
    const t = setup();
    await t.installer.checksDisabled();
    await t.installer.onFound(A);
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    t.installer.checksEnabled();
    await t.installer.onFound(A);
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: A.version });
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: true, stagedApp: '/x' });
    await pending;
    expect(t.installer.state().phase).toBe('ready');
  });

  it('переключатель выключен: ручная проверка принимает находку, сохранение настроек её не сбрасывает', async () => {
    const t = setup();
    await t.installer.checksDisabled();
    t.installer.manualCheck();
    await t.installer.onFound(A);
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: A.version });
    // Сохранение ui.json при выключенном переключателе (ширина сайдбара, тема).
    await t.installer.checksDisabled();
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: A.version });
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: true, stagedApp: '/x' });
    await pending;
    expect(t.installer.state().phase).toBe('ready');
  });

  it('переключатель был включён: checksDisabled сбрасывает в idle даже после ручной проверки', async () => {
    const t = setup();
    t.installer.manualCheck();
    await t.installer.onFound(A);
    await t.installer.checksDisabled();
    expect(t.installer.state()).toEqual({ phase: 'idle' });
  });

  it('F7: установщик по умолчанию включён (находки принимаются без вызова checksEnabled)', async () => {
    const t = setup();
    await t.installer.onFound(A);
    expect(t.installer.state().phase).toBe('available');
  });

  it('выключение посреди загрузки отменяет попытку и забывает её итог', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    const attempt = t.last();
    const open = attempt.holdCancel();
    const disabling = t.installer.checksDisabled();
    expect(attempt.cancelCalls).toBe(1);
    // Запоздалый успех приходит, пока отмена ещё убирает каталоги: `done` уже отдал успех, и установщик его получает.
    attempt.settle({ ok: true, stagedApp: '/x' });
    await flushTasks();
    expect(attempt.cleaned).toBe(false);
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    open();
    await disabling;
    await pending;
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    expect(phases(t.states)).toEqual(['available', 'downloading', 'idle']);
  });

  it('выключение при готовом: каталоги удалены, намерение сброшено, выход сценария не запускает', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    await t.installer.install();
    await t.installer.checksDisabled();
    expect(attempt.cancelCalls).toBe(1);
    expect(t.installer.state()).toEqual({ phase: 'idle' });
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
  });
});

describe('SU-02: что видит окно в available', () => {
  it('заменить себя можно — canInstall: true', async () => {
    const t = setup();
    await t.installer.onFound(A);
    expect(t.installer.state()).toEqual({
      phase: 'available',
      version: '1.2.3',
      url: A.url,
      canInstall: true,
    });
  });

  it('заменить себя нельзя — canInstall: false, и «Update» ничего не качает', async () => {
    const t = setup();
    t.setTarget(null);
    await t.installer.onFound(A);
    expect(t.installer.state()).toMatchObject({ phase: 'available', canInstall: false });
    await t.installer.download();
    expect(t.attempts).toHaveLength(0);
    expect(t.installer.state()).toMatchObject({ phase: 'available', canInstall: false });
  });

  it('повторная находка той же версии состояния не меняет и событий не шлёт', async () => {
    const t = setup();
    await t.installer.onFound(A);
    await t.installer.onFound(A);
    expect(t.states).toHaveLength(1);
  });

  it('две одновременные находки той же версии дают одно событие', async () => {
    const t = setup();
    await Promise.all([t.installer.onFound(A), t.installer.onFound(A)]);
    expect(t.states).toHaveLength(1);
  });

  it('более новая находка в available заменяет версию', async () => {
    const t = setup();
    await t.installer.onFound(A);
    await t.installer.onFound(B);
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: B.version });
  });
});

describe('SU-03: загрузка до ready', () => {
  it('download → downloading → verifying → ready; попытка получает свои каталоги и версию', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    expect(t.installer.state()).toEqual({
      phase: 'downloading',
      version: '1.2.3',
      url: A.url,
      received: 0,
      total: null,
    });
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    const attempt = t.last();
    expect(attempt.input).toEqual({
      version: '1.2.3',
      arch: 'arm64',
      downloadDir: `${UPDATES}/1`,
      stagingDir: `/Apps/.Parley.app.update-${PID}-1`,
    });

    attempt.deps.onProgress(0, 1000);
    expect(t.installer.state()).toMatchObject({ phase: 'downloading', received: 0, total: 1000 });
    attempt.deps.onProgress(400, 1000);
    expect(t.installer.state()).toMatchObject({ phase: 'downloading', received: 400, total: 1000 });

    // Первый дочерний процесс (`ditto`): архив скачан, идёт проверка и распаковка.
    attempt.deps.run('/usr/bin/ditto', []);
    expect(t.installer.state()).toEqual({ phase: 'verifying', version: '1.2.3', url: A.url });
    // Следующие процессы и запоздалый ход состояния не откатывают.
    attempt.deps.run('/usr/bin/defaults', []);
    attempt.deps.onProgress(900, 1000);
    expect(t.installer.state().phase).toBe('verifying');

    attempt.settle({ ok: true, stagedApp: `${attempt.input.stagingDir}/Parley.app` });
    await pending;
    expect(t.installer.state()).toEqual({ phase: 'ready', version: '1.2.3', url: A.url });
    expect(phases(t.states)).toEqual([
      'available',
      'downloading',
      'downloading',
      'downloading',
      'verifying',
      'ready',
    ]);
  });

  it('второй «Update» во время загрузки второй попытки не начинает', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const first = t.installer.download();
    await t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: false, reason: 'network' });
    await first;
    expect(t.attempts).toHaveLength(1);
  });

  it('заменить себя уже нельзя в момент старта → failed: cannot_replace, попытки нет', async () => {
    const t = setup();
    await t.installer.onFound(A);
    t.setTarget(null);
    await t.installer.download();
    expect(t.installer.state()).toEqual({
      phase: 'failed',
      version: '1.2.3',
      url: A.url,
      reason: 'cannot_replace',
    });
    expect(t.attempts).toHaveLength(0);
  });
});

describe('отказ попытки и «Try again»', () => {
  it('отказ — failed с той же причиной; повторный download идёт в новых каталогах', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const first = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: false, reason: 'checksum' });
    await first;
    expect(t.installer.state()).toEqual({
      phase: 'failed',
      version: '1.2.3',
      url: A.url,
      reason: 'checksum',
    });

    const second = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(2));
    expect(t.attempts[1]?.input.downloadDir).toBe(`${UPDATES}/2`);
    expect(t.attempts[1]?.input.stagingDir).toBe(`/Apps/.Parley.app.update-${PID}-2`);
    t.last().settle({ ok: true, stagedApp: '/x' });
    await second;
    expect(t.installer.state().phase).toBe('ready');
  });

  it('находка той же версии в failed состояния не меняет, более новой — переводит в available', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: false, reason: 'network' });
    await pending;
    await t.installer.onFound(A);
    expect(t.installer.state()).toMatchObject({ phase: 'failed', reason: 'network' });
    await t.installer.onFound(B);
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: B.version });
  });

  it('«Try again» там, где заменить себя уже нельзя, — failed: cannot_replace', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: false, reason: 'disk' });
    await pending;
    t.setTarget(null);
    await t.installer.download();
    expect(t.installer.state()).toMatchObject({ phase: 'failed', reason: 'cannot_replace' });
    expect(t.attempts).toHaveLength(1);
  });
});

describe('SU-07: отмена и сразу новая попытка', () => {
  it('cancel в downloading → available; итог отменённой попытки состояния не меняет; новая попытка — в своих каталогах', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const firstDone = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    const first = t.last();
    const open = first.holdCancel();

    const cancelling = t.installer.cancel();
    // Каталоги ещё удаляются, а состояние уже вернулось.
    await vi.waitFor(() =>
      expect(t.installer.state()).toMatchObject({ phase: 'available', version: '1.2.3' }),
    );
    expect(first.cancelCalls).toBe(1);

    // Сразу новая попытка той же версии, пока старая ещё убирает свои каталоги.
    const secondDone = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(2));
    const second = t.last();
    expect(second.input.downloadDir).not.toBe(first.input.downloadDir);
    expect(second.input.stagingDir).not.toBe(first.input.stagingDir);

    // Запоздалый успех вытесненной попытки приходит, пока её отмена ещё не кончилась: состояния он не трогает.
    first.settle({ ok: true, stagedApp: '/old' });
    await flushTasks();
    expect(first.cleaned).toBe(false);
    expect(t.installer.state()).toMatchObject({ phase: 'downloading' });

    open();
    await cancelling;
    await firstDone;
    expect(first.cleaned).toBe(true);
    expect(t.installer.state()).toMatchObject({ phase: 'downloading' });

    second.settle({ ok: true, stagedApp: '/new' });
    await secondDone;
    expect(t.installer.state()).toEqual({ phase: 'ready', version: '1.2.3', url: A.url });
  });

  it('cancel в verifying (распаковка задержана) → available', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().deps.run('/usr/bin/ditto', []);
    expect(t.installer.state().phase).toBe('verifying');
    const cancelling = t.installer.cancel();
    await cancelling;
    await pending;
    expect(t.installer.state()).toMatchObject({
      phase: 'available',
      version: '1.2.3',
      canInstall: true,
    });
    expect(t.last().cancelCalls).toBe(1);
  });

  it('cancel до того, как попытка запущена (идёт проверка «можно ли заменить»), попытку не запускает', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await t.installer.cancel();
    await pending;
    expect(t.attempts).toHaveLength(0);
    expect(t.installer.state()).toMatchObject({ phase: 'available', version: '1.2.3' });
  });

  it('cancel вне downloading и verifying ничего не делает', async () => {
    const t = setup();
    await t.installer.cancel();
    await t.installer.onFound(A);
    await t.installer.cancel();
    expect(t.installer.state()).toMatchObject({ phase: 'available' });
    const attempt = await t.readyUp(B);
    await t.installer.cancel();
    expect(t.installer.state().phase).toBe('ready');
    expect(attempt.cancelCalls).toBe(0);
  });

  it('итог попытки с причиной cancelled (без вызова cancel) состояния не меняет', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    t.last().settle({ ok: false, reason: 'cancelled' });
    await pending;
    expect(t.installer.state().phase).toBe('downloading');
  });
});

describe('SU-08: вызовы без параметров и вне своих состояний', () => {
  it('методы моста не принимают параметров', () => {
    const t = setup();
    expect(t.installer.download.length).toBe(0);
    expect(t.installer.cancel.length).toBe(0);
    expect(t.installer.install.length).toBe(0);
    expect(t.installer.state.length).toBe(0);
    expect(t.installer.takeResult.length).toBe(0);
  });

  it('install вне ready ничего не делает', async () => {
    const t = setup();
    await t.installer.install();
    await t.installer.onFound(A);
    await t.installer.install();
    expect(t.quit).not.toHaveBeenCalled();
    expect(t.installer.state()).toMatchObject({ phase: 'available' });
  });

  it('download без canInstall и из idle ничего не делает', async () => {
    const t = setup();
    await t.installer.download();
    t.setTarget(null);
    await t.installer.onFound(A);
    await t.installer.download();
    expect(t.attempts).toHaveLength(0);
  });

  it('download из ready и downloading ничего не делает', async () => {
    const t = setup();
    await t.readyUp();
    await t.installer.download();
    expect(t.attempts).toHaveLength(1);
  });
});

describe('SU-09: выбранный релиз не вытесняется находками', () => {
  for (const stage of ['downloading', 'verifying', 'ready'] as const) {
    it(`в ${stage} находки той же A и новой B состояния и каталогов не меняют`, async () => {
      const t = setup();
      await t.installer.onFound(A);
      const pending = t.installer.download();
      await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
      const attempt = t.last();
      if (stage !== 'downloading') attempt.deps.run('/usr/bin/ditto', []);
      if (stage === 'ready') {
        attempt.settle({ ok: true, stagedApp: '/x' });
        await pending;
      }
      const before = t.installer.state();
      await t.installer.onFound(A);
      await t.installer.onFound(B);
      expect(t.installer.state()).toEqual(before);
      expect(t.attempts).toHaveLength(1);
      expect(attempt.cancelCalls).toBe(0);
      attempt.settle({ ok: false, reason: 'network' });
    });
  }

  it('после отмены A возвращается к последней найденной версии B', async () => {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    await t.installer.onFound(B);
    expect(t.installer.state().phase).toBe('downloading');
    await t.installer.cancel();
    await pending;
    expect(t.installer.state()).toMatchObject({
      phase: 'available',
      version: B.version,
      url: B.url,
    });
  });
});

describe('SU-14: «Restart now», отказы до выхода', () => {
  it('заменить себя уже нельзя → failed: cannot_replace; выход не вызван, подготовленное удалено', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    t.setTarget(null);
    await t.installer.install();
    expect(t.installer.state()).toEqual({
      phase: 'failed',
      version: '1.2.3',
      url: A.url,
      reason: 'cannot_replace',
    });
    expect(t.quit).not.toHaveBeenCalled();
    expect(attempt.cancelCalls).toBe(1);
  });

  it('подготовленного приложения на месте нет → failed: cannot_replace', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    t.dirs.clear();
    await t.installer.install();
    expect(t.installer.state()).toMatchObject({ phase: 'failed', reason: 'cannot_replace' });
    expect(t.quit).not.toHaveBeenCalled();
    expect(attempt.cancelCalls).toBe(1);
  });

  it('сценарий не записался → failed: disk; выход не вызван; намерения нет', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    t.failWriteScript(new Error('EACCES'));
    await t.installer.install();
    expect(t.installer.state()).toEqual({
      phase: 'failed',
      version: '1.2.3',
      url: A.url,
      reason: 'disk',
    });
    expect(t.quit).not.toHaveBeenCalled();
    expect(attempt.cancelCalls).toBe(1);
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('успех: сценарий записан в каталог подготовки, выход вызван один раз, состояние остаётся ready', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    await t.installer.install();
    expect(t.written.get(`${attempt.input.stagingDir}/helper.sh`)).toBe(helperScript());
    expect(t.quit).toHaveBeenCalledTimes(1);
    expect(t.installer.state()).toEqual({ phase: 'ready', version: '1.2.3', url: A.url });
  });

  it('второй клик, пока первый ещё проверяет, выход второй раз не вызывает', async () => {
    const t = setup();
    await t.readyUp();
    await Promise.all([t.installer.install(), t.installer.install()]);
    expect(t.quit).toHaveBeenCalledTimes(1);
  });

  it('выход отменён вопросом, и клик повторён: снова ready и снова выход', async () => {
    const t = setup();
    await t.readyUp();
    await t.installer.install();
    await t.installer.install();
    expect(t.quit).toHaveBeenCalledTimes(2);
    expect(t.installer.state().phase).toBe('ready');
  });
});

describe('SU-10, SU-11, SU-13: намерение и событие quit', () => {
  it('SU-10: клик → before-quit своего вызова → quit → сценарий запущен один раз с пятью аргументами', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    await t.installer.install();
    t.installer.onQuit();
    t.installer.onQuit();
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.spawn).toHaveBeenCalledWith(
      '/bin/sh',
      [
        `${attempt.input.stagingDir}/helper.sh`,
        String(PID),
        '/Apps/Parley.app',
        `${attempt.input.stagingDir}/Parley.app`,
        '1.2.3',
        '/Apps/.Parley.app.result',
      ],
      { detached: true, stdio: 'ignore' },
    );
  });

  it('SU-10: между кликом и quit проходит повтор выхода «своим» вызовом — намерение живо', async () => {
    const t = setup();
    await t.readyUp();
    await t.installer.install();
    // Повтор после вопроса: «свой» выход порождает before-quit с отметкой.
    t.intent.ownQuit(() => t.intent.onBeforeQuit());
    t.installer.onQuit();
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('SU-11: выход брошен, потом обычный выход — сценарий не запущен', async () => {
    const t = setup();
    await t.readyUp();
    await t.installer.install();
    // ⌘Q без отметки.
    t.intent.onBeforeQuit();
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('SU-13: ⌘Q при стоящем вопросе сбрасывает намерение', async () => {
    const t = setup();
    await t.readyUp();
    await t.installer.install();
    t.intent.onBeforeQuit();
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('SU-13: выключение системы посреди выхода сбрасывает намерение до своего quit', async () => {
    const t = setup();
    await t.readyUp();
    await t.installer.install();
    // Обработчик `powerMonitor 'shutdown'`: `intent.clear()`, потом `app.quit()` без before-quit (выход уже идёт).
    t.intent.clear();
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('quit без намерения (обычный выход без обновления) ничего не делает', () => {
    const t = setup();
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.calls).toEqual([]);
  });

  it('слушатель срабатывает один раз: повторный quit после первого ничего не запускает', async () => {
    const t = setup();
    await t.readyUp();
    t.installer.onQuit();
    await t.installer.install();
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
  });
});

describe('SU-15: запуск сценария на quit', () => {
  async function armed() {
    const t = setup();
    const attempt = await t.readyUp();
    await t.installer.install();
    return { t, attempt };
  }

  it('handoff создаётся до spawn; слушатель error стоит до unref', async () => {
    const { t } = await armed();
    t.installer.onQuit();
    expect(t.calls).toEqual(['handoff', 'spawn', 'on-error', 'unref']);
    const handoff = [...t.written.keys()].find((file) => file.endsWith(`/${HANDOFF_FILE}`));
    expect(handoff).toBe(`/Apps/.Parley.app.update-${PID}-1/${HANDOFF_FILE}`);
    expect(t.written.get(`/Apps/.Parley.app.result`)).toBeUndefined();
  });

  it('spawn бросил исключение → отказ helper в файле итога (wx)', async () => {
    const { t } = await armed();
    t.failSpawn(new Error('EAGAIN'));
    t.installer.onQuit();
    expect(t.written.get('/Apps/.Parley.app.result')).toBe('failed 1.2.3 helper\n');
  });

  it('child.pid === undefined → отказ helper', async () => {
    const { t } = await armed();
    t.setChildPid(undefined);
    t.installer.onQuit();
    expect(t.written.get('/Apps/.Parley.app.result')).toBe('failed 1.2.3 helper\n');
    // Слушатель error и unref уже поставлены: позднее событие процесс не уронит.
    expect(t.children[0]?.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(t.children[0]?.unref).toHaveBeenCalled();
  });

  it('итог уже существует (EEXIST) → не затирается и не бросает', async () => {
    const { t } = await armed();
    t.failSpawn(new Error('EAGAIN'));
    t.failWriteNew(Object.assign(new Error('exists'), { code: 'EEXIST' }));
    expect(() => t.installer.onQuit()).not.toThrow();
    expect(t.written.has('/Apps/.Parley.app.result')).toBe(false);
  });

  it('handoff не создался → сценарий не запускается, отказ helper записан', async () => {
    const { t } = await armed();
    t.failCreateEmpty(new Error('ENOSPC'));
    t.installer.onQuit();
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.written.get('/Apps/.Parley.app.result')).toBe('failed 1.2.3 helper\n');
  });

  it('событие error после возврата процесс не роняет', async () => {
    const { t } = await armed();
    t.installer.onQuit();
    const listener = t.children[0]?.on.mock.calls[0]?.[1] as ((error: Error) => void) | undefined;
    expect(listener).toBeTypeOf('function');
    expect(() => listener?.(new Error('ENOENT'))).not.toThrow();
  });
});

describe('состояние: слушатели и итог старта', () => {
  it('onState: отписка работает, исключение слушателя остальным не мешает', async () => {
    const t = setup();
    const seen: string[] = [];
    const off = t.installer.onState((s) => seen.push(s.phase));
    t.installer.onState(() => {
      throw new Error('boom');
    });
    await t.installer.onFound(A);
    off();
    await t.installer.onFound(B);
    expect(seen).toEqual(['available']);
    expect(t.states.map((s) => s.phase)).toEqual(['available', 'available']);
  });

  it('takeResult отдаёт итог старта один раз', () => {
    const result: UpdateResult = { kind: 'updated', version: '1.2.3' };
    const t = setup({ startupResult: result });
    expect(t.installer.takeResult()).toEqual(result);
    expect(t.installer.takeResult()).toBeNull();
  });

  it('takeResult без итога — null', () => {
    expect(setup().installer.takeResult()).toBeNull();
  });
});

describe('«можно ли заменить себя»: replaceBundle и createReplaceTarget', () => {
  const EXE = '/Applications/Parley.app/Contents/MacOS/Parley';
  function env(patch: Partial<ReplaceEnv> = {}): ReplaceEnv & { probes: number } {
    const result = {
      probes: 0,
      platform: 'darwin',
      packaged: true,
      exePath: () => EXE,
      canWrite: () => true,
      probeLockf: async () => {
        result.probes += 1;
        return true;
      },
      ...patch,
    };
    return result;
  }

  it('replaceBundle: приложение, когда платформа, сборка, путь и запись в порядке; lockf не нужен', () => {
    const e = env({ probeLockf: () => Promise.reject(new Error('не должен вызываться')) });
    expect(replaceBundle(e)).toEqual({
      parent: '/Applications',
      name: 'Parley',
      app: '/Applications/Parley.app',
    });
  });

  it.each([
    ['не macOS', { platform: 'linux' }],
    ['несобранное окно', { packaged: false }],
    ['чужой вид пути', { exePath: () => '/usr/bin/node' }],
    ['образ диска', { exePath: () => '/Volumes/Parley/Parley.app/Contents/MacOS/Parley' }],
    ['нет права записи', { canWrite: () => false }],
    [
      'realpath бросил',
      {
        exePath: () => {
          throw new Error('ENOENT');
        },
      },
    ],
  ] as Array<[string, Partial<ReplaceEnv>]>)('replaceBundle: %s → null', (_name, patch) => {
    expect(replaceBundle(env(patch))).toBeNull();
  });

  it('createReplaceTarget: проба lockf идёт один раз за запуск, ответ запоминается', async () => {
    const e = env();
    const target = createReplaceTarget(e);
    expect((await target())?.app).toBe('/Applications/Parley.app');
    await target();
    await Promise.all([target(), target()]);
    expect(e.probes).toBe(1);
  });

  it('createReplaceTarget: lockf без нужной формы → null (запоминается)', async () => {
    const e = env({
      probeLockf: async () => {
        e.probes += 1;
        return false;
      },
    });
    const target = createReplaceTarget(e);
    expect(await target()).toBeNull();
    expect(await target()).toBeNull();
    expect(e.probes).toBe(1);
  });

  it('createReplaceTarget: отказавшая проба — нельзя; пробы при прочих отказах нет', async () => {
    const failing = env({ probeLockf: () => Promise.reject(new Error('no')) });
    expect(await createReplaceTarget(failing)()).toBeNull();
    const refused = env({ packaged: false });
    expect(await createReplaceTarget(refused)()).toBeNull();
    expect(refused.probes).toBe(0);
  });

  it('createReplaceTarget: условия §5.2 перечитываются при каждом вызове', async () => {
    let writable = true;
    const target = createReplaceTarget(env({ canWrite: () => writable }));
    expect(await target()).not.toBeNull();
    writable = false;
    expect(await target()).toBeNull();
  });
});

describe('настоящая файловая система и запуск', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  async function tmp(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-installer-'));
    dirs.push(dir);
    return dir;
  }

  it('writeScript: права 0700; createEmpty и writeNew существующий файл не принимают', async () => {
    const dir = await tmp();
    const script = path.join(dir, 'helper.sh');
    nodeInstallerFs.writeScript(script, '#!/bin/sh\n');
    expect(((await stat(script)).mode & 0o777).toString(8)).toBe('700');
    expect(await readFile(script, 'utf8')).toBe('#!/bin/sh\n');

    const handoff = path.join(dir, HANDOFF_FILE);
    nodeInstallerFs.createEmpty(handoff);
    expect(await readFile(handoff, 'utf8')).toBe('');
    expect(() => nodeInstallerFs.createEmpty(handoff)).toThrow();

    const result = path.join(dir, 'result');
    nodeInstallerFs.writeNew(result, 'first');
    expect(() => nodeInstallerFs.writeNew(result, 'second')).toThrow(
      expect.objectContaining({ code: 'EEXIST' }),
    );
    expect(await readFile(result, 'utf8')).toBe('first');
  });

  it('isDir: каталог — да; файл, ссылка и пустота — нет', async () => {
    const dir = await tmp();
    nodeInstallerFs.writeNew(path.join(dir, 'file'), 'x');
    expect(nodeInstallerFs.isDir(dir)).toBe(true);
    expect(nodeInstallerFs.isDir(path.join(dir, 'file'))).toBe(false);
    expect(nodeInstallerFs.isDir(path.join(dir, 'missing'))).toBe(false);
  });

  it('runExitCode: код выхода; запуск не удался — null', async () => {
    expect(await runExitCode('/bin/sh', ['-c', 'exit 0'])).toBe(0);
    expect(await runExitCode('/bin/sh', ['-c', 'exit 75'])).toBe(75);
    expect(await runExitCode('/nonexistent/program', [])).toBeNull();
  });
});

describe('F6: выход во время подготовки (спека §13, п. 14)', () => {
  /** Попытка запущена и дошла до нужной фазы. */
  async function running(stage: 'downloading' | 'verifying') {
    const t = setup();
    await t.installer.onFound(A);
    const pending = t.installer.download();
    await vi.waitFor(() => expect(t.attempts).toHaveLength(1));
    const attempt = t.last();
    if (stage === 'verifying') attempt.deps.run('/usr/bin/ditto', []);
    expect(t.installer.state().phase).toBe(stage);
    return { t, attempt, pending };
  }

  for (const stage of ['downloading', 'verifying'] as const) {
    it(`stopForQuit в ${stage}: полная отмена, возврат только после конца процесса и удаления каталогов`, async () => {
      const { t, attempt, pending } = await running(stage);
      const open = attempt.holdCancel();
      let returned = false;
      const stopping = t.installer.stopForQuit().then(() => {
        returned = true;
      });
      expect(attempt.cancelCalls).toBe(1);
      await flushTasks();
      expect(returned).toBe(false);
      expect(attempt.cleaned).toBe(false);

      open();
      await stopping;
      await pending;
      expect(attempt.cleaned).toBe(true);
      expect(returned).toBe(true);
      expect(attempt.abandonCalls).toBe(0);
      expect(t.installer.state()).toMatchObject({ phase: 'available', version: A.version });
    });
  }

  it('stopForQuit ждёт не дольше предела и возвращается, даже если отмена не кончилась', async () => {
    const { t, attempt } = await running('verifying');
    const open = attempt.holdCancel();
    let returned = false;
    const stopping = t.installer.stopForQuit().then(() => {
      returned = true;
    });
    expect(QUIT_STOP_MS).toBe(5000);
    t.time.advance(QUIT_STOP_MS - 1);
    await flushTasks();
    expect(returned).toBe(false);
    t.time.advance(1);
    await stopping;
    expect(returned).toBe(true);
    expect(attempt.cleaned).toBe(false);
    expect(attempt.cancelCalls).toBe(1);
    // Таймер предела не висит после возврата.
    expect(t.time.pending()).toBe(0);
    open();
  });

  it('stopForQuit, кончившийся раньше предела, снимает таймер', async () => {
    const { t, attempt } = await running('downloading');
    await t.installer.stopForQuit();
    expect(attempt.cleaned).toBe(true);
    expect(t.time.pending()).toBe(0);
  });

  it('stopForQuit не бросает, даже если отмена отказала', async () => {
    const { t, attempt } = await running('downloading');
    attempt.failCancel(new Error('EBUSY'));
    await expect(t.installer.stopForQuit()).resolves.toBeUndefined();
    expect(attempt.cancelCalls).toBe(1);
  });

  it('stopForQuit вне downloading и verifying ничего не трогает: готовое приложение остаётся для сценария', async () => {
    const t = setup();
    await t.installer.stopForQuit();
    await t.installer.onFound(A);
    await t.installer.stopForQuit();
    expect(t.installer.state().phase).toBe('available');
    const attempt = await t.readyUp(B);
    await t.installer.install();
    await t.installer.stopForQuit();
    expect(attempt.cancelCalls).toBe(0);
    expect(t.installer.state().phase).toBe('ready');
    expect(t.time.pending()).toBe(0);
  });

  for (const stage of ['downloading', 'verifying'] as const) {
    it(`onQuit без намерения в ${stage}: abandon() без ожидания, сценарий не запущен, каталоги не трогаются`, async () => {
      const { t, attempt } = await running(stage);
      t.installer.onQuit();
      expect(attempt.abandonCalls).toBe(1);
      expect(attempt.cancelCalls).toBe(0);
      expect(t.spawn).not.toHaveBeenCalled();
      expect(t.calls).toEqual([]);
      expect(attempt.cleaned).toBe(false);
      // Слушатель срабатывает один раз.
      t.installer.onQuit();
      expect(attempt.abandonCalls).toBe(1);
    });
  }

  it('onQuit без намерения, когда попытки нет (idle, available, ready), abandon не зовёт', async () => {
    const t = setup();
    const ready = await t.readyUp();
    t.installer.onQuit();
    expect(ready.abandonCalls).toBe(0);
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('onQuit с намерением «Restart now» запускает сценарий как прежде и попытку не обрывает', async () => {
    const t = setup();
    const attempt = await t.readyUp();
    await t.installer.install();
    t.installer.onQuit();
    expect(attempt.abandonCalls).toBe(0);
    expect(t.calls).toEqual(['handoff', 'spawn', 'on-error', 'unref']);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });
});
