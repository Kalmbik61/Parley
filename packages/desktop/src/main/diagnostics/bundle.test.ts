import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostDiagnostics, ProfileStatus } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { saveDiagnostics, type SaveDiagnosticsDeps } from './bundle.js';
import type { RpcRecord } from './rpc-ring.js';

const HAS_UNZIP = existsSync('/usr/bin/unzip');
/** «Сейчас» для сборки: по нему имя архива и возраст профилей. */
const NOW = new Date(2026, 9, 16, 12, 34, 56);

/** Минимальный ответ `host.diagnostics`: хватает полей, которые проверяют тесты. */
const HOST_INFO = {
  hostVersion: '0.13.1',
  node: 'v22.0.0',
  platform: 'darwin',
  release: '24.3.0',
  arch: 'arm64',
  pid: 4242,
  startedAt: '2026-10-16T10:00:00.000Z',
  uptimeSec: 100,
  health: {
    cpuPct: 12.5,
    rssMb: 200,
    heapMb: 80,
    extMb: 10,
    loop: { maxMs: 3, p99Ms: 2, meanMs: 1 },
    ptys: 2,
    attached: 1,
    feedSubs: 1,
    works: 1,
    rooms: 1,
    clients: 1,
  },
  sessions: [],
  profiles: [],
  profile: { state: 'idle' },
} satisfies HostDiagnostics;

const RECORDS: RpcRecord[] = [
  { t: '2026-10-16T10:00:00.000Z', method: 'works.list', ms: 12, ok: true },
  { t: '2026-10-16T10:00:01.000Z', method: 'pty.send', ms: 80, ok: false, error: 'not_found', ref: 's-1' },
];

let hostDir: string;
let outDir: string;

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'parley-bundle-'));
  hostDir = path.join(root, 'host');
  outDir = path.join(root, 'out', 'nested');
  await mkdir(hostDir, { recursive: true });
  await writeFile(path.join(hostDir, 'host.pid'), `${process.pid}\n2026-10-16T10:00:00.000Z\n`);
  await writeFile(path.join(hostDir, 'host.log'), 'строка журнала хоста\n');
});

afterEach(async () => {
  await rm(path.dirname(hostDir), { recursive: true, force: true });
});

/** Настоящий `ps` не нужен там, где проверяется только сбор: `processTree` и `systemSummary` подменены. */
function makeDeps(overrides: Partial<SaveDiagnosticsDeps> = {}): SaveDiagnosticsDeps {
  return {
    call: vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'host.diagnostics') return HOST_INFO;
      throw new Error(`unexpected ${method}`);
    }),
    recentCalls: () => RECORDS,
    hostDir,
    outDir,
    appInfo: () => ({ appVersion: '0.13.1', platform: 'darwin' }),
    readme: 'Parley diagnostics bundle',
    now: () => NOW,
    callTimeoutMs: 1000,
    processTree: vi.fn(async (pids: readonly number[]) => `tree of ${pids.join(',')}`),
    systemSummary: () => 'cpus: 8',
    ...overrides,
  };
}

/** `call`, который на `host.diagnostics` отвечает заданным снимком. */
function answerWith(info: HostDiagnostics): SaveDiagnosticsDeps['call'] {
  return vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'host.diagnostics') return info;
    throw new Error(`unexpected ${method}`);
  });
}

/** `call` хоста, не знающего метода: ответа `host.diagnostics` нет, pid остаётся только в `host.pid`. */
function unsupportedCall(): SaveDiagnosticsDeps['call'] {
  return vi.fn(async () => {
    throw new Error('unknown method host.diagnostics');
  });
}

function listZip(file: string): string {
  return spawnSync('unzip', ['-l', file], { encoding: 'utf8' }).stdout;
}

function readFromZip(file: string, name: string): string {
  return spawnSync('unzip', ['-p', file, name], { encoding: 'utf8' }).stdout;
}

