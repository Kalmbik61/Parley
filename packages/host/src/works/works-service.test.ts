import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addMessage,
  addSession,
  compactWorkMap,
  createWork,
  deleteWorkFiles,
  MapLockTimeoutError,
  readMap,
  readStoredMap,
  replaceStoredMap,
  transitionSession,
  updateMap,
  workPaths,
  workVersion,
} from '@parley/core';
import type { Room, WorkMap } from '@parley/core';
import type { EventData, EventName } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createWindowCounters } from '../health/window-counters.js';
import { createWorksService } from './works-service.js';
import type { WorksService } from './works-service.js';

// `readMap` обёрнут шпионом, который по умолчанию зовёт настоящий: тесты битой карты считают его вызовы и подсовывают отказ
// занятой базы, которого на живой WAL-базе не вызвать. Так же обёрнут `compactWorkMap`: тесты снимка окна считают, какие
// работы он пересобрал.
vi.mock('@parley/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/core')>();
  return { ...actual, readMap: vi.fn(actual.readMap), compactWorkMap: vi.fn(actual.compactWorkMap) };
});

/** Второе соединение с базой дома: держит запись и читает размеры, как это делает чужой процесс (CLI, MCP агента без канала). */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

let home = '';
let projectA = '';
let projectB = '';
let broadcasts: Array<{ event: EventName; data: unknown }>;
let services: WorksService[] = [];

/** Минимальный `HostContext` для сервиса: ему нужны только `log` и `broadcast`. */
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
  projectA = await mkdtemp(path.join(tmpdir(), 'parley-project-a-'));
  projectB = await mkdtemp(path.join(tmpdir(), 'parley-project-b-'));
  process.env.PARLEY_HOME = home;
  broadcasts = [];
});

afterEach(async () => {
  await Promise.all(services.map((service) => service.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, projectA, projectB].map((dir) => rm(dir, { recursive: true, force: true })));
});

function service(options: Parameters<typeof createWorksService>[1] = {}): WorksService {
  const created = createWorksService(fakeHost(), options);
  services.push(created);
  return created;
}

