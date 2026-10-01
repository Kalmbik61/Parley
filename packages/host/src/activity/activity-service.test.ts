import { mkdir, appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addSession,
  createWork,
  transitionSession,
  updateMap,
  workPaths,
  NEW_LABEL,
} from '@parley/core';
import type { EventData, EventName, LiveMetrics, SessionRef } from '@parley/protocol';
import { refKey } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createWorksService } from '../works/works-service.js';
import type { WorksService } from '../works/works-service.js';
import { createActivityService } from './activity-service.js';
import type { ActivityService, ActivityServiceOptions } from './activity-service.js';
import type { SubagentMeta } from './subagent-meta.js';

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let services: Array<{ stop: () => Promise<void> }> = [];

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
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  // Второй корень тоже временный: иначе индекс логов читал бы настоящий ~/.codex
  // (use-sessions.test.tsx, use-session-link.test.tsx — тот же приём).
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['PARLEY_HOME'] = home;
  broadcasts = [];
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function works(): Promise<WorksService> {
  const service = createWorksService(fakeHost());
  services.push(service);
  await service.start();
  return service;
}

function activity(worksService: WorksService, options: ActivityServiceOptions = {}): ActivityService {
  const host = fakeHost();
  const service = createActivityService(host, worksService, {
    silenceThresholdMs: 30_000,
    claudeRoot,
    codexRoot,
    ...options,
  });
  services.push(service);
  return service;
}

const settle = (ms = 250): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ждёт условие вместо фиксированной паузы: под полной сборкой пакетов файлы
 * тестов идут параллельно, и разовый `settle()` иногда не успевает застать
 * промежуточное состояние (use-sessions.test.tsx, use-session-link.test.tsx —
 * тот же приём).
 */
