import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import type { CodexSignal } from './codex-terminal.js';
import { createWindowCounters } from '../health/window-counters.js';
import { createPtyManager } from './pty-manager.js';
import type { ExitInfo, PtyLaunch } from './pty-process.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let busyKeys: Set<string>;

/** Минимальный `HostContext`: `PtyManager` использует только `busy` и `broadcast`. */
function fakeHost(): HostContext {
  busyKeys = new Set();
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => busyKeys.size,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: (key, isBusy) => {
      if (isBusy) busyKeys.add(key);
      else busyKeys.delete(key);
    },
  };
}

let refCounter = 0;
function ref(): SessionRef {
  refCounter += 1;
  return { projectPath: '/tmp/project', workId: 'w-01', sessionId: `s-${refCounter}` };
}

function launch(env: NodeJS.ProcessEnv = {}, args: string[] = []): PtyLaunch {
  return { command: process.execPath, args: [STUB, ...args], cwd: process.cwd(), env: { ...process.env, ...env } };
}

const tempFiles: string[] = [];
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-pty-test-'));
  tempFiles.push(dir);
  return path.join(dir, 'args.json');
}

afterEach(async () => {
  broadcasts = [];
  await Promise.all(tempFiles.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PtyManager', () => {
  it('счётчики окна: каждый кусок вывода PTY считается кусками и байтами', async () => {
    const windowCounters = createWindowCounters();
    const manager = createPtyManager(fakeHost(), windowCounters);
    const sessionRef = ref();
    manager.start(sessionRef, launch());

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    const tally = windowCounters.read();
    expect(tally.ptyChunks).toBeGreaterThan(0);
    expect(tally.ptyBytes).toBeGreaterThanOrEqual('STUB READY'.length);

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('pty.attach: снимок сразу после старта содержит баннер стаба', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch());

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    expect(manager.snapshot(sessionRef).snapshot).toContain('STUB READY');

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('ввод человека доходит до процесса и эхо приходит в поток output', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch());

    let stream = '';
    manager.on('output', (_ref, data) => {
      stream += data;
    });

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    manager.input(sessionRef, 'hello\r');

    await waitFor(() => stream.includes('echo: hello'));
    expect(stream).toContain('echo: hello');

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('resize долетает до процесса: стаб печатает новый размер по SIGWINCH', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch());

    let stream = '';
    manager.on('output', (_ref, data) => {
      stream += data;
    });

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    manager.resize(sessionRef, 100, 30);

    await waitFor(() => stream.includes('SIZE 100 30'));
    expect(stream).toContain('SIZE 100 30');
    expect(manager.get(sessionRef)?.cols).toBe(100);
    expect(manager.get(sessionRef)?.rows).toBe(30);

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('stop(): процесс, игнорирующий SIGHUP, добивается SIGKILL по истечении grace', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch({ STUB_IGNORE_SIGHUP: '1' }));

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));

    const started = Date.now();
    const exit = await manager.stop(sessionRef, { graceMs: 200 });
    const elapsed = Date.now() - started;

    expect(exit.signal).toBe(9);
    // Добивание пришло не раньше grace — иначе это случайный SIGHUP, а не SIGKILL по таймеру.
    expect(elapsed).toBeGreaterThanOrEqual(190);
  });

  it('manager.write (печать хоста) не выставляет флаг черновика', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const handle = manager.start(sessionRef, launch());

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));

    manager.write(sessionRef, 'текст указателя\r');
    expect(handle.hasDraft()).toBe(false);

    // Контраст: тот же ввод через input() флаг ставит (до Enter).
    manager.input(sessionRef, 'привет');
    expect(handle.hasDraft()).toBe(true);

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('tracks a raw Kimi queue/steer key as a submit without letting keys inside a paste clear the draft', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const handle = manager.start(sessionRef, { ...launch(), kimiNative: true });
    try {
      await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
      for (const key of ['\x11', '\x1b[13;5u', '\x13']) {
        manager.input(sessionRef, 'prompt');
        expect(handle.hasDraft()).toBe(true);
        manager.input(sessionRef, key);
        expect(handle.hasDraft()).toBe(false);
      }
      manager.input(sessionRef, '\x1b[200~prompt');
      manager.input(sessionRef, '\x11');
      manager.input(sessionRef, '\x1b[201~');
      expect(handle.hasDraft()).toBe(true);
    } finally {
      await manager.stop(sessionRef, { graceMs: 200 });
    }
  });

  it('живой PTY занимает host.busy() и освобождает его на выходе процесса; pty.exit уходит broadcast', async () => {
    const host = fakeHost();
    const manager = createPtyManager(host);
    const sessionRef = ref();
    manager.start(sessionRef, launch());

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    expect(host.liveSessions()).toBe(1);

    await manager.stop(sessionRef, { graceMs: 200 });

    expect(host.liveSessions()).toBe(0);
    const exitEvent = broadcasts.find((b) => b.event === 'pty.exit');
    expect(exitEvent).toBeDefined();
    expect((exitEvent?.data as { ref: SessionRef }).ref).toEqual(sessionRef);
  });

  it('STUB_ARGS_FILE: до процесса доезжают cwd и переменные окружения работы', async () => {
    const argsFile = await tempFile();
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(
      sessionRef,
      launch({ STUB_ARGS_FILE: argsFile, PARLEY_WORK_DIR: '/tmp/work', PARLEY_SESSION_ID: sessionRef.sessionId }),
    );

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    await waitFor(() => existsSync(argsFile));

    const payload = JSON.parse(await readFile(argsFile, 'utf8')) as {
      env: { PARLEY_WORK_DIR: string | null; PARLEY_SESSION_ID: string | null };
    };
    expect(payload.env.PARLEY_WORK_DIR).toBe('/tmp/work');
    expect(payload.env.PARLEY_SESSION_ID).toBe(sessionRef.sessionId);

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('STUB_EXIT_AFTER_MS: процесс завершается сам с кодом 3', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch({ STUB_EXIT_AFTER_MS: '50' }));

    const exit = await new Promise<ExitInfo>((resolve) => manager.on('exit', (_ref, info) => resolve(info)));
    expect(exit.exitCode).toBe(3);
  });

  it("on('start'): новый PTY сессии сообщается слушателю, и ручка уже доступна через get()", async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const seen: Array<{ ref: SessionRef; live: boolean }> = [];
    manager.on('start', (startedRef) => seen.push({ ref: startedRef, live: manager.get(startedRef) !== undefined }));

    manager.start(sessionRef, launch());
    await manager.stop(sessionRef, { graceMs: 200 });
    manager.start(sessionRef, launch());

    expect(seen).toEqual([
      { ref: sessionRef, live: true },
      { ref: sessionRef, live: true },
    ]);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('STUB_HOOKS + STUB_TURN_MS: ход занимает заданное время между репликами', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch({ STUB_HOOKS: '1', STUB_TURN_MS: '150' }));

    let stream = '';
    manager.on('output', (_ref, data) => {
      stream += data;
    });

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    const started = Date.now();
    manager.input(sessionRef, 'hello\r');

    await waitFor(() => stream.includes('echo: hello'));
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it(
    'STUB_FLOOD_MB=20: снимок остаётся ограничен прокруткой, а не растёт с потоком',
    async () => {
      const manager = createPtyManager(fakeHost());
      const sessionRef = ref();
      manager.start(sessionRef, launch({ STUB_FLOOD_MB: '20' }));

      await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('FLOOD DONE'), 40_000);

      const { snapshot, rows } = manager.snapshot(sessionRef);
      const lineCount = snapshot.split(/\r?\n/).length;
      // 5000 строк прокрутки плюс видимая область — с запасом на служебные
      // переносы, но точно не тысячи строк, которые реально напечатал стаб.
      expect(lineCount).toBeLessThanOrEqual(5000 + rows + 20);
      expect(snapshot).toContain('FLOOD DONE');

      await manager.stop(sessionRef, { graceMs: 200 });
    },
    50_000,
  );
});

