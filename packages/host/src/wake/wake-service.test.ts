import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
} from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
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
const pointer = (count: number): string => `New messages (${count}). Call check_inbox.`;

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let logErrors: string[] = [];
let logInfos: Array<Record<string, unknown>> = [];
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
    log: {
      info: (message: string, fields?: Record<string, unknown>) =>
        logInfos.push({ message, ...(fields === undefined ? {} : fields) }),
      warn: () => {},
      error: (message: string) => logErrors.push(message),
    },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
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
  process.env['PARLEY_HOME'] = home;
  // План возобновления Claude ищет транскрипт сессии в корне истории — во временном, не в ~/.claude.
  setEnv('PARLEY_CLAUDE_PROJECTS_DIR', claudeRoot);
  broadcasts = [];
  logErrors = [];
  logInfos = [];
});

afterEach(async () => {
  for (const stop of stoppers) await stop();
  stoppers = [];
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  delete process.env['PARLEY_HOME'];
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
  /** Замок смены модели и effort сессии (`SessionsService.exclusive`); по умолчанию — не взят никогда. */
  lock: { held: (ref: SessionRef) => boolean } = { held: () => false },
): Promise<Rig> {
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  // Подъёма в этих тестах нет: все сессии живые, и `launch` будильнику не нужен.
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {}, exclusive: lock as never }, {
    enterDelayMs: 30,
    ...wakeOptions,
  });

  await works.start();
  await activity.start();
  wake.start();

  const ref: SessionRef = { projectPath: project, workId, sessionId };
  // Как при настоящем запуске: `events/` заводит запись настроек до старта процесса, а хук
  // процесса доходит до журнала. Без единого хука с запуска будильник не печатает (fix-final-b);
  // нейтральное `StubReady` состояния не меняет. Тест без хуков передаёт STUB_READY_HOOK: '0'.
  await mkdir(workPaths(project, workId).events, { recursive: true });
  const launch: PtyLaunch = {
    command: process.execPath,
    args: [STUB],
    cwd: project,
    env: {
      ...process.env,
      PARLEY_WORK_DIR: path.join(project, '.parley', 'works', workId),
      PARLEY_SESSION_ID: sessionId,
      STUB_READY_HOOK: '1',
      ...launchEnv,
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
      PARLEY_WORK_DIR: path.join(project, '.parley', 'works', workId),
      PARLEY_SESSION_ID: sessionId,
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
    const { stream, pty, ref, activity } = await rig(sessionId, workId);

    pty.input(ref, 'пр');
    await sendLetter(workId, sessionId);
    await settle(300);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);
    // Причина ожидания — в логе хоста, раз на причину: по файлам работы её потом не восстановить.
    const reasons = logInfos
      .filter((entry) => entry.message === 'будильник: письма ждут')
      .map((entry) => entry.reason);
    expect(reasons.at(-1)).toBe('draft');
    expect(reasons.filter((reason) => reason === 'draft')).toHaveLength(1);
    // Та же причина — окну: комната пишет её рядом с «not picked up yet».
    expect(activity.get(ref)?.metrics?.mailWaiting).toBe('draft');

    pty.input(ref, '\r');
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    // Указатель дошёл, письмо ещё не прочитано: причина сменилась на «сообщено».
    await waitFor(() => ['in-flight', 'pointed'].includes(activity.get(ref)?.metrics?.mailWaiting ?? ''), 3000);
  });

  it('3а: активность стала working до своего Enter — Enter всё равно уходит, указатель не остаётся в поле ввода', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, wake, ref, activity } = await rig(sessionId, workId, {}, { enterDelayMs: 700 });

    await sendLetter(workId, sessionId);
    // Текст указателя напечатан, свой Enter ещё ждёт паузы.
    await waitFor(() => wake.inFlight(ref), 3000);
    // Как записи журнала Claude Code сразу после Stop: активность возвращается в working, хотя ход по
    // указателю начаться ещё не мог (живая проверка 2026-10-02: указатель оставался в поле без Enter).
    await appendFile(
      path.join(workPaths(project, workId).events, `${sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'чужой ход' })}\n`,
    );
    await waitFor(() => activity.get(ref)?.activity.activity === 'working', 3000);
    expect(wake.inFlight(ref)).toBe(true);

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
    expect(noticeTexts('pointer-timeout')).toEqual([`session ${sessionId} did not start a turn after the pointer`]);
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
    expect((cancelled?.data as { text: string }).text).toBe(`the pointer for session ${sessionId} was cancelled by human input`);
  });
});

