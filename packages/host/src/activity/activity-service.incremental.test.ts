import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createWindowCounters, type WindowCounters } from '../health/window-counters.js';
import type { WorksService, WorksView } from '../works/works-service.js';
import type { ActivityService } from './activity-service.js';

/**
 * Проход списка работ пересчитывает только сессии с изменившимся входом (`changedSessions`). Здесь — настоящие служба
 * работ и база в `PARLEY_HOME`; `watchEvents` обёрнут и записывает открытые и закрытые каталоги журналов.
 */
const opened: string[] = [];
const closed: string[] = [];

vi.mock('@parley/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@parley/core')>();
  return {
    ...core,
    watchEvents: (...args: Parameters<typeof core.watchEvents>) => {
      const dir = args[0];
      opened.push(dir);
      const watcher = core.watchEvents(...args);
      return {
        close: () => {
          closed.push(dir);
          watcher.close();
        },
      };
    },
  };
});

const {
  HUMAN,
  addMember,
  addRoom,
  addSession,
  removeSession,
  resolveProposal,
  setProposal,
  setRoomMode,
  setWorkStatus,
  transitionSession,
  unreadLetters,
  updateMap,
  workPaths,
  writeLetters,
  createWork,
} = await import('@parley/core');
const { createWorksService } = await import('../works/works-service.js');
const { createActivityService } = await import('./activity-service.js');

let home = '';
let project = '';
let claudeRoot = '';
let codexRoot = '';
let services: Array<{ stop: () => Promise<void> }> = [];

/** Часы службы: далеко после любых записей теста, чтобы результат не зависел от времени прогона. */
const NOW = Date.parse('2031-01-01T00:00:00.000Z');

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
    hold: () => {},
  };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
  process.env['PARLEY_HOME'] = home;
  opened.length = 0;
  closed.length = 0;
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env['PARLEY_HOME'];
  await Promise.all(
    [home, project, claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('не дождались условия');
    await sleep(25);
  }
};

/** Тишина: счётчик пересчётов не менялся `ms` — фоновые чтения журналов и первый список индекса логов закончились. */
async function quiet(counters: WindowCounters, ms = 400): Promise<number> {
  const started = Date.now();
  let last = counters.read().recomputes;
  let since = Date.now();
  while (Date.now() - since < ms) {
    if (Date.now() - started > 20_000) throw new Error('пересчёты не затихли');
    await sleep(25);
    const current = counters.read().recomputes;
    if (current !== last) {
      last = current;
      since = Date.now();
    }
  }
  return last;
}

const hook = (name: string): string => `${JSON.stringify({ hook_event_name: name })}\n`;
/** Завершённый ход: активность не `working`, таймеров тишины нет. */
const TURN = hook('SessionStart') + hook('UserPromptSubmit') + hook('Stop');

type Lifecycle = 'active' | 'sleeping' | 'closed';

/** Работа с сессиями `s-01…` по списку жизненных циклов; у активных — каталог `events/` и журнал завершённого хода. */
async function makeWork(title: string, lifecycles: Lifecycle[]): Promise<string> {
  const created = await createWork(project, { title });
  const workId = created.work.id;
  await updateMap(project, workId, (map) => {
    lifecycles.forEach((lifecycle, index) => {
      const session = addSession(map, { provider: 'claude', label: `сессия ${index + 1}`, task: 'сделать' });
      session.launchedBy = 'tui';
      session.providerSessionId = `log-${workId}-${index + 1}`;
      transitionSession(map, session.id, 'active');
      if (lifecycle !== 'active') transitionSession(map, session.id, lifecycle);
    });
  });
  const events = workPaths(project, workId).events;
  await mkdir(events, { recursive: true });
  const sessions = lifecycles.flatMap((lifecycle, index) => (lifecycle === 'active' ? [`s-0${index + 1}`] : []));
  for (const sessionId of sessions) await writeFile(path.join(events, `${sessionId}.jsonl`), TURN);
  return workId;
}