const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const hook = (name: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hook_event_name: name, ...extra })}\n`;

/** Заводит активную сессию `s-01` в новой работе и готовит каталог `events/`. */
async function activeSession(over: {
  launchedBy?: 'tui' | 'cli' | 'host';
  providerSessionId?: string | null;
  label?: string;
  createEventsDir?: boolean;
} = {}): Promise<{ workId: string; ref: SessionRef }> {
  const map = await createWork(project, { title: 'Работа' });
  let sessionId = '';
  await updateMap(project, map.work.id, (current) => {
    const created = addSession(current, {
      provider: 'claude',
      label: over.label ?? 'план',
      task: 'сделать',
    });
    sessionId = created.id;
    created.launchedBy = over.launchedBy ?? 'host';
    if (over.providerSessionId !== undefined) created.providerSessionId = over.providerSessionId;
    transitionSession(current, created.id, 'active');
  });

  if (over.createEventsDir !== false) {
    await mkdir(workPaths(project, map.work.id).events, { recursive: true });
  }

  return { workId: map.work.id, ref: { projectPath: project, workId: map.work.id, sessionId } };
}

function activityChanges(ref: SessionRef): Array<{ activity: string; metrics: unknown }> {
  return broadcasts
    .filter((entry) => entry.event === 'activity.changed')
    .map((entry) => entry.data as { ref: SessionRef; activity: { activity: string }; metrics: unknown })
    .filter((entry) => refKey(entry.ref) === refKey(ref))
    .map((entry) => ({ activity: entry.activity.activity, metrics: entry.metrics }));
}

describe('createActivityService', () => {
  it('1: UserPromptSubmit → working; Stop → unseen; markSeen → idle', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      hook('UserPromptSubmit'),
    );
    await settle();
    expect(a.get(ref)?.activity.activity).toBe('working');

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      hook('Stop'),
    );
    await settle();
    expect(a.get(ref)?.activity.activity).toBe('unseen');

    a.markSeen(ref);
    await settle(50);
    expect(a.get(ref)?.activity.activity).toBe('idle');
  }, 20_000);

  it('2: PermissionRequest → blocked; Notification elicitation_complete → working', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      `${hook('UserPromptSubmit')}${hook('PermissionRequest')}`,
    );
    await settle();
    expect(a.get(ref)?.activity.activity).toBe('blocked');

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      hook('Notification', { notification_type: 'elicitation_complete' }),
    );
    await settle();
    expect(a.get(ref)?.activity.activity).toBe('working');
  }, 20_000);

  it('3: без хуков тишина лога дольше порога → idle, таймер срабатывает один раз', async () => {
    const startedAt = new Date().toISOString();
    const { ref } = await activeSession({ providerSessionId: 's-log', createEventsDir: false });

    await mkdir(path.join(claudeRoot, '-proj'), { recursive: true });
    await writeFile(
      path.join(claudeRoot, '-proj', 's-log.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 's-log',
        timestamp: startedAt,
        message: { role: 'user', content: 'привет' },
      })}\n`,
    );

    // Порог с запасом: индекс логов строится в фоне (не блокирует `start()`,
    // иначе гигабайты настоящей истории задержали бы старт хоста) и под общей
    // сборкой пакетов подключается позже, чем в одиночном прогоне. Пока индекс
    // ещё пуст, о сессии вообще ничего не известно — это `idle` (4.1), а не
    // `working`, поэтому ждём именно страховку по логу (`source: 'log'`), а не
    // первое появление записи.
    const w = await works();
    const a = activity(w, { silenceThresholdMs: 6000 });
    await a.start();
    await waitFor(() => a.get(ref)?.activity.source === 'log', 15_000);
    expect(a.get(ref)?.activity.activity).toBe('working');

    // Порог тишины истёк — таймер сам поднял состояние, без нового опроса.
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen', 15_000);

    const changes = activityChanges(ref);
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[changes.length - 1]?.activity).toBe('unseen');
    // Ждём ещё: значение не колышется — второго срабатывания таймера не было.
    await settle(500);
    expect(activityChanges(ref)).toEqual(changes);
  }, 40_000);

  it('4: SubagentStart ×2 и SubagentStop ×1 того же id → subagents: 1', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      hook('UserPromptSubmit') +
        hook('SubagentStart', { agent_id: 'a1' }) +
        hook('SubagentStart', { agent_id: 'a2' }) +
        hook('SubagentStop', { agent_id: 'a1' }),
    );
    await settle();
    expect(a.get(ref)?.activity.subagents).toBe(1);
    expect(a.get(ref)?.metrics?.subagents).toBe(1);
  }, 20_000);

  it('5: unread считается по карте', async () => {
    const { ref, workId } = await activeSession();
    await updateMap(project, workId, (map) => {
      map.messages.push(
        { id: 'm1', roomId: null, from: 's-00', to: [ref.sessionId], at: new Date().toISOString(), text: 'привет', kind: 'note', readBy: {} },
        { id: 'm2', roomId: null, from: 's-00', to: [ref.sessionId], at: new Date().toISOString(), text: 'ещё', kind: 'note', readBy: {} },
        { id: 'm3', roomId: null, from: 's-00', to: [ref.sessionId], at: new Date().toISOString(), text: 'прочитано', kind: 'note', readBy: { [ref.sessionId]: new Date().toISOString() } },
      );
    });

    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    expect(a.get(ref)?.metrics?.unread).toBe(2);
  }, 20_000);

  it('6: автозаголовок применяется один раз, переименованную вручную не трогает', async () => {
    const { ref, workId } = await activeSession({ label: NEW_LABEL, providerSessionId: 's-title' });
    await mkdir(path.join(claudeRoot, '-proj'), { recursive: true });
    await writeFile(
      path.join(claudeRoot, '-proj', 's-title.jsonl'),
      `${JSON.stringify({ type: 'custom-title', customTitle: 'первый заголовок', sessionId: 's-title' })}\n`,
    );

    const w = await works();
    const a = activity(w);
    await a.start();
    // Индекс логов строится в фоне (не блокирует старт) — под общей сборкой
    // пакетов подключается заметно медленнее, чем в одиночном прогоне.
    await waitFor(
      () =>
        w.entry(project, workId)?.map.sessions.find((s) => s.id === ref.sessionId)?.label ===
        'первый заголовок',
      15_000,
    );

    const afterAuto = w.entry(project, workId)?.map.sessions.find((s) => s.id === ref.sessionId);
    expect(afterAuto?.label).toBe('первый заголовок');

    // Переименовали руками — метка больше не NEW_LABEL.
    await updateMap(project, workId, (map) => {
      const session = map.sessions.find((s) => s.id === ref.sessionId);
      if (session) session.label = 'своё имя';
    });

    // Заголовок в логе изменился — автозаголовок это уже не трогает. Ждём с
    // запасом сверх `watchSessions`'ного debounce (300мс по умолчанию в core):
    // если бы автозаголовок сработал повторно, за это время он бы успел.
    await appendFile(
      path.join(claudeRoot, '-proj', 's-title.jsonl'),
      `${JSON.stringify({ type: 'custom-title', customTitle: 'другой заголовок', sessionId: 's-title' })}\n`,
    );
    await settle(1500);

    const final = w.entry(project, workId)?.map.sessions.find((s) => s.id === ref.sessionId);
    expect(final?.label).toBe('своё имя');
  }, 40_000);

  it('6b: ярлык в прежней русской записи (карта сборки до перевода) тоже получает автозаголовок', async () => {
    const { ref, workId } = await activeSession({ label: 'новая сессия', providerSessionId: 's-legacy' });
    await mkdir(path.join(claudeRoot, '-proj'), { recursive: true });
    await writeFile(
      path.join(claudeRoot, '-proj', 's-legacy.jsonl'),
      `${JSON.stringify({ type: 'custom-title', customTitle: 'заголовок из лога', sessionId: 's-legacy' })}\n`,
    );

    const w = await works();
    await activity(w).start();
    await waitFor(
      () =>
        w.entry(project, workId)?.map.sessions.find((s) => s.id === ref.sessionId)?.label ===
        'заголовок из лога',
      15_000,
    );
  }, 40_000);

  it('7: hooks-missing приходит один раз для сессии хоста без журнала', async () => {
    await activeSession({ launchedBy: 'host', createEventsDir: false });
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle(200);

    const notices = broadcasts.filter(
      (entry) =>
        entry.event === 'host.notice' &&
        (entry.data as { kind: string }).kind === 'hooks-missing',
    );
    expect(notices).toHaveLength(1);
    expect((notices[0]?.data as { text: string }).text).toMatch(
      /^Claude Code hooks did not arrive for session s-\d+ — status comes from the log$/,
    );

    // Дальнейшие пересчёты (например, works.changed от другой работы) второго не дают.
    await createWork(project, { title: 'Толчок' });
    await settle(200);
    expect(
      broadcasts.filter(
        (entry) =>
          entry.event === 'host.notice' &&
          (entry.data as { kind: string }).kind === 'hooks-missing',
      ),
    ).toHaveLength(1);
  }, 20_000);

  it('7б: чужая сессия (не host) без журнала предупреждения не даёт', async () => {
    await activeSession({ launchedBy: 'tui', createEventsDir: false });
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle(200);

    expect(
      broadcasts.some(
        (entry) =>
          entry.event === 'host.notice' &&
          (entry.data as { kind: string }).kind === 'hooks-missing',
      ),
    ).toBe(false);
  }, 20_000);

  it('trust-wait (план, кусок 4.2): сессия в worktree без единого хука за trustWaitMs — уведомление', async () => {
    const { ref } = await activeSession({ createEventsDir: false });
    // Стаб без `STUB_HOOKS` — журнала не будет вовсе (как хуки Claude Code,
    // застрявшего на диалоге доверия к незнакомой папке, спека 8.2).
    await updateMap(project, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      session.worktree = {
        path: path.join(project, 'worktree'),
        branch: 'harnas/w-0001/s-01',
        base: 'main',
        createdAt: new Date().toISOString(),
      };
    });

    const w = await works();
    const a = activity(w, { trustWaitMs: 200 });
    await a.start();

    await waitFor(
      () =>
        broadcasts.some(
          (entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'trust-wait',
        ),
      5000,
    );

    const notice = broadcasts.find(
      (entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'trust-wait',
    );
    expect((notice?.data as { ref: SessionRef }).ref).toEqual(ref);
    expect((notice?.data as { text: string }).text).toMatch(
      /^S\d+ has not responded since launch — it may be waiting for folder trust$/,
    );
  }, 20_000);

  /** Сессия `ref` — в worktree: trust-wait ждут только такие (спека 8.2). */
  async function intoWorktree(ref: SessionRef): Promise<void> {
    await updateMap(project, ref.workId, (map) => {
      const session = map.sessions.find((candidate) => candidate.id === ref.sessionId);
      if (session === undefined) return;
      session.worktree = {
        path: path.join(project, 'worktree'),
        branch: 'harnas/w-0001/s-01',
        base: 'main',
        createdAt: new Date().toISOString(),
      };
    });
  }

  const trustWaitSent = (): boolean =>
    broadcasts.some(
      (entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'trust-wait',
    );

  // Раунд исправлений 1 куска 3.3 (ревью B, находка 2): каталог `events/` заводится при
  // старте сессии, и журнал без событий читается пустым массивом, а не `null`. Прежняя
  // проверка `!== null` считала пустой журнал «хук пришёл» — ⚠ не появлялся никогда.
  it('trust-wait: журнал есть, но пуст (каталог events/ уже заведён) — уведомление приходит', async () => {
    const { ref } = await activeSession();
    await intoWorktree(ref);
    const w = await works();
    const a = activity(w, { trustWaitMs: 200 });
    await a.start();

    await waitFor(trustWaitSent, 5000);
    const notice = broadcasts.find(
      (entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'trust-wait',
    );
    expect((notice?.data as { ref: SessionRef }).ref).toEqual(ref);
  }, 20_000);

  it('trust-wait: в журнале есть событие — уведомления нет', async () => {
    const { ref } = await activeSession();
    await intoWorktree(ref);
    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      hook('SessionStart'),
    );
    const w = await works();
    const a = activity(w, { trustWaitMs: 200 });
    await a.start();
    await settle(600);

    expect(trustWaitSent()).toBe(false);
  }, 20_000);

  it('trust-wait: сессия не в worktree — уведомления нет, даже без хуков', async () => {
    await activeSession({ createEventsDir: false });
    const w = await works();
    const a = activity(w, { trustWaitMs: 200 });
    await a.start();
    await settle(400);

    expect(
      broadcasts.some(
        (entry) => entry.event === 'host.notice' && (entry.data as { kind: string }).kind === 'trust-wait',
      ),
    ).toBe(false);
  }, 20_000);

  it('8: одинаковый повторный расчёт не даёт второго события', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      hook('UserPromptSubmit'),
    );
    await settle();
    const afterFirst = activityChanges(ref).length;
    expect(afterFirst).toBeGreaterThan(0);

    // Толчок works.changed без изменения активности самой сессии.
    await createWork(project, { title: 'Ещё одна' });
    await settle(200);

    expect(activityChanges(ref).length).toBe(afterFirst);
  }, 20_000);
  it('9: работа без events/ на старте — первая сессия после запуска видна по хукам', async () => {
    // `createWork` каталога журналов не заводит: наблюдатель на старте ставить
    // не на что, и без повтора хуки первой сессии не были бы видны никогда.
    const map = await createWork(project, { title: 'Новая' });
    const workId = map.work.id;
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    // Запуск сессии: сначала каталог (`writeWorkSettings`), потом запись карты.
    await mkdir(workPaths(project, workId).events, { recursive: true });
    let sessionId = '';
    await updateMap(project, workId, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 'сделать' });
      sessionId = created.id;
      created.launchedBy = 'host';
      transitionSession(current, created.id, 'active');
    });
    const ref: SessionRef = { projectPath: project, workId, sessionId };
    await waitFor(() => a.get(ref) !== undefined);
    await settle();

    await appendFile(
      path.join(workPaths(project, workId).events, `${sessionId}.jsonl`),
      hook('UserPromptSubmit'),
    );
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
  }, 20_000);

  it('13: current() отдаёт сессию после PermissionRequest с blocked', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`),
      `${hook('UserPromptSubmit')}${hook('PermissionRequest')}`,
    );
    await waitFor(() => a.get(ref)?.activity.activity === 'blocked');

    const current = a.current();
    expect(current).toHaveLength(1);
    expect(current[0]?.ref).toEqual(ref);
    expect(current[0]?.activity.activity).toBe('blocked');
    expect(current[0]?.metrics).toEqual(a.get(ref)?.metrics);
  }, 20_000);
});

describe('createActivityService: субагенты и ожидание (Parley 0.2.0)', () => {
  const journalOf = (ref: SessionRef): string =>
    path.join(workPaths(project, ref.workId).events, `${ref.sessionId}.jsonl`);
  /** Транскрипт родителя во временном корне Claude: рядом с ним (без `.jsonl`) лежат субагенты. */
  const transcript = (): string => path.join(claudeRoot, '-proj', 'sess.jsonl');
  const metaFile = (id: string): string =>
    path.join(claudeRoot, '-proj', 'sess', 'subagents', `agent-${id}.meta.json`);
  /** Задача в снимке `background_tasks` хука. */
  const running = (id: string, description: string | null = `задача ${id}`) => ({
    id,
    type: 'subagent',
    status: 'running',
    agent_type: 'general-purpose',
    ...(description === null ? {} : { description }),
  });

  it('Stop при работающей фоновой задаче — сессия working, а LiveMetrics.tasks несёт описание из снимка', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') +
        hook('SubagentStart', {
          agent_id: 'a1',
          agent_type: 'general-purpose',
          transcript_path: transcript(),
        }) +
        hook('Stop', { background_tasks: [running('a1', 'Orca mobile app research')] }),
    );
    await waitFor(() => a.get(ref)?.activity.subagents === 1);

    const live = a.get(ref);
    expect(live?.activity.activity).toBe('working');
    expect(live?.activity.turnEndedAt).toBeNull();
    const expected = [
      {
        id: 'a1',
        agentType: 'general-purpose',
        description: 'Orca mobile app research',
        background: true,
      },
    ];
    expect(live?.metrics?.tasks).toEqual(expected);
    expect(live?.metrics?.subagents).toBe(1);
    // То же самое получает окно событием.
    expect((activityChanges(ref).at(-1)?.metrics as LiveMetrics).tasks).toEqual(expected);

    // Задача закончилась, снимок опустел — ход окончен.
    await appendFile(
      journalOf(ref),
      hook('SubagentStop', { agent_id: 'a1', background_tasks: [] }),
    );
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');
    expect(a.get(ref)?.metrics?.tasks).toEqual([]);
  }, 20_000);

  it('описание — из meta.json субагента, когда снимок его не знает; файл появился позже — подхватывается', async () => {
    const { ref } = await activeSession();
    const w = await works();
    // Часы управляемые: после неудачного чтения повтор не раньше 10 с, и тест их перематывает.
    let clock = Date.now();
    const a = activity(w, { now: () => clock, silenceThresholdMs: 120_000 });
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') +
        hook('SubagentStart', { agent_id: 'a2', agent_type: '', transcript_path: transcript() }),
    );
    await waitFor(() => a.get(ref)?.activity.subagents === 1);
    // Файла ещё нет: описания нет, но и сбоя тоже.
    expect(a.get(ref)?.metrics?.tasks).toEqual([
      { id: 'a2', agentType: null, description: null, background: false },
    ]);

    await mkdir(path.dirname(metaFile('a2')), { recursive: true });
    await writeFile(
      metaFile('a2'),
      JSON.stringify({ agentType: 'claude-code-guide', description: 'Docs lookup' }),
    );
    // Прошло больше срока повтора, а следующее событие журнала — следующее обновление: файл перечитывается.
    clock += 10_001;
    await appendFile(journalOf(ref), hook('PreToolUse'));
    await waitFor(() => a.get(ref)?.metrics?.tasks?.[0]?.description === 'Docs lookup');
    expect(a.get(ref)?.metrics?.tasks).toEqual([
      { id: 'a2', agentType: 'claude-code-guide', description: 'Docs lookup', background: false },
    ]);

    // Кэш по id: прочитанное не теряется, пока задача жива, — файл больше не читается.
    await rm(metaFile('a2'));
    await appendFile(journalOf(ref), hook('PreToolUse'));
    await settle(300);
    expect(a.get(ref)?.metrics?.tasks?.[0]?.description).toBe('Docs lookup');
  }, 20_000);

  it('описание из снимка файла не требует: meta.json не читается — чтение наблюдаемо', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const reads: string[] = [];
    const a = activity(w, {
      // Читатель-счётчик: что запрошено, то и считано; файл он подменяет другим описанием.
      readSubagentMeta: async (_transcriptPath, id) => {
        reads.push(id);
        return { agentType: null, description: 'из файла' };
      },
    });
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') +
        hook('SubagentStart', { agent_id: 'a3', transcript_path: transcript() }) +
        hook('Stop', { background_tasks: [running('a3', 'из снимка')] }),
    );
    await waitFor(() => a.get(ref)?.activity.subagents === 1);
    await settle(200);

    expect(reads).toEqual([]);
    expect(a.get(ref)?.metrics?.tasks?.[0]?.description).toBe('из снимка');

    // Контроль прибора: субагент без описания в снимке читателя зовёт, и описание берётся из файла.
    await appendFile(
      journalOf(ref),
      hook('SubagentStart', { agent_id: 'b3', transcript_path: transcript() }) +
        hook('Notification', {
          background_tasks: [running('a3', 'из снимка'), running('b3', null)],
        }),
    );
    await waitFor(() => reads.length > 0);
    expect(reads).toEqual(['b3']);
    await waitFor(() => a.get(ref)?.metrics?.tasks?.[1]?.description === 'из файла');
  }, 20_000);

  it('неудачное чтение запоминается: повтор не чаще раза в 10 с, а не на каждом пересчёте', async () => {
    const { ref } = await activeSession();
    const w = await works();
    let clock = Date.now();
    const reads: number[] = [];
    let result: SubagentMeta | null = null;
    const a = activity(w, {
      now: () => clock,
      silenceThresholdMs: 120_000,
      readSubagentMeta: async () => {
        reads.push(clock);
        return result;
      },
    });
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') +
        hook('SubagentStart', { agent_id: 'a4', transcript_path: transcript() }),
    );
    await waitFor(() => reads.length === 1);

    // Пересчёты идут своим чередом (события журнала), а файла всё нет: читать заново рано.
    for (let count = 0; count < 3; count += 1) {
      await appendFile(journalOf(ref), hook('PreToolUse'));
      await settle(150);
    }
    expect(reads).toHaveLength(1);

    // Срок прошёл — одна новая попытка, а за ней снова пауза.
    clock += 10_000;
    await appendFile(journalOf(ref), hook('PreToolUse'));
    await waitFor(() => reads.length === 2);
    await appendFile(journalOf(ref), hook('PreToolUse'));
    await settle(150);
    expect(reads).toHaveLength(2);

    // Файл появился: следующая попытка берёт его, и больше о нём не спрашивают.
    result = { agentType: 'explorer', description: 'Docs lookup' };
    clock += 10_000;
    await appendFile(journalOf(ref), hook('PreToolUse'));
    await waitFor(() => a.get(ref)?.metrics?.tasks?.[0]?.description === 'Docs lookup');
    const total = reads.length;
    await appendFile(journalOf(ref), hook('PreToolUse'));
    await settle(150);
    expect(reads).toHaveLength(total);
  }, 30_000);

  it('ParleyWaitStart и ParleyWaitEnd: LiveMetrics.waitingFor', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(journalOf(ref), hook('UserPromptSubmit'));
    await waitFor(() => a.get(ref)?.activity.activity === 'working');
    expect(a.get(ref)?.metrics?.waitingFor).toBeNull();
    expect(a.get(ref)?.metrics?.tasks).toEqual([]);

    await appendFile(journalOf(ref), hook('ParleyWaitStart', { parley_wait_target: 's-02' }));
    await waitFor(() => a.get(ref)?.metrics?.waitingFor === 's-02');
    expect(a.get(ref)?.activity.waitingFor).toBe('s-02');
    expect(a.get(ref)?.activity.activity).toBe('working');

    await appendFile(journalOf(ref), hook('ParleyWaitEnd'));
    await waitFor(() => a.get(ref)?.metrics?.waitingFor === null);
  }, 20_000);

  it('просмотрел сессию, пока лид ждал фоновых, — когда они закончились, она снова unseen', async () => {
    const { ref } = await activeSession();
    const w = await works();
    const a = activity(w);
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') + hook('Stop', { background_tasks: [running('a1')] }),
    );
    await waitFor(() => a.get(ref)?.activity.heldByBackground === true);

    // Человек открыл сессию, пока лид ждал: просмотр позже Stop.
    await settle(50);
    a.markSeen(ref);
    await settle(50);
    expect(a.get(ref)?.activity.activity).toBe('working');

    // Последний фоновый закончился: ход окончен позже просмотра — человека ждёт новое, а не idle.
    await appendFile(
      journalOf(ref),
      hook('SubagentStop', { agent_id: 'a1', background_tasks: [] }),
    );
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen');
  }, 20_000);

  it('предел удержания снимает сессию сам, без нового события: таймер ждёт предела, а не порога тишины', async () => {
    const { ref } = await activeSession();
    const w = await works();
    // Порог тишины короткий, предел удержания чуть длиннее: за порогом сессию держит фоновая задача.
    const a = activity(w, { silenceThresholdMs: 300, backgroundHoldMs: 1500 });
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') + hook('Stop', { background_tasks: [running('a1')] }),
    );
    await waitFor(() => a.get(ref)?.activity.heldByBackground === true);
    await settle(600);
    // Порог тишины прошёл: сессию держит фоновая задача.
    expect(a.get(ref)?.activity.activity).toBe('working');

    // Событий больше нет — предел удержания снимет её сам.
    await waitFor(() => a.get(ref)?.activity.activity === 'unseen', 5000);
    expect(a.get(ref)?.activity.heldByBackground).toBe(false);
    expect(a.get(ref)?.activity.tasks).toEqual([]);
    expect(a.get(ref)?.metrics?.tasks).toEqual([]);
  }, 20_000);

  it('порог тишины давно прошёл, а сессию держит фоновая задача: таймер тишины не крутится вхолостую', async () => {
    const { ref } = await activeSession();
    let calls = 0;
    const later = Date.now() + 10 * 60_000;
    const w = await works();
    const a = activity(w, {
      now: () => {
        calls += 1;
        return later;
      },
    });
    await a.start();
    await settle();

    await appendFile(
      journalOf(ref),
      hook('UserPromptSubmit') + hook('Stop', { background_tasks: [running('a1')] }),
    );
    await waitFor(() => a.get(ref)?.activity.activity === 'working');

    const before = calls;
    await settle(500);
    // Без защиты таймер с нулевой задержкой пересчитывал бы сессию сотни раз за полсекунды.
    expect(calls - before).toBeLessThan(50);
    expect(a.get(ref)?.activity.activity).toBe('working');
  }, 20_000);
});
