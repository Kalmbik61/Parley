import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  writeLetters,
  addRoom,
  addSession,
  archiveRoom,
  createWork,
  DEFAULT_RESOURCE_LIMITS,
  HUMAN,
  LIMIT_RETURN_TEXT,
  readStoredMap,
  reserveAttempt,
  saveConfig,
  setWorkStatus,
  settleAttempt,
  SYSTEM,
  transitionSession,
  unreadFor,
  updateMap,
  workPaths,
} from '@parley/core';
import type { ProviderLimits, SessionActivity, SessionNeed, WorkSession } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createActivityService } from '../activity/activity-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import { CODEX_SUBMIT_DELAY_MS } from '../pty/codex-input.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createHumanRoom, deleteHumanRoom, sendHumanLetter, setHumanRoomLead } from '../rooms/rooms-service.js';
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

async function sendLetter(workId: string, to: string, text = 'тело письма — секрет', from = 's-00'): Promise<void> {
  await updateMap(project, workId, (map, letters) => {
    letters.add({ roomId: null, kind: 'note', from, to: [to], text });
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
    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: 's-00', to: [sessionId], text: 'один' });
      letters.add({ roomId: null, kind: 'note', from: 's-00', to: [sessionId], text: 'два' });
      letters.add({ roomId: null, kind: 'note', from: 's-00', to: [sessionId], text: 'три' });
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

  it('сжатие держит сессию (спека 2026-10-15, 5.4) — указатель не печатается; отпустило — уходит сам', async () => {
    const { workId, sessionId } = await activeSession();
    let compacting = true;
    const { stream, pty } = await rig(sessionId, workId, {}, { compacting: () => compacting });
    const writes = spyWrites(pty);

    await sendLetter(workId, sessionId);
    await settle(400);
    expect(writes).toEqual([]);
    expect(stream()).not.toContain(pointer(1));

    compacting = false;
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
    // Верхняя граница, а не пауза: хук доходит событием fs (или дочитыванием), настоящий процесс отвечает под нагрузкой не сразу.
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 15_000);
  }, 30_000);

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