const refOf = (workId: string, sessionId: string): SessionRef => ({ projectPath: project, workId, sessionId });

async function startWorks(): Promise<WorksService> {
  const service = createWorksService(fakeHost());
  services.push(service);
  await service.start();
  return service;
}

function startActivity(worksService: WorksService, counters: WindowCounters): ActivityService {
  const service = createActivityService(fakeHost(), worksService, {
    silenceThresholdMs: 30_000,
    claudeRoot,
    codexRoot,
    windowCounters: counters,
    now: () => NOW,
  });
  services.push(service);
  return service;
}

/** Служба работ, которая отдаёт записи без `version` и `incarnation`: карту приходится сверять по отпечаткам. */
function withoutVersions(real: WorksService): WorksService {
  const strip = (view: WorksView): WorksView => ({
    ...view,
    entries: view.entries.map((entry) => {
      const copy = { ...entry };
      delete copy.version;
      delete copy.incarnation;
      return copy;
    }),
  });
  return {
    ...real,
    snapshot: () => strip(real.snapshot()),
    onChange: (listener) => real.onChange((snapshot, previous) => listener(strip(snapshot), strip(previous))),
  };
}

const sessionOf = (worksService: WorksService, workId: string, sessionId: string) =>
  worksService.entry(project, workId)?.map.sessions.find((session) => session.id === sessionId);

