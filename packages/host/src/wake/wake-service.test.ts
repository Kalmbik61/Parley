import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addMessage,
  addRoom,
  addSession,
  createWork,
  readMap,
  SYSTEM,
  transitionSession,
  unreadFor,
  updateMap,
  workPaths,
} from '@harnas/core';
import type { EventData, EventName, SessionRef } from '@harnas/protocol';
import type { HostContext } from '../context.js';
import { createActivityService } from '../activity/activity-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import { createPtyManager } from '../pty/pty-manager.js';
import { createHumanRoom, sendHumanLetter } from '../rooms/rooms-service.js';
import { createSessionsService } from '../sessions/sessions-service.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { ResumeLimiter } from './resume-limiter.js';
import { createWakeService } from './wake-service.js';
import type { WakeService, WakeServiceOptions } from './wake-service.js';

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
let broadcasts: Array<{ event: EventName; data: unknown }>;
let stoppers: Array<() => Promise<void> | void> = [];
let extraEnv: string[] = [];

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  extraEnv.push(key);
}

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'harnas-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'harnas-codex-'));
  process.env['HARNAS_HOME'] = home;
  broadcasts = [];
});

afterEach(async () => {
  for (const stop of stoppers) await stop();
  stoppers = [];
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  delete process.env['HARNAS_HOME'];
  await Promise.all([home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Заводит активную сессию `launchedBy: host` в новой работе. */
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

async function sendLetter(workId: string, to: string, text = 'тело письма — секрет'): Promise<void> {
  await updateMap(project, workId, (map) => {
    addMessage(map, { from: 's-00', to: [to], text });
  });
}

interface Rig {
  works: WorksService;
  activity: ActivityService;
  pty: ReturnType<typeof createPtyManager>;
  wake: WakeService;
  stream: () => string;
  ref: SessionRef;
}

/** Собирает works+activity+pty+wake вокруг одной сессии и запускает в ней стаб. */
async function rig(
  sessionId: string,
  workId: string,
  launchEnv: NodeJS.ProcessEnv = {},
  wakeOptions: WakeServiceOptions = {},
): Promise<Rig> {
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  // Подъёма в этих тестах нет: все сессии живые, и `launch` будильнику не нужен.
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {} }, {
    enterDelayMs: 30,
    ...wakeOptions,
  });

  await works.start();
  await activity.start();
  wake.start();

  const ref: SessionRef = { projectPath: project, workId, sessionId };
  const launch: PtyLaunch = {
    command: process.execPath,
    args: [STUB],
    cwd: project,
    env: { ...process.env, ...launchEnv },
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
  return { works, activity, pty, wake, stream: () => stream, ref };
}

describe('WakeService', () => {
  it('1: письмо простаивающей сессии печатается указателем — байт в байт, тело письма не течёт', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, ref } = await rig(sessionId, workId);

    await sendLetter(workId, sessionId, 'секретное тело письма');

    const expected = `echo: ${pointer(1)}`;
    await waitFor(() => stream().includes(expected), 3000);
    expect(stream()).toContain(expected);
    expect(stream()).not.toContain('секретное тело письма');
    void ref;
  });

  it('2: письмо во время хода — указатель уходит только после Stop', async () => {
    const { workId, sessionId } = await activeSession();
    // Как при настоящем запуске: `events/` заводит запись настроек до старта
    // процесса. Без каталога активность не видела бы хуков стаба, пока карта
    // не изменится, а тогда пересчёт будильника обгонял бы чтение журнала.
    await mkdir(workPaths(project, workId).events, { recursive: true });
    const { stream, pty, ref, activity } = await rig(sessionId, workId, {
      STUB_HOOKS: '1',
      STUB_TURN_MS: '500',
      HARNAS_WORK_DIR: path.join(project, '.harnas', 'works', workId),
      HARNAS_SESSION_ID: sessionId,
    });

    pty.input(ref, 'привет\r');
    // Письмо — когда хост уже знает о ходе: журнал хуков склеивается 100 мс, и
    // письмо, пришедшее раньше, застало бы сессию ещё простаивающей.
    await waitFor(() => activity.get(ref)?.activity.activity === 'working', 3000);
    await sendLetter(workId, sessionId);

    // Ход ещё не закончился — указателя быть не должно.
    await settle(250);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);

    // Ход закончился (Stop) — теперь указатель уходит.
    await waitFor(() => stream().includes('echo: привет'), 3000);
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  }, 20_000);

  it('3: черновик блокирует указатель; после \\r черновик снят — указатель уходит', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty, ref } = await rig(sessionId, workId);

    pty.input(ref, 'пр');
    await sendLetter(workId, sessionId);
    await settle(300);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);

    pty.input(ref, '\r');
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });

  it('4: три письма — один указатель с (3)', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream } = await rig(sessionId, workId);

    // Одной записью карты, а не тремя: иначе гонка с наблюдателем работ могла
    // бы застать письма по одному и напечатать три отдельных указателя с (1),
    // а второй и третий заблокировались бы уже висящей попыткой (`in-flight`).
    await updateMap(project, workId, (map) => {
      addMessage(map, { from: 's-00', to: [sessionId], text: 'один' });
      addMessage(map, { from: 's-00', to: [sessionId], text: 'два' });
      addMessage(map, { from: 's-00', to: [sessionId], text: 'три' });
    });

    const expected = `echo: ${pointer(3)}`;
    await waitFor(() => stream().includes(expected), 5000);
    expect(stream().split(expected)).toHaveLength(2);
  });

  it('5: без хуков и с малым pointerTimeoutMs — pointer-timeout, повторного набора нет', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream } = await rig(sessionId, workId, {}, { pointerTimeoutMs: 300 });

    await sendLetter(workId, sessionId);

    const expected = `echo: ${pointer(1)}`;
    await waitFor(() => stream().includes(expected), 3000);

    await waitFor(
      () => broadcasts.some((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'pointer-timeout'),
      2000,
    );

    // Ждём с запасом сверх таймаута — второй попытки быть не должно.
    await settle(400);
    expect(stream().split(expected)).toHaveLength(2);
  });

  it('6: пауза держит письма, resume — доставляет', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, wake } = await rig(sessionId, workId);

    wake.pause();
    expect(wake.paused()).toBe(true);
    await sendLetter(workId, sessionId);
    await settle(300);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);

    wake.resume();
    expect(wake.paused()).toBe(false);
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });

  it('7: ввод человека между текстом и Enter — Enter не уходит, приходит pointer-cancelled', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty, ref } = await rig(sessionId, workId, {}, { enterDelayMs: 300 });

    await sendLetter(workId, sessionId);

    const raw = pointer(1);
    await waitFor(() => stream().includes(raw), 3000);
    pty.input(ref, 'X');

    await settle(600);
    expect(stream()).not.toContain(`echo: ${raw}`);

    const cancelled = broadcasts.find(
      (b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'pointer-cancelled',
    );
    expect(cancelled).toBeDefined();
    expect((cancelled?.data as { ref: SessionRef }).ref).toEqual(ref);
  });
});

