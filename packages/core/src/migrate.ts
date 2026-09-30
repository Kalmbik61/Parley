/**
 * Перенос данных с прежнего имени на новое (план переименования harnas → parley, R6): домашний каталог
 * `~/.harnas` → `~/.parley` (его переносит главный процесс окна на старте, до поиска и запуска хоста) и
 * каталоги состояния проектов `<проект>/.harnas` → `<проект>/.parley` (их переносит хост на старте, до
 * наблюдателей).
 *
 * Только `rename`, никогда не копия: имя на диске одно, данные не раздваиваются. Нет живого — переносим,
 * есть живое — работаем со старым и пробуем при следующем запуске. Живое — всё, что держит старый путь:
 * хост дома, процесс сессии проекта, блокировка записи. Сомнение (не читается каталог, не разобралась карта)
 * тоже отказ. Причина отказа уходит в результате, а не исключением, и старт окна и хоста от переноса не
 * зависит; исключение одно — `migrateProjects` не может идти по нечитаемому индексу работ.
 *
 * Не переносится никогда: worktree сессий и их ветки (путь и ветка закреплены в картах, а `--resume` ищет
 * транскрипт по cwd) и `worktreeRoot`, заданный человеком.
 *
 * О каждом переносе дом хранит запись — `migrated-from-harnas.json`: что, откуда, куда и когда.
 */

import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { hostAlive } from './host-lock.js';
import { envValue, HOME_DIR, LEGACY_HOME_DIR, LEGACY_STATE_DIR, STATE_DIR } from './names.js';
import type { Env } from './names.js';
import { hasLiveProcess } from './work/liveness.js';
import { parseMap } from './work/map.js';
import { writeSelfIgnore } from './work/state-dir.js';
import { parleyHome, readWorksIndex } from './work/store.js';

/** Запись о переносах в доме: рядом с `works-index.json`, переезжает вместе с домом. */
export const MIGRATION_RECORD = 'migrated-from-harnas.json';

/** Одна строка записи: что перенесено, откуда, куда и когда. */
export interface MigrationEntry {
  what: 'home' | 'project';
  from: string;
  to: string;
  at: string;
}

/** Почему не перенесено. `no-legacy` — переносить нечего (обычное дело, новый дом или уже перенесённый). */
export type SkipReason =
  | 'explicit-home'
  | 'no-legacy'
  | 'legacy-not-directory'
  | 'current-exists'
  | 'host-alive'
  | 'locked'
  | 'live-session'
  | 'unreadable'
  | 'rename-failed';

export type MigrationResult =
  | { status: 'moved'; from: string; to: string }
  | { status: 'skipped'; reason: SkipReason; from: string; detail?: string };

function skipped(reason: SkipReason, from: string, detail?: string): MigrationResult {
  return { status: 'skipped', reason, from, ...(detail === undefined ? {} : { detail }) };
}

/** Код ошибки ФС, а нет его — текст; для `detail` результата. */
const errorText = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? (error instanceof Error ? error.message : String(error));

/** `lstat` без перехода по ссылке; `null` — пути нет (или его родитель не каталог). */
async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Дописывает строку в запись переносов; файла нет или он не разобрался — запись начинается заново. */
async function appendRecord(file: string, entry: MigrationEntry): Promise<void> {
  let migrated: MigrationEntry[] = [];
  try {
    const list = (JSON.parse(await readFile(file, 'utf8')) as { migrated?: unknown }).migrated;
    if (Array.isArray(list)) migrated = list as MigrationEntry[];
  } catch {
    // Первая запись в этом доме.
  }
  migrated.push(entry);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ schemaVersion: 1, migrated }, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export interface MigrateHomeOptions {
  /**
   * Окружение, в котором будет работать хост: дом, заданный в нём (`PARLEY_HOME`, `HARNAS_HOME`), —
   * выбор человека или теста, такой дом не переносится.
   */
  env?: Env;
  /** Домашний каталог человека; у окна — `os.homedir()`. */
  userHome?: string;
  now?: () => Date;
}

/**
 * `~/.harnas` → `~/.parley` (R6), если всё сразу: дом не задан переменной; `~/.parley` нет; `~/.harnas` —
 * настоящий каталог, не ссылка; старый хост не жив (замок `host/host.pid` и сокет, как при старте хоста);
 * в корне дома нет `*.lock`. Иначе дом остаётся прежним, и по R4 окно подключится к старому хосту как раньше.
 */