describe('WakeService: смена модели или effort и открытый ползунок /effort', () => {
  const SLIDER = ['Effort', '←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'];

  /** Запись в PTY сессии: всё, что хост печатает, и отдельно Enter. */
  function spyWrites(pty: Rig['pty']): string[] {
    const writes: string[] = [];
    const original = pty.write.bind(pty);
    pty.write = (ref, data) => {
      writes.push(data);
      original(ref, data);
    };
    return writes;
  }

  it('замок смены взят — указатель не печатается и Enter не уходит; замок снят — уходит сам', async () => {
    const { workId, sessionId } = await activeSession();
    let held = true;
    const { stream, pty } = await rig(sessionId, workId, {}, {}, { held: () => held });
    const writes = spyWrites(pty);

    await sendLetter(workId, sessionId);
    await settle(400);
    expect(writes).toEqual([]);
    expect(stream()).not.toContain(pointer(1));

    held = false;
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    expect(writes).toEqual([pointer(1), '\r']);
  });

  it('ползунок /effort на экране — указатель не печатается и Enter не уходит; ползунок закрыт — уходит сам', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty } = await rig(sessionId, workId);
    const writes = spyWrites(pty);
    const real = pty.screenText.bind(pty);
    let open = true;
    pty.screenText = (ref) => (open ? SLIDER : real(ref));

    await sendLetter(workId, sessionId);
    await settle(400);
    expect(writes).toEqual([]);

    open = false;
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    expect(writes).toEqual([pointer(1), '\r']);
  });

  it('замок взят за паузу между текстом и Enter — Enter не уходит, приходит pointer-cancelled', async () => {
    const { workId, sessionId } = await activeSession();
    let held = false;
    const { stream, pty, ref } = await rig(sessionId, workId, {}, { enterDelayMs: 300 }, { held: () => held });
    const original = pty.write.bind(pty);
    const writes: string[] = [];
    pty.write = (target, data) => {
      writes.push(data);
      original(target, data);
      // Указатель напечатан — смена начинается до Enter.
      if (data === pointer(1)) held = true;
    };

    await sendLetter(workId, sessionId);
    await waitFor(() => writes.includes(pointer(1)), 3000);
    await settle(600);
    expect(writes).toEqual([pointer(1)]);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);
    const cancelled = broadcasts.find(
      (b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'pointer-cancelled',
    );
    expect((cancelled?.data as { ref: SessionRef }).ref).toEqual(ref);
    expect((cancelled?.data as { text: string }).text).toContain('model or effort');
  });

  it('ползунок открылся за паузу между текстом и Enter — Enter не уходит', async () => {
    const { workId, sessionId } = await activeSession();
    const { pty } = await rig(sessionId, workId, {}, { enterDelayMs: 300 });
    const real = pty.screenText.bind(pty);
    let open = false;
    pty.screenText = (ref) => (open ? SLIDER : real(ref));
    const original = pty.write.bind(pty);
    const writes: string[] = [];
    pty.write = (target, data) => {
      writes.push(data);
      original(target, data);
      if (data === pointer(1)) open = true;
    };

    await sendLetter(workId, sessionId);
    await waitFor(() => writes.includes(pointer(1)), 3000);
    await settle(600);
    expect(writes).toEqual([pointer(1)]);
  });

  it('без замка и ползунка — указатель и Enter, как раньше', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty } = await rig(sessionId, workId);
    const writes = spyWrites(pty);

    await sendLetter(workId, sessionId);
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    expect(writes).toEqual([pointer(1), '\r']);
  });
});