/**
 * Спящая сессия-адресат `s-01` и сессия-отправитель `s-02` в `pending`: её
 * будильник не трогает (поднимает autoLaunch), а письмо о сбое ей приходит.
 */
async function sleepingPair(
  lifecycle: 'sleeping' | 'closed' = 'sleeping',
): Promise<{ workId: string; target: string; sender: string; providerSessionId: string }> {
  const map = await createWork(project, { title: 'Работа' });
  const providerSessionId = randomUUID();
  let target = '';
  let sender = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, { provider: 'claude', label: 'адресат', task: 'сделать' });
    target = created.id;
    created.launchedBy = 'host';
    created.providerSessionId = providerSessionId;
    transitionSession(current, created.id, 'active');
    transitionSession(current, created.id, lifecycle);
    sender = addSession(current, { provider: 'claude', label: 'отправитель', task: 'писать' }).id;
  });
  // Спящая уже жила: каталог журналов хуков завёл её первый запуск (`--settings`).
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });
  return { workId: map.work.id, target, sender, providerSessionId };
}

interface ResumeRig {
  pty: ReturnType<typeof createPtyManager>;
  sessions: SessionsService;
  stream: () => string;
}

/** works+activity+pty+sessions+wake: будильник поднимает сессии настоящим `launch` со стабом. */
async function resumeRig(wakeOptions: WakeServiceOptions = {}): Promise<ResumeRig> {
  // Настоящий `claude` в автотестах не запускается никогда — только стаб.
  setEnv('HARNAS_CLAUDE_BIN', STUB);
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const sessions = createSessionsService(host, works, pty, activity);
  const wake = createWakeService(host, works, activity, pty, sessions, { enterDelayMs: 30, ...wakeOptions });

  let stream = '';
  pty.on('output', (_ref, data) => {
    stream += data;
  });

  await works.start();
  await activity.start();
  wake.start();

  stoppers.push(async () => {
    wake.stop();
    await sessions.stopAll();
    await activity.stop();
    await works.stop();
  });
  // Всплеск событий наблюдателя от записей подготовки ещё может догонять старт:
  // два наблюдателя работ читают их независимо, и позднее, но устаревшее чтение
  // перекрыло бы снимок со свежим письмом. Письма шлём после затишья.
  await settle(200);
  return { pty, sessions, stream: () => stream };
}