describe('saveDiagnostics', () => {
  it.skipIf(!HAS_UNZIP)('собирает архив со всеми файлами и responded:true', async () => {
    // Настоящие ps и сводка системы: дерево процессов хоста (pid теста, он же в ответе хоста) попадает в processes.txt.
    const deps = makeDeps({ call: answerWith({ ...HOST_INFO, pid: process.pid }) });
    delete deps.processTree;
    delete deps.systemSummary;

    const result = await saveDiagnostics(deps, { profile: false });

    expect(result.hostResponded).toBe(true);
    expect(result.file).toBe(path.join(outDir, 'parley-diagnostics-20261016-123456.zip'));
    const listing = listZip(result.file);
    for (const name of ['README.txt', 'host.log', 'host-info.json', 'app-info.json', 'processes.txt', 'actions.jsonl']) {
      expect(listing).toContain(name);
    }
    const info = JSON.parse(readFromZip(result.file, 'host-info.json')) as { responded: boolean; health: { cpuPct: number } };
    expect(info.responded).toBe(true);
    expect(info.health.cpuPct).toBe(12.5);
    expect(readFromZip(result.file, 'README.txt')).toBe('Parley diagnostics bundle');
    expect(readFromZip(result.file, 'host.log')).toBe('строка журнала хоста\n');
    expect(readFromZip(result.file, 'processes.txt')).toContain(String(process.pid));
    const app = JSON.parse(readFromZip(result.file, 'app-info.json')) as Record<string, unknown>;
    expect(app).toMatchObject({ appVersion: '0.13.1', hostResponded: true });
    const lines = readFromZip(result.file, 'actions.jsonl').trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line) as RpcRecord)).toEqual(RECORDS);
  });

  it.skipIf(!HAS_UNZIP)('processes.txt: хост не ответил — дерево по pid из host.pid, затем пустая строка и сводка системы', async () => {
    const deps = makeDeps({ call: unsupportedCall() });

    const result = await saveDiagnostics(deps, { profile: false });

    expect(deps.processTree).toHaveBeenCalledWith([process.pid]);
    expect(readFromZip(result.file, 'processes.txt')).toBe(`tree of ${process.pid}\n\ncpus: 8`);
  });

  it.skipIf(!HAS_UNZIP)('pid хоста берётся из ответа host.diagnostics, а не из host.pid', async () => {
    await writeFile(path.join(hostDir, 'host.pid'), '777\n2026-10-16T10:00:00.000Z\n');
    const deps = makeDeps({ call: answerWith({ ...HOST_INFO, pid: 4242 }) });

    const result = await saveDiagnostics(deps, { profile: false });

    expect(deps.processTree).toHaveBeenCalledWith([4242]);
    expect(readFromZip(result.file, 'processes.txt')).toBe('tree of 4242\n\ncpus: 8');
  });

  it.skipIf(!HAS_UNZIP)('без host.pid и без ответа хоста в processes.txt строка host.pid: missing', async () => {
    await rm(path.join(hostDir, 'host.pid'));
    const deps = makeDeps({ call: unsupportedCall() });

    const result = await saveDiagnostics(deps, { profile: false });

    expect(deps.processTree).not.toHaveBeenCalled();
    expect(readFromZip(result.file, 'processes.txt')).toBe('host.pid: missing\n\ncpus: 8');
  });

  it.skipIf(!HAS_UNZIP)('хост не ответил за таймаут — responded:false и hostResponded false, архив есть', async () => {
    const deps = makeDeps({ call: () => new Promise<unknown>(() => {}), callTimeoutMs: 50 });

    const started = Date.now();
    const result = await saveDiagnostics(deps, { profile: false });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.hostResponded).toBe(false);
    expect(existsSync(result.file)).toBe(true);
    const info = JSON.parse(readFromZip(result.file, 'host-info.json')) as Record<string, unknown>;
    expect(info).toMatchObject({ responded: false, timeoutMs: 50 });
    expect(info).not.toHaveProperty('error');
    expect(readFromZip(result.file, 'app-info.json')).toContain('"hostResponded": false');
  });

  it.skipIf(!HAS_UNZIP)('повисший вызов, отклонённый после таймаута, не даёт unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate: (error: Error) => void = () => {};
      const deps = makeDeps({
        call: () => new Promise<unknown>((_resolve, reject) => { rejectLate = reject; }),
        callTimeoutMs: 20,
      });
      await saveDiagnostics(deps, { profile: false });

      rejectLate(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it.skipIf(!HAS_UNZIP)('метод не поддержан (call отвергает) — responded:false с error', async () => {
    const deps = makeDeps({ call: unsupportedCall() });

    const result = await saveDiagnostics(deps, { profile: false });

    expect(result.hostResponded).toBe(false);
    const info = JSON.parse(readFromZip(result.file, 'host-info.json')) as Record<string, unknown>;
    expect(info).toMatchObject({ responded: false });
    expect(info.error).toContain('unknown method');
    expect(info).not.toHaveProperty('timeoutMs');
  });

  it.skipIf(!HAS_UNZIP)('свежий дом без host.log.1 и host.err — архив без них', async () => {
    const result = await saveDiagnostics(makeDeps(), { profile: false });

    const listing = listZip(result.file);
    expect(listing).toContain('host.log');
    expect(listing).not.toContain('host.log.1');
    expect(listing).not.toContain('host.err');
    expect(listing).toContain('README.txt');
  });

  it.skipIf(!HAS_UNZIP)('есть host.log.1 и host.err — попадают в архив', async () => {
    await writeFile(path.join(hostDir, 'host.log.1'), 'старый журнал\n');
    await writeFile(path.join(hostDir, 'host.err'), 'stderr хоста\n');

    const result = await saveDiagnostics(makeDeps(), { profile: false });

    expect(readFromZip(result.file, 'host.log.1')).toBe('старый журнал\n');
    expect(readFromZip(result.file, 'host.err')).toBe('stderr хоста\n');
  });

  it.skipIf(!HAS_UNZIP)('profile: ждёт done по статусам и включает свежий .cpuprofile, старый (25 ч) — нет', async () => {
    const diagnosticsDir = path.join(hostDir, 'diagnostics');
    await mkdir(diagnosticsDir, { recursive: true });
    await writeFile(path.join(diagnosticsDir, 'host-20261016-120000.cpuprofile'), '{"fresh":true}');
    await writeFile(path.join(diagnosticsDir, 'host-20261014-110000.cpuprofile'), '{"old":true}');
    // Возраст считается от инжектированного now(): свежий — минуту назад, старый — 25 ч.
    const fresh = new Date(NOW.getTime() - 60_000);
    const old = new Date(NOW.getTime() - 25 * 3600 * 1000);
    await utimes(path.join(diagnosticsDir, 'host-20261016-120000.cpuprofile'), fresh, fresh);
    await utimes(path.join(diagnosticsDir, 'host-20261014-110000.cpuprofile'), old, old);

    const running: ProfileStatus = { state: 'running', startedAt: '2026-10-16T12:00:00.000Z', seconds: 20 };
    const done: ProfileStatus = {
      state: 'done',
      file: path.join(diagnosticsDir, 'host-20261016-120000.cpuprofile'),
      finishedAt: '2026-10-16T12:00:20.000Z',
    };
    // Первый опрос — ещё идёт, второй — готово.
    const pollAnswers: ProfileStatus[] = [running, done];
    const calls: Array<{ method: string; params: unknown }> = [];
    const call = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      if (method === 'host.profile.start') return running;
      if (method === 'host.profile.status') return pollAnswers.shift();
      if (method === 'host.diagnostics') return HOST_INFO;
      throw new Error(`unexpected ${method}`);
    });

    const result = await saveDiagnostics(makeDeps({ call, profileSeconds: 20, profilePollMs: 5 }), { profile: true });

    expect(calls[0]).toEqual({ method: 'host.profile.start', params: { seconds: 20 } });
    const polls = calls.filter((item) => item.method === 'host.profile.status');
    expect(polls.length).toBe(2);
    // Профиль завершён до снимка хоста: diagnostics спрашивается после опроса.
    expect(calls.map((item) => item.method).lastIndexOf('host.profile.status')).toBeLessThan(calls.findIndex((item) => item.method === 'host.diagnostics'));
    const listing = listZip(result.file);
    expect(listing).toContain('host-20261016-120000.cpuprofile');
    expect(listing).not.toContain('host-20261014-110000.cpuprofile');
    expect(readFromZip(result.file, 'host-20261016-120000.cpuprofile')).toBe('{"fresh":true}');
  });

  it.skipIf(!HAS_UNZIP)('profile: старт отвергнут (старый хост) — архив всё равно собирается', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'host.diagnostics') throw new Error('unknown method host.diagnostics');
      throw new Error('unknown method');
    });

    const result = await saveDiagnostics(makeDeps({ call }), { profile: true });

    expect(result.hostResponded).toBe(false);
    expect(existsSync(result.file)).toBe(true);
  });

  it.skipIf(!HAS_UNZIP)('profile: failed завершает ожидание без опроса до дедлайна', async () => {
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'host.profile.start') return { state: 'running', startedAt: 'x', seconds: 20 };
      if (method === 'host.profile.status') return { state: 'failed', error: 'inspector unavailable' };
      return HOST_INFO;
    });

    const started = Date.now();
    const result = await saveDiagnostics(makeDeps({ call, profilePollMs: 5 }), { profile: true });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.hostResponded).toBe(true);
  });

  it.skipIf(!HAS_UNZIP)('profile: статус навсегда running — ожидание прекращается по дедлайну, архив собирается без профиля', async () => {
    let statusCalls = 0;
    const running: ProfileStatus = { state: 'running', startedAt: '2026-10-16T12:00:00.000Z', seconds: 0.01 };
    const call = vi.fn(async (method: string): Promise<unknown> => {
      if (method === 'host.profile.start') return running;
      if (method === 'host.profile.status') {
        statusCalls += 1;
        return running;
      }
      return HOST_INFO;
    });

    const result = await saveDiagnostics(
      makeDeps({ call, profileSeconds: 0.01, profilePollMs: 5, profileGraceMs: 50 }),
      { profile: true },
    );

    expect(existsSync(result.file)).toBe(true);
    expect(result.hostResponded).toBe(true);
    // Дедлайн 10 мс + 50 мс при опросе раз в 5 мс: опросов несколько, но конечное число.
    expect(statusCalls).toBeGreaterThan(0);
    expect(statusCalls).toBeLessThan(100);
    expect(listZip(result.file)).not.toContain('.cpuprofile');
  });

  it.skipIf(!HAS_UNZIP)('приватность: токен, сокет и providers.json хоста в архив не попадают (спека A7)', async () => {
    const marker = 'SECRET-MARKER';
    await writeFile(path.join(hostDir, 'host.token'), `${marker}\n`);
    await writeFile(path.join(hostDir, 'host.sock'), marker);
    await writeFile(path.join(hostDir, 'providers.json'), JSON.stringify({ glm: { env: { ANTHROPIC_AUTH_TOKEN: marker } } }));

    const result = await saveDiagnostics(makeDeps(), { profile: false });

    const names = spawnSync('unzip', ['-Z1', result.file], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(names).toEqual(['README.txt', 'host.log', 'host-info.json', 'app-info.json', 'processes.txt', 'actions.jsonl']);
    // `unzip -p` без имён распаковывает в stdout все записи: маркера нет ни в одной.
    expect(spawnSync('unzip', ['-p', result.file], { encoding: 'utf8' }).stdout).not.toContain(marker);
  });
});

describe('README диагностики (S.diagnostics.readme)', () => {
  it('называет архив, состав процессов, приватность и куда отправить', () => {
    const { readme } = S.diagnostics;

    expect(readme).toContain('Parley diagnostics bundle');
    expect(readme).toContain('executable name only');
    expect(readme).toContain('Message text, terminal output, provider keys and environment variables are not.');
    expect(readme).toContain('https://github.com/Kalmbik61/Parley/issues');
  });
});