describe('WakeService: процесс без хуков и диалог перед Enter (fix-final-b)', () => {
  it('ни одного хука с запуска — указатель не печатается; первый хук — уходит', async () => {
    const { workId, sessionId } = await activeSession();
    // Свежая сессия на вопросе доверия к папке: Claude Code хуков не шлёт, активность idle.
    const { stream } = await rig(sessionId, workId, { STUB_READY_HOOK: '0' });

    await sendLetter(workId, sessionId);
    await settle(600);
    expect(stream()).not.toContain(pointer(1));

    // Доверие подтвердил человек — агент прислал первый хук, письмо уходит указателем.
    await writeFile(
      path.join(workPaths(project, workId).events, `${sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'SessionStart' })}\n${JSON.stringify({ hook_event_name: 'Stop' })}\n`,
    );
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });

  it('хуки прошлого процесса не в счёт: журнал до запуска — указатель не печатается', async () => {
    const { workId, sessionId } = await activeSession();
    await mkdir(workPaths(project, workId).events, { recursive: true });
    await writeFile(
      path.join(workPaths(project, workId).events, `${sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'Stop' })}\n`,
    );
    // mtime журнала — строго раньше запуска процесса.
    await settle(50);
    const { stream } = await rig(sessionId, workId, { STUB_READY_HOOK: '0' });

    await sendLetter(workId, sessionId);
    await settle(600);
    expect(stream()).not.toContain(pointer(1));
  });

  it('стал blocked за ожидание Enter — Enter не жмётся, указатель остаётся в поле ввода', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, activity, ref } = await rig(sessionId, workId, {}, { enterDelayMs: 600 });

    await sendLetter(workId, sessionId);
    await waitFor(() => stream().includes(pointer(1)), 3000);
    // Запрос разрешения показан, хук дошёл до Enter.
    await writeFile(
      path.join(workPaths(project, workId).events, `${sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'PermissionRequest' })}\n`,
      { flag: 'a' },
    );
    await waitFor(() => activity.get(ref)?.activity.activity === 'blocked', 3000);

    await settle(800);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);
    expect(noticeTexts('pointer-cancelled')).toEqual([
      `the pointer for session ${sessionId} was left without Enter — the session is waiting for an answer`,
    ]);
  });

  // SessionStart ход не открывает (activity.ts): первый хук нового процесса — признак готовности поля ввода,
  // живая проба Claude Code 2.1.289 (хук через ~0,2-0,35 с после запуска, набранный в тот миг текст не теряется).
  it('человек поднял сессию (Resume): журнал после запуска — только SessionStart(resume) — указатель уходит сразу, без idle_prompt', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, activity, ref } = await rig(sessionId, workId, { STUB_READY_HOOK: '0' });

    await sendLetter(workId, sessionId);
    await settle(600);
    expect(stream()).not.toContain(pointer(1));

    await writeFile(
      path.join(workPaths(project, workId).events, `${sessionId}.jsonl`),
      `${JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' })}\n`,
    );
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    // Ни Stop, ни idle_prompt не было, а ход SessionStart не открыл — сессия у приглашения.
    expect(activity.get(ref)?.activity.activity).not.toBe('working');
  });

  it('прежний процесс оборвал ход (UserPromptSubmit без Stop): SessionStart(resume) ход оканчивает — указатель уходит', async () => {
    const { workId, sessionId } = await activeSession();
    // Каталог `events/` — до старта наблюдения активности, как при настоящем запуске (см. тест 2): иначе
    // хост узнал бы о хуке только с письмом. Журнал заведён нейтральным StubReady.
    await mkdir(workPaths(project, workId).events, { recursive: true });
    const { stream, activity, ref } = await rig(sessionId, workId);
    const journal = path.join(workPaths(project, workId).events, `${sessionId}.jsonl`);

    await writeFile(journal, `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n`, { flag: 'a' });
    await waitFor(() => activity.get(ref)?.activity.activity === 'working', 3000);
    await sendLetter(workId, sessionId);
    // Ход открыт и не кончается — указатель ждёт.
    await settle(400);
    expect(stream()).not.toContain(pointer(1));

    await writeFile(journal, `${JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' })}\n`, {
      flag: 'a',
    });
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });
});