describe('PtyManager: черновик хоста (кусок 5.1)', () => {
  /** Живая сессия со стабом и журналом событий draft и host-draft. */
  async function started() {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch());
    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    const drafts: boolean[] = [];
    const hostDrafts: boolean[] = [];
    manager.on('draft', (_ref, value) => drafts.push(value));
    manager.on('host-draft', (_ref, value) => hostDrafts.push(value));
    return { manager, sessionRef, drafts, hostDrafts };
  }

  it('setHostDraft(true): hasDraft() истинно, draft нет, host-draft есть; повтор значения молчит', async () => {
    const { manager, sessionRef, drafts, hostDrafts } = await started();
    manager.setHostDraft(sessionRef, true);
    expect(manager.get(sessionRef)?.hasDraft()).toBe(true);
    expect(drafts).toEqual([]);
    expect(hostDrafts).toEqual([true]);

    manager.setHostDraft(sessionRef, true);
    expect(hostDrafts).toEqual([true]);
    manager.setHostDraft(sessionRef, false);
    expect(hostDrafts).toEqual([true, false]);
    expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('ввод человека x черновик хоста не снимает', async () => {
    const { manager, sessionRef } = await started();
    manager.setHostDraft(sessionRef, true);
    manager.input(sessionRef, 'x');
    manager.input(sessionRef, '\x7f');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(true);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  for (const key of ['\r', '\x03', '\x15']) {
    it(`${JSON.stringify(key)} человека снимает черновик хоста и шлёт draft`, async () => {
      const { manager, sessionRef, drafts } = await started();
      manager.setHostDraft(sessionRef, true);
      manager.input(sessionRef, key);
      expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
      expect(drafts).toEqual([false]);
      await manager.stop(sessionRef, { graceMs: 200 });
    });
  }

  it('вставка человека с \\r, конец вставки отдельным куском, — черновики стоят; \\r после вставки снимает оба', async () => {
    const { manager, sessionRef } = await started();
    manager.setHostDraft(sessionRef, true);
    manager.input(sessionRef, '\x1b[200~a\rb\r');
    manager.input(sessionRef, '\x1b[201~');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(true);
    manager.input(sessionRef, '\x15');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(false);

    manager.setHostDraft(sessionRef, true);
    manager.input(sessionRef, '\x1b[200~a\r');
    manager.input(sessionRef, '\x1b[201~\r');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('содержимое вставки (⌃C, ⌃U, \\r, \\n в конце) черновики не снимает; Enter после — снимает', async () => {
    const { manager, sessionRef, hostDrafts } = await started();
    for (const chunk of [
      '\x1b[200~a\x03b\x1b[201~',
      '\x1b[200~a\x15b\x1b[201~',
      '\x1b[200~a\rb\x1b[201~',
      '\x1b[200~text\n\x1b[201~',
    ]) {
      manager.setHostDraft(sessionRef, true);
      manager.input(sessionRef, chunk);
      expect(manager.get(sessionRef)?.hasDraft()).toBe(true);
      manager.input(sessionRef, '\r');
      expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
    }
    expect(hostDrafts).toEqual([true, true, true, true]);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  // Снятие черновика хоста вводом человека уходит событием draft, не host-draft, поэтому
  // черновик хоста виден так: стираем Backspace черновик человека — hasDraft() остаётся
  // истинным, только пока стоит черновик хоста.
  it('две вставки в одном куске с \\r между ними — черновик хоста снят', async () => {
    const { manager, sessionRef } = await started();
    manager.setHostDraft(sessionRef, true);
    manager.input(sessionRef, '\x1b[200~a\x1b[201~\r\x1b[200~b\x1b[201~');
    manager.input(sessionRef, '\x7f');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('вставка из двух кусков с \\n и ⌃C внутри не снимает черновик хоста до Enter после конца', async () => {
    const { manager, sessionRef } = await started();
    manager.setHostDraft(sessionRef, true);
    manager.input(sessionRef, '\x1b[200~');
    manager.input(sessionRef, '\x03\n\x1b[201~');
    manager.input(sessionRef, '\x7f');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(true);
    manager.input(sessionRef, '\r');
    expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('bracketedPaste() ручки — режим экрана: стаб его не включает', async () => {
    const { manager, sessionRef } = await started();
    expect(manager.get(sessionRef)?.bracketedPaste()).toBe(false);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('новый процесс той же сессии черновика хоста не наследует', async () => {
    const { manager, sessionRef } = await started();
    manager.setHostDraft(sessionRef, true);
    await manager.stop(sessionRef, { graceMs: 200 });
    manager.start(sessionRef, launch());
    expect(manager.get(sessionRef)?.hasDraft()).toBe(false);
    await manager.stop(sessionRef, { graceMs: 200 });
  });
});

const CODEX_STUB = fileURLToPath(new URL('../../test/stub-codex.mjs', import.meta.url));

/** Запуск заглушки codex: `provider` включает разбор терминала, остальное — как у любого агента. */
function codexLaunch(env: NodeJS.ProcessEnv = {}, provider?: string): PtyLaunch {
  return {
    command: process.execPath,
    args: [CODEX_STUB],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    ...(provider === undefined ? {} : { provider }),
  };
}

describe('PtyManager: сигналы терминала codex (спека комнат, 3.6)', () => {
  const kinds = (signals: CodexSignal[]): string[] => signals.map((signal) => signal.kind);

  it('ручка знает провайдера: codex — `codex`, без provider — null', async () => {
    const manager = createPtyManager(fakeHost());
    const codexRef = ref();
    const plainRef = ref();
    manager.start(codexRef, codexLaunch({}, 'codex'));
    manager.start(plainRef, launch());

    expect(manager.get(codexRef)?.provider).toBe('codex');
    expect(manager.get(plainRef)?.provider).toBeNull();
    await manager.stop(codexRef, { graceMs: 200 });
    await manager.stop(plainRef, { graceMs: 200 });
  });

  it('заголовок и уведомление процесса приходят сигналами по порядку', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const signals: CodexSignal[] = [];
    manager.on('signal', (from, signal) => {
      if (from.sessionId === sessionRef.sessionId) signals.push(signal);
    });
    manager.start(sessionRef, codexLaunch({}, 'codex'));

    await waitFor(() => kinds(signals).includes('ready'));
    manager.input(sessionRef, 'STUB_WORK\r');
    await waitFor(() => kinds(signals).includes('working'));
    manager.input(sessionRef, 'STUB_APPROVAL\r');
    await waitFor(() => signals.some((signal) => signal.kind === 'needs-you'));
    manager.input(sessionRef, 'STUB_READY\r');
    await waitFor(() => kinds(signals).at(-1) === 'ready');

    const list = kinds(signals);
    expect(list[0]).toBe('ready');
    expect(list.indexOf('working')).toBeGreaterThan(list.indexOf('ready'));
    expect(signals).toContainEqual({ kind: 'needs-you', reason: 'approval-requested', detail: 'ls -la' });
    expect(signals).toContainEqual({ kind: 'needs-you', reason: 'action-required', detail: null });
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('спиннер идёт кадр за кадром — сигналов working много, ready в конце один', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const signals: CodexSignal[] = [];
    manager.on('signal', (_from, signal) => signals.push(signal));
    manager.start(sessionRef, codexLaunch({}, 'codex'));

    await waitFor(() => kinds(signals).includes('ready'));
    manager.input(sessionRef, 'STUB_WORK 300\r');
    await waitFor(() => kinds(signals).filter((kind) => kind === 'ready').length === 2, 8000);

    expect(kinds(signals).filter((kind) => kind === 'working').length).toBeGreaterThanOrEqual(3);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('процесс без provider (claude) тот же поток не разбирается: сигналов нет', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const signals: CodexSignal[] = [];
    manager.on('signal', (_from, signal) => signals.push(signal));
    manager.start(sessionRef, codexLaunch({}));

    let stream = '';
    manager.on('output', (_from, data) => {
      stream += data;
    });
    await waitFor(() => stream.includes('\x1b]0;Ready'));
    manager.input(sessionRef, 'STUB_WORK 100\r');
    await waitFor(() => stream.includes('Working'));

    expect(signals).toEqual([]);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('слушатель, который бросает, поток не роняет: остальные слушатели и вывод живы', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const signals: CodexSignal[] = [];
    manager.on('signal', () => {
      throw new Error('слушатель упал');
    });
    manager.on('signal', (_from, signal) => signals.push(signal));
    let stream = '';
    manager.on('output', (_from, data) => {
      stream += data;
    });
    manager.start(sessionRef, codexLaunch({}, 'codex'));

    await waitFor(() => kinds(signals).includes('ready'));
    manager.input(sessionRef, 'STUB_WORK 60\r');
    await waitFor(() => kinds(signals).includes('working'));
    await waitFor(() => stream.includes('stub-codex готов'));
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('снятая подписка сигналов больше не получает', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const seen: CodexSignal[] = [];
    const off = manager.on('signal', (_from, signal) => seen.push(signal));
    manager.start(sessionRef, codexLaunch({}, 'codex'));
    await waitFor(() => seen.length > 0);
    off();
    const count = seen.length;
    manager.input(sessionRef, 'STUB_WORK 60\r');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen.length).toBe(count);
    await manager.stop(sessionRef, { graceMs: 200 });
  });
});

describe('PtyManager: изоляция слушателей', () => {
  function spyHost(): { host: HostContext; errors: string[] } {
    const errors: string[] = [];
    const base = fakeHost();
    const host: HostContext = {
      ...base,
      log: { info: () => {}, warn: () => {}, error: (message: string) => void errors.push(message) },
    };
    return { host, errors };
  }

  it('бросивший слушатель выхода не мешает остальным и не вешает stop()', async () => {
    const { host, errors } = spyHost();
    const manager = createPtyManager(host);
    const sessionRef = ref();
    let second = 0;
    manager.on('exit', () => {
      throw new Error('boom');
    });
    manager.on('exit', () => {
      second += 1;
    });
    manager.start(sessionRef, launch());
    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));

    await manager.stop(sessionRef, { graceMs: 200 });
    expect(second).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('бросивший слушатель старта не отменяет запуск', async () => {
    const { host, errors } = spyHost();
    const manager = createPtyManager(host);
    const sessionRef = ref();
    let second = 0;
    manager.on('start', () => {
      throw new Error('boom');
    });
    manager.on('start', () => {
      second += 1;
    });
    const handle = manager.start(sessionRef, launch());

    expect(handle).toBeDefined();
    expect(manager.get(sessionRef)).toBeDefined();
    expect(second).toBe(1);
    expect(errors).toHaveLength(1);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('сбой рассылки pty.exit всё равно разрешает stop()', async () => {
    const base = fakeHost();
    const host: HostContext = {
      ...base,
      broadcast: (event, data) => {
        if (event === 'pty.exit') throw new Error('broadcast failed');
        base.broadcast(event, data);
      },
    };
    const manager = createPtyManager(host);
    const sessionRef = ref();
    manager.start(sessionRef, launch());
    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));

    await expect(manager.stop(sessionRef, { graceMs: 200 })).resolves.toBeDefined();
  });
});

describe('PtyManager: Qwen Code program status (OSC 7501)', () => {
  /** A process that prints the given OSC 7501 reports, split at the ST terminator, then waits. */
  const qwenLaunch = (states: string[], provider = 'qwen'): PtyLaunch => ({
    command: process.execPath,
    args: ['-e', `const parts = ${JSON.stringify(states)}.map((s) => '\\x1b]7501;' + s + '\\x1b\\\\');
      let i = 0; const t = setInterval(() => { if (i >= parts.length) { clearInterval(t); return; }
      const p = parts[i++]; process.stdout.write(p.slice(0, -1)); setTimeout(() => process.stdout.write(p.slice(-1)), 5); }, 30);
      setTimeout(() => {}, 60000);`],
    cwd: process.cwd(),
    env: { ...process.env },
    provider,
  });

  it('reports the qwen session status in stream order, across chunk boundaries', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const seen: Array<{ state: string; kind: string | null }> = [];
    manager.on('program-status', (from, status) => {
      if (from.sessionId === sessionRef.sessionId) seen.push({ state: status.state, kind: status.kind });
    });
    manager.start(sessionRef, qwenLaunch(['state=blocked:kind=auth:app=qwen-code', 'state=idle:app=qwen-code']));
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([{ state: 'blocked', kind: 'auth' }, { state: 'idle', kind: null }]);
    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('other providers report nothing', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    const seen: unknown[] = [];
    let output = '';
    manager.on('program-status', (_from, status) => seen.push(status));
    manager.on('output', (_from, data) => { output += data; });
    manager.start(sessionRef, qwenLaunch(['state=idle:app=qwen-code'], 'claude'));
    await waitFor(() => output.includes('7501'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(seen).toEqual([]);
    await manager.stop(sessionRef, { graceMs: 200 });
  });
});

function controlled(pid: number) {
  let emit: (value: string) => void = () => {};
  let finish: (value: ExitInfo) => void = () => {};
  return {
    process: { pid, write() {}, resize() {}, kill() {},
      onData(listener: typeof emit) { emit = listener; return () => {}; },
      onExit(listener: typeof finish) { finish = listener; return () => {}; },
    },
    data: (value: string) => emit(value),
    exit: () => finish({ exitCode: 0, signal: null }),
  };
}

it('fences late PTY data and exit callbacks after another generation owns the ref', async () => {
  const manager = createPtyManager(fakeHost());
  const sessionRef = ref();
  const old = controlled(1);
  const current = controlled(2);
  let stream = '';
  manager.on('output', (_ref, data) => { stream += data; });
  manager.start(sessionRef, { ...launch(), process: old.process });
  old.data('queued old');
  const handle = manager.start(sessionRef, { ...launch(), process: current.process, kimiNative: true });
  old.data('late old');
  old.exit();
  expect(manager.get(sessionRef)?.generation).toBe(handle.generation);
  manager.resize(sessionRef, 105, 35);
  expect(handle.inputRevision?.()).toBe(1);
  expect(handle.rawInputRevision?.()).toBe(0);
  manager.input(sessionRef, 'x');
  expect(handle.inputRevision?.()).toBe(2);
  expect(handle.rawInputRevision?.()).toBe(1);
  expect(busyKeys.size).toBe(1);
  expect(broadcasts.some(({ event }) => event === 'pty.exit')).toBe(false);
  current.data('current bytes');
  await waitFor(() => stream === 'current bytes');
  current.exit();
  expect(manager.get(sessionRef)).toBeUndefined();
});

describe('PtyManager: display-only terminal status', () => {
  const osc = (fields: string) => '\x1b]7501;' + fields + '\x07';

  it('isolates the display event from Qwen readiness and from unconfirmed families', () => {
    const manager = createPtyManager(fakeHost());
    const qwen = controlled(1);
    const other = controlled(2);
    const a = ref();
    const b = ref();
    const display: unknown[] = [];
    const canonical: unknown[] = [];
    manager.on('terminal-status', (from, status) => display.push([from, status]));
    manager.on('program-status', (from, status) => canonical.push([from, status]));
    manager.start(a, { ...launch(), provider: 'qwen', process: qwen.process });
    manager.start(b, { ...launch(), provider: 'kimi', process: other.process });

    other.data(osc('state=idle:app=qwen-code') + osc('state=clear'));
    qwen.data(osc('state=idle:app=opencode') + osc('state=clear:app=opencode'));
    qwen.data(osc('state=idle:app=qwen-code:id=child') + osc('state=clear:id=child'));
    qwen.data(osc('state=blocked:kind=permission:app=qwen-code:msg=YWJj'));
    qwen.data(osc('state=unrecognized:app=qwen-code'));
    qwen.data(osc('state=clear'));

    expect(display).toEqual([[a, { state: 'blocked', kind: 'permission' }], [a, null]]);
    expect(canonical).toEqual([
      [a, { state: 'blocked', kind: 'permission', msg: 'abc' }],
      [a, { state: 'clear', kind: null, msg: null }],
    ]);
    qwen.exit();
    other.exit();
  });

  it('routes OpenCode root frames only to display, never to Qwen readiness or prompts', () => {
    const manager = createPtyManager(fakeHost());
    const qwen = controlled(1);
    const opencode = controlled(2);
    const a = ref();
    const b = ref();
    const display: unknown[] = [];
    const canonical: unknown[] = [];
    manager.on('terminal-status', (from, status) => display.push([from, status]));
    manager.on('program-status', (from, status) => canonical.push([from, status]));
    manager.start(a, { ...launch(), provider: 'qwen', process: qwen.process });
    manager.start(b, { ...launch(), provider: 'opencode', process: opencode.process });

    qwen.data(osc('state=blocked:app=qwen-code:kind=question'));
    opencode.data(osc('state=idle:app=opencode'));
    opencode.data(osc('state=working:app=opencode:id=ses_child'));
    opencode.data(osc('state=blocked:app=opencode:kind=permission'));
    opencode.data(osc('state=clear:id=ses_child'));
    opencode.data(osc('state=idle:app=qwen-code'));
    opencode.data(osc('state=clear'));
    expect(canonical).toEqual([[a, { state: 'blocked', kind: 'question', msg: null }]]);
    expect(display).toEqual([
      [a, { state: 'blocked', kind: 'question' }],
      [b, { state: 'idle' }],
      [b, { state: 'blocked', kind: 'permission' }],
      [b, null],
    ]);
    qwen.exit();
    opencode.exit();
  });

  it('delivers mixed Codex OSC 0/2/9 and 7501 frames in stream order without Qwen signals', () => {
    const manager = createPtyManager(fakeHost());
    const codex = controlled(1);
    const target = ref();
    const reports: unknown[] = [];
    const qwen: unknown[] = [];
    manager.on('signal', (_ref, signal) => reports.push(['legacy', signal]));
    manager.on('terminal-status', (_ref, status) => reports.push(['display', status]));
    manager.on('program-status', (_ref, status) => qwen.push(status));
    manager.start(target, { ...launch(), provider: 'codex', process: codex.process });

    codex.data('\x1b]0;Ready\x07' + osc('?') + '\x1b]7501;state=blocked:kind=permission:app=codex\x1b');
    expect(reports).toEqual([['legacy', { kind: 'ready' }]]);
    codex.data('\\\x1b]9;Approval requested: ls -la\x07' +
      osc('state=working:app=codex:id=child') + osc('state=done:app=codex') +
      '\x1b]2;Working\x07' + osc('state=clear'));
    expect(reports).toEqual([
      ['legacy', { kind: 'ready' }],
      ['display', { state: 'blocked', kind: 'permission' }],
      ['legacy', { kind: 'needs-you', reason: 'approval-requested', detail: 'ls -la' }],
      ['display', { state: 'done' }],
      ['legacy', { kind: 'working' }],
      ['display', null],
    ]);
    expect(qwen).toEqual([]);
    codex.exit();
  });

  it('does not carry frames across replacements or exits, with two Qwen sessions in one directory', () => {
    const manager = createPtyManager(fakeHost());
    const old = controlled(1);
    const current = controlled(2);
    const parallel = controlled(3);
    const a = ref();
    const b = ref();
    const lifecycle: unknown[] = [];
    manager.on('start', (from) => lifecycle.push(['start', from]));
    manager.on('exit', (from) => lifecycle.push(['exit', from]));
    manager.on('terminal-status', (from, status) => lifecycle.push(['status', from, status]));
    manager.start(a, { ...launch(), provider: 'qwen', process: old.process });
    manager.start(b, { ...launch(), provider: 'qwen', process: parallel.process });

    const idle = osc('state=idle:app=qwen-code');
    old.data(osc('state=working:app=qwen-code') + idle.slice(0, -1));
    manager.start(a, { ...launch(), provider: 'qwen', process: current.process });
    old.data(idle.slice(-1) + osc('state=clear'));
    old.exit();
    current.data(idle.slice(-1));
    parallel.data(idle);
    current.data(osc('state=blocked:kind=auth:app=qwen-code'));
    current.exit();
    current.data(osc('state=clear'));
    parallel.data(osc('state=clear'));
    parallel.exit();

    expect(lifecycle).toEqual([
      ['start', a], ['start', b], ['status', a, { state: 'working' }],
      ['start', a], ['status', b, { state: 'idle' }], ['status', a, { state: 'blocked', kind: 'auth' }],
      ['exit', a], ['status', b, null], ['exit', b],
    ]);
  });

  it('stops delivering the old chunk if a status listener replaces the PTY', () => {
    const manager = createPtyManager(fakeHost());
    const old = controlled(1);
    const current = controlled(2);
    const a = ref();
    const display: unknown[] = [];
    const canonical: unknown[] = [];
    manager.on('terminal-status', () => {
      manager.start(a, { ...launch(), provider: 'qwen', process: current.process });
    });
    manager.on('terminal-status', (_from, status) => display.push(status));
    manager.on('program-status', (_from, status) => canonical.push(status));
    manager.start(a, { ...launch(), provider: 'qwen', process: old.process });
    old.data(osc('state=working:app=qwen-code') + osc('state=idle:app=qwen-code'));
    expect(display).toEqual([]);
    expect(canonical).toEqual([{ state: 'working', kind: null, msg: null }]);
    old.exit();
    current.exit();
  });
});