describe('WakeService: письма ждут застрявшую сессию (спека «Застрявшие сессии», 6.1)', () => {
  const hookLine = (name: string, extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;
  /** Ход упёрся в лимит: он окончен, сессия у приглашения, но ждёт сброса, а не письма (`need` `limit`). */
  const limitHit =
    hookLine('UserPromptSubmit') +
    hookLine('StopFailure', { error: 'rate_limit', last_assistant_message: "You've hit your limit" });

  it('лимит: письмо удержано — mailWaiting stuck, в терминале тишина; ход без ошибки лимита — указатель уходит', async () => {
    const { workId, sessionId } = await activeSession();
    // Как при настоящем запуске: `events/` заводит запись настроек до старта процесса.
    await mkdir(workPaths(project, workId).events, { recursive: true });
    const { stream, activity, ref } = await rig(sessionId, workId);
    const journal = path.join(workPaths(project, workId).events, `${sessionId}.jsonl`);

    await appendFile(journal, limitHit);
    await waitFor(() => activity.get(ref)?.activity.need?.kind === 'limit', 3000);

    await sendLetter(workId, sessionId);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'stuck', 3000);
    await settle(300);
    expect(stream()).not.toContain(pointer(1));
    // Причина в логе хоста — раз на причину, как у прочих ожиданий живой сессии.
    const reasons = logInfos
      .filter((entry) => entry.message === 'будильник: письма ждут')
      .map((entry) => entry.reason);
    expect(reasons.filter((reason) => reason === 'stuck')).toHaveLength(1);

    // Эпизод кончился — ход начался и закончился без ошибки лимита: письма доставляются как обычно.
    await appendFile(journal, hookLine('UserPromptSubmit') + hookLine('Stop'));
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    expect(activity.get(ref)?.activity.need).toBeNull();
  });

  it('указатель уже напечатан, потом сессия застряла — mailWaiting stuck, а не pointed', async () => {
    const { workId, sessionId } = await activeSession();
    await mkdir(workPaths(project, workId).events, { recursive: true });
    const { stream, activity, ref } = await rig(sessionId, workId);

    await sendLetter(workId, sessionId);
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 3000);
    // Письмо указано, прочитать его агент не успел.
    await waitFor(() => ['in-flight', 'pointed'].includes(activity.get(ref)?.metrics?.mailWaiting ?? ''), 3000);

    // Ход по указателю упёрся в лимит: человек должен видеть, что сессия застряла, а не что «указатель напечатан».
    await appendFile(path.join(workPaths(project, workId).events, `${sessionId}.jsonl`), limitHit);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'stuck', 3000);
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
  works: WorksService;
  pty: ReturnType<typeof createPtyManager>;
  sessions: SessionsService;
  activity: ReturnType<typeof createActivityService>;
  wake: WakeService;
  stream: () => string;
}

/** works+activity+pty+sessions+wake: будильник поднимает сессии настоящим `launch` со стабом. */
async function resumeRig(
  wakeOptions: WakeServiceOptions = {},
  /** Что будильник получает вместо сервиса сессий — по умолчанию сам сервис. */
  forWake: (sessions: SessionsService) => SessionsService = (sessions) => sessions,
): Promise<ResumeRig> {
  // Настоящий `claude` в автотестах не запускается никогда — только стаб.
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const sessions = createSessionsService(host, works, pty, activity);
  const wake = createWakeService(host, works, activity, pty, forWake(sessions), { enterDelayMs: 30, ...wakeOptions });

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
  return { works, pty, sessions, activity, wake, stream: () => stream };
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

    // Отправитель — настоящая сессия, а не s-00 из хелпера.
    await sendLetter(workId, target, 'тело письма', sender);

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

  it('5-pm: провайдера сессии нет в реестре — письмо ждёт provider-missing: ни запуска, ни слота часа, ни resume-failed, ни писем отправителям', async () => {
    const { workId, target } = await sleepingPair();
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === target);
      if (session !== undefined) session.provider = 'custom-claude-2';
    });
    const ref = { projectPath: project, workId, sessionId: target };
    const limiter = new ResumeLimiter(() => 6);
    const launch = vi.fn();
    const { sessions, activity } = await resumeRig({ limiter }, (real) => {
      const spy = Object.create(real) as SessionsService;
      spy.launch = launch;
      return spy;
    });

    await sendLetter(workId, target);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'provider-missing', 5000);
    await settle(300);

    expect(launch).not.toHaveBeenCalled();
    expect(sessions.live(ref)).toBe(false);
    expect(notices('resume-failed')).toHaveLength(0);
    expect(notices('resume-limit')).toHaveLength(0);
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    const map = readStoredMap(project, workId);
    expect(map.sessions.find((s) => s.id === target)?.lifecycle).toBe('sleeping');
    expect(JSON.stringify(map)).not.toContain('did not resume');
  }, 20_000);

  it('5-sw: идёт замена агента — письмо не поднимает сессию, ожидание resuming; switched после замены — подъём (спека замены 6.3)', async () => {
    const { workId, target } = await sleepingPair();
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === target);
      if (session !== undefined) session.switching = { id: 'sw-1', to: 'codex', since: new Date().toISOString() };
    });
    const ref = { projectPath: project, workId, sessionId: target };
    const launch = vi.fn(async () => 'started' as const);
    const { activity, wake } = await resumeRig({}, (real) => {
      const spy = Object.create(real) as SessionsService;
      spy.launch = launch;
      return spy;
    });

    await sendLetter(workId, target);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'resuming', 5000);
    await settle(300);
    expect(launch).not.toHaveBeenCalled();
    expect(notices('resume-failed')).toHaveLength(0);

    // Замена кончилась (оркестратор снял `switching`): письмо поднимает сессию обычным путём.
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === target);
      if (session !== undefined) session.switching = null;
    });
    await waitFor(() => readStoredMap(project, workId).sessions.find((s) => s.id === target)?.switching === null, 5000);
    await settle(200);
    wake.switched(ref);
    await waitFor(() => launch.mock.calls.length > 0, 5000);
    expect(launch).toHaveBeenCalledWith(ref, 'resume', expect.objectContaining({ by: 'wake' }));
  }, 20_000);

  it('5-sw2: после замены прежний «поднять нечем» не мешает следующему подъёму', async () => {
    const { workId, target, providerSessionId } = await sleepingPair();
    // Прежний агент без разговора у провайдера: подъёму письмом нечем — resumeUnavailable.
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === target);
      if (session !== undefined) session.providerSessionId = null;
    });
    const ref = { projectPath: project, workId, sessionId: target };
    const launch = vi.fn(async () => 'started' as const);
    const { activity, wake } = await resumeRig({}, (real) => {
      const spy = Object.create(real) as SessionsService;
      spy.launch = launch;
      return spy;
    });
    await sendLetter(workId, target);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'sleeping', 5000);
    await settle(200);
    expect(launch).not.toHaveBeenCalled();

    // Новый агент записан с разговором (как после замены): без `switched` удержание осталось бы до живого процесса.
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === target);
      if (session !== undefined) session.providerSessionId = providerSessionId;
    });
    await settle(300);
    expect(launch).not.toHaveBeenCalled();
    wake.switched(ref);
    await waitFor(() => launch.mock.calls.length > 0, 5000);
  }, 20_000);

  it('5-sw3: письмо поднимает сессию, ждущую нового агента после отказа замены (ревью №8) — подъём без указателя в argv', async () => {
    const { workId, target, providerSessionId } = await sleepingPair();
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === target);
      if (session === undefined) return;
      session.previousAgents = [{
        provider: 'claude', model: null, effort: null, providerSessionId, startedAt: null, endedAt: new Date().toISOString(),
        reason: 'limit', requestedBy: 'human', carried: 'handover',
      }];
      session.providerSessionId = null;
    });
    const ref = { projectPath: project, workId, sessionId: target };
    const launch = vi.fn(async () => 'started' as const);
    await resumeRig({}, (real) => {
      const spy = Object.create(real) as SessionsService;
      spy.launch = launch;
      return spy;
    });
    await sendLetter(workId, target);
    await waitFor(() => launch.mock.calls.length > 0, 5000);
    // `launch` сессий сам переведёт подъём в запуск с пакетом; указатель уйдёт после первого простоя, не в argv.
    expect(launch).toHaveBeenCalledWith(ref, 'resume', { by: 'wake', launchClass: 'mail' });
  }, 20_000);

  it('5-pm2: битый providers.json не роняет хост (ревью №3): провайдер считается на месте, подъём отчитывается сбоем', async () => {
    const { workId, target } = await sleepingPair();
    await writeFile(path.join(home, 'providers.json'), '{ not json');
    const ref = { projectPath: project, workId, sessionId: target };
    const { activity } = await resumeRig();
    await sendLetter(workId, target);
    await waitFor(() => notices('resume-failed').length > 0, 8000);
    expect(activity.get(ref)?.metrics?.mailWaiting).not.toBe('provider-missing');
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
    const map = readStoredMap(project, workId);
    expect(map.sessions.find((s) => s.id === target)?.lifecycle).toBe('sleeping');
  }, 20_000);

  it('5а: бюджет работы исчерпан — письмо ждёт, процесса нет, resume-limit называет бюджет, счёт часа не списан (P37)', async () => {
    await saveConfig({ workLaunches: 1 });
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    // Один запуск в окне уже потрачен — другим поколением.
    await updateMap(project, workId, (map) => {
      const attempt = reserveAttempt(map, {
        kind: 'launch', actor: 'human', session: sender, owner: 'host-old', limits: { ...DEFAULT_RESOURCE_LIMITS, workLaunches: 1 },
      });
      settleAttempt(map, attempt.id, 'host-old', 'spent');
    });
    const limiter = new ResumeLimiter(() => 6);
    const { sessions } = await resumeRig({ limiter });

    await sendLetter(workId, target, 'проснись');
    await waitFor(() => notices('resume-limit').length > 0, 8000);
    await sendLetter(workId, target, 'ещё раз');
    await settle(300);

    expect(notices('resume-limit')).toHaveLength(1);
    expect(noticeTexts('resume-limit')[0]).toMatch(/^S01 was not resumed: the workspace budget is exhausted \(launch limit reached: 1 of 1/);
    expect(sessions.live(ref)).toBe(false);
    const map = readStoredMap(project, workId);
    expect(map.sessions.find((s) => s.id === target)?.lifecycle).toBe('sleeping');
    // Письма не потеряны и не названы указанными: они ждут слота. Резерв не остался.
    expect(unreadFor(map, target)).toHaveLength(2);
    expect(map.messages.some((m) => m.from === SYSTEM)).toBe(false);
    expect(map.resources?.attempts.filter((a) => a.state === 'reserved')).toEqual([]);
    // Отказ не расходует счёт часа: все шесть подъёмов ещё доступны.
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    expect(limiter.tryTake(ref)).toBe(false);
  }, 20_000);

  it('5б: перезапуск хоста не обнуляет потолок возобновлений сессии — он читается из карты (P37)', async () => {
    const { workId, target } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    // Шесть возобновлений за час сделал прошлый хост; у нового памяти об этом нет.
    await updateMap(project, workId, (map) => {
      for (let i = 0; i < 6; i += 1) {
        const attempt = reserveAttempt(map, {
          kind: 'resume', actor: 'wake', session: target, owner: 'host-old', limits: { ...DEFAULT_RESOURCE_LIMITS, workLaunches: 100 },
        });
        settleAttempt(map, attempt.id, 'host-old', 'spent');
      }
    });
    const { sessions } = await resumeRig();

    await sendLetter(workId, target, 'проснись');
    await waitFor(() => notices('resume-limit').length > 0, 8000);

    expect(noticeTexts('resume-limit')[0]).toContain('resume limit reached: 6 of 6');
    expect(sessions.live(ref)).toBe(false);
    expect((readStoredMap(project, workId)).sessions.find((s) => s.id === target)?.lifecycle).toBe('sleeping');
  }, 20_000);

  it('5в: запуск Codex удержан до согласия на папку (held) — письма ждут без сбоя, повторов нет, счёт часа цел, retry поднимает', async () => {
    const { workId, target } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    const limiter = new ResumeLimiter(() => 6);
    let held = true;
    const modes: string[] = [];
    const { sessions, activity, wake } = await resumeRig({ limiter }, (real) => ({
      ...real,
      launch: async (target, mode, options) => {
        modes.push(mode);
        return held ? 'held' : real.launch(target, mode, options);
      },
    }));

    await sendLetter(workId, target, 'первое');
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'folder-trust', 5000);
    // Пока согласия нет, новое письмо новой просьбы не рождает: пауза держится, а не каждое событие карты.
    await sendLetter(workId, target, 'второе');
    await settle(300);

    expect(modes).toEqual(['resume']);
    expect(activity.get(ref)?.metrics?.mailWaiting).toBe('folder-trust');
    expect(notices('resume-failed')).toEqual([]);
    expect(notices('resume-limit')).toEqual([]);
    expect(sessions.live(ref)).toBe(false);
    const waiting = readStoredMap(project, workId);
    expect(unreadFor(waiting, target)).toHaveLength(2);
    expect(waiting.messages.some((m) => m.from === SYSTEM)).toBe(false);
    // Удержание не расходует счёт часа: все шесть подъёмов ещё доступны.
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    expect(limiter.tryTake(ref)).toBe(false);
    limiter.release(ref);

    // Согласие пришло — `retry` снимает удержание, письма поднимают сессию обычным путём.
    held = false;
    wake.retry(ref);
    await waitFor(() => sessions.live(ref), 8000);
    expect(modes).toEqual(['resume', 'resume']);
    expect(notices('resume-failed')).toEqual([]);
  }, 30_000);

  it('5г: перезапуск хоста при удержанном подъёме — новый будильник считает письма указанными, но retry поднимает сессию с обоими', async () => {
    const { workId, target } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    const first = await resumeRig({}, (real) => ({ ...real, launch: async () => 'held' as const }));

    await sendLetter(workId, target, 'первое');
    await waitFor(() => first.activity.get(ref)?.metrics?.mailWaiting === 'folder-trust', 5000);
    await sendLetter(workId, target, 'второе');
    await settle(300);

    // «Перезапуск»: прежнего будильника нет, новый стартует над той же картой — его старт записывает лежащие письма
    // спящей как указанные, и сам по себе он её не поднимает.
    first.wake.stop();
    const launches: Array<{ mode: string; options: { by?: string; prompt?: string } | undefined }> = [];
    const second = createWakeService(
      fakeHost(),
      first.works,
      first.activity,
      first.pty,
      {
        launch: async (_ref, mode, options) => {
          launches.push({ mode, options });
          return 'started' as const;
        },
      },
      { enterDelayMs: 30 },
    );
    stoppers.push(async () => second.stop());
    second.start();
    await settle(300);
    expect(launches).toEqual([]);
    expect(unreadFor(readStoredMap(project, workId), target)).toHaveLength(2);

    // Согласие пришло: `retry` заново считает письма спящей неуказанными — подъём с указателем на оба.
    second.retry(ref);
    await waitFor(() => launches.length > 0, 5000);
    expect(launches).toEqual([{ mode: 'resume', options: { by: 'wake', prompt: pointer(2), launchClass: 'mail' } }]);
  }, 30_000);

  it('6: стаб выходит сразу — отправителю письмо от system, есть resume-failed', async () => {
    const { workId, target, sender } = await sleepingPair();
    setEnv('STUB_EXIT_AFTER_MS', '10');
    await resumeRig();

    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: sender, to: [target], text: 'проснись' });
    });

    await waitFor(() => notices('resume-failed').length > 0, 8000);
    const map = readStoredMap(project, workId);
    const systemLetters = map.messages.filter((m) => m.from === SYSTEM);
    expect(systemLetters).toHaveLength(1);
    expect(systemLetters[0]?.to).toEqual([sender]);
    expect(systemLetters[0]?.text).toMatch(/^S01 did not resume: /);
    // Человеку — то же самое уведомлением: текст письма и уведомления один.
    expect(noticeTexts('resume-failed')).toEqual([systemLetters[0]?.text]);

    // Выход процесса дописывает карту следом (выход или сверка живости — кто
    // первый) — дождаться, чтобы уборка теста не гонялась с этой записью.
    for (;;) {
      const session = (readStoredMap(project, workId)).sessions.find((s) => s.id === target);
      if (session?.lifecycle === 'sleeping') break;
      await settle(20);
    }
    await settle(100);
  }, 20_000);

  it('6b: запуск сам остановил процесс и ответил ошибкой — сбой сообщается раз и причиной запуска', async () => {
    const { workId, target, sender } = await sleepingPair();
    const reason = 'lock /home/.parley/parley.db was not released within 3000 ms';
    await resumeRig({}, (sessions) => ({
      ...sessions,
      // Как `launch`, когда старт не записался в карту: процесс поднят, остановлен, вызывающему — ошибка.
      launch: async (ref, mode, options) => {
        await sessions.launch(ref, mode, options);
        await sessions.stop(ref);
        throw new Error(reason);
      },
    }));

    await updateMap(project, workId, (map, letters) => {
      letters.add({ roomId: null, kind: 'note', from: sender, to: [target], text: 'проснись' });
    });

    await waitFor(() => notices('resume-failed').length > 0, 8000);
    // Второй отчёт — выход процесса в срок сбоя — пришёл бы следом: даём ему время.
    await settle(500);
    expect(noticeTexts('resume-failed')).toEqual([`S01 did not resume: ${reason}`]);
    const systemLetters = (readStoredMap(project, workId)).messages.filter((m) => m.from === SYSTEM);
    expect(systemLetters.map((m) => m.text)).toEqual([`S01 did not resume: ${reason}`]);
  }, 20_000);

  it('7: closed не поднимается ни письмом, ни resumeInterrupted', async () => {
    const { workId, target } = await sleepingPair();
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const { sessions } = await resumeRig();
    const ref = { projectPath: project, workId, sessionId: target };

    await sessions.close(ref);
    expect((readStoredMap(project, workId)).sessions.find((s) => s.id === target)?.lifecycle).toBe('closed');

    await sendLetter(workId, target);
    await settle(400);
    await sessions.resumeInterrupted([ref]);
    await expect(sessions.launch(ref, 'resume')).rejects.toThrow(/is closed/);
    await settle(200);

    expect(sessions.live(ref)).toBe(false);
    expect(existsSync(argsFile)).toBe(false);
    expect((readStoredMap(project, workId)).sessions.find((s) => s.id === target)?.lifecycle).toBe('closed');
  }, 20_000);

  it('8: письмо спящей в архивной работе ждёт без подъёма и без resume-failed; после Reopen будит', async () => {
    const { workId, target } = await sleepingPair();
    await setWorkStatus(project, workId, 'archived');
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const { sessions, activity } = await resumeRig();
    const ref = { projectPath: project, workId, sessionId: target };

    await sendLetter(workId, target);
    // Будильник письмо увидел и оставил ждать спящей; без архива здесь был бы `resuming`.
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'sleeping', 5000);
    await settle(400);
    expect(sessions.live(ref)).toBe(false);
    expect(existsSync(argsFile)).toBe(false);
    expect(notices('resume-failed')).toEqual([]);

    await setWorkStatus(project, workId, 'active');
    await readArgv(argsFile);
    await waitFor(() => sessions.live(ref), 5000);
  }, 20_000);

  it('9: письмо в ленте архивной комнаты спящую не поднимает — ни подъёма, ни resume-failed; прямое письмо по-прежнему будит', async () => {
    const { workId, target, sender } = await sleepingPair();
    await updateMap(project, workId, (map, letters) => {
      addRoom(map, { title: 'Созвон', creator: sender, members: [sender, target], lead: sender });
      archiveRoom(map, letters, 'r-01');
    });
    const argsFile = await tempArgsFile();
    setEnv('STUB_ARGS_FILE', argsFile);
    const { sessions } = await resumeRig();
    const ref = { projectPath: project, workId, sessionId: target };

    // Письмо в архивную комнату агент или окно записать не могут (`requireOpenRoom`), но в ленте оно может оказаться
    // (`letters.add` архив не проверяет): будильник адресатов у такой комнаты не видит.
    await updateMap(project, workId, (map, letters) => {
      letters.add({ kind: 'note', from: sender, to: [target], roomId: 'r-01', text: 'в архивную' });
    });
    await settle(600);
    expect(sessions.live(ref)).toBe(false);
    expect(existsSync(argsFile)).toBe(false);
    expect(notices('resume-failed')).toEqual([]);

    // Контроль: стенд поднимает спящую, когда есть кого будить.
    await sendLetter(workId, target);
    await readArgv(argsFile);
    await waitFor(() => sessions.live(ref), 5000);
  }, 20_000);
});

