/**
 * Замер записи в базу работ на синтетической большой работе (как `w-0054`: 250 сессий, 64 комнаты, 7 000 писем,
 * карта около 2,5 МБ). Не vitest: инструмент измерения, цифры идут в описание PR до и после правок.
 *
 * Запуск: cd packages/core && node --import tsx test/bench-store-writes.ts [runs=30]
 *
 * Дом и проект — временные каталоги, которые скрипт сам создаёт и удаляет; настоящий `~/.parley` и `~/.harnas`
 * скрипт не открывает (проверка ниже), хотя бы `PARLEY_HOME` и был задан снаружи.
 *
 * Колонки: total — вызов целиком, lock — время между успешным `BEGIN IMMEDIATE` и `COMMIT`/`ROLLBACK` (замок базы
 * держит именно оно). «Чужое письмо» и «чужая правка карты» делает второе соединение к той же базе, как другой
 * процесс (MCP агента): письмо — только подъём версии работы, правка карты — правка одной строки `entries` и версии.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';

const runs = Math.max(3, Number(process.argv[2] ?? '30') || 30);
const SESSIONS = 250;
const ROOMS = 64;
const ARCHIVED_ROOMS = 49;
const MEMBERS = 8;
const LETTERS = 7_000;
const LETTER_CHARS = 800;
const TASK_CHARS = 9_000;
const SUMMARY_CHARS = 1_000;

const home = mkdtempSync(path.join(tmpdir(), 'parley-bench-home-'));
const project = mkdtempSync(path.join(tmpdir(), 'parley-bench-project-'));
process.env['PARLEY_HOME'] = home;
delete process.env['HARNAS_HOME'];

// Модули берутся после того, как дом задан: статический import вычислил бы дом раньше.
const { parleyHome } = await import('../src/home.js');
const { closeWorkDb, workDb } = await import('../src/work/db.js');
const { writeLetters } = await import('../src/work/letter-store.js');
const { addSession } = await import('../src/work/map.js');
const { addRoom } = await import('../src/work/rooms.js');
const { createWork, readMap, storedMapBytes, updateMap, viewMap } = await import('../src/work/store.js');

let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  try {
    closeWorkDb();
  } catch {
    /* база уже закрыта */
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

/** Предохранитель: дом скрипта не может быть настоящим домом человека, ни его частью. */
function refuseRealHome(resolved: string): void {
  const target = path.resolve(resolved);
  for (const base of new Set([homedir(), userInfo().homedir])) {
    for (const dir of ['.parley', '.harnas']) {
      const relative = path.relative(path.join(base, dir), target);
      if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        throw new Error(`The benchmark refuses to use the real Parley home (${target})`);
      }
    }
  }
  if (target !== path.resolve(home)) throw new Error(`The benchmark home is not the temporary one: ${target}`);
}

interface Sample {
  total: number;
  lock: number | null;
}

const median = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const p90 = (xs: number[]): number => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)]!;
};
const fmt = (ms: number): string => ms.toFixed(2);