async function tempArgsFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harnas-wake-args-'));
  stoppers.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'args.json');
}

async function readArgv(file: string): Promise<string[]> {
  await waitFor(() => existsSync(file), 5000);
  return (JSON.parse(await readFile(file, 'utf8')) as { argv: string[] }).argv;
}

const notices = (kind: string): unknown[] =>
  broadcasts.filter((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === kind);

describe('WakeService: подъём спящей письмом', () => {
  it('3: письмо спящей Claude — указатель последним аргументом, стаб отвечает эхом указателя', async () => {
    const { workId, target, sender } = await sleepingPair();
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('STUB_PROMPT_FROM_ARGV', '1');
    const { stream, sessions } = await resumeRig();

    await sendLetter(workId, target, 'тело письма');
    // Отправитель — настоящая сессия, а не s-00 из хелпера.
    await updateMap(project, workId, (map) => {
      const letter = map.messages.at(-1);
      if (letter !== undefined) letter.from = sender;
    });

    const argv = await readArgv(argsFile);
    expect(argv.at(-1)).toBe(pointer(1));
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 5000);
    expect(stream()).not.toContain('тело письма');

    const ref = { projectPath: project, workId, sessionId: target };
    expect(sessions.live(ref)).toBe(true);
  }, 20_000);

  it('4: провайдер без {prompt} — подъём без промпта, указатель печатается после первого Stop', async () => {
    // Тестовый реестр: `resumeArgs` Claude без `{prompt}`.
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({ claude: { resumeArgs: ['--resume', '{providerSessionId}'] } }),
    );
    const { workId, target, providerSessionId } = await sleepingPair();
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    setEnv('STUB_HOOKS', '1');
    const { stream, pty } = await resumeRig();

    await sendLetter(workId, target);

    const argv = await readArgv(argsFile);
    expect(argv.slice(-2)).toEqual(['--resume', providerSessionId]);
    await waitFor(() => stream().includes('STUB READY'), 5000);

    // Хода ещё не было (SessionStart — работа): указателя нет.
    await settle(400);
    expect(stream()).not.toContain(pointer(1));

    // Первый ход нового процесса закончился — теперь указатель уходит.
    const ref = { projectPath: project, workId, sessionId: target };
    pty.input(ref, 'привет\r');
    await waitFor(() => stream().includes('echo: привет'), 5000);
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 5000);
  }, 20_000);

  it('5: седьмой подъём за час — письмо ждёт, приходит resume-limit один раз', async () => {
    const { workId, target } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    const limiter = new ResumeLimiter(() => 6);
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    const { sessions } = await resumeRig({ limiter });

    await sendLetter(workId, target, 'первое');
    await waitFor(() => notices('resume-limit').length > 0, 5000);
    await sendLetter(workId, target, 'второе');
    await settle(300);

    expect(notices('resume-limit')).toHaveLength(1);
    expect(sessions.live(ref)).toBe(false);
    const map = await readMap(project, workId);
    expect(map.sessions.find((s) => s.id === target)?.lifecycle).toBe('sleeping');
  }, 20_000);

  it('6: стаб выходит сразу — отправителю письмо от system, есть resume-failed', async () => {
    const { workId, target, sender } = await sleepingPair();
    setEnv('STUB_EXIT_AFTER_MS', '10');
    await resumeRig();

    await updateMap(project, workId, (map) => {
      addMessage(map, { from: sender, to: [target], text: 'проснись' });
    });

    await waitFor(() => notices('resume-failed').length > 0, 8000);
    const map = await readMap(project, workId);
    const systemLetters = map.messages.filter((m) => m.from === SYSTEM);
    expect(systemLetters).toHaveLength(1);
    expect(systemLetters[0]?.to).toEqual([sender]);
    expect(systemLetters[0]?.text).toMatch(/^S01 не поднялась: /);

    // Выход процесса дописывает карту следом (выход или сверка живости — кто
    // первый) — дождаться, чтобы уборка теста не гонялась с этой записью.
    for (;;) {
      const session = (await readMap(project, workId)).sessions.find((s) => s.id === target);
      if (session?.lifecycle === 'sleeping') break;
      await settle(20);
    }
    await settle(100);
  }, 20_000);

  it('7: closed не поднимается ни письмом, ни resumeInterrupted', async () => {
    const { workId, target } = await sleepingPair();
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const { sessions } = await resumeRig();
    const ref = { projectPath: project, workId, sessionId: target };

    await sessions.close(ref);
    expect((await readMap(project, workId)).sessions.find((s) => s.id === target)?.lifecycle).toBe('closed');

    await sendLetter(workId, target);
    await settle(400);
    await sessions.resumeInterrupted([ref]);
    await expect(sessions.launch(ref, 'resume')).rejects.toThrow(/закрыта/);
    await settle(200);

    expect(sessions.live(ref)).toBe(false);
    expect(existsSync(argsFile)).toBe(false);
    expect((await readMap(project, workId)).sessions.find((s) => s.id === target)?.lifecycle).toBe('closed');
  }, 20_000);
});