/** Сколько байт текста лежит в строках работы: то, что хост разбирает при чтении, — и считает счётчик окна. */
function rowBytes(projectPath: string, workId: string): number {
  const db = new DatabaseSync(path.join(home, 'parley.db'));
  try {
    const row = db
      .prepare(
        `SELECT length(CAST(work_json AS BLOB)) + length(CAST(extra_json AS BLOB)) + COALESCE(
           (SELECT SUM(length(CAST(json AS BLOB))) FROM entries WHERE project_path = works.project_path AND work_id = works.id), 0
         ) AS n FROM works WHERE project_path = ? AND id = ?`,
      )
      .get(projectPath, workId) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

const exists = async (file: string): Promise<boolean> => {
  try {
    await readFile(file, 'utf8');
    return true;
  } catch {
    return false;
  }
};

describe('источники', () => {
  it('две работы в двух проектах из индекса попадают в один снимок', async () => {
    const a = await createWork(projectA, { title: 'Работа A' });
    const b = await createWork(projectB, { title: 'Работа B' });

    const s = service();
    await s.start();

    const ids = s.snapshot().entries.map((entry) => `${entry.projectPath}:${entry.map.work.id}`);
    expect(ids.sort()).toEqual([`${projectA}:${a.work.id}`, `${projectB}:${b.work.id}`].sort());
  });

  // Ожидание по условию, а не фиксированные 100 мс: запись видна по событию хранилища и по опросу базы (раз в 500 мс),
  // и под нагрузкой это не укладывалось в фиксированное окно. Дебаунс проверяется числом рассылок: запись работы и её
  // строк склеивается в одну. Дебаунс — с запасом на разброс между событиями под нагрузкой (при 50 мс запоздавшее
  // событие той же записи могло дать вторую рассылку), ожидание появления — тоже с запасом: это верхняя граница, а не пауза.
  it('новая работа появляется одной рассылкой works.changed', async () => {
    const debounceMs = 250;
    const s = service({ debounceMs });
    await s.start();
    expect(s.snapshot().entries).toHaveLength(0);
    const changes = (): number => broadcasts.filter((item) => item.event === 'works.changed').length;
    const before = changes();

    const work = await createWork(projectA, { title: 'Свежая' });

    await vi.waitFor(
      () => expect(s.snapshot().entries.map((entry) => entry.map.work.id)).toContain(work.work.id),
      { timeout: 10_000, interval: 5 },
    );
    // Ещё несколько окон дебаунса: запоздавшая вторая рассылка успела бы прийти.
    await new Promise((resolve) => setTimeout(resolve, debounceMs * 3));
    expect(changes() - before).toBe(1);
  }, 20_000);

  it('новый проект в индексе подхватывается', async () => {
    const s = service({ debounceMs: 50 });
    await s.start();

    const brandNewProject = await mkdtemp(path.join(tmpdir(), 'parley-project-new-'));
    try {
      const work = await createWork(brandNewProject, { title: 'Новый проект' });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const entry = s.entry(brandNewProject, work.work.id);
      expect(entry?.map.work.title).toBe('Новый проект');
    } finally {
      await rm(brandNewProject, { recursive: true, force: true });
    }
  });
});

describe('счётчики окна', () => {
  it('start читает N карт один раз: байты равны сумме размеров строк карт в базе, refresh считан один раз', async () => {
    const first = await createWork(projectA, { title: 'Первая' });
    const second = await createWork(projectA, { title: 'Вторая с чуть более длинным названием' });
    const windowCounters = createWindowCounters();

    const s = service({ windowCounters });
    await s.start();

    // Карт-файлов больше нет: счётчик считает байты строк базы, из которых собраны карты.
    const sizes = [first, second].map((map) => rowBytes(projectA, map.work.id));
    const tally = windowCounters.read();
    expect(tally.mapBytesParsed).toBe(sizes[0]! + sizes[1]!);
    // Число проходов не фиксируем: пока идёт start, наблюдатель может прислать своё событие и добавить ещё один refresh.
    expect(tally.refreshCount).toBeGreaterThanOrEqual(1);
    expect(tally.refreshMs).toBeGreaterThanOrEqual(0);
  });

  it('карта, пришедшая через наблюдатель, добавляет свои байты к mapBytesParsed', async () => {
    const windowCounters = createWindowCounters();
    const s = service({ debounceMs: 50, windowCounters });
    await s.start();
    const afterStart = windowCounters.read().mapBytesParsed;

    const work = await createWork(projectA, { title: 'Через наблюдатель' });
    await vi.waitFor(
      () => expect(s.snapshot().entries.map((entry) => entry.map.work.id)).toContain(work.work.id),
      { timeout: 10_000, interval: 5 },
    );

    const size = rowBytes(projectA, work.work.id);
    // Наблюдатель мог прочитать список не раз, поэтому не меньше размера, а не равенство.
    expect(windowCounters.read().mapBytesParsed - afterStart).toBeGreaterThanOrEqual(size);
  }, 20_000);

  it('проход refresh, упавший в слушателе, всё равно считается', async () => {
    const windowCounters = createWindowCounters();
    const s = service({ windowCounters });
    s.onChange(() => {
      throw new Error('сбой слушателя');
    });

    await expect(s.start()).rejects.toThrow('сбой слушателя');

    expect(windowCounters.read().refreshCount).toBeGreaterThanOrEqual(1);
  });
});

describe('живость', () => {
  it('карта с active-сессией мёртвого pid после старта становится sleeping', async () => {
    const map = await createWork(projectA, { title: 'Работа' });
    await updateMap(projectA, map.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      created.launchedBy = 'tui';
      created.pid = 999_999;
      transitionSession(current, created.id, 'active');
    });

    const s = service();
    await s.start();

    const entry = s.entry(projectA, map.work.id);
    expect(entry?.map.sessions[0]?.lifecycle).toBe('sleeping');
  });
});

describe('аренда', () => {
  it('файлы есть у всех работ после старта и исчезают после stop', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const b = await createWork(projectB, { title: 'B' });

    const s = service();
    await s.start();

    expect(await exists(path.join(workPaths(projectA, a.work.id).dir, 'host.lease'))).toBe(true);
    expect(await exists(path.join(workPaths(projectB, b.work.id).dir, 'host.lease'))).toBe(true);

    await s.stop();
    services = services.filter((candidate) => candidate !== s);

    expect(await exists(path.join(workPaths(projectA, a.work.id).dir, 'host.lease'))).toBe(false);
    expect(await exists(path.join(workPaths(projectB, b.work.id).dir, 'host.lease'))).toBe(false);
  });

  it('хост не пишет ничего вне .parley/works/<id>/ и своего каталога', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const s = service();
    await s.start();

    // Карта лежит в базе, а не в каталоге работы: в нём остаются только каталоги и аренда хоста.
    expect((await readdir(workPaths(projectA, a.work.id).dir)).sort()).toEqual(
      ['artifacts', 'briefs', 'host.lease'].sort(),
    );
  });
});

