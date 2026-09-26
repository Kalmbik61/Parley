import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventData, EventName, SessionRef } from '@harnas/protocol';
import type { HostContext } from '../context.js';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-pty-test-'));
  tempFiles.push(dir);
  return path.join(dir, 'args.json');
}

afterEach(async () => {
  broadcasts = [];
  await Promise.all(tempFiles.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PtyManager', () => {
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
      launch({ STUB_ARGS_FILE: argsFile, HARNAS_WORK_DIR: '/tmp/work', HARNAS_SESSION_ID: sessionRef.sessionId }),
    );

    await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('STUB READY'));
    await waitFor(() => existsSync(argsFile));

    const payload = JSON.parse(await readFile(argsFile, 'utf8')) as {
      env: { HARNAS_WORK_DIR: string | null; HARNAS_SESSION_ID: string | null };
    };
    expect(payload.env.HARNAS_WORK_DIR).toBe('/tmp/work');
    expect(payload.env.HARNAS_SESSION_ID).toBe(sessionRef.sessionId);

    await manager.stop(sessionRef, { graceMs: 200 });
  });

  it('STUB_EXIT_AFTER_MS: процесс завершается сам с кодом 3', async () => {
    const manager = createPtyManager(fakeHost());
    const sessionRef = ref();
    manager.start(sessionRef, launch({ STUB_EXIT_AFTER_MS: '50' }));

    const exit = await new Promise<ExitInfo>((resolve) => manager.on('exit', (_ref, info) => resolve(info)));
    expect(exit.exitCode).toBe(3);
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

      await waitFor(() => manager.snapshot(sessionRef).snapshot.includes('FLOOD DONE'), 15_000);

      const { snapshot, rows } = manager.snapshot(sessionRef);
      const lineCount = snapshot.split(/\r?\n/).length;
      // 5000 строк прокрутки плюс видимая область — с запасом на служебные
      // переносы, но точно не тысячи строк, которые реально напечатал стаб.
      expect(lineCount).toBeLessThanOrEqual(5000 + rows + 20);
      expect(snapshot).toContain('FLOOD DONE');

      await manager.stop(sessionRef, { graceMs: 200 });
    },
    20_000,
  );
});