/** Работа с тремя живыми сессиями хоста; `events/` заведён, как при настоящем запуске. */
async function trio(): Promise<{ workId: string; ids: [string, string, string] }> {
  const map = await createWork(project, { title: 'Работа' });
  const ids: string[] = [];
  await updateMap(project, map.work.id, (current) => {
    for (const label of ['один', 'два', 'три']) {
      const created = addSession(current, { provider: 'claude', label, task: 'сделать' });
      created.launchedBy = 'host';
      transitionSession(current, created.id, 'active');
      ids.push(created.id);
    }
  });
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });
  return { workId: map.work.id, ids: ids as [string, string, string] };
}

/**
 * works+activity+pty+wake и по стабу на каждую сессию. Письма, лежавшие в
 * карте до старта (приглашения в комнату), будильник считает указанными —
 * будят только новые.
 */
async function trioRig(workId: string, ids: readonly string[]): Promise<Map<string, () => string>> {
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {} }, { enterDelayMs: 30 });

  await works.start();
  await activity.start();
  wake.start();

  const streams = new Map<string, string>();
  pty.on('output', (ref, data) => {
    streams.set(ref.sessionId, (streams.get(ref.sessionId) ?? '') + data);
  });
  for (const sessionId of ids) {
    pty.start(
      { projectPath: project, workId, sessionId },
      { command: process.execPath, args: [STUB], cwd: project, env: { ...process.env } },
    );
  }

  stoppers.push(async () => {
    for (const sessionId of ids) {
      await pty.stop({ projectPath: project, workId, sessionId }, { graceMs: 200 }).catch(() => {});
    }
    wake.stop();
    await activity.stop();
    await works.stop();
  });

  await waitFor(() => ids.every((id) => (streams.get(id) ?? '').includes('STUB READY')));
  // Затишье после записей подготовки: письма — уже в спокойный снимок.
  await settle(200);
  return new Map(ids.map((id) => [id, () => streams.get(id) ?? '']));
}