describe('проход списка работ пересчитывает только изменившееся', () => {
  async function rig(wrap: (real: WorksService) => WorksService = (real) => real) {
    const a = await makeWork('Работа A', ['active', 'active', 'sleeping', 'sleeping', 'closed', 'closed']);
    const b = await makeWork('Работа B', ['closed', 'closed', 'closed']);
    await setWorkStatus(project, b, 'archived');
    const real = await startWorks();
    const counters = createWindowCounters();
    const service = startActivity(wrap(real), counters);
    await service.start();
    await waitFor(() => service.current().length === 9);
    await quiet(counters);
    return { a, b, real, counters, service };
  }

  it('правка одной сессии пересчитывает только её', async () => {
    const { a, real, counters } = await rig();
    const base = counters.read().recomputes;

    await updateMap(project, a, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.label = 'другое имя';
    });
    await waitFor(() => sessionOf(real, a, 's-02')?.label === 'другое имя');
    const total = (await quiet(counters)) - base;

    // Пересчёт сразу; журнал после него не менялся, второго пересчёта нет. Раньше — по два на каждую из девяти сессий.
    expect(total).toBeGreaterThanOrEqual(1);
    expect(total).toBeLessThanOrEqual(2);
  }, 60_000);

  it('то же при чтении без точной версии', async () => {
    const { a, real, counters } = await rig(withoutVersions);
    const base = counters.read().recomputes;

    await updateMap(project, a, (map) => {
      map.sessions.find((session) => session.id === 's-02')!.label = 'другое имя';
    });
    await waitFor(() => sessionOf(real, a, 's-02')?.label === 'другое имя');
    const total = (await quiet(counters)) - base;

    expect(total).toBeGreaterThanOrEqual(1);
    expect(total).toBeLessThanOrEqual(2);
  }, 60_000);

  it('письмо пересчитывает только адресата', async () => {
    const { a, counters, service } = await rig();
    const base = counters.read().recomputes;

    await updateMap(project, a, (map, letters) => {
      letters.add({ roomId: null, from: 's-01', to: ['s-02'], text: 'привет', kind: 'note' });
      map.sessions.find((session) => session.id === 's-02')!.label = 'письмо пришло';
    });
    await waitFor(() => service.get(refOf(a, 's-02'))?.metrics?.unread === 1);
    const withMap = (await quiet(counters)) - base;
    expect(withMap).toBeLessThanOrEqual(3);

    const mid = counters.read().recomputes;
    writeLetters(project, a, (letters) => {
      letters.add({ roomId: null, from: 's-01', to: ['s-04'], text: 'спящему', kind: 'note' });
    });
    await waitFor(() => service.get(refOf(a, 's-04'))?.metrics?.unread === 1);
    const lettersOnly = (await quiet(counters)) - mid;
    expect(lettersOnly).toBeGreaterThanOrEqual(1);
    expect(lettersOnly).toBeLessThanOrEqual(2);
  }, 60_000);

  it('смена комнат работы пересчитывает все её сессии и только их', async () => {
    const { a, real, counters } = await rig();
    const base = counters.read().recomputes;

    await updateMap(project, a, (map) => {
      addRoom(map, { title: 'Комната', creator: HUMAN, members: ['s-01', 's-02'] });
    });
    await waitFor(() => real.entry(project, a)?.map.rooms.length === 1);
    const total = (await quiet(counters)) - base;

    // Шесть сессий работы A; архивная работа B не задета.
    expect(total).toBeGreaterThanOrEqual(6);
    expect(total).toBeLessThanOrEqual(7);
  }, 60_000);

  it('наблюдатель журналов только у неархивной работы с активной сессией', async () => {
    const a = await makeWork('Работа A', ['active', 'sleeping']);
    const b = await makeWork('Работа B', ['closed']);
    await setWorkStatus(project, b, 'archived');
    const c = await makeWork('Работа C', ['sleeping']);
    const real = await startWorks();
    const counters = createWindowCounters();
    const service = startActivity(real, counters);
    await service.start();
    await quiet(counters);

    expect(opened).toEqual([workPaths(project, a).events]);

    // Спящая сессия стала активной — у её работы появился наблюдатель.
    await updateMap(project, c, (map) => {
      transitionSession(map, 's-01', 'active');
    });
    await waitFor(() => opened.includes(workPaths(project, c).events));

    // Работа ушла в архив — наблюдатель закрыт.
    await setWorkStatus(project, a, 'archived');
    await waitFor(() => closed.includes(workPaths(project, a).events));
    expect(opened.filter((dir) => dir === workPaths(project, a).events)).toHaveLength(1);
  }, 60_000);

  /**
   * Равенство полному пересчёту: после каждого изменения карты, писем или журнала результат работающей службы совпадает с
   * результатом второй службы, которая поднялась только что и посчитала всё с нуля. Времена границ хода берутся из mtime
   * файла на момент чтения журнала (поздно прочитанный кусок и целый журнал дают разное), поэтому они не сравниваются.
   */
  it('совпадение с полным пересчётом', async () => {
    const a = await makeWork('Работа A', ['active', 'active', 'sleeping', 'sleeping', 'closed', 'closed']);
    const b = await makeWork('Работа B', ['closed', 'closed']);
    const real = await startWorks();
    const counters = createWindowCounters();
    const service = startActivity(real, counters);
    await service.start();
    const total = (): number => real.snapshot().entries.reduce((sum, entry) => sum + entry.map.sessions.length, 0);
    await waitFor(() => service.current().length === total());
    await quiet(counters);

    const serialise = (value: ReturnType<ActivityService['current']>): string =>
      JSON.stringify(value, (key, item: unknown) =>
        key === 'turnEndedAt' || key === 'turnBoundaryAt' || key === 'lastEventAt' ? null : item,
      );

    async function fromScratch(): Promise<string> {
      const fullCounters = createWindowCounters();
      const full = startActivity(real, fullCounters);
      await full.start();
      await waitFor(() => full.current().length === total());
      await quiet(fullCounters);
      const result = serialise(full.current());
      await full.stop();
      return result;
    }

    async function step(name: string, run: () => Promise<unknown>, visible: () => boolean): Promise<void> {
      await run();
      await waitFor(visible);
      await quiet(counters);
      expect(serialise(service.current()), name).toBe(await fromScratch());
    }

    const room = (): ReturnType<typeof real.entry> => real.entry(project, a);
    const unreadOf = (sessionId: string): number | undefined => service.get(refOf(a, sessionId))?.metrics?.unread;
    const draft = {
      mode: 'checklist' as const,
      goal: 'Цель',
      items: [
        { id: 1, title: 'Сделать', owner: 's-02', scope: 'src/a.ts' },
        { id: 2, title: 'Собрать', owner: 's-01', scope: 'src/b.ts', after: [1] },
      ],
    };

    await step(
      'правка своей записи',
      () =>
        updateMap(project, a, (map) => {
          map.sessions.find((session) => session.id === 's-02')!.label = 'другое имя';
        }),
      () => sessionOf(real, a, 's-02')?.label === 'другое имя',
    );

    const before = JSON.stringify(service.get(refOf(a, 's-01'))?.activity);
    await sleep(30);
    await step(
      'строка в журнал активной сессии',
      () => appendFile(path.join(workPaths(project, a).events, 's-01.jsonl'), hook('UserPromptSubmit') + hook('Stop')),
      () => JSON.stringify(service.get(refOf(a, 's-01'))?.activity) !== before,
    );

    await step(
      'новая комната',
      () =>
        updateMap(project, a, (map) => {
          addRoom(map, { title: 'Комната', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01', mode: 'checklist' });
        }),
      () => room()?.map.rooms.length === 1,
    );

    await step(
      'письмо в комнату',
      async () => {
        writeLetters(project, a, (letters) => {
          letters.add({ roomId: 'r-01', from: 's-01', to: [], text: 'всем', kind: 'note' });
        });
      },
      () => unreadOf('s-02') === 1,
    );

    await step(
      'принятый план',
      () =>
        updateMap(project, a, (map, letters) => {
          const proposal = setProposal(map, 'r-01', 's-01', 'Решение', undefined, { plan: draft });
          const plan = map.rooms[0]!.proposal!.plan!;
          resolveProposal(
            map,
            letters,
            'r-01',
            proposal.proposalId,
            'accept',
            { rev: proposal.rev, planId: plan.id, planRev: plan.rev },
          );
        }),
      () => (room()?.map.plans?.length ?? 0) === 1,
    );

    await step(
      'новый участник комнаты',
      () =>
        updateMap(project, a, (map, letters) => {
          addMember(map, letters, 'r-01', 's-03');
        }),
      () => (unreadOf('s-03') ?? 0) >= 1,
    );

    await step(
      'отметка прочтения',
      () => {
        const ids = unreadLetters(project, a, 's-03').map((message) => message.id);
        return updateMap(project, a, (_map, letters) => {
          letters.markRead('s-03', ids, new Date().toISOString());
        });
      },
      () => unreadOf('s-03') === 0,
    );

    await step(
      'закрытие сессии',
      () =>
        updateMap(project, a, (map) => {
          transitionSession(map, 's-02', 'closed');
        }),
      () => sessionOf(real, a, 's-02')?.lifecycle === 'closed',
    );

    await step(
      'удаление закрытой сессии',
      () =>
        updateMap(project, a, (map, letters) => {
          removeSession(map, letters, 's-05');
        }),
      () => sessionOf(real, a, 's-05') === undefined,
    );

    await step(
      'смена названия работы',
      () =>
        updateMap(project, a, (map) => {
          map.work.title = 'Новое название';
        }),
      () => room()?.map.work.title === 'Новое название',
    );

    await step(
      'новая сессия',
      () =>
        updateMap(project, a, (map) => {
          const session = addSession(map, { provider: 'claude', label: 'новая', task: 'сделать' });
          session.launchedBy = 'tui';
          session.providerSessionId = 'log-new';
          transitionSession(map, session.id, 'active');
        }),
      () => service.get(refOf(a, 's-07')) !== undefined,
    );

    await step(
      'сброс режима комнаты отменяет план',
      () =>
        updateMap(project, a, (map, letters) => {
          setRoomMode(map, letters, 'r-01', HUMAN, 'free', 'сброс', { confirmCancel: true });
        }),
      () => room()?.map.rooms[0]?.mode === 'free',
    );

    await step(
      'архив другой работы',
      () => setWorkStatus(project, b, 'archived'),
      () => real.entry(project, b)?.map.work.status === 'archived',
    );
  }, 180_000);
});