/**
 * Очередь машины (спека сна агентов 4.2): `launch` подъёма ответил `queued` — потолок живых CLI полон либо память на
 * пределе. Процесса нет, а сбоя нет: письма ждут слота, и подъём продолжит очередь (`retry`), а не каждое событие карты.
 */
describe('WakeService: подъём в очереди машины (спека сна агентов 4.2)', () => {
  it.each([
    ['retry', (wake: WakeService, ref: SessionRef) => wake.retry(ref)],
    ['switched', (wake: WakeService, ref: SessionRef) => wake.switched(ref)],
  ])('1: подъём в очереди — письма ждут без сбоя, новых попыток нет, счёт часа цел; %s начинает новую', async (_name, free) => {
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    const limiter = new ResumeLimiter(() => 6);
    const launch = vi.fn<SessionsService['launch']>(async () => 'queued');
    const { activity, wake } = await resumeRig({ limiter }, (real) => ({ ...real, launch }));

    await sendLetter(workId, target, 'первое', sender);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'queued', 5000);
    // Пока слота нет, новое письмо новой попытки не рождает: очередь держит запись, а не каждое событие карты.
    await sendLetter(workId, target, 'второе', sender);
    await settle(300);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(activity.get(ref)?.metrics?.mailWaiting).toBe('queued');
    expect(notices('resume-failed')).toEqual([]);
    expect(notices('resume-limit')).toEqual([]);
    const waiting = readStoredMap(project, workId);
    expect(unreadFor(waiting, target)).toHaveLength(2);
    expect(waiting.messages.some((m) => m.from === SYSTEM)).toBe(false);
    // Очередь не расходует счёт часа: все шесть подъёмов ещё доступны.
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    expect(limiter.tryTake(ref)).toBe(false);
    limiter.release(ref);

    // Слот освободился: очередь зовёт `retry` (после замены агента — `switched`), письма поднимают сессию обычным путём.
    launch.mockImplementation(async () => 'started');
    free(wake, ref);
    await waitFor(() => launch.mock.calls.length === 2, 5000);
    expect(launch.mock.calls[1]?.[2]).toEqual({ by: 'wake', prompt: pointer(2), launchClass: 'mail' });
  }, 30_000);

  it('2: класс запуска в очереди — письмо агента даёт mail, письмо человека в пачке — human', async () => {
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    const launch = vi.fn<SessionsService['launch']>(async () => 'queued');
    const { wake } = await resumeRig({}, (real) => ({ ...real, launch }));

    await sendLetter(workId, target, 'от агента', sender);
    await waitFor(() => launch.mock.calls.length === 1, 5000);
    expect(launch.mock.calls[0]?.[2]).toEqual({ by: 'wake', prompt: pointer(1), launchClass: 'mail' });

    // Письмо человека пришло, пока подъём в очереди: следующая попытка несёт оба письма, и класс — по самому важному.
    await sendLetter(workId, target, 'от человека', HUMAN);
    await settle(300);
    wake.retry(ref);
    await waitFor(() => launch.mock.calls.length === 2, 5000);
    expect(launch.mock.calls[1]?.[2]).toEqual({ by: 'wake', prompt: pointer(2), launchClass: 'human' });
  }, 30_000);

  it('3: письмо одного человека — класс human, и сразу при первом подъёме', async () => {
    const { workId, target } = await sleepingPair();
    const launch = vi.fn<SessionsService['launch']>(async () => 'started');
    await resumeRig({}, (real) => ({ ...real, launch }));

    await sendLetter(workId, target, 'от человека', HUMAN);
    await waitFor(() => launch.mock.calls.length === 1, 5000);
    expect(launch.mock.calls[0]?.[2]).toEqual({ by: 'wake', prompt: pointer(1), launchClass: 'human' });
  }, 20_000);

  it('4: сессию подняли мимо очереди — письма не указаны, и живой процесс снимает очередь: после Stop новое письмо снова поднимает', async () => {
    setEnv('STUB_READY_HOOK', '1');
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    const launch = vi.fn<SessionsService['launch']>(async () => 'queued');
    const { activity, sessions, stream } = await resumeRig({}, (real) => ({ ...real, launch }));

    await sendLetter(workId, target, 'пришло в очереди', sender);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'queued', 5000);

    // Человек поднял сессию сам, мимо очереди: письма очередью не указаны, и будильник печатает указатель в живой процесс.
    await sessions.launch(ref, 'resume', { by: 'human' });
    await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 8000);

    // Stop человека: сессия снова спит, прежнее письмо считается указанным, а новое поднимает её — очередь не держит.
    await sessions.stop(ref);
    await settle(500);
    await sendLetter(workId, target, 'пришло после Stop', sender);
    await waitFor(() => launch.mock.calls.length === 2, 5000);
  }, 30_000);
});