const inRoom = (count: number, room: string, title: string): string =>
  `Новые письма (${count}) в ${room} «${title}». Вызови check_inbox.`;

describe('WakeService: комнаты (3.5)', () => {
  it('1: рассылка комнаты будит всех участников, кроме отправителя', async () => {
    const { workId, ids } = await trio();
    const [a, b, c] = ids;
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'Ревью «схемы»', creator: a, members: [b, c] });
    });
    const streams = await trioRig(workId, ids);

    await updateMap(project, workId, (map) => {
      addMessage(map, { from: a, to: [], roomId: 'r-01', text: 'всем' });
    });

    const expected = `echo: ${inRoom(1, 'r-01', 'Ревью «схемы»')}`;
    await waitFor(() => streams.get(b)?.().includes(expected) === true, 3000);
    await waitFor(() => streams.get(c)?.().includes(expected) === true, 3000);
    await settle(300);
    expect(streams.get(a)?.()).not.toContain('Новые письма');
  }, 20_000);

  it('2: адресное письмо в комнате будит только адресата; неадресату ни указателя, ни письма', async () => {
    const { workId, ids } = await trio();
    const [a, b, c] = ids;
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'Трое', creator: a, members: [b, c] });
    });
    const streams = await trioRig(workId, ids);

    await updateMap(project, workId, (map) => {
      addMessage(map, { from: a, to: [b], roomId: 'r-01', text: 'только тебе' });
    });

    await waitFor(() => streams.get(b)?.().includes(`echo: ${inRoom(1, 'r-01', 'Трое')}`) === true, 3000);
    await settle(300);
    expect(streams.get(c)?.()).not.toContain('Новые письма');
    expect(streams.get(a)?.()).not.toContain('Новые письма');

    // `check_inbox` отдаёт `unreadFor`: неадресату в нём пусто.
    const map = await readMap(project, workId);
    expect(unreadFor(map, c)).toEqual([]);
    expect(unreadFor(map, b).map((message) => message.text)).toEqual(['только тебе']);
  }, 20_000);

  it('3а: прямое письмо человека будит адресата', async () => {
    const { workId, ids } = await trio();
    const [a, b] = ids;
    const streams = await trioRig(workId, ids);

    await sendHumanLetter({ projectPath: project, workId, roomId: null, to: [b], text: 'от человека', kind: 'note' });

    await waitFor(() => streams.get(b)?.().includes(`echo: ${pointer(1)}`) === true, 3000);
    await settle(300);
    expect(streams.get(a)?.()).not.toContain('Новые письма');
  }, 20_000);

  it('3б: рассылка человека будит всех участников его комнаты, и только их', async () => {
    const { workId, ids } = await trio();
    const [a, b, c] = ids;
    const roomId = await createHumanRoom({ projectPath: project, workId, title: 'Созвон', members: [a, b] });
    const streams = await trioRig(workId, ids);

    await sendHumanLetter({ projectPath: project, workId, roomId, to: [], text: 'всем', kind: 'decision' });

    // Приглашение в комнату тоже ещё не прочитано — в счёт указателя оно идёт.
    const expected = `echo: ${inRoom(2, roomId, 'Созвон')}`;
    await waitFor(() => streams.get(a)?.().includes(expected) === true, 3000);
    await waitFor(() => streams.get(b)?.().includes(expected) === true, 3000);
    await settle(300);
    expect(streams.get(c)?.()).not.toContain('Новые письма');
  }, 20_000);
});
