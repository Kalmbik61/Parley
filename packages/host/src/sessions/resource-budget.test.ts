/** Бюджет работы на запуске сессий (P37): резерв до процесса, отмена, перезапуск хоста, неоднозначный владелец, автозапуск. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addSession,
  configPath,
  createWork,
  readMap,
  reserveAttempt,
  saveConfig,
  SYSTEM,
  updateMap,
  DEFAULT_RESOURCE_LIMITS,
} from '@parley/core';
import type { WorkMap } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import { HostError } from '../errors.js';
import { createPtyManager } from '../pty/pty-manager.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createSessionsService } from './sessions-service.js';
import type { SessionsFeedOptions, SessionsService } from './sessions-service.js';

const STUB = fileURLToPath(new URL('../../test/stub-agent.mjs', import.meta.url));
vi.setConfig({ testTimeout: 30_000 });

let broadcasts: Array<{ event: EventName; data: unknown }>;
let project = '';
let savedBin: string | undefined;
let stoppers: Array<() => Promise<void>> = [];

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

const fakeWorks = (): WorksService => ({
  start: async () => {},
  snapshot: () => ({ entries: [], branches: {} }),
  entry: () => undefined,
  firstReadDone: () => false,
  onChange: () => () => {},
  stop: async () => {},
});

const fakeActivity = (): ActivityService => ({
  start: async () => {},
  get: () => undefined,
  markSeen: () => {},
  onChange: () => () => {},
  stop: async () => {},
});

/** Один «хост»: свой PTY-менеджер, сервис сессий и поколение. Перезапуск — новый экземпляр на тех же файлах. */
function host(works: WorksService = fakeWorks(), feed: SessionsFeedOptions = {}): { sessions: SessionsService; pty: PtyManager } {
  const pty = createPtyManager(fakeHost());
  const sessions = createSessionsService(fakeHost(), works, pty, fakeActivity(), feed);
  stoppers.push(() => sessions.stopAll());
  return { sessions, pty };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000, nudge?: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  let nudgedAt = started;
  for (;;) {
    if (await check()) return;
    const now = Date.now();
    if (now - started > timeoutMs) throw new Error('не дождались условия');
    if (nudge !== undefined && now - nudgedAt >= 1000) {
      nudgedAt = now;
      await nudge();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-budget-project-'));
  broadcasts = [];
  stoppers = [];
  savedBin = process.env['PARLEY_CLAUDE_BIN'];
  process.env['PARLEY_CLAUDE_BIN'] = STUB;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const stop of stoppers) await stop().catch(() => {});
  if (savedBin === undefined) delete process.env['PARLEY_CLAUDE_BIN'];
  else process.env['PARLEY_CLAUDE_BIN'] = savedBin;
  await rm(configPath(), { force: true });
  await rm(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const create = (sessions: SessionsService, workId: string, label = 'a'): Promise<SessionRef> =>
  sessions.create({ projectPath: project, workId, provider: 'claude', label, task: 'т', parent: null });

const ledger = async (workId: string): Promise<WorkMap['resources']> => (await readMap(project, workId)).resources;

const budgetError = async (run: Promise<unknown>): Promise<HostError> => {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(HostError);
    return error as HostError;
  }
  throw new Error('отказа не было');
};

describe('запуск: резерв до процесса, исход после', () => {
  it('удавшийся запуск — резерв потрачен: попытка launch, spent, от человека, поколение хоста записано', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { sessions } = host();
    await create(sessions, work.work.id);

    const resources = await ledger(work.work.id);
    expect(resources?.attempts).toHaveLength(1);
    expect(resources?.attempts[0]).toMatchObject({ kind: 'launch', state: 'spent', actor: 'human', session: 's-01' });
    expect(resources?.attempts[0]?.owner).toMatch(/^host-/);
  });

  it('исчерпанные слоты: следующий запуск отказан без процесса, ошибка называет бюджет и просит человека', async () => {
    await saveConfig({ workConcurrent: 2 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { sessions, pty } = host();
    await create(sessions, work.work.id, 'a');
    await create(sessions, work.work.id, 'b');

    const refusal = await budgetError(create(sessions, work.work.id, 'c'));
    expect(refusal.code).toBe('conflict');
    expect(refusal.data).toMatchObject({ code: 'resource-budget', reason: 'concurrent', scope: 'work', limit: 2 });
    expect(refusal.message).toContain('raise the limit in Settings');
    // Модель не запущена: живых процессов по-прежнему два, ожидающих резервов нет.
    expect(pty.list()).toHaveLength(2);
    const resources = await ledger(work.work.id);
    expect(resources?.attempts.filter((attempt) => attempt.state === 'reserved')).toEqual([]);
    expect((await readMap(project, work.work.id)).sessions.find((session) => session.id === 's-03')?.lifecycle).toBe('pending');
  });

  // Спека хранилища 6.2: письмо об отказе пишется как письмо (`writeLetters`), без разбора карты.
  it('автозапуск отказан бюджетом: родителю — системное письмо об отказе, человеку — уведомление; запуск человека письма не пишет', async () => {
    await saveConfig({ workConcurrent: 1 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { sessions } = host();
    const parent = await create(sessions, work.work.id, 'a');
    await updateMap(project, work.work.id, (map) => {
      // `addSession` родителя не принимает: поле осталось в старых картах, письмо идёт тому, кого оно называет.
      addSession(map, { provider: 'claude', label: 'child', task: 'т' }).parent = parent.sessionId;
    });
    const child: SessionRef = { projectPath: project, workId: work.work.id, sessionId: 's-02' };

    await budgetError(sessions.launch(child, 'launch'));
    expect((await readMap(project, work.work.id)).messages).toEqual([]);

    const refusal = await budgetError(sessions.launch(child, 'launch', { by: 'auto' }));
    const letters = (await readMap(project, work.work.id)).messages;
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ from: SYSTEM, to: [parent.sessionId], roomId: null, kind: 'note' });
    expect(letters[0]?.text).toMatch(/^S02 was not started: /);
    expect(letters[0]?.text).toContain(refusal.message);
    expect(broadcasts.some((item) => item.event === 'host.notice' && (item.data as { kind: string }).kind === 'launch-failed')).toBe(true);
  });

  it('окно запусков: после остановки слот свободен, а запуск всё равно считается в часе', async () => {
    await saveConfig({ workLaunches: 2 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { sessions } = host();
    const first = await create(sessions, work.work.id, 'a');
    const second = await create(sessions, work.work.id, 'b');
    await sessions.stop(first);
    await sessions.stop(second);

    const refusal = await budgetError(create(sessions, work.work.id, 'c'));
    expect(refusal.data).toMatchObject({ reason: 'launches', limit: 2, used: 2 });
  });
});

describe('параллельные запуски не обходят общую квоту', () => {
  it('шесть одновременных запусков при двух слотах: стартуют ровно две сессии, остальные отказаны без процесса', async () => {
    await saveConfig({ workConcurrent: 2 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    await updateMap(project, work.work.id, (map) => {
      for (let i = 0; i < 6; i += 1) addSession(map, { provider: 'claude', label: `s${i}`, task: 'т' });
    });
    const { sessions, pty } = host();

    const results = await Promise.allSettled(
      ['s-01', 's-02', 's-03', 's-04', 's-05', 's-06'].map((sessionId) =>
        sessions.launch({ projectPath: project, workId: work.work.id, sessionId }, 'launch'),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(refused).toHaveLength(4);
    expect(refused.every((result) => (result.reason as HostError).data?.['code'] === 'resource-budget')).toBe(true);
    expect(pty.list()).toHaveLength(2);
    const resources = await ledger(work.work.id);
    expect(resources?.attempts.filter((attempt) => attempt.state === 'spent')).toHaveLength(2);
    expect(resources?.attempts.filter((attempt) => attempt.state === 'reserved')).toEqual([]);
  });

  it('повтор запуска и возобновления одной сессии одновременно: один процесс и одна попытка, второй резерв не списан', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    await updateMap(project, work.work.id, (map) => {
      addSession(map, { provider: 'claude', label: 'a', task: 'т' });
    });
    const { sessions, pty } = host();
    const ref = { projectPath: project, workId: work.work.id, sessionId: 's-01' };

    await Promise.allSettled([sessions.launch(ref, 'launch'), sessions.launch(ref, 'launch', { by: 'auto' }), sessions.launch(ref, 'resume')]);
    expect(pty.list()).toHaveLength(1);
    await waitFor(async () => (await ledger(work.work.id))?.attempts.every((attempt) => attempt.state === 'spent') === true);
    expect((await ledger(work.work.id))?.attempts).toHaveLength(1);
  });
});

describe('меньший лимит и управление', () => {
  it('лимит снижен ниже числа живых: живые не останавливаются, новые отказаны, а stop и close исчерпанным бюджетом не блокируются', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const { sessions, pty } = host();
    const a = await create(sessions, work.work.id, 'a');
    const b = await create(sessions, work.work.id, 'b');

    await saveConfig({ workConcurrent: 1, workLaunches: 1 });
    expect(pty.list()).toHaveLength(2);
    expect(sessions.live(a)).toBe(true);
    await budgetError(create(sessions, work.work.id, 'c'));
    expect(pty.list()).toHaveLength(2);

    // Остановка и закрытие — управление: они проходят при исчерпанном бюджете и освобождают слоты.
    await sessions.stop(a);
    await sessions.close(b);
    expect(pty.list()).toHaveLength(0);
    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((session) => session.id === 's-01')?.lifecycle).toBe('sleeping');
    expect(map.sessions.find((session) => session.id === 's-02')?.lifecycle).toBe('closed');
  });
});

describe('отмена: освобождается только свой ожидающий слот', () => {
  it('запуск не дошёл до процесса — свой резерв released, окно не потрачено, чужой ожидающий резерв остался', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    // Провайдер готов (проверка готовности идёт до резерва и следа в карте не оставляет), а запуск падает позже, уже с
    // резервом: предел длины запуска не определён.
    const { sessions } = host(undefined, { spawnLimits: async () => null });
    // Чужой ожидающий резерв другой сессии (другое поколение): запуск этой сессии его не трогает.
    await updateMap(project, work.work.id, (map) => {
      const foreign = addSession(map, { provider: 'claude', label: 'чужая', task: 'т' });
      reserveAttempt(map, {
        kind: 'launch', actor: 'auto', session: foreign.id, owner: 'host-other', limits: { ...DEFAULT_RESOURCE_LIMITS },
      });
    });

    await expect(create(sessions, work.work.id, 'мой')).rejects.toThrow('spawn-budget-unavailable');

    const resources = await ledger(work.work.id);
    const byOwner = Object.fromEntries((resources?.attempts ?? []).map((attempt) => [attempt.session, attempt.state]));
    expect(byOwner).toEqual({ 's-01': 'reserved', 's-02': 'released' });
  });

  it('повторный запуск после отмены берёт новый резерв и проходит', async () => {
    await saveConfig({ workLaunches: 1 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    // Первый запуск падает после резерва; повторный — тем же файлам, но уже с определённым пределом.
    const failing = host(undefined, { spawnLimits: async () => null }).sessions;
    await expect(create(failing, work.work.id)).rejects.toThrow('spawn-budget-unavailable');
    const { sessions } = host();
    await sessions.launch({ projectPath: project, workId: work.work.id, sessionId: 's-01' }, 'launch');
    const resources = await ledger(work.work.id);
    expect(resources?.attempts.map((attempt) => attempt.state).sort()).toEqual(['released', 'spent']);
  });
});

describe('перезапуск хоста', () => {
  it('новый хост не выдаёт новый бюджет: окно запусков и потраченные слоты читаются из карты', async () => {
    await saveConfig({ workLaunches: 2 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    const old = host();
    const a = await create(old.sessions, work.work.id, 'a');
    const b = await create(old.sessions, work.work.id, 'b');
    await old.sessions.stopAll();
    expect(old.pty.list()).toHaveLength(0);
    expect(a.sessionId).toBe('s-01');
    expect(b.sessionId).toBe('s-02');

    const restarted = host();
    const refusal = await budgetError(create(restarted.sessions, work.work.id, 'c'));
    expect(refusal.data).toMatchObject({ reason: 'launches', limit: 2 });
    expect(restarted.pty.list()).toHaveLength(0);
  });

  it('неоднозначный резерв прошлого хоста: сутки спустя он держит слот, а повтор той же сессии подхватывает его без второго списания', async () => {
    await saveConfig({ workConcurrent: 1 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    // Резерв «упавшего» хоста: сессия pending, процесса нет, исхода в карте нет.
    await updateMap(project, work.work.id, (map) => {
      const lost = addSession(map, { provider: 'claude', label: 'потерянная', task: 'т' });
      const attempt = reserveAttempt(map, {
        kind: 'launch', actor: 'auto', session: lost.id, owner: 'host-dead', limits: { ...DEFAULT_RESOURCE_LIMITS },
      });
      attempt.at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      addSession(map, { provider: 'claude', label: 'другая', task: 'т' });
    });

    const { sessions } = host();
    // Одного срока мало: слот занят, чужая сессия не стартует.
    const refusal = await budgetError(sessions.launch({ projectPath: project, workId: work.work.id, sessionId: 's-02' }, 'launch'));
    expect(refusal.data).toMatchObject({ reason: 'concurrent' });
    expect((await ledger(work.work.id))?.attempts[0]).toMatchObject({ state: 'reserved', owner: 'host-dead' });

    // Повтор той же сессии подхватывает резерв: попытка одна, и она потрачена новым владельцем.
    await sessions.launch({ projectPath: project, workId: work.work.id, sessionId: 's-01' }, 'launch');
    const resources = await ledger(work.work.id);
    expect(resources?.attempts).toHaveLength(1);
    expect(resources?.attempts[0]).toMatchObject({ state: 'spent', session: 's-01' });
    expect(resources?.attempts[0]?.owner).not.toBe('host-dead');
  });
});

describe('явный запуск исторической сессии', () => {
  it('сверх слотов явный запуск возвращает отказ: pending остаётся, процесса и резерва нет', async () => {
    await saveConfig({ workConcurrent: 2 });
    const work = await createWork(project, { title: 'Работа', goal: '' });
    let parentId = '';
    let otherId = '';
    await updateMap(project, work.work.id, (map) => {
      parentId = addSession(map, { provider: 'claude', label: 'родитель', task: 'т' }).id;
      otherId = addSession(map, { provider: 'claude', label: 'другая', task: 'т' }).id;
    });
    const works = createWorksService(fakeHost(), { debounceMs: 30 });
    stoppers.push(() => works.stop());
    const { sessions, pty } = host(works);
    // Оба слота заняты живыми сессиями.
    await sessions.launch({ projectPath: project, workId: work.work.id, sessionId: parentId }, 'launch');
    await sessions.launch({ projectPath: project, workId: work.work.id, sessionId: otherId }, 'launch');
    await works.start();

    let childId = '';
    await updateMap(project, work.work.id, (map) => {
      const child = addSession(map, { provider: 'claude', label: 'ребёнок', task: 'т', parent: null });
      child.parent = parentId;
      childId = child.id;
    });

    await expect(sessions.launch({ projectPath: project, workId: work.work.id, sessionId: childId }, 'launch')).rejects.toThrow('session limit reached');

    const map = await readMap(project, work.work.id);
    expect(map.sessions.find((session) => session.id === childId)?.lifecycle).toBe('pending');
    expect(pty.list()).toHaveLength(2);
    expect(map.messages).toEqual([]);
    const notice = broadcasts.find(event => event.event === 'host.notice' && (event.data as { kind?: string; ref?: SessionRef }).kind === 'launch-failed' && (event.data as { ref?: SessionRef }).ref?.sessionId === childId);
    expect(notice?.data).toMatchObject({ kind: 'launch-failed', ref: { sessionId: childId } });
    // Резерва за отказ не осталось.
    expect((await ledger(work.work.id))?.attempts.filter((attempt) => attempt.state === 'reserved')).toEqual([]);
  });

  it('явный запуск исторического ребёнка проходит допуск и тратит человеческий резерв', async () => {
    const work = await createWork(project, { title: 'Работа', goal: '' });
    let parentId = '';
    await updateMap(project, work.work.id, (map) => {
      parentId = addSession(map, { provider: 'claude', label: 'родитель', task: 'т' }).id;
    });
    const works = createWorksService(fakeHost(), { debounceMs: 30 });
    stoppers.push(() => works.stop());
    const { sessions } = host(works);
    await works.start();

    let childId = '';
    await updateMap(project, work.work.id, (map) => {
      const child = addSession(map, { provider: 'claude', label: 'ребёнок', task: 'т', parent: null });
      child.parent = parentId;
      childId = child.id;
    });
    await sessions.launch({ projectPath: project, workId: work.work.id, sessionId: childId }, 'launch');
    // Исход резерва пишется следом за записью старта.
    await waitFor(async () => (await ledger(work.work.id))?.attempts.find((row) => row.session === childId)?.state === 'spent');
    const attempt = (await ledger(work.work.id))?.attempts.find((row) => row.session === childId);
    expect(attempt).toMatchObject({ kind: 'launch', state: 'spent', actor: 'human' });
  });
});