try {
  refuseRealHome(parleyHome());

  const created = await createWork(project, { title: 'bench' });
  const workId = created.work.id;

  // Работа как w-0054: сессии с длинным task и summary, комнаты по 8 участников, большинство в архиве.
  await updateMap(
    project,
    workId,
    (map) => {
      for (let i = 0; i < SESSIONS; i += 1) {
        const session = addSession(map, { provider: 'claude', label: `Session ${i}`, task: 'x'.repeat(TASK_CHARS) });
        session.summary = 'y'.repeat(SUMMARY_CHARS);
      }
      const ids = map.sessions.map((s) => s.id);
      for (let r = 0; r < ROOMS; r += 1) {
        const members = Array.from({ length: MEMBERS }, (_, k) => ids[(r * 4 + k) % ids.length]!);
        const room = addRoom(map, { title: `Room ${r}`, creator: members[0]!, members });
        if (r < ARCHIVED_ROOMS) room.archivedAt = new Date().toISOString();
      }
    },
    { lockTimeoutMs: 60_000 },
  );

  const setup = await readMap(project, workId);
  const openRooms = setup.rooms.filter((r) => r.archivedAt === null);
  writeLetters(
    project,
    workId,
    (letters) => {
      for (let i = 0; i < LETTERS; i += 1) {
        const room = openRooms[i % openRooms.length]!;
        const from = room.members[i % room.members.length]!;
        letters.add({
          roomId: room.id,
          from,
          to: room.members.filter((m) => m !== from),
          text: 'm'.repeat(LETTER_CHARS),
          kind: 'note',
        });
      }
    },
    { lockTimeoutMs: 60_000 },
  );

  const roomId = openRooms[0]!.id;
  const sender = openRooms[0]!.members[0]!;
  const peers = openRooms[0]!.members.slice(1);
  console.log(
    `shape: ${setup.sessions.length} sessions, ${setup.rooms.length} rooms (${ARCHIVED_ROOMS} archived), ${LETTERS} letters, ` +
      `storedMapBytes=${storedMapBytes(project, workId) ?? 'not cached'}, runs=${runs}`,
  );

  // Время под замком: обёртка exec у экземпляра, которым пишет хранилище.
  const db = workDb();
  const rawExec = db.exec.bind(db);
  let lockStart: number | null = null;
  let lastLock: number | null = null;
  db.exec = (statement: string): void => {
    rawExec(statement);
    if (statement === 'BEGIN IMMEDIATE') lockStart = performance.now();
    else if ((statement === 'COMMIT' || statement === 'ROLLBACK') && lockStart !== null) {
      lastLock = performance.now() - lockStart;
      lockStart = null;
    }
  };

  // Чужой процесс: второе соединение к той же базе.
  const foreign = new DatabaseSync(path.join(home, 'parley.db'));
  foreign.exec('PRAGMA busy_timeout = 5000');
  const bumpVersion = foreign.prepare('UPDATE works SET version = version + 1 WHERE project_path = ? AND id = ?');
  const touchEntry = foreign.prepare(
    `UPDATE entries SET json = json_set(json, '$.summary', ?) WHERE rowid =
       (SELECT MIN(rowid) FROM entries WHERE project_path = ? AND work_id = ? AND kind = 'session')`,
  );
  const foreignLetter = (): void => {
    bumpVersion.run(project, workId);
  };
  let counter = 0;
  const foreignMapChange = (): void => {
    counter += 1;
    touchEntry.run(`foreign ${counter}`, project, workId);
    bumpVersion.run(project, workId);
  };

  const writeOneLetter = (): void => {
    writeLetters(
      project,
      workId,
      (letters) =>
        letters.add({ roomId, from: sender, to: peers, text: 'n'.repeat(LETTER_CHARS), kind: 'note' }),
      { lockTimeoutMs: 60_000 },
    );
  };

  interface Scenario {
    name: string;
    before?: () => void;
    run: () => unknown;
  }
  const scenarios: Scenario[] = [
    { name: 'letter, cache hit', run: writeOneLetter },
    { name: 'letter after foreign letter', before: foreignLetter, run: writeOneLetter },
    { name: 'letter after foreign map change', before: foreignMapChange, run: writeOneLetter },
    {
      name: 'map update, cache hit',
      run: () =>
        updateMap(
          project,
          workId,
          (map) => {
            map.sessions[1]!.summary = `bench ${(counter += 1)}`;
          },
          { lockTimeoutMs: 60_000 },
        ),
    },
    { name: 'read after foreign letter', before: foreignLetter, run: () => readMap(project, workId) },
    {
      name: 'full load, no copy',
      before: foreignMapChange,
      run: () => viewMap(project, workId, () => 0),
    },
  ];

  const rows: string[] = [];
  for (const scenario of scenarios) {
    const samples: Sample[] = [];
    // Прогрев: первый прогон и кэш карты, и подготовленные запросы.
    for (let i = -1; i < runs; i += 1) {
      scenario.before?.();
      lastLock = null;
      const started = performance.now();
      const outcome = scenario.run();
      if (outcome instanceof Promise) await outcome;
      const total = performance.now() - started;
      if (i >= 0) samples.push({ total, lock: lastLock });
    }
    const locks = samples.map((s) => s.lock).filter((v): v is number => v !== null);
    rows.push(
      `| ${scenario.name} | ${fmt(median(samples.map((s) => s.total)))} | ${fmt(p90(samples.map((s) => s.total)))} | ` +
        `${locks.length === 0 ? '-' : fmt(median(locks))} | ${locks.length === 0 ? '-' : fmt(p90(locks))} |`,
    );
  }
  foreign.close();

  console.log('\n| scenario | total median ms | total p90 ms | lock median ms | lock p90 ms |');
  console.log('|---|---|---|---|---|');
  for (const row of rows) console.log(row);
} finally {
  cleanup();
}