/**
 * Сон агентов (спека 2026-10-30, 4.1): сессию, которую усыпил хост, письмо поднимает и после перезапуска хоста, и сверх
 * `resumeRate`, не тратя слот часа; остановленную человеком будильник считает по-прежнему.
 */
describe('WakeService: усыплённая хостом сессия (сон агентов, 4.1)', () => {
  /** Помечает спящую сессию усыплённой хостом: `autoSleep` лежит в карте так, как его оставляет `transitionSession`. */
  async function sleptByHost(workId: string, sessionId: string): Promise<void> {
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === sessionId);
      if (session !== undefined) session.autoSleep = { reason: 'idle', at: new Date().toISOString(), waitTarget: null };
    });
  }
  /** Сервис сессий, у которого `launch` — подделка: настоящий подъём не нужен, важно лишь, что будильник его потребовал. */
  const withLaunch = (launch: SessionsService['launch']) => (real: SessionsService): SessionsService => {
    const spy = Object.create(real) as SessionsService;
    spy.launch = launch;
    return spy;
  };

  it('10: после старта хоста письмо поднимает усыплённую хостом сессию', async () => {
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    await sleptByHost(workId, target);
    // Письмо легло, пока будильника не было: на старте он встречает его как лежавшее (`ensureKnown`).
    await sendLetter(workId, target, 'проснись', sender);
    const launch = vi.fn(async () => 'started' as const);
    await resumeRig({}, withLaunch(launch));

    await waitFor(() => launch.mock.calls.length > 0, 5000);
    expect(launch).toHaveBeenCalledWith(ref, 'resume', { by: 'wake', prompt: pointer(1), launchClass: 'mail' });
  }, 20_000);

  it('11: после старта хоста остановленную человеком письмо не поднимает, как и раньше; новое письмо поднимает', async () => {
    const { workId, target, sender } = await sleepingPair();
    await sendLetter(workId, target, 'лежало до старта', sender);
    const launch = vi.fn(async () => 'started' as const);
    await resumeRig({}, withLaunch(launch));

    await settle(500);
    expect(launch).not.toHaveBeenCalled();

    // Контроль: стенд исправен, подъём не заперт навсегда.
    await sendLetter(workId, target, 'новое', sender);
    await waitFor(() => launch.mock.calls.length > 0, 5000);
  }, 20_000);

  it('12: усыплённую хостом поднимают семь писем за час: лимитер на шесть не мешает, слот часа не берётся', async () => {
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    await sleptByHost(workId, target);
    const limiter = new ResumeLimiter(() => 6);
    const launch = vi.fn(async () => 'started' as const);
    await resumeRig({ limiter }, withLaunch(launch));

    for (let i = 1; i <= 7; i += 1) {
      await sendLetter(workId, target, `письмо ${i}`, sender);
      await waitFor(() => launch.mock.calls.length === i, 5000);
    }

    expect(notices('resume-limit')).toEqual([]);
    // Слот часа не взят ни разу: все шесть подъёмов по-прежнему доступны.
    for (let i = 0; i < 6; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    expect(limiter.tryTake(ref)).toBe(false);
  }, 30_000);

  it('13: поднять нечем (нет id разговора) — у усыплённой хостом слот не взят, и чужой не возвращается', async () => {
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === target);
      if (session !== undefined) session.providerSessionId = null;
    });
    await sleptByHost(workId, target);
    // Пять подъёмов за этот час уже сделаны: возврат без своего слота вернул бы один из них.
    const limiter = new ResumeLimiter(() => 6);
    for (let i = 0; i < 5; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    const launch = vi.fn(async () => 'started' as const);
    const { activity } = await resumeRig({ limiter }, withLaunch(launch));

    await sendLetter(workId, target, 'проснись', sender);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'sleeping', 5000);
    await settle(200);

    expect(launch).not.toHaveBeenCalled();
    // Пять взятых на месте: шестой есть, седьмого нет.
    expect(limiter.tryTake(ref)).toBe(true);
    expect(limiter.tryTake(ref)).toBe(false);
  }, 20_000);

  it('14: запуск удержан (held) — у усыплённой хостом слот не взят, и чужой не возвращается', async () => {
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    await sleptByHost(workId, target);
    const limiter = new ResumeLimiter(() => 6);
    for (let i = 0; i < 5; i += 1) expect(limiter.tryTake(ref)).toBe(true);
    const launch = vi.fn(async () => 'held' as const);
    const { activity } = await resumeRig({ limiter }, withLaunch(launch));

    await sendLetter(workId, target, 'проснись', sender);
    await waitFor(() => activity.get(ref)?.metrics?.mailWaiting === 'folder-trust', 5000);
    await settle(200);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(limiter.tryTake(ref)).toBe(true);
    expect(limiter.tryTake(ref)).toBe(false);
  }, 20_000);

  /**
   * Живая сессия получает письмо, и её процесс останавливают: настоящий `sessions.stop`, выход процесса и запись `sleeping` в карту.
   * `mark` — хост уже поставил отметку «засыпает» (`autoSleepPending`), письмо ограда не выдаёт, и оно остаётся непрочитанным;
   * иначе остановка — как кнопка Stop человека. `hooks` — хуки доходят, и будильник успевает напечатать указатель в умирающий
   * процесс: письмо уже «указано», но агент его так и не прочёл.
   */
  async function stoppedWithLetter(options: { mark: boolean; hooks: boolean }) {
    if (options.hooks) setEnv('STUB_READY_HOOK', '1');
    const { workId, target, sender } = await sleepingPair();
    const ref = { projectPath: project, workId, sessionId: target };
    const session = (): WorkSession | undefined => readStoredMap(project, workId).sessions.find((candidate) => candidate.id === target);
    const launch = vi.fn(async () => 'started' as const);
    const { sessions, stream } = await resumeRig({}, withLaunch(launch));
    await sessions.launch(ref, 'resume', { by: 'human' });
    await waitFor(() => sessions.live(ref) && stream().includes('STUB READY') && session()?.lifecycle === 'active', 5000);

    if (options.mark) {
      await updateMap(project, workId, (map) => {
        const found = map.sessions.find((candidate) => candidate.id === target);
        if (found !== undefined) found.autoSleepPending = { reason: 'idle', at: new Date().toISOString(), waitTarget: null };
      });
    }
    await sendLetter(workId, target, 'пришло перед остановкой', sender);
    if (options.hooks) await waitFor(() => stream().includes(`echo: ${pointer(1)}`), 5000);
    else await settle(200);
    // До остановки подъёма нет: живую письмо не поднимает.
    expect(launch).not.toHaveBeenCalled();

    await sessions.stop(ref);
    return { launch, ref, workId, target, sender, session };
  }

  it('15: письмо пришло, пока стояла отметка «засыпает»: процесс вышел, карта стала sleeping и autoSleep — сессию поднимает указатель', async () => {
    const { launch, ref, session } = await stoppedWithLetter({ mark: true, hooks: false });

    await waitFor(() => launch.mock.calls.length > 0, 5000);
    expect(launch).toHaveBeenCalledWith(ref, 'resume', { by: 'wake', prompt: pointer(1), launchClass: 'mail' });
    expect(session()).toMatchObject({ lifecycle: 'sleeping', autoSleep: { reason: 'idle' } });
    expect(session()).not.toHaveProperty('autoSleepPending');
  }, 30_000);

  it('16: то же, но указатель успел уйти в умирающий процесс: письмо снова указывается, сессию поднимает', async () => {
    const { launch, ref, session } = await stoppedWithLetter({ mark: true, hooks: true });

    await waitFor(() => launch.mock.calls.length > 0, 5000);
    expect(launch).toHaveBeenCalledWith(ref, 'resume', { by: 'wake', prompt: pointer(1), launchClass: 'mail' });
    expect(session()).toMatchObject({ lifecycle: 'sleeping', autoSleep: { reason: 'idle' } });
  }, 30_000);

  it('17: то же без отметки (Stop человека): письмо, лежавшее при выходе, сессию не поднимает, как и раньше; новое письмо поднимает', async () => {
    const { launch, workId, target, sender, session } = await stoppedWithLetter({ mark: false, hooks: false });

    await settle(500);
    expect(launch).not.toHaveBeenCalled();
    expect(session()?.lifecycle).toBe('sleeping');
    expect(session()?.autoSleep ?? null).toBeNull();

    // Контроль: стенд исправен, подъём не заперт навсегда.
    await sendLetter(workId, target, 'новое', sender);
    await waitFor(() => launch.mock.calls.length > 0, 5000);
  }, 30_000);

  it('18: Stop человека после того, как указатель ушёл в процесс: письмо считается указанным, подъёма нет', async () => {
    const { launch, workId, target, sender } = await stoppedWithLetter({ mark: false, hooks: true });

    await settle(500);
    expect(launch).not.toHaveBeenCalled();

    await sendLetter(workId, target, 'новое', sender);
    await waitFor(() => launch.mock.calls.length > 0, 5000);
  }, 30_000);
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
async function trioRig(
  workId: string,
  ids: readonly string[],
  wakeOptions: WakeServiceOptions = {},
): Promise<Map<string, () => string>> {
  const host = fakeHost();
  const works = createWorksService(host, { debounceMs: 20 });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const wake = createWakeService(host, works, activity, pty, { launch: async () => {} }, { enterDelayMs: 30, ...wakeOptions });

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

/** `task` — среди писем задача человека всем: указатель помечает её «(a task for everyone)». */
const inRoom = (count: number, room: string, title: string, task = false): string =>
  `New messages (${count}) in ${room} "${title}"${task ? ' (a task for everyone)' : ''}. Call check_inbox.`;

describe('WakeService: комнаты (3.5)', () => {
  it('1: рассылка комнаты будит всех участников, кроме отправителя', async () => {
    const { workId, ids } = await trio();
    const [a, b, c] = ids;
    await updateMap(project, workId, (map) => {
      addRoom(map, { title: 'Ревью «схемы»', creator: a, members: [b, c] });
    });
    // Заметка всем несрочная: ждёт окна тишины; его таймер будит каждого участника (короткое окно вместо 30 с).
    const streams = await trioRig(workId, ids, { settleMs: 300 });

    await updateMap(project, workId, (map, letters) => {
      letters.add({ kind: 'note', from: a, to: [], roomId: 'r-01', text: 'всем' });
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

    await updateMap(project, workId, (map, letters) => {
      letters.add({ kind: 'note', from: a, to: [b], roomId: 'r-01', text: 'только тебе' });
    });

    await waitFor(() => streams.get(b)?.().includes(`echo: ${inRoom(1, 'r-01', 'Трое')}`) === true, 3000);
    await settle(300);
    expect(streams.get(c)?.()).not.toContain('New messages');
    expect(streams.get(a)?.()).not.toContain('New messages');

    // `check_inbox` отдаёт `unreadFor`: неадресату в нём пусто.
    const map = readStoredMap(project, workId);
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

    // Приглашение в комнату тоже ещё не прочитано — в счёт указателя оно идёт; рассылка человека — задача всем.
    const expected = `echo: ${inRoom(2, roomId, 'Созвон', true)}`;
    await waitFor(() => streams.get(a)?.().includes(expected) === true, 3000);
    await waitFor(() => streams.get(b)?.().includes(expected) === true, 3000);
    await settle(300);
    expect(streams.get(c)?.()).not.toContain('New messages');
  }, 20_000);

  it('4: «Make lead» — письма parley будят нового и прежнего ведущего, прочих участников — нет', async () => {
    const { workId, ids } = await trio();
    const [a, b, c] = ids;
    const roomId = await createHumanRoom({ projectPath: project, workId, title: 'Созвон', members: [a, b, c], lead: a, quiet: true });
    const streams = await trioRig(workId, ids);

    await setHumanRoomLead({ projectPath: project, workId, roomId, sessionId: b });

    const expected = `echo: ${inRoom(1, roomId, 'Созвон')}`;
    await waitFor(() => streams.get(b)?.().includes(expected) === true, 3000);
    await waitFor(() => streams.get(a)?.().includes(expected) === true, 3000);
    await settle(300);
    expect(streams.get(c)?.()).not.toContain('New messages');
  }, 20_000);

  it('5: удалённая комната — прямое письмо parley будит её участников, сессию вне комнаты — нет', async () => {
    const { workId, ids } = await trio();
    const [a, b, c] = ids;
    const roomId = await createHumanRoom({ projectPath: project, workId, title: 'Созвон', members: [a, b], quiet: true });
    const streams = await trioRig(workId, ids);

    await deleteHumanRoom({ projectPath: project, workId, roomId });

    await waitFor(() => streams.get(a)?.().includes(`echo: ${pointer(1)}`) === true, 3000);
    await waitFor(() => streams.get(b)?.().includes(`echo: ${pointer(1)}`) === true, 3000);
    await settle(300);
    expect(streams.get(c)?.()).not.toContain('New messages');
  }, 20_000);
});

describe('WakeService: журнал задержек доставки (mail.deliver)', () => {
  const deliveries = (): Array<Record<string, unknown>> => logInfos.filter((entry) => entry.op === 'mail.deliver');

  it('указатель: запись mail.deliver с комнатой и возрастом самого нового письма, outcome submitted, без текста письма', async () => {
    const map = await createWork(project, { title: 'Работа' });
    let target = '';
    let author = '';
    await updateMap(project, map.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'адресат', task: 'сделать' });
      target = created.id;
      created.launchedBy = 'host';
      transitionSession(current, created.id, 'active');
      author = addSession(current, { provider: 'claude', label: 'автор', task: 'писать' }).id;
      addRoom(current, { title: 'Ревью', creator: author, members: [target] });
    });
    const { ref } = await rig(target, map.work.id);

    // Два письма в одном указателе: старое прямое и новое в комнате — запись описывает новое.
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    await updateMap(project, map.work.id, (current, letters) => {
      letters.add({ roomId: null, kind: 'note', from: author, to: [target], text: 'старое секретное', at: ago(60_000) });
      letters.add({ kind: 'note', from: author, to: [], roomId: 'r-01', text: 'новое секретное', at: ago(5_000) });
    });
    await waitFor(() => deliveries().length > 0, 3000);

    expect(deliveries()).toHaveLength(1);
    const record = deliveries()[0];
    expect(record).toMatchObject({
      message: 'письмо доставлено',
      ref,
      roomId: 'r-01',
      letters: 2,
      mode: 'pointer',
      outcome: 'submitted',
    });
    // От самого нового письма (5 с), а не от старого (60 с).
    expect(record?.['sinceSentMs']).toBeGreaterThanOrEqual(5000);
    expect(record?.['sinceSentMs']).toBeLessThan(30_000);
    // Печать указателя и пауза перед Enter (30 мс) входят в ms.
    expect(record?.['ms']).toBeGreaterThanOrEqual(25);
    expect(JSON.stringify(logInfos)).not.toContain('секретное');
  }, 20_000);

  it('подъём спящей: запись mail.deliver с mode resume и outcome launched', async () => {
    const { workId, target } = await sleepingPair();
    setEnv('STUB_ARGS_FILE', await tempArgsFile());
    setEnv('STUB_PROMPT_FROM_ARGV', '1');
    await resumeRig();

    await sendLetter(workId, target, 'тело письма');
    await waitFor(() => deliveries().length > 0, 5000);

    expect(deliveries()).toHaveLength(1);
    const record = deliveries()[0];
    expect(record).toMatchObject({
      message: 'письмо доставлено',
      ref: { projectPath: project, workId, sessionId: target },
      roomId: null,
      letters: 1,
      mode: 'resume',
      outcome: 'launched',
    });
    expect(record?.['sinceSentMs']).toBeGreaterThanOrEqual(0);
    expect(record?.['ms']).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(logInfos)).not.toContain('тело письма');
  }, 20_000);
});

