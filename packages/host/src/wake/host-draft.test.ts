/**
 * Будильник рядом с `pty.send` (кусок 5.1): черновик хоста и «указатель в полёте».
 * Настоящие `PtyManager`, работы, активность и будильник вокруг стаба — заготовка по
 * образцу `rig` из `wake-service.test.ts`; сам тот файл не меняется (тест 1 куска).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addMessage, addSession, createWork, transitionSession, unreadFor, updateMap, workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createActivityService } from '../activity/activity-service.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import { createSender } from '../pty/send.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createWakeService } from './wake-service.js';
import type { WakeService } from './wake-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Указатель на прямые письма — байт в байт по плану (сквозные ограничения). */
const pointer = (count: number): string => `Новые письма (${count}). Вызови check_inbox.`;

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let stoppers: Array<() => Promise<void> | void> = [];

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: () => {},
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['HARNAS_HOME'] = home;
});

afterEach(async () => {
  for (const stop of stoppers) await stop();
  stoppers = [];
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Активная сессия `launchedBy: host` в новой работе. */
async function activeSession(): Promise<{ workId: string; sessionId: string }> {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'claude', label: 'сессия', task: 'сделать' });
    sessionId = created.id;
    created.launchedBy = 'host';
    transitionSession(current, created.id, 'active');
  });
  return { workId: map.work.id, sessionId };
}

async function sendLetter(workId: string, to: string): Promise<void> {
  await updateMap(project, workId, (map) => {
    addMessage(map, { from: 's-00', to: [to], text: 'тело письма' });
  });
}

interface Rig {
  works: WorksService;
  pty: ReturnType<typeof createPtyManager>;
  wake: WakeService;
  send: ReturnType<typeof createSender>;
  stream: () => string;
  ref: SessionRef;
}

async function rig(enterDelayMs: number): Promise<Rig> {
  const { workId, sessionId } = await activeSession();
  // `events/` — до старта наблюдателей, как при настоящем запуске: хук стаба должен дойти, иначе
  // сессия «без хуков с запуска» и ни будильник, ни pty.send в неё не печатают (fix-final-b).
  await mkdir(workPaths(project, workId).events, { recursive: true });
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {} }, { enterDelayMs });
  const send = createSender({ pty, activity, wake });

  await works.start();
  await activity.start();
  wake.start();

  const ref: SessionRef = { projectPath: project, workId, sessionId };
  const launch: PtyLaunch = {
    command: process.execPath,
    args: [STUB],
    cwd: project,
    env: {
      ...process.env,
      HARNAS_WORK_DIR: path.join(project, '.harnas', 'works', workId),
      HARNAS_SESSION_ID: sessionId,
      STUB_READY_HOOK: '1',
    },
  };
  pty.start(ref, launch);

  let stream = '';
  pty.on('output', (_ref, data) => {
    stream += data;
  });

  stoppers.push(async () => {
    await pty.stop(ref, { graceMs: 200 }).catch(() => {});
    wake.stop();
    await activity.stop();
    await works.stop();
  });

  await waitFor(() => stream.includes('STUB READY'));
  await waitFor(() => (activity.get(ref)?.activity.lastEventAt ?? null) !== null);
  return { works, pty, wake, send, stream: () => stream, ref };
}

/** Письмо сессии дошло до снимка работ хоста — будильник его уже пересчитал. */
async function letterSeen(works: WorksService, ref: SessionRef): Promise<void> {
  await waitFor(() => {
    const map = works.entry(ref.projectPath, ref.workId)?.map;
    return map !== undefined && unreadFor(map, ref.sessionId).length > 0;
  });
}

/**
 * Ответы стаба: `echo: …` до конца строки. Не по началу строки: эхо терминала от
 * следующей печати может встать в ту же строку перед ответом стаба.
 */
const echoes = (stream: string): string[] => stream.match(/echo: [^\r\n]*/g) ?? [];

describe('wake.inFlight и enterDelayMs (кусок 5.1, тест 7)', () => {
  it('истинно между печатью указателя и его Enter, сразу после Enter — ложно, хотя хода нет', async () => {
    const { wake, stream, ref } = await rig(400);
    expect(wake.enterDelayMs).toBe(400);
    expect(wake.inFlight(ref)).toBe(false);

    await sendLetter(ref.workId, ref.sessionId);
    // Эхо терминала показывает напечатанный указатель ещё до Enter.
    await waitFor(() => stream().includes(pointer(1)));
    expect(echoes(stream())).toEqual([]);
    expect(wake.inFlight(ref)).toBe(true);

    await waitFor(() => echoes(stream()).length > 0);
    // У стаба без хуков ход не начинается никогда — внутренняя попытка будильника
    // живёт до предохранителя, а наружу «в полёте» только до Enter.
    expect(wake.inFlight(ref)).toBe(false);
  }, 15_000);
});

describe('будильник поверх черновика хоста (кусок 5.1, тест 8)', () => {
  it('вставка без Enter держит указатель, пока человек не нажмёт Enter; затем указатель отдельным ходом', async () => {
    const { works, pty, send, stream, ref } = await rig(300);

    await expect(send({ ref, text: "'/tmp/a b.png' ", submit: false })).resolves.toEqual({
      inserted: true,
      submitted: false,
      reason: null,
    });
    await sendLetter(ref.workId, ref.sessionId);
    await letterSeen(works, ref);
    await settle(600);
    expect(stream()).not.toContain(pointer(1));
    expect(echoes(stream())).toEqual([]);

    pty.input(ref, '\r');
    await waitFor(() => echoes(stream()).length >= 2);
    expect(echoes(stream())[0]).toBe("echo: '/tmp/a b.png' ");
    expect(echoes(stream())[1]).toBe(`echo: ${pointer(1)}`);
  }, 15_000);

  it('письмо в ожидании Enter pty.send — поверх не печатается, после Enter уходит отдельным ходом', async () => {
    const { works, send, stream, ref } = await rig(500);

    const result = send({ ref, text: 'hello', submit: true });
    await sendLetter(ref.workId, ref.sessionId);
    await letterSeen(works, ref);
    // Письмо в снимке, а свой Enter pty.send ещё не ушёл.
    expect(echoes(stream())).toEqual([]);
    expect(stream()).not.toContain(pointer(1));

    await expect(result).resolves.toEqual({ inserted: true, submitted: true, reason: null });
    await waitFor(() => echoes(stream()).length >= 2);
    expect(echoes(stream())[0]).toBe('echo: hello');
    expect(echoes(stream())[1]).toBe(`echo: ${pointer(1)}`);
  }, 15_000);
});