describe('лок', () => {
  it('занятая база уходит host.notice(map-lock) и не роняет сервис; на следующем изменении проходит', async () => {
    const map = await createWork(projectA, { title: 'Работа' });
    await updateMap(projectA, map.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      created.launchedBy = 'tui';
      created.pid = 999_999;
      transitionSession(current, created.id, 'active');
    });
    const other = new DatabaseSync(path.join(home, 'parley.db'));
    other.exec('BEGIN IMMEDIATE');

    try {
      const s = service({ lockTimeoutMs: 50, debounceMs: 50 });
      await s.start();

      expect(broadcasts.some((b) => b.event === 'host.notice')).toBe(true);
      expect(s.entry(projectA, map.work.id)?.map.sessions[0]?.lifecycle).toBe('active');

      other.exec('ROLLBACK');
      broadcasts = [];
      // Любое дальнейшее изменение запускает следующий цикл.
      await createWork(projectB, { title: 'Толчок' });
      await vi.waitFor(
        () => expect(s.entry(projectA, map.work.id)?.map.sessions[0]?.lifecycle).toBe('sleeping'),
        { timeout: 3000, interval: 25 },
      );
    } finally {
      other.close();
    }
  });
});

/** Комната, которую `normalizeMap` не примет: неизвестный режим — работа остаётся в базе, но не загружается. */
const bogusRoom = (): Room =>
  ({
    id: 'r-01',
    title: 'бэкенд',
    creator: 'human',
    ownerId: null,
    members: [],
    createdAt: '2026-10-24T00:00:00.000Z',
    lead: null,
    proposal: null,
    archivedAt: null,
    mode: 'bogus',
  }) as unknown as Room;

