// Code Mode (план T12a, §9, слайс D): Stop и сон живой сессии с занятой записью прогона пишут строку журнала, её читает T12b. Настоящий PTY
// со стабом вместо claude, настоящая папка работы; запись прогона — та, что видит `inspectRunRecord` (свободна, нечитаема).
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWork, workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService } from './sessions-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
/** The run-record store of core's build, as a Code Mode session process opens it (s-296 R1 on slice D). */
const RUN_RECORD = fileURLToPath(new URL('../../../core/dist/mcp/code-mode/run-record.js', import.meta.url));
type Store = { open(runId: string): { ok: boolean }; intent(runId: string, ordinal: number, method: string, argsSha256: string): boolean };
const { createRunRecordStore } = (await import(RUN_RECORD)) as { createRunRecordStore: (o: { workDir: string; sessionId: string; launchId: string }) => Store };
vi.setConfig({ testTimeout: 30_000 });

const ENV = ['PARLEY_CLAUDE_BIN', 'PARLEY_SKILL_NAVIGATOR', 'PARLEY_HOME'] as const;
const saved = ENV.map((k) => process.env[k]);
let project = '';
let home = '';
let logs: Array<{ msg: string; data: Record<string, unknown> | undefined }> = [];

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-t12a-stop-'));
  home = await mkdtemp(path.join(tmpdir(), 'parley-t12a-stop-home-'));
  process.env['PARLEY_CLAUDE_BIN'] = STUB;
  process.env['PARLEY_SKILL_NAVIGATOR'] = '0';
  process.env['PARLEY_HOME'] = home;
  logs = [];
});
afterEach(async () => {
  ENV.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function fakeHost(): HostContext {
  const log = (msg: string, data?: object) => { logs.push({ msg, data: data as Record<string, unknown> | undefined }); };
  return {
    version: '0.0.0', startedAt: new Date().toISOString(), paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: log, warn: log, error: log }, clients: () => [], liveSessions: () => 0, broadcast: () => {},
    onShutdown: () => {}, shutdown: async () => {}, busy: () => {},
  };
}
const fakeWorks = (): WorksService => ({ start: async () => {}, snapshot: () => ({ entries: [], branches: {} }), entry: () => undefined, firstReadDone: () => false, onChange: () => () => {}, stop: async () => {} });
const fakeActivity = (): ActivityService => ({ start: async () => {}, get: () => undefined, markSeen: () => {}, onChange: () => () => {}, stop: async () => {} });

async function live(): Promise<{ service: ReturnType<typeof createSessionsService>; ref: SessionRef; codeMode: string }> {
  const host = fakeHost();
  const service = createSessionsService(host, fakeWorks(), createPtyManager(host), fakeActivity());
  const work = await createWork(project, { title: 'T12a stop', goal: '' });
  const ref = await service.create({ projectPath: project, workId: work.work.id, provider: 'claude', label: 'stop', task: 'wait', parent: null });
  expect(service.live(ref)).toBe(true);
  return { service, ref, codeMode: path.join(workPaths(project, work.work.id).dir, 'code-mode') };
}
const heldLines = () => logs.filter((l) => l.msg === 'code mode: stop with a held run record');

describe('Stop and sleep log a held Code Mode run record (T12a §9)', () => {
  it('a free record: Stop writes no line', async () => {
    const { service, ref } = await live();
    await service.stop(ref);
    expect(heldLines()).toEqual([]);
  });

  it('an unreadable record: Stop writes one line, by stop, with the record kind', async () => {
    const { service, ref, codeMode } = await live();
    await mkdir(codeMode, { recursive: true, mode: 0o700 });
    await writeFile(path.join(codeMode, `${ref.sessionId}.run`), '{"torn');
    await service.stop(ref);
    expect(heldLines()).toEqual([{ msg: 'code mode: stop with a held run record', data: { ref, by: 'stop', reason: null, record: 'unreadable', methods: [] } }]);
  });

  it('a sleep names itself and its reason; a group-writable record directory reads as unreadable too', async () => {
    const { service, ref, codeMode } = await live();
    await mkdir(codeMode, { recursive: true });
    await chmod(codeMode, 0o770);
    await service.stop(ref, { by: 'sleep', reason: 'idle' });
    expect(heldLines()).toEqual([{ msg: 'code mode: stop with a held run record', data: { ref, by: 'sleep', reason: 'idle', record: 'unreadable', methods: [] } }]);
  });

  it('a live holder (this process) mid-call, then Stop: one line, held-live, with the method in flight', async () => {
    const { service, ref, codeMode } = await live();
    const store = createRunRecordStore({ workDir: path.dirname(codeMode), sessionId: ref.sessionId, launchId: 'l' });
    expect(store.open('run-1').ok).toBe(true);
    expect(store.intent('run-1', 1, 'get_map', 'a'.repeat(64))).toBe(true);
    await service.stop(ref);
    expect(heldLines()).toEqual([{ msg: 'code mode: stop with a held run record', data: { ref, by: 'stop', reason: null, record: 'held-live', methods: ['get_map'] } }]);
  });

  it('a holder process that exited mid-call without settling, then sleep: one line, unaccounted, by sleep', async () => {
    const { service, ref, codeMode } = await live();
    const script = `const { createRunRecordStore } = await import(${JSON.stringify(RUN_RECORD)});
const s = createRunRecordStore({ workDir: ${JSON.stringify(path.dirname(codeMode))}, sessionId: ${JSON.stringify(ref.sessionId)}, launchId: 'gone' });
if (!s.open('run-1').ok || !s.intent('run-1', 1, 'get_map', '${'b'.repeat(64)}')) process.exit(3);`;
    execFileSync(process.execPath, ['--input-type=module', '-e', script]);
    await service.stop(ref, { by: 'sleep', reason: 'idle' });
    expect(heldLines()).toEqual([{ msg: 'code mode: stop with a held run record', data: { ref, by: 'sleep', reason: 'idle', record: 'unaccounted', methods: ['get_map'] } }]);
  });

  it('a session with no live process: nothing is read or written', async () => {
    const { service, ref, codeMode } = await live();
    await service.stop(ref);
    await mkdir(codeMode, { recursive: true, mode: 0o700 });
    await writeFile(path.join(codeMode, `${ref.sessionId}.run`), '{"torn');
    await service.stop(ref);
    expect(heldLines()).toEqual([]);
  });
});