describe('WakeService: лид закончил ход и ждёт фоновых субагентов (Parley 0.2.0)', () => {
  const journalOf = (workId: string, sessionId: string): string =>
    path.join(workPaths(project, workId).events, `${sessionId}.jsonl`);
  const hookLine = (name: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;
  const append = (file: string, text: string): Promise<void> =>
    writeFile(file, text, { flag: 'a' });
  /** Снимок фоновых задач хука: субагент ещё работает. */
  const running = {
    id: 'a1',
    type: 'subagent',
    status: 'running',
    agent_type: 'general-purpose',
    description: 'Orca research',
  };

  /** Лид закончил ход (Stop), а фоновый субагент работает: активность `working`, но агент у приглашения. */
  async function leadWithSubagents(
    wakeOptions: WakeServiceOptions = {},
  ): Promise<Rig & { workId: string; sessionId: string }> {
    const { workId, sessionId } = await activeSession();
    // Как при настоящем запуске: `events/` заводит запись настроек до старта процесса.
    await mkdir(workPaths(project, workId).events, { recursive: true });
    const rigged = await rig(sessionId, workId, {}, wakeOptions);
    await append(
      journalOf(workId, sessionId),
      hookLine('UserPromptSubmit') + hookLine('Stop', { background_tasks: [running] }),
    );
    await waitFor(() => rigged.activity.get(rigged.ref)?.activity.heldByBackground === true, 3000);
    expect(rigged.activity.get(rigged.ref)?.activity.activity).toBe('working');
    return { ...rigged, workId, sessionId };
  }

  it('письмо печатается указателем, хотя активность working: ход окончен, держит фоновый субагент', async () => {
    const { stream, workId, sessionId } = await leadWithSubagents();

    await sendLetter(workId, sessionId);

    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });

  it('ждёт в wait_for — указатель не печатается, пока ожидание и ход не кончатся', async () => {
    const { workId, sessionId } = await activeSession();
    await mkdir(workPaths(project, workId).events, { recursive: true });
    const { stream, activity, ref } = await rig(sessionId, workId);
    const journal = journalOf(workId, sessionId);
    await append(
      journal,
      hookLine('UserPromptSubmit', { background_tasks: [running] }) +
        hookLine('ParleyWaitStart', { parley_wait_target: 's-02' }),
    );
    await waitFor(() => activity.get(ref)?.activity.waitingFor === 's-02', 3000);

    await sendLetter(workId, sessionId);
    await settle(500);
    expect(activity.get(ref)?.activity.heldByBackground).toBe(false);
    expect(stream()).not.toContain(pointer(1));

    // Ожидание кончилось, ход закончился, фоновых больше нет — теперь указатель уходит.
    await append(journal, hookLine('ParleyWaitEnd') + hookLine('Stop', { background_tasks: [] }));
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });

  it('пока указатель ждёт Enter, посторонний пересчёт удерживаемой сессии Enter не отменяет', async () => {
    const { stream, workId, sessionId } = await leadWithSubagents({ enterDelayMs: 500 });

    await sendLetter(workId, sessionId);
    await waitFor(() => stream().includes(pointer(1)), 3000);
    // За паузу перед Enter приходит ещё одно событие хука: снимок прежний, сессия по-прежнему working
    // и по-прежнему удержана фоновыми. Это не начало хода, и Enter указателя отменять нельзя.
    await append(
      journalOf(workId, sessionId),
      hookLine('Notification', { background_tasks: [running] }),
    );

    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
  });

  it('указатель принят и ход начался (working без удержания) — предохранитель указателя снят', async () => {
    const { stream, activity, ref, workId, sessionId } = await leadWithSubagents({
      pointerTimeoutMs: 600,
    });

    await sendLetter(workId, sessionId);
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    // Claude принял ввод и начал ход, фоновый субагент всё ещё работает.
    await append(
      journalOf(workId, sessionId),
      hookLine('UserPromptSubmit', { background_tasks: [running] }),
    );
    await waitFor(() => activity.get(ref)?.activity.heldByBackground === false, 3000);

    // Дольше срока предохранителя: ход начался, и сказать «не начался» он уже не должен.
    await settle(900);
    expect(noticeTexts('pointer-timeout')).toEqual([]);
  });
});

describe('WakeService: сбой Enter указателя (кусок 5.1, раунд исправлений 2)', () => {
  it('запись Enter бросает — будильник не падает, пишет в лог, предохранитель срабатывает, новое письмо доставляется', async () => {
    const { workId, sessionId } = await activeSession();
    const { stream, pty, wake, ref } = await rig(sessionId, workId, {}, { pointerTimeoutMs: 400 });

    // PTY «умер» между проверкой pid и записью Enter: текст указателя пишется, \r — бросает.
    const write = pty.write;
    let failing = true;
    pty.write = (target, data) => {
      if (failing && data === '\r') throw new Error('EIO: pty закрыт');
      write(target, data);
    };

    await sendLetter(workId, sessionId);
    await waitFor(() => logErrors.includes('Enter указателя не записался'), 3000);
    expect(wake.inFlight(ref)).toBe(false);
    expect(stream()).not.toContain(`echo: ${pointer(1)}`);

    // Дальше попытку ведёт предохранитель указателя — по своим правилам.
    await waitFor(
      () => broadcasts.some((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'pointer-timeout'),
      2000,
    );

    // Хост жив: следующее письмо снова печатается указателем и уходит Enter.
    failing = false;
    pty.input(ref, '\x15');
    await sendLetter(workId, sessionId, 'второе письмо');
    await waitFor(() => /echo: .*New messages \(\d+\)\. Call check_inbox\./.test(stream()), 3000);
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
  // Спящая уже жила: каталог журналов хуков завёл её первый запуск (`--settings`), а разговор с
  // ней — транскрипт Claude Code; без него core поднял бы её новым процессом, а не `--resume`.
  await mkdir(workPaths(project, map.work.id).events, { recursive: true });
  const transcripts = path.join(claudeRoot, '-private-tmp-parley-wake');
  await mkdir(transcripts, { recursive: true });
  await writeFile(path.join(transcripts, `${providerSessionId}.jsonl`), '{"type":"user"}\n');
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
  setEnv('PARLEY_CLAUDE_BIN', STUB);
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
  const dir = await mkdtemp(path.join(tmpdir(), 'parley-wake-args-'));
  stoppers.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'args.json');
}

async function readArgv(file: string): Promise<string[]> {
  await waitFor(() => existsSync(file), 5000);
  return (JSON.parse(await readFile(file, 'utf8')) as { argv: string[] }).argv;
}

const notices = (kind: string): unknown[] =>
  broadcasts.filter((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === kind);

/** `text` уведомлений хоста данного вида — то, что человек читает в консоли окна, а агент — в письме. */
const noticeTexts = (kind: string): string[] =>
  broadcasts
    .filter((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === kind)
    .map((b) => (b.data as { text: string }).text);

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

    // Хода ещё не было (SessionStart ход не открывает и не кончает): указателя нет.
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
    expect(noticeTexts('resume-limit')).toEqual([
      'S01 was not resumed: the hourly resume limit is reached, messages are waiting',
    ]);
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
    expect(systemLetters[0]?.text).toMatch(/^S01 did not resume: /);
    // Человеку — то же самое уведомлением: текст письма и уведомления один.
    expect(noticeTexts('resume-failed')).toEqual([systemLetters[0]?.text]);

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
    await expect(sessions.launch(ref, 'resume')).rejects.toThrow(/is closed/);
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
      {
        command: process.execPath,
        args: [STUB],
        cwd: project,
        // Хук процесса доходит до журнала — иначе будильник в сессию не печатает (fix-final-b).
        env: {
          ...process.env,
          PARLEY_WORK_DIR: path.join(project, '.parley', 'works', workId),
          PARLEY_SESSION_ID: sessionId,
          STUB_READY_HOOK: '1',
        },
      },
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
  `New messages (${count}) in ${room} "${title}". Call check_inbox.`;

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
    expect(streams.get(a)?.()).not.toContain('New messages');
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
    expect(streams.get(c)?.()).not.toContain('New messages');
    expect(streams.get(a)?.()).not.toContain('New messages');

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
    expect(streams.get(a)?.()).not.toContain('New messages');
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
    expect(streams.get(c)?.()).not.toContain('New messages');
  }, 20_000);
});