/**
 * Возврат после сброса лимита (спека застрявших 6.3, 6.4). Процесс, активность и карта подменены, время — фальшивое:
 * настоящий лимит ждёт минуты, а проверять нужно, что именно и когда будильник печатает в терминал.
 */
describe('возврат после сброса лимита', () => {
  const T0 = Date.parse('2026-10-22T10:00:00.000Z');
  const ENTER_MS = 30;
  const MINUTE = 60_000;
  /** Короткие сроки: по ним возврат наступает через 2 с после удара без времени сброса. */
  const FAST = { limitReturn: { graceMs: 500, retryMs: 2000 } };
  const DUE_MS = 2100;

  const activityOf = (activity: SessionActivity['activity'], patch: Partial<SessionActivity> = {}): SessionActivity => ({
    activity,
    subagents: 0,
    tasks: [],
    waitingFor: null,
    heldByBackground: false,
    runningBackground: [],
    turnEndedAt: null,
    turnBoundaryAt: null,
    lastEventAt: new Date(Date.now()).toISOString(),
    source: 'hooks',
    hooksMissing: false,
    need: null,
    ...patch,
  });

  interface LimitRig {
    wake: WakeService;
    /** Всё, что хост напечатал в терминал сессии. */
    written: string[];
    /** Тексты уведомлений хоста `limit-return-blocked`. */
    blocked: () => string[];
    /** Лимит: ход кончился ошибкой, `since` — сейчас; `state` — что показывает активность (по умолчанию простой). */
    hit: (patch?: Partial<SessionNeed>, state?: SessionActivity['activity']) => void;
    /** Ход идёт (`working`) — как после просьбы продолжить или после промпта человека. */
    working: () => void;
    /** Ход кончился чисто: у приглашения, без `need`. */
    idle: () => void;
    /** Письмо в карту и пересчёт. */
    letter: () => void;
    screen: string[];
    draft: { on: boolean };
    limitsData: { value: ProviderLimits | null };
    /** Событие активности без смены состояния (метрики) — пересчёт будильника. */
    poke: () => void;
    exit: () => void;
    advance: (ms: number) => Promise<void>;
  }

  let wakes: WakeService[] = [];

  async function limitRig(wakeOptions: WakeServiceOptions = {}, provider = 'claude'): Promise<LimitRig> {
    const { workId, sessionId } = await activeSession();
    const map = readStoredMap(project, workId);
    const session = map.sessions.find((candidate) => candidate.id === sessionId);
    if (session !== undefined) session.provider = provider;
    const ref: SessionRef = { projectPath: project, workId, sessionId };
    const entry = { projectPath: project, map };

    // Файлы работы подготовлены на настоящих часах; дальше отсчёт фальшивый.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(T0);

    type Live = { activity: SessionActivity; metrics: null };
    let live: Live = { activity: activityOf('idle'), metrics: null };
    const activityListeners = new Set<(ref: SessionRef, value: Live) => void>();
    const ptyListeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let alive = true;
    const written: string[] = [];
    const draft = { on: false };
    const screen: string[] = ['❯ '];
    const limitsData: { value: ProviderLimits | null } = { value: null };

    const publish = (activity: SessionActivity): void => {
      live = { activity, metrics: null };
      for (const listener of [...activityListeners]) listener(ref, live);
    };

    const handle = {
      ref,
      pid: 4242,
      startedAt: 0,
      cols: 80,
      rows: 24,
      provider,
      hasDraft: () => draft.on,
      bracketedPaste: () => true,
    };
    const pty = {
      get: () => (alive ? handle : undefined),
      write: (_ref: SessionRef, data: string) => written.push(data),
      screenText: () => screen,
      setHostDraft: () => {},
      on: (event: string, listener: (...args: unknown[]) => void) => {
        let set = ptyListeners.get(event);
        if (set === undefined) ptyListeners.set(event, (set = new Set()));
        const listeners = set;
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as PtyManager;
    const works = {
      entry: () => entry,
      snapshot: () => ({ entries: [entry] }),
      onChange: () => () => {},
      onMail: () => () => {},
    } as unknown as WorksService;
    const activity = {
      get: () => live,
      onChange: (listener: (ref: SessionRef, value: Live) => void) => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
      mailWaiting: () => {},
    } as unknown as ActivityService;

    const wake = createWakeService(fakeHost(), works, activity, pty, { launch: async () => {} }, {
      enterDelayMs: ENTER_MS,
      limits: { get: () => limitsData.value },
      ...wakeOptions,
    });
    wake.start();
    wakes.push(wake);

    return {
      wake,
      written,
      screen,
      draft,
      limitsData,
      blocked: () =>
        broadcasts
          .filter((item) => item.event === 'host.notice')
          .map((item) => item.data as { kind: string; text: string })
          .filter((notice) => notice.kind === 'limit-return-blocked')
          .map((notice) => notice.text),
      hit: (patch = {}, state = 'idle') =>
        publish(
          activityOf(state, {
            turnEndedAt: new Date(Date.now()).toISOString(),
            need: {
              kind: 'limit',
              since: new Date(Date.now()).toISOString(),
              detail: "You've hit your session limit",
              resetsAt: null,
              window: null,
              account: null,
              ...patch,
            },
          }),
        ),
      working: () => publish(activityOf('working')),
      idle: () => publish(activityOf('idle', { turnEndedAt: new Date(Date.now()).toISOString() })),
      letter: () => {
        // Письма лежат в базе, а не в снимке карты у службы: пишем через хранилище, как пишет хост.
        writeLetters(project, workId, (letters) =>
          letters.add({ roomId: null, kind: 'note', from: 's-00', to: [sessionId], text: 'письмо, пока шёл лимит' }),
        );
        publish(live.activity);
      },
      poke: () => publish(live.activity),
      exit: () => {
        alive = false;
        for (const listener of ptyListeners.get('exit') ?? []) listener(ref, { exitCode: 0 });
      },
      advance: async (ms) => {
        await vi.advanceTimersByTimeAsync(ms);
      },
    };
  }

  const returnText = (rig: LimitRig): string[] => rig.written.filter((chunk) => chunk.startsWith('Your usage limit'));
  const enters = (rig: LimitRig): number => rig.written.filter((chunk) => chunk === '\r').length;

  /** Лимит, возврат и ход по просьбе (он начался); `clean` — ход кончился без ошибки лимита. */
  async function cycle(rig: LimitRig, clean = false): Promise<void> {
    rig.hit();
    await rig.advance(DUE_MS);
    await rig.advance(ENTER_MS + 5);
    rig.working();
    if (clean) rig.idle();
  }

  afterEach(() => {
    for (const wake of wakes) wake.stop();
    wakes = [];
    vi.useRealTimers();
  });

  it('время сброса известно: через сброс и две минуты в терминале просьба продолжить и Enter', async () => {
    const rig = await limitRig();
    rig.hit({ resetsAt: new Date(T0 + 10 * MINUTE).toISOString() });

    await rig.advance(10 * MINUTE + 119_000);
    expect(rig.written).toEqual([]);

    await rig.advance(1010);
    expect(rig.written).toEqual([LIMIT_RETURN_TEXT]);
    await rig.advance(ENTER_MS);
    expect(rig.written).toEqual([LIMIT_RETURN_TEXT, '\r']);
    expect(rig.blocked()).toEqual([]);
  });

  it('письма ждут: после просьбы — указатель на них, а указанные письма второй раз не печатаются', async () => {
    const rig = await limitRig();
    rig.hit({ resetsAt: new Date(T0 + 1000).toISOString() });
    rig.letter();
    // Письмо держится, пока идёт эпизод: указатель отдельно не печатается.
    expect(rig.written).toEqual([]);

    await rig.advance(1000 + 120_000 + 10);
    expect(rig.written).toEqual([`${LIMIT_RETURN_TEXT} ${pointer(1)}`]);

    // Просьба начала ход, лимит снят: письмо уже указано, второго указателя нет.
    await rig.advance(ENTER_MS);
    rig.working();
    rig.idle();
    await rig.advance(5000);
    expect(rig.written.filter((chunk) => chunk.includes('check_inbox'))).toHaveLength(1);
  });

  it('времени сброса нет: возврат через срок после удара, не раньше', async () => {
    const rig = await limitRig(FAST);
    rig.hit();

    await rig.advance(1999);
    expect(rig.written).toEqual([]);
    await rig.advance(2);
    expect(returnText(rig)).toHaveLength(1);
    await rig.advance(ENTER_MS + 5);
    expect(enters(rig)).toBe(1);
  });

  it('сдвиг `since` в том же эпизоде срок не переносит', async () => {
    const rig = await limitRig(FAST);
    rig.hit();
    await rig.advance(1500);
    // Индекс лога догнал журнал: та же нужда, но `since` теперь позже.
    rig.hit();
    await rig.advance(600);
    expect(returnText(rig)).toHaveLength(1);
  });

  it('время сброса появилось в том же эпизоде: срок переставляется на него', async () => {
    const rig = await limitRig(FAST);
    const since = new Date(T0).toISOString();
    rig.hit({ since });
    await rig.advance(500);
    rig.hit({ since, resetsAt: new Date(T0 + 5000).toISOString() });

    // Прежний срок (2 с) прошёл бы раньше сброса.
    await rig.advance(2500);
    expect(rig.written).toEqual([]);
    await rig.advance(3100);
    expect(returnText(rig)).toHaveLength(1);
  });

  it('нужда снята раньше срока (Claude продолжил сам, человек написал): ничего не печатается, уведомления нет', async () => {
    const rig = await limitRig(FAST);
    rig.hit({ resetsAt: new Date(T0 + 1000).toISOString() });

    await rig.advance(1200);
    rig.working();
    await rig.advance(10_000);

    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual([]);
  });

  it('черновик человека: уведомление с причиной, а не печать', async () => {
    const rig = await limitRig(FAST);
    rig.draft.on = true;
    rig.hit();

    await rig.advance(DUE_MS);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual(['The limit has reset, but S01 could not continue: unsent text in its terminal']);

    // Эпизод остаётся, но уведомление одно: черновик снят — повторно не печатаем и не уведомляем.
    rig.draft.on = false;
    rig.poke();
    await rig.advance(10_000);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toHaveLength(1);
  });

  it('на экране меню лимита: уведомление, печати нет', async () => {
    const rig = await limitRig(FAST);
    rig.screen.push('❯ 1. Wait here, then continue automatically at 7:27pm');
    rig.hit();

    await rig.advance(DUE_MS);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual(['The limit has reset, but S01 could not continue: a menu is open in its terminal']);
  });

  it('будильник на паузе: ждёт, а после resume() возвращает сессию', async () => {
    const rig = await limitRig(FAST);
    rig.hit();
    rig.wake.pause();

    await rig.advance(5000);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual([]);

    rig.wake.resume();
    expect(returnText(rig)).toHaveLength(1);
  });

  it('сессия занята в момент срока: ждёт приглашения и возвращает на ближайшем пересчёте', async () => {
    const rig = await limitRig(FAST);
    const since = new Date(T0).toISOString();
    rig.hit({ since }, 'working');

    await rig.advance(DUE_MS);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual([]);

    rig.hit({ since }, 'idle');
    expect(returnText(rig)).toHaveLength(1);
  });

  it('третий возврат подряд не печатается — уведомление: «it hit the limit again twice»', async () => {
    const rig = await limitRig(FAST);

    await cycle(rig);
    await cycle(rig);
    expect(returnText(rig)).toHaveLength(2);
    rig.hit();
    await rig.advance(DUE_MS);

    expect(returnText(rig)).toHaveLength(2);
    expect(rig.blocked()).toEqual(['The limit has reset, but S01 could not continue: it hit the limit again twice']);
  });

  it('лимит повторился, а хост хода не видел: `since` новее печати — новый эпизод, возврат снова', async () => {
    const rig = await limitRig(FAST);
    rig.hit();
    await rig.advance(DUE_MS);
    await rig.advance(ENTER_MS + 5);
    expect(returnText(rig)).toHaveLength(1);

    // Ход и ошибка уложились в одну склейку активности: между ними `need` не был пуст ни разу.
    await rig.advance(1000);
    rig.hit();
    await rig.advance(DUE_MS);

    expect(returnText(rig)).toHaveLength(2);
  });

  it('ход по просьбе кончился без ошибки лимита: счётчик сброшен, третий возврат разрешён', async () => {
    const rig = await limitRig(FAST);

    await cycle(rig, true);
    await cycle(rig);
    await cycle(rig);

    // Без сброса после первого чистого хода третий возврат упёрся бы в «два подряд».
    expect(returnText(rig)).toHaveLength(3);
    expect(rig.blocked()).toEqual([]);
  });

  it('промпт человека сбрасывает счётчик', async () => {
    const rig = await limitRig(FAST);

    await cycle(rig);
    await cycle(rig);
    rig.hit();
    await rig.advance(DUE_MS);
    expect(rig.blocked()).toHaveLength(1);

    // Человек написал сам: ход не от будильника, возвраты снова разрешены.
    rig.working();
    rig.hit();
    await rig.advance(DUE_MS);

    expect(returnText(rig)).toHaveLength(3);
    expect(rig.blocked()).toHaveLength(1);
  });

  it('время сброса неизвестно, а данные провайдера показывают свободное окно: возврат через запас от этого момента, не через срок', async () => {
    const rig = await limitRig({ limitReturn: { graceMs: 500, retryMs: 600_000 } });
    rig.hit();
    await rig.advance(1000);
    expect(rig.written).toEqual([]);

    rig.limitsData.value = {
      fiveHour: { usedPercent: 2, resetsAt: new Date(T0 + 5 * 60 * MINUTE).toISOString() },
      week: null,
      at: new Date(Date.now()).toISOString(),
    };
    rig.poke();
    // Запас тот же, что после известного сброса: Claude мог продолжить сам.
    expect(rig.written).toEqual([]);
    await rig.advance(499);
    expect(rig.written).toEqual([]);

    await rig.advance(2);
    expect(returnText(rig)).toHaveLength(1);
  });

  it('окно свободно, но к запасу Claude продолжил сам: ничего не печатается', async () => {
    const rig = await limitRig({ limitReturn: { graceMs: 500, retryMs: 600_000 } });
    rig.hit();
    rig.limitsData.value = {
      fiveHour: { usedPercent: 2, resetsAt: null },
      week: null,
      at: new Date(Date.now() + 1).toISOString(),
    };
    await rig.advance(10);
    rig.poke();
    await rig.advance(300);
    rig.working();

    await rig.advance(10_000);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual([]);
  });

  it('свободное окно видно повторно: срок не отодвигается', async () => {
    const rig = await limitRig({ limitReturn: { graceMs: 500, retryMs: 600_000 } });
    rig.hit();
    await rig.advance(10);
    rig.limitsData.value = {
      fiveHour: { usedPercent: 2, resetsAt: null },
      week: null,
      at: new Date(Date.now()).toISOString(),
    };
    rig.poke();
    await rig.advance(300);
    rig.poke();
    await rig.advance(250);

    expect(returnText(rig)).toHaveLength(1);
  });

  it('данные провайдера старше удара возврата не ускоряют', async () => {
    const rig = await limitRig({ limitReturn: { graceMs: 500, retryMs: 600_000 } });
    rig.limitsData.value = {
      fiveHour: { usedPercent: 2, resetsAt: null },
      week: null,
      at: new Date(T0 - MINUTE).toISOString(),
    };
    rig.hit();
    await rig.advance(1000);
    rig.poke();

    expect(rig.written).toEqual([]);
  });

  it('процесс вышел посреди эпизода: к сроку ничего не печатается', async () => {
    const rig = await limitRig(FAST);
    rig.hit();
    await rig.advance(500);
    rig.exit();

    await rig.advance(10_000);
    expect(rig.written).toEqual([]);
    expect(rig.blocked()).toEqual([]);
  });

  it('остановка будильника снимает таймер возврата', async () => {
    const rig = await limitRig(FAST);
    rig.hit();
    rig.wake.stop();

    await rig.advance(10_000);
    expect(rig.written).toEqual([]);
  });

  it('многочасовой срок: ни раньше, ни позже срока, ступенями по минуте', async () => {
    const rig = await limitRig();
    rig.hit({ resetsAt: new Date(T0 + 5 * 60 * MINUTE).toISOString() });

    // Срок — сброс через 5 часов и запас 2 минуты.
    await rig.advance(5 * 60 * MINUTE + 119_999);
    expect(rig.written).toEqual([]);

    await rig.advance(1);
    expect(returnText(rig)).toHaveLength(1);
  });

  it('Mac спал: часы ушли за срок, а таймер стоял — возврат на ближайшей ступени, не через часы', async () => {
    const rig = await limitRig();
    rig.hit({ resetsAt: new Date(T0 + 5 * 60 * MINUTE).toISOString() });
    await rig.advance(1000);

    // Сон: настенные часы прыгнули на 6 часов, а отсчёт таймеров не двинулся.
    vi.setSystemTime(T0 + 6 * 60 * MINUTE);
    expect(rig.written).toEqual([]);

    // Одна ступень (минута): таймер сверяет срок с часами, а не со своим отсчётом.
    await rig.advance(60_000);
    expect(returnText(rig)).toHaveLength(1);
  });

  it('Mac спал, ступень ещё не сработала: любой пересчёт сессии видит, что срок прошёл', async () => {
    const rig = await limitRig();
    rig.hit({ resetsAt: new Date(T0 + 5 * 60 * MINUTE).toISOString() });

    vi.setSystemTime(T0 + 6 * 60 * MINUTE);
    rig.poke();

    expect(returnText(rig)).toHaveLength(1);
  });

  it('отказ (черновик), а затем новый лимит без видимого хода: `since` новее отказа — новый эпизод, не молчание', async () => {
    const rig = await limitRig(FAST);
    rig.draft.on = true;
    rig.hit();
    await rig.advance(DUE_MS);
    expect(rig.blocked()).toHaveLength(1);
    expect(rig.written).toEqual([]);

    // Человек убрал черновик и написал сам; ход и ошибка лимита уложились в одну склейку активности.
    rig.draft.on = false;
    await rig.advance(1000);
    rig.hit();
    await rig.advance(DUE_MS);

    expect(returnText(rig)).toHaveLength(1);
    expect(rig.blocked()).toHaveLength(1);
  });

  it('Codex: просьба вставкой, клавиша отправки через паузу Codex', async () => {
    const rig = await limitRig(FAST, 'codex');
    rig.hit();

    await rig.advance(2010);
    expect(rig.written).toEqual([`\u001b[200~${LIMIT_RETURN_TEXT}\u001b[201~`]);
    await rig.advance(CODEX_SUBMIT_DELAY_MS);
    expect(rig.written.at(-1)).toBe('\r');
  });
});