export async function migrateHome(options: MigrateHomeOptions = {}): Promise<MigrationResult> {
  const { env = process.env, userHome = homedir(), now = () => new Date() } = options;
  const from = path.join(userHome, LEGACY_HOME_DIR);
  const to = path.join(userHome, HOME_DIR);
  try {
    if (envValue(env, 'HOME') !== undefined) return skipped('explicit-home', from);
    const legacy = await lstatOrNull(from);
    if (legacy === null) return skipped('no-legacy', from);
    if (!legacy.isDirectory()) return skipped('legacy-not-directory', from);
    if ((await lstatOrNull(to)) !== null) return skipped('current-exists', from);
    // Раскладка `host/` — как `hostPaths` хоста.
    const alive = await hostAlive({
      pid: path.join(from, 'host', 'host.pid'),
      socket: path.join(from, 'host', 'host.sock'),
    });
    if (alive) return skipped('host-alive', from);
    const lock = (await readdir(from)).find((name) => name.endsWith('.lock'));
    if (lock !== undefined) return skipped('locked', from, lock);

    try {
      await rename(from, to);
    } catch (error) {
      return skipped('rename-failed', from, errorText(error));
    }
    // Перенос состоялся; запись о нём — справка, её сбой перенос не отменяет.
    await appendRecord(path.join(to, MIGRATION_RECORD), {
      what: 'home',
      from,
      to,
      at: now().toISOString(),
    }).catch(() => undefined);
    return { status: 'moved', from, to };
  } catch (error) {
    return skipped('unreadable', from, errorText(error));
  }
}

/** Работа проекта, из-за которой его каталог состояния переносить нельзя. */
interface BusyWork {
  reason: 'locked' | 'live-session';
  detail: string;
}

/**
 * Занята ли работа в каталоге состояния: держится `map.lock` (карту пишут хост, CLI и MCP-серверы агентов) или
 * у сессии живой процесс (`hasLiveProcess`; его сервер MCP держит путь к каталогу открытым). Карта, которая
 * не разобралась, — исключение: живость по ней не проверить.
 */
async function busyWork(stateRoot: string, nowMs: number): Promise<BusyWork | null> {
  const worksDir = path.join(stateRoot, 'works');
  let items: Dirent[];
  try {
    items = await readdir(worksDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null; // работ в проекте ещё нет
    throw error;
  }
  const workIds = items.filter((item) => item.isDirectory()).map((item) => item.name);

  for (const workId of workIds) {
    if ((await lstatOrNull(path.join(worksDir, workId, 'map.lock'))) !== null) {
      return { reason: 'locked', detail: workId };
    }
  }
  for (const workId of workIds) {
    const file = path.join(worksDir, workId, 'map.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // каталог без карты: сессий в нём нет
      throw error;
    }
    for (const session of parseMap(raw, file).sessions) {
      if (await hasLiveProcess(session, { now: nowMs })) {
        return { reason: 'live-session', detail: `${workId}/${session.id}` };
      }
    }
  }
  return null;
}

async function migrateProject(
  projectPath: string,
  home: string,
  now: () => Date,
): Promise<MigrationResult> {
  const from = path.join(projectPath, LEGACY_STATE_DIR);
  const to = path.join(projectPath, STATE_DIR);
  try {
    const legacy = await lstatOrNull(from);
    if (legacy === null) return skipped('no-legacy', from);
    if (!legacy.isDirectory()) return skipped('legacy-not-directory', from);
    if ((await lstatOrNull(to)) !== null) return skipped('current-exists', from);
    const busy = await busyWork(from, now().getTime());
    if (busy !== null) return skipped(busy.reason, from, busy.detail);

    try {
      await rename(from, to);
    } catch (error) {
      return skipped('rename-failed', from, errorText(error));
    }
    // Каталог состояния сам прячет себя от git, как созданный кодом `.parley` (R5). Не получилось — он
    // остаётся таким же видимым, каким был под прежним именем: переезд от этого не откатывается.
    await writeSelfIgnore(to).catch(() => undefined);
    await appendRecord(path.join(home, MIGRATION_RECORD), {
      what: 'project',
      from,
      to,
      at: now().toISOString(),
    }).catch(() => undefined);
    return { status: 'moved', from, to };
  } catch (error) {
    return skipped('unreadable', from, errorText(error));
  }
}

export type ProjectMigration = MigrationResult & { projectPath: string };

/**
 * `<проект>/.harnas` → `<проект>/.parley` у каждого проекта из индекса работ (R6), где есть `.harnas` и нет
 * `.parley`, если у его работ нет живого процесса сессии и блокировки записи `map.lock`. Проект переносится
 * целиком или остаётся как есть. Записи индекса, чей проект исчез, пропускаются. Зовёт хост на старте — под
 * замком единственности, до сокета и наблюдателей. Индекс не прочитался — исключение: хост его и так покажет.
 */
export async function migrateProjects(
  options: { now?: () => Date } = {},
): Promise<ProjectMigration[]> {
  const now = options.now ?? (() => new Date());
  const home = parleyHome();
  const projects = new Set((await readWorksIndex()).works.map((work) => work.projectPath));
  const results: ProjectMigration[] = [];
  for (const projectPath of projects) {
    results.push({ projectPath, ...(await migrateProject(projectPath, home, now)) });
  }
  return results;
}