describe('битая карта', () => {
  it('работа, которую normalizeMap не принимает, даёт один host.notice(map-corrupt) и не переписывается', async () => {
    const map = await createWork(projectA, { title: 'Работа' });
    const stored = readStoredMap(projectA, map.work.id);
    stored.rooms.push(bogusRoom());
    replaceStoredMap(projectA, map.work.id, stored);
    const versionBefore = workVersion(projectA, map.work.id);

    const s = service({ debounceMs: 50 });
    await s.start();

    const notices = broadcasts.filter((b) => b.event === 'host.notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.data).toMatchObject({ kind: 'map-corrupt' });
    expect((notices[0]?.data as { text: string }).text).toContain(map.work.id);
    // Строки базы хост не трогает: любая его запись подняла бы версию работы.
    expect(workVersion(projectA, map.work.id)).toBe(versionBefore);
    expect(s.entry(projectA, map.work.id)).toBeUndefined();

    // Второй цикл — работа всё ещё битая, но повторного уведомления нет.
    await createWork(projectB, { title: 'Толчок' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(broadcasts.filter((b) => b.event === 'host.notice')).toHaveLength(1);
  });

  const corruptNotices = (): number =>
    broadcasts.filter((b) => b.event === 'host.notice' && (b.data as { kind: string }).kind === 'map-corrupt').length;

  /** Работа проекта A с комнатой, которую `normalizeMap` не принимает, и её же исправная карта. */
  async function brokenWork(): Promise<{ id: string; good: WorkMap; broken: WorkMap }> {
    const created = await createWork(projectA, { title: 'Работа' });
    const good = readStoredMap(projectA, created.work.id);
    const broken = structuredClone(good);
    broken.rooms.push(bogusRoom());
    replaceStoredMap(projectA, created.work.id, broken);
    return { id: created.work.id, good, broken };
  }

  /** Ждёт, пока сервис закончит ещё один проход обновления (номер снимка растёт после проверки битых работ). */
  async function nextPass(s: WorksService, trigger: () => unknown): Promise<void> {
    const before = s.windowSnapshot()?.revision ?? 0;
    await trigger();
    await vi.waitFor(() => expect(s.windowSnapshot()?.revision ?? 0).toBeGreaterThan(before), { timeout: 3000, interval: 10 });
  }

  it('занятая база — не повреждение: уведомления нет, а на следующем проходе битая работа названа', async () => {
    await brokenWork();
    vi.mocked(readMap).mockImplementationOnce(async () => {
      throw new MapLockTimeoutError('parley.db', 5000);
    });

    const s = service({ debounceMs: 20 });
    await s.start();
    expect(corruptNotices()).toBe(0);

    await nextPass(s, () => createWork(projectB, { title: 'Толчок' }));
    expect(corruptNotices()).toBe(1);
  });

  it('работа, что починилась и сломалась снова, даёт новое host.notice(map-corrupt)', async () => {
    const { id, good, broken } = await brokenWork();
    const s = service({ debounceMs: 20 });
    await s.start();
    expect(corruptNotices()).toBe(1);

    await nextPass(s, () => replaceStoredMap(projectA, id, good));
    expect(s.entry(projectA, id)).toBeDefined();
    await nextPass(s, () => replaceStoredMap(projectA, id, broken));

    expect(s.entry(projectA, id)).toBeUndefined();
    expect(corruptNotices()).toBe(2);
  });

  it('битая работа грузится один раз на версию, а не на каждый проход; новая версия — новая загрузка без нового уведомления', async () => {
    const { id, broken } = await brokenWork();
    const loads = (): number => vi.mocked(readMap).mock.calls.filter(([projectPath]) => projectPath === projectA).length;
    vi.mocked(readMap).mockClear();
    const s = service({ debounceMs: 20 });
    await s.start();
    expect(loads()).toBe(1);

    await nextPass(s, () => createWork(projectB, { title: 'Толчок' }));
    await nextPass(s, () => createWork(projectB, { title: 'Ещё толчок' }));
    expect(loads()).toBe(1);

    const other = structuredClone(broken);
    other.work.goal = 'другая версия, всё ещё битая';
    await nextPass(s, () => replaceStoredMap(projectA, id, other));
    expect(loads()).toBe(2);
    expect(corruptNotices()).toBe(1);
  });
});

const run = promisify(execFile);
const hostDir = fileURLToPath(new URL('../../', import.meta.url));

/** Запись настоящего второго процесса: `node` со своим соединением к той же базе, ядро берётся из `dist`. */
async function writeFromChildProcess(body: string): Promise<void> {
  await run(process.execPath, ['--input-type=module', '--no-warnings', '-e', `import * as core from '@parley/core';\n${body}`], {
    cwd: hostDir,
    env: { ...process.env, PARLEY_HOME: home },
  });
}

describe('изменения без файлов', () => {
  it('updateMap в процессе хоста даёт works.changed и звонит слушателям', async () => {
    const work = await createWork(projectA, { title: 'Работа' });
    const s = service({ debounceMs: 20 });
    await s.start();
    const goals: string[] = [];
    s.onChange((snapshot) => {
      goals.push(snapshot.entries[0]?.map.work.goal ?? '');
    });
    const changes = (): number => broadcasts.filter((item) => item.event === 'works.changed').length;
    const before = changes();

    await updateMap(projectA, work.work.id, (map) => {
      map.work.goal = 'через событие хранилища';
    });

    await vi.waitFor(() => expect(goals).toContain('через событие хранилища'), { timeout: 2000, interval: 10 });
    expect(changes()).toBeGreaterThan(before);
  });

  it('запись из дочернего процесса (другое соединение с базой) видна слушателям в течение 2 с', async () => {
    const work = await createWork(projectA, { title: 'Работа' });
    const s = service({ debounceMs: 20 });
    await s.start();
    const goals: string[] = [];
    s.onChange((snapshot) => {
      goals.push(snapshot.entries[0]?.map.work.goal ?? '');
    });

    await writeFromChildProcess(
      `const map = core.readStoredMap(${JSON.stringify(projectA)}, ${JSON.stringify(work.work.id)});
       map.work.goal = 'из дочернего процесса';
       core.replaceStoredMap(${JSON.stringify(projectA)}, ${JSON.stringify(work.work.id)}, map);`,
    );

    await vi.waitFor(() => expect(goals).toContain('из дочернего процесса'), { timeout: 2000, interval: 25 });
    expect(s.entry(projectA, work.work.id)?.map.work.goal).toBe('из дочернего процесса');
  }, 20_000);

  it('работа, созданная дочерним процессом, появляется в снимке', async () => {
    const s = service({ debounceMs: 20 });
    await s.start();

    await writeFromChildProcess(
      `await core.createWork(${JSON.stringify(projectB)}, { title: 'Из дочернего' });`,
    );

    await vi.waitFor(
      () => expect(s.snapshot().entries.map((entry) => entry.map.work.title)).toEqual(['Из дочернего']),
      { timeout: 2000, interval: 25 },
    );
  }, 20_000);

  it('работа, снятая в процессе хоста (deleteWorkFiles), пропадает из снимка', async () => {
    const work = await createWork(projectA, { title: 'Работа' });
    await createWork(projectB, { title: 'Остаётся' });
    const s = service({ debounceMs: 20 });
    await s.start();
    expect(s.snapshot().entries).toHaveLength(2);

    await deleteWorkFiles(projectA, work.work.id);

    await vi.waitFor(() => expect(s.snapshot().entries.map((entry) => entry.map.work.title)).toEqual(['Остаётся']), {
      timeout: 2000,
      interval: 10,
    });
  });

  it('после stop сервис записей больше не слушает', async () => {
    const work = await createWork(projectA, { title: 'Работа' });
    const s = service({ debounceMs: 20 });
    await s.start();
    await s.stop();
    services = services.filter((candidate) => candidate !== s);
    broadcasts = [];

    await updateMap(projectA, work.work.id, (map) => {
      map.work.goal = 'после stop';
    });
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(broadcasts.filter((item) => item.event === 'works.changed')).toEqual([]);
  });
});

describe('снимок окна по версии работы (план 4, задача 5)', () => {
  const compact = vi.mocked(compactWorkMap);
  /** Работы, чей снимок для окна пересобирался с последнего `mockClear`. */
  const rebuilt = (): string[] => compact.mock.calls.map(([map]) => map.work.id);
  const goalOf = (s: WorksService, workId: string): string | undefined =>
    s.windowSnapshot()?.entries.find((entry) => entry.map.work.id === workId)?.map.work.goal;

  /** Ждёт, пока рассылки стихнут: служебные записи хоста (аренда) тоже будят сервис, а считать надо только запись теста. */
  async function settle(s: WorksService): Promise<void> {
    let last = -1;
    await vi.waitFor(
      () => {
        const now = s.windowSnapshot()?.revision ?? 0;
        const quiet = now === last;
        last = now;
        expect(quiet).toBe(true);
      },
      { timeout: 15_000, interval: 300 },
    );
  }

  it('запись в работу A не пересобирает снимок работы B; снимок B в рассылке остаётся на месте', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const b = await createWork(projectB, { title: 'B' });
    const s = service({ debounceMs: 20 });
    await s.start();
    await settle(s);
    const before = s.windowSnapshot();
    compact.mockClear();

    await updateMap(projectA, a.work.id, (map) => {
      map.work.goal = 'новая цель';
    });
    await vi.waitFor(() => expect(goalOf(s, a.work.id)).toBe('новая цель'), { timeout: 10_000, interval: 10 });
    await settle(s);

    expect(rebuilt()).toContain(a.work.id);
    expect(rebuilt()).not.toContain(b.work.id);
    const after = s.windowSnapshot();
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(after?.entries.map((entry) => entry.map.work.title)).toEqual(['A', 'B']);
    // Снимок B — тот же объект, что в прошлой рассылке: его не собирали и не копировали заново.
    const mapOf = (snapshot: typeof after, workId: string) => snapshot?.entries.find((entry) => entry.map.work.id === workId)?.map;
    expect(mapOf(after, b.work.id)).toBe(mapOf(before, b.work.id));
  });

  it('работу с кандидатом на сверку живости каждый проход перечитывают, но её снимок не пересобирается, пока версия та же', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const b = await createWork(projectB, { title: 'B' });
    await updateMap(projectB, b.work.id, (current) => {
      const created = addSession(current, { provider: 'claude', label: 'план', task: 't' });
      created.launchedBy = 'tui';
      created.pid = 999_999;
      transitionSession(current, created.id, 'active');
    });
    const s = service({ debounceMs: 20 });
    await s.start();
    await settle(s);
    expect(s.entry(projectB, b.work.id)?.map.sessions[0]?.lifecycle).toBe('sleeping');
    compact.mockClear();
    vi.mocked(readMap).mockClear();

    await updateMap(projectA, a.work.id, (map) => {
      map.work.goal = 'новая цель';
    });
    await vi.waitFor(() => expect(goalOf(s, a.work.id)).toBe('новая цель'), { timeout: 10_000, interval: 10 });
    await settle(s);

    // Сверка живости перечитала B (свежая карта, другой объект), а снимок для окна остался прежним: версия строки та же.
    expect(vi.mocked(readMap).mock.calls.filter(([, workId]) => workId === b.work.id).length).toBeGreaterThan(0);
    expect(rebuilt()).toContain(a.work.id);
    expect(rebuilt()).not.toContain(b.work.id);
  });

  it('работа, записанная несколько раз подряд, каждый раз в снимке свежая: старый снимок под новой версией не залипает', async () => {
    const a = await createWork(projectA, { title: 'A' });
    await createWork(projectB, { title: 'B' });
    const s = service({ debounceMs: 20 });
    await s.start();
    await settle(s);

    for (const goal of ['первая', 'вторая', 'третья']) {
      await updateMap(projectA, a.work.id, (map) => {
        map.work.goal = goal;
      });
      await vi.waitFor(() => expect(goalOf(s, a.work.id)).toBe(goal), { timeout: 10_000, interval: 10 });
    }
    await settle(s);
    expect(goalOf(s, a.work.id)).toBe('третья');
  });

  it('письмо в работе доходит до снимка: компактная карта видит новый хвост', async () => {
    const a = await createWork(projectA, { title: 'A' });
    await updateMap(projectA, a.work.id, (map) => {
      addSession(map, { provider: 'claude', label: 'план', task: 'x' });
    });
    const s = service({ debounceMs: 20 });
    await s.start();
    await settle(s);
    const latest = (): string | null | undefined => s.windowSnapshot()?.entries[0]?.map.compact?.messages.latestId;
    expect(latest()).toBeNull();

    await updateMap(projectA, a.work.id, (map) => {
      addMessage(map, { from: 's-01', to: [], text: 'привет' });
    });

    await vi.waitFor(() => expect(latest()).toBe('m-01'), { timeout: 10_000, interval: 10 });
  });

  it('бюджет писем зависит от числа живых работ: когда оно меняется, пересобираются все живые, и каждая со своим бюджетом', async () => {
    const works = [
      await createWork(projectA, { title: '1' }),
      await createWork(projectA, { title: '2' }),
      await createWork(projectB, { title: '3' }),
    ];
    const s = service({ debounceMs: 20 });
    await s.start();
    await settle(s);
    const budgetsOf = (workId: string): number[] =>
      compact.mock.calls.filter(([map]) => map.work.id === workId).map(([, options]) => options.messageBytes);
    // Три живые работы — по 1 МиБ каждой.
    for (const work of works) expect(budgetsOf(work.work.id).at(-1)).toBe(1024 * 1024);
    compact.mockClear();

    // Четвёртая живая работа: 3 МиБ на четверых — по 768 КиБ, и бюджет сменился у всех.
    const fourth = await createWork(projectB, { title: '4' });
    await vi.waitFor(() => expect(s.windowSnapshot()?.entries).toHaveLength(4), { timeout: 10_000, interval: 10 });
    await settle(s);

    for (const work of [...works, fourth]) expect(budgetsOf(work.work.id).at(-1), work.work.title).toBe(768 * 1024);
  });

  it('работа, снятая из базы, уходит из снимка; новая работа в нём собирается, а уцелевшая — нет', async () => {
    const a = await createWork(projectA, { title: 'A' });
    const b = await createWork(projectB, { title: 'B' });
    const s = service({ debounceMs: 20 });
    await s.start();
    await settle(s);
    compact.mockClear();

    await deleteWorkFiles(projectA, a.work.id);
    const again = await createWork(projectA, { title: 'Новая A' });
    await vi.waitFor(() => expect(s.windowSnapshot()?.entries.map((entry) => entry.map.work.title).sort()).toEqual(['B', 'Новая A']), {
      timeout: 10_000,
      interval: 10,
    });
    await settle(s);

    expect(rebuilt()).toContain(again.work.id);
    expect(rebuilt()).not.toContain(b.work.id);
  });
});
