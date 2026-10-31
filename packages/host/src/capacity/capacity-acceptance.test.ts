/**
 * Приёмка потолка машины на заглушке (спека сна агентов и ёмкости 2026-10-30, 7, «На поддельном CLI»; план 2, задача 11).
 *
 * Стенд собран так же, как в `host.ts`: карты работ, учёт активности, PTY, сессии, будильник, сервис ёмкости и сервис сна
 * настоящие, вместо `claude` стоит `test/stub-agent.mjs`. Подставлен только датчик памяти: объект с изменяемым `level`,
 * чьих слушателей тест зовёт вручную. Настройки сервиса ёмкости и сервиса сна — замыкания с фиксированными значениями;
 * бюджет работы сервис сессий читает из настоящей настройки в песочнице `PARLEY_HOME`, умолчаний ему хватает.
 *
 * Проверяют готовый код целиком, а не отдельные модули (те проверены своими тестами): падение здесь — дефект связки.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HUMAN, addSession, createWork, readStoredMap, sessionTag, updateMap } from '@parley/core';
import type { MachineConcurrent, MemoryPressure, QueuedLaunch, WorkMap, WorkSession } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import { createActivityService } from '../activity/activity-service.js';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createSessionsService } from '../sessions/sessions-service.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import { createAutoSleepService } from '../sleep/auto-sleep-service.js';
import { createWakeService } from '../wake/wake-service.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createCapacityService } from './capacity-service.js';
import type { CapacityService } from './capacity-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
const MIN = 60_000;
/** Создатель сессий в каждой работе стенда: первая сессия карты. */
const CREATOR = 's-01';

// Тесты ждут настоящие процессы заглушки: под нагрузкой машины пяти секунд по умолчанию им хватает не всегда.
vi.setConfig({ testTimeout: 30_000 });

type LogLevel = 'info' | 'warn' | 'error';

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let logs: Array<{ level: LogLevel; message: string; fields: Record<string, unknown> }> = [];
const stoppers: Array<() => Promise<void>> = [];
let extraEnv: string[] = [];

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  extraEnv.push(key);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-capacity-acceptance-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-capacity-acceptance-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-capacity-acceptance-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-capacity-acceptance-codex-'));
  process.env['PARLEY_HOME'] = home;
  // Настоящий `claude` в автотестах не запускается никогда — только заглушка; история — во временном корне, не в ~/.claude.
  setEnv('PARLEY_CLAUDE_BIN', STUB);
  setEnv('PARLEY_CLAUDE_PROJECTS_DIR', claudeRoot);
  setEnv('PARLEY_SKILL_NAVIGATOR', '0');
  broadcasts = [];
  logs = [];
});

afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
  for (const key of extraEnv) delete process.env[key];
  extraEnv = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ),
  );
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`не дождались: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Стенд
// ---------------------------------------------------------------------------------------------

/** Датчик памяти, каким его видят сервис ёмкости и сервис сна: уровень и слушатели чтений (`PressureSensor` хоста). */
interface FakeSensor {
  level: MemoryPressure;
  current(): { level: MemoryPressure };
  onReading(listener: (reading: { level: MemoryPressure }) => void): () => void;
  /** Датчик сделал очередное чтение (в хосте раз в 10 с): слушатели получают нынешний уровень. */
  read(): void;
}

function fakeSensor(level: MemoryPressure): FakeSensor {
  const listeners = new Set<(reading: { level: MemoryPressure }) => void>();
  const sensor: FakeSensor = {
    level,
    current: () => ({ level: sensor.level }),
    onReading: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read: () => {
      for (const listener of Array.from(listeners)) listener({ level: sensor.level });
    },
  };
  return sensor;
}

function fakeHost(): HostContext {
  const write =
    (level: LogLevel) =>
    (message: string, fields?: object): void => {
      logs.push({ level, message, fields: { ...fields } });
    };
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: write('info'), warn: write('warn'), error: write('error') },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
    hold: () => {},
  };
}

interface RigOptions {
  machineConcurrent: MachineConcurrent;
  sleepAfterMinutes: number;
  sleepUnderPressureMinutes?: number;
  /** Уровень давления датчика в начале теста. */
  level?: MemoryPressure;
  /** Часы сервиса сна (как `now` его зависимостей); нет — настоящие. */
  sleepNow?: () => number;
}

interface Rig {
  pty: PtyManager;
  works: WorksService;
  activity: ActivityService;
  sessions: SessionsService;
  capacity: CapacityService;
  sensor: FakeSensor;
  /** Сессии в порядке событий `start` процессов. */
  starts: string[];
  /** Наибольшее число живых процессов за всё время, точно: по событиям `start` и `exit`. */
  peak(): number;
  /** То же по замерам `pty.list().length` раз в 50 мс, как велит план. */
  sampledPeak(): number;
}

/**
 * Связка служб как в `host.ts`: сервис ёмкости заводится до сессий, а продолжение очереди и сон ради слота читают
 * сервисы, созданные ниже, — привязка поздняя. Старт — в порядке хоста (карты, активность, будильник, сон, очередь),
 * остановка — наоборот: очередь раньше `stopAll`, чтобы выходы процессов при остановке не продвигали её.
 */
async function buildRig(options: RigOptions): Promise<Rig> {
  const settings = {
    machineConcurrent: options.machineConcurrent,
    sleepAfterMinutes: options.sleepAfterMinutes,
    sleepUnderPressureMinutes: options.sleepUnderPressureMinutes ?? 5,
  };
  const host = fakeHost();
  const sensor = fakeSensor(options.level ?? 'normal');
  const works = createWorksService(host, {
    debounceMs: 20,
    ownedPids: () => new Set(pty.list().map((handle) => handle.pid)),
  });
  const activity = createActivityService(host, works, { claudeRoot, codexRoot });
  const pty = createPtyManager(host);
  const capacity = createCapacityService(host, {
    pty,
    works,
    pressure: sensor,
    config: async () => settings,
    launch: (ref, mode, choice) => sessions.launch(ref, mode, choice),
    retry: (ref) => wake.retry(ref),
    sleep: () => sleep,
  });
  const sessions = createSessionsService(host, works, pty, activity, { capacity });
  const wake = createWakeService(host, works, activity, pty, sessions, { enterDelayMs: 30 });
  const sleep = createAutoSleepService(host, {
    works,
    activity,
    pty,
    sessions,
    wake,
    compacting: () => false,
    config: async () => settings,
    pressure: sensor,
    ...(options.sleepNow === undefined ? {} : { now: options.sleepNow }),
  });

  const starts: string[] = [];
  let live = 0;
  let peak = 0;
  let sampled = 0;
  pty.on('start', (ref) => {
    starts.push(ref.sessionId);
    live += 1;
    peak = Math.max(peak, live);
  });
  pty.on('exit', () => {
    live -= 1;
  });

  await works.start();
  await activity.start();
  wake.start();
  sleep.start();
  // Очередь собирается из карт, прочитанных выше: запуски, что ждали слота до «перезапуска хоста», продолжаются.
  capacity.start();

  const sampler = setInterval(() => {
    sampled = Math.max(sampled, pty.list().length);
  }, 50);
  stoppers.push(async () => {
    clearInterval(sampler);
    capacity.stop();
    sleep.stop();
    wake.stop();
    await sessions.stopAll();
    await activity.stop();
    await works.stop();
  });
  // Всплеск событий наблюдателя от записей подготовки ещё может догонять старт: действия теста — после затишья.
  await settle(200);
  return { pty, works, activity, sessions, capacity, sensor, starts, peak: () => peak, sampledPeak: () => sampled };
}

// ---------------------------------------------------------------------------------------------
// Карта
// ---------------------------------------------------------------------------------------------

/**
 * Работа с создателем `CREATOR`: он `pending` и без процесса, слота не занимает, а для `create()` он есть в карте и не
 * закрыт. `fill` добавляет остальные сессии в той же записи. Возвращает id работы.
 */
async function prepareWork(fill: (map: WorkMap) => void = () => {}): Promise<string> {
  const { work } = await createWork(project, { title: 'Работа' });
  await updateMap(project, work.id, (map) => {
    addSession(map, { provider: 'claude', label: 'Создатель', task: 'раздать работу' });
    fill(map);
  });
  return work.id;
}

const refOf = (workId: string, sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });

function sessionOf(ref: SessionRef): WorkSession {
  const found = readStoredMap(ref.projectPath, ref.workId).sessions.find((candidate) => candidate.id === ref.sessionId);
  if (found === undefined) throw new Error(`сессии ${ref.sessionId} нет в карте`);
  return found;
}

/** Сессии очереди сервиса ёмкости по порядку. */
const queueIds = (rig: Rig): string[] => rig.capacity.queue().map((entry) => entry.ref.sessionId);

const noticeTexts = (kind: string): string[] =>
  broadcasts
    .filter((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === kind)
    .map((item) => (item.data as { text: string }).text);

/** Сессия `active` в снимке работ хоста: его читают сервис ёмкости и сервис сна, и он отстаёт от карты на мгновение. */
const activeInSnapshot = (rig: Rig, ref: SessionRef): boolean =>
  rig.works
    .snapshot()
    .entries.some((entry) =>
      entry.map.sessions.some((session) => session.id === ref.sessionId && session.lifecycle === 'active'),
    );

const errorLogs = (): string[] => logs.filter((line) => line.level === 'error').map((line) => line.message);

// ---------------------------------------------------------------------------------------------
// Приёмка
// ---------------------------------------------------------------------------------------------

describe('Потолок машины: приёмка на заглушке', () => {
  it('потолок 3: из 8 созданных агентом сессий живых никогда больше 3, все стартуют по порядку', async () => {
    // Каждая заглушка выходит сама через 1,5 с: слоты освобождаются без участия теста.
    setEnv('STUB_EXIT_AFTER_MS', '1500');
    const workId = await prepareWork();
    const rig = await buildRig({ machineConcurrent: 3, sleepAfterMinutes: 0 });

    const created: SessionRef[] = [];
    for (let n = 1; n <= 8; n += 1) {
      const result = await rig.sessions.create({
        projectPath: project,
        workId,
        provider: 'claude',
        label: `Агент ${n}`,
        task: `Задача ${n}`,
        parent: null,
        requestedBy: CREATOR,
      });
      created.push(refOf(workId, result.sessionId));
      // Агент не зовёт `create_session` чаще раза в сотню миллисекунд.
      if (result.queued === undefined) {
        // Заглушки первой тройки не должны выходить почти разом: два слота, освободившиеся вместе, дают два параллельных
        // запуска из очереди, и какой из них первым дойдёт до `pty.start`, не определено (порядок допуска при этом верен).
        await settle(100);
      } else {
        // Запись очереди попадает в снимок работ раньше следующего запуска: он видит впереди себя всех ждущих.
        await waitFor(() => queueIds(rig).includes(result.sessionId), `запись очереди ${result.sessionId} в снимке работ`);
      }
    }

    await waitFor(() => rig.starts.length === 8, 'старт всех восьми сессий', 30_000);
    await waitFor(
      () => created.every((ref) => sessionOf(ref).lifecycle !== 'pending'),
      'запись старта всех восьми сессий в карту',
    );

    // Все восемь стартовали по порядку создания, а живых за всё время было не больше потолка.
    expect(rig.starts).toEqual(created.map((ref) => ref.sessionId));
    expect(rig.peak()).toBeLessThanOrEqual(3);
    expect(rig.sampledPeak()).toBeLessThanOrEqual(3);
    // Запись очереди снимается со стартом: в карте не осталось ждущих, а снимок работ догоняет карту за мгновение.
    expect(readStoredMap(project, workId).sessions.filter((session) => session.queued != null)).toEqual([]);
    await waitFor(() => queueIds(rig).length === 0, 'пустая очередь в снимке работ');
    expect(errorLogs()).toEqual([]);
  }, 45_000);

  it('давление critical: запуск агента в очереди, два запуска человека сверх потолка, третий — первым в очереди', async () => {
    const workId = await prepareWork((map) => {
      for (const label of ['Человек 1', 'Человек 2', 'Человек 3']) {
        addSession(map, { provider: 'claude', label, task: 'сделать' });
      }
    });
    const first = refOf(workId, 's-02');
    const second = refOf(workId, 's-03');
    const third = refOf(workId, 's-04');
    // Потолок 3 не заполнен ни разу: запуски держит одно давление.
    const rig = await buildRig({ machineConcurrent: 3, sleepAfterMinutes: 0, level: 'critical' });

    // Агент просит сессию: при critical она ждёт в очереди, процесса нет.
    const agent = refOf(
      workId,
      (
        await rig.sessions.create({
          projectPath: project,
          workId,
          provider: 'claude',
          label: 'Агент',
          task: 'Задача агента',
          parent: null,
          requestedBy: CREATOR,
        })
      ).sessionId,
    );
    expect(sessionOf(agent).queued).toMatchObject({ class: 'agent', mode: 'launch', by: CREATOR, reason: 'memory-critical' });
    expect(rig.pty.list()).toHaveLength(0);

    // Два запуска человека идут сверх потолка, с уведомлением; третий встаёт в очередь.
    expect(await rig.sessions.launch(first, 'launch', { by: HUMAN })).toBe('started');
    expect(await rig.sessions.launch(second, 'launch', { by: HUMAN })).toBe('started');
    expect(await rig.sessions.launch(third, 'launch', { by: HUMAN })).toBe('queued');
    expect(sessionOf(third).queued).toMatchObject({ class: 'human', mode: 'launch', by: HUMAN, reason: 'memory-critical' });
    expect(noticeTexts('machine-over-limit')).toEqual([
      `${sessionTag(first.sessionId)} started while memory is critical`,
      `${sessionTag(second.sessionId)} started while memory is critical`,
    ]);

    // Человек встал в очередь позже агента, но идёт первым.
    await waitFor(() => queueIds(rig).length === 2, 'обе записи очереди в снимке работ');
    expect(queueIds(rig)).toEqual([third.sessionId, agent.sessionId]);

    // Пока давление critical, очередь стоит, хотя до потолка 3 остаётся одно место.
    rig.sensor.read();
    rig.sensor.read();
    await settle(400);
    expect(rig.pty.list()).toHaveLength(2);
    expect(queueIds(rig)).toEqual([third.sessionId, agent.sessionId]);

    // Давление в норме: свободно одно место из трёх, и его получает запись человека, а не агента.
    rig.sensor.level = 'normal';
    rig.sensor.read();
    await waitFor(() => rig.pty.get(third) !== undefined, 'старт записи человека после спада давления');
    await settle(400);
    expect(rig.pty.get(agent)).toBeUndefined();
    expect(queueIds(rig)).toEqual([agent.sessionId]);

    // Процесс вышел — освободившееся место получает агент.
    await rig.sessions.stop(first);
    await waitFor(() => rig.pty.get(agent) !== undefined, 'старт записи агента после выхода сессии');
    await waitFor(
      () => [third, agent].every((ref) => sessionOf(ref).lifecycle === 'active'),
      'запись старта обеих сессий в карту',
    );

    expect(rig.starts).toEqual([first, second, third, agent].map((ref) => ref.sessionId));
    expect(sessionOf(third).queued).toBeUndefined();
    expect(sessionOf(agent).queued).toBeUndefined();
    expect(errorLogs()).toEqual([]);
  });

  it('перезапуск хоста: очередь собирается заново и идёт без человека', async () => {
    setEnv('STUB_EXIT_AFTER_MS', '1500');
    const queuedAt = Date.parse('2026-10-31T10:00:00.000Z');
    const workId = await prepareWork((map) => {
      const record = (at: number): QueuedLaunch => ({
        class: 'agent',
        mode: 'launch',
        by: CREATOR,
        at: new Date(at).toISOString(),
        reason: 'machine-limit',
        live: 1,
        limit: 1,
      });
      // Карта, какой её оставил прежний хост: две сессии `pending` с записью очереди. `s-03` встала раньше `s-02` —
      // порядок очереди идёт по времени постановки, а не по номеру сессии.
      addSession(map, { provider: 'claude', label: 'Вторая', task: 'сделать', createdBy: CREATOR }).queued = record(
        queuedAt + 2_000,
      );
      addSession(map, { provider: 'claude', label: 'Первая', task: 'сделать', createdBy: CREATOR }).queued = record(
        queuedAt + 1_000,
      );
    });
    const later = refOf(workId, 's-02');
    const earlier = refOf(workId, 's-03');

    // Новый хост: потолок 1, живых нет, никто ничего не вызывает.
    const rig = await buildRig({ machineConcurrent: 1, sleepAfterMinutes: 0 });

    await waitFor(() => rig.starts.length === 1, 'старт первой записи очереди без чьего-либо вызова');
    expect(rig.starts).toEqual([earlier.sessionId]);
    // Потолок 1 занят: вторая запись ждёт, пока первая жива.
    await settle(400);
    expect(rig.pty.get(later)).toBeUndefined();
    expect(sessionOf(later).queued).toBeDefined();

    // Первая заглушка вышла сама — слот получает вторая.
    await waitFor(() => rig.starts.length === 2, 'старт второй записи очереди после выхода первой', 20_000);
    await waitFor(
      () => [earlier, later].every((ref) => sessionOf(ref).lifecycle !== 'pending'),
      'запись старта обеих сессий в карту',
    );

    expect(rig.starts).toEqual([earlier.sessionId, later.sessionId]);
    expect(rig.peak()).toBe(1);
    expect(sessionOf(earlier).queued).toBeUndefined();
    expect(sessionOf(later).queued).toBeUndefined();
    await waitFor(() => queueIds(rig).length === 0, 'пустая очередь в снимке работ');
    expect(errorLogs()).toEqual([]);
  }, 45_000);

  it('сон ради слота на настоящем стеке: агент просит третью сессию при потолке 2 — одна из двух уснула, третья стартовала', async () => {
    // Хуки заглушки пишут журнал, а промпт из argv — первый ход, который она тут же заканчивает: сессии выглядят простаивающими.
    setEnv('STUB_HOOKS', '1');
    setEnv('STUB_PROMPT_FROM_ARGV', '1');
    const workId = await prepareWork((map) => {
      for (const label of ['Простаивает 1', 'Простаивает 2']) {
        addSession(map, { provider: 'claude', label, task: 'сделать' });
      }
    });
    const idle = ['s-02', 's-03'].map((id) => refOf(workId, id));
    // Часы сервиса сна на десять минут впереди: ход, кончившийся секунды назад, выглядит давним. Обычный порог (60 мин) такой
    // простой не берёт, порог давления (1 мин) берёт — значит, сон может быть только сном ради слота.
    const rig = await buildRig({
      machineConcurrent: 2,
      sleepAfterMinutes: 60,
      sleepUnderPressureMinutes: 1,
      sleepNow: () => Date.now() + 10 * MIN,
    });

    for (const ref of idle) expect(await rig.sessions.launch(ref, 'launch', { by: HUMAN })).toBe('started');
    await waitFor(
      () => idle.every((ref) => rig.activity.get(ref)?.activity.turnEndedAt != null && activeInSnapshot(rig, ref)),
      'конец хода обеих сессий и запись их старта в снимок работ',
    );
    expect(rig.pty.list()).toHaveLength(2);

    // Агент просит третью: слотов нет, и допуск усыпляет простаивающую.
    const result = await rig.sessions.create({
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'Третья',
      task: 'Задача третьей',
      parent: null,
      requestedBy: CREATOR,
    });
    const third = refOf(workId, result.sessionId);

    // Третья стартовала, а не встала в очередь.
    expect(result.queued).toBeUndefined();
    expect(rig.pty.get(third)).toBeDefined();
    // Одна из двух уснула по слоту, вторая работает.
    const sleeping = idle.filter((ref) => sessionOf(ref).lifecycle === 'sleeping');
    expect(sleeping).toHaveLength(1);
    const slept = sleeping[0] as SessionRef;
    const awake = idle.find((ref) => ref.sessionId !== slept.sessionId) as SessionRef;
    expect(sessionOf(slept).autoSleep).toMatchObject({ reason: 'slot', waitTarget: null });
    expect(rig.pty.get(slept)).toBeUndefined();
    expect(rig.pty.get(awake)).toBeDefined();
    expect(sessionOf(awake).lifecycle).toBe('active');
    expect(
      logs.some(
        (line) => line.message === 'агент усыплён' && line.fields['reason'] === 'slot' && (line.fields['ref'] as SessionRef).sessionId === slept.sessionId,
      ),
    ).toBe(true);

    // Уснувшую ничто не будит, а живых всё время было не больше потолка.
    await settle(500);
    expect(rig.pty.get(slept)).toBeUndefined();
    expect(sessionOf(slept).lifecycle).toBe('sleeping');
    expect(rig.pty.list()).toHaveLength(2);
    expect(rig.peak()).toBeLessThanOrEqual(2);
    expect(rig.sampledPeak()).toBeLessThanOrEqual(2);
    expect(errorLogs()).toEqual([]);
  });
});
