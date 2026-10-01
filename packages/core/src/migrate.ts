/**
 * Перенос данных с прежнего имени на новое (план переименования harnas → parley, R6): домашний каталог
 * `~/.harnas` → `~/.parley` (его переносит главный процесс окна на старте, до поиска и запуска хоста) и
 * каталоги состояния проектов `<проект>/.harnas` → `<проект>/.parley` (их переносит хост на старте, до
 * наблюдателей).
 *
 * Только `rename`, никогда не копия: имя на диске одно, данные не раздваиваются. Нет живого — переносим,
 * есть живое — работаем со старым и пробуем при следующем запуске. Живое — всё, что держит старый путь:
 * хост дома, процесс сессии проекта, блокировка записи. Сессию, которую человек поднял напечатанной командой
 * (`work session new`), карта не видит: она остаётся `pending` без pid. Её агент держит путь к каталогу
 * состояния в своей командной строке (`--mcp-config`, `--settings`, `-c mcp_servers…`), поэтому занятость
 * проверяется ещё и по таблице процессов. Дом не переносится, пока живое есть в любом проекте его индекса: сервер
 * MCP такого агента ходит в индекс и в каталог состояния по старому пути. Сомнение (не читается каталог, не
 * разобралась карта или индекс, нет таблицы процессов) тоже отказ. Причина отказа уходит в результате, а не
 * исключением, и старт окна и хоста от переноса не зависит; исключение одно — `migrateProjects` не может идти
 * по нечитаемому индексу работ.
 *
 * Проект, у которого git отслеживает файлы прежнего каталога (человек его закоммитил: так его предупреждает
 * README), не переносится: перенос стёр бы отслеживаемое из рабочей копии, а новый `.parley` под собственным
 * `.gitignore` не закоммитить — состояние разошлось бы с репозиторием.
 *
 * Переехавший каталог правится в двух местах, где он называет сам себя: пути артефактов в картах и пути в
 * сохранённых брифах. Сказанное прозой (письма, резюме) — запись о сказанном, её не переписывают.
 *
 * Не переносится никогда: worktree сессий и их ветки (путь и ветка закреплены в картах, а `--resume` ищет
 * транскрипт по cwd) и `worktreeRoot`, заданный человеком.
 *
 * О каждом переносе дом хранит запись — `migrated-from-harnas.json`: что, откуда, куда и когда.
 */

import { execFile } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import { lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hostAlive } from './host-lock.js';
import { envValue, HOME_DIR, LEGACY_HOME_DIR, LEGACY_STATE_DIR, STATE_DIR, STATE_DIRS } from './names.js';
import type { Env } from './names.js';
import { hasLiveProcess } from './work/liveness.js';
import { parseMap } from './work/map.js';
import { writeSelfIgnore } from './work/state-dir.js';
import { parleyHome, readMap, readWorksIndex, updateMap } from './work/store.js';
import type { WorksIndex } from './work/types.js';
import { NO_FSMONITOR } from './work/worktree.js';

const run = promisify(execFile);

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
  | 'tracked'
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

/** Сколько ждём `ps` и `git`: перенос идёт на старте окна и хоста, и зависший вызов их держать не должен. */
const TOOL_TIMEOUT_MS = 10_000;
/** Вывод `ps` на машине с десятками агентов (у каждого системная вставка в командной строке) — мегабайты. */
const PS_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/** Командные строки процессов, по строке `<pid> <команда>`; `null` — `ps` не ответил. */
type ProcessTable = () => Promise<readonly string[] | null>;

/**
 * Таблица процессов, снятая не чаще раза за вызов и только когда понадобилась: чаще всего переносить нечего, и
 * `ps` не зовётся вовсе. `-A -ww`: все процессы и командные строки целиком, без обрезки по ширине терминала.
 */
function processTable(): ProcessTable {
  let table: Promise<readonly string[] | null> | undefined;
  return () =>
    (table ??= run('ps', ['-A', '-ww', '-o', 'pid=,command='], { maxBuffer: PS_MAX_BUFFER, timeout: TOOL_TIMEOUT_MS }).then(
      ({ stdout }) => stdout.split('\n'),
      () => null,
    ));
}

/** Есть ли `.git` (каталог или ссылка worktree) в проекте или выше него. */
async function insideRepo(projectPath: string): Promise<boolean> {
  for (let dir = projectPath; ; dir = path.dirname(dir)) {
    if ((await lstatOrNull(path.join(dir, '.git'))) !== null) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Отслеживает ли git хоть один файл из `dirName` в проекте. Репозитория нет — отслеживать нечему, и `git` не зовётся:
 * на Mac без средств разработчика он открывает диалог установки. Не репозиторий по ответу git (код 128) и нет git —
 * то же самое.
 */
async function hasTrackedFiles(projectPath: string, dirName: string): Promise<boolean> {
  if (!(await insideRepo(projectPath))) return false;
  try {
    const { stdout } = await run('git', [...NO_FSMONITOR, '-C', projectPath, 'ls-files', '-z', '--', dirName], {
      maxBuffer: GIT_MAX_BUFFER,
      timeout: TOOL_TIMEOUT_MS,
    });
    return stdout !== '';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 128) return false;
    throw error;
  }
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
 * в корне дома нет `*.lock`; ни у одного проекта из индекса дома нет живой сессии (`busyWork`). Иначе дом
 * остаётся прежним, и по R4 окно подключится к старому хосту как раньше.
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
    // Живая сессия в любом проекте индекса: сервер MCP её агента ходит в индекс и в каталог состояния по старому пути.
    const index = await readWorksIndex(path.join(from, 'works-index.json'));
    const busy = await busyInIndex(index, now().getTime(), processTable());
    if (busy !== null) return skipped(busy.reason, from, busy.detail);

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

/** Номер процесса в начале строки `ps`. */
const PID = /^\s*(\d+)\s/;

/**
 * Занят ли каталог состояния: держится `map.lock` (карту пишут хост, CLI и MCP-серверы агентов), у сессии по карте
 * живой процесс (`hasLiveProcess`) или путь к каталогу стоит в командной строке живого процесса. Последнее — для
 * сессий, которых карта не видит: поднятая из терминала остаётся `pending` без pid, `hasLiveProcess` про неё всегда
 * «нет», а агент работает и держит `--mcp-config <каталог>/works/…`. Карта, которая не разобралась, и таблица
 * процессов, которую не получить, — исключения: живость по ним не проверить.
 */
async function busyWork(stateRoot: string, nowMs: number, processes: ProcessTable): Promise<BusyWork | null> {
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
  if (workIds.length === 0) return null; // без работ нет ни сессий, ни конфигов MCP, которые держал бы процесс

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

  const commands = await processes();
  if (commands === null) throw new Error('the process table could not be read (ps)');
  // Путь с разделителем в конце: `…/shop/.harnas/` не совпадёт с `…/shop-old/.harnas/`.
  const needle = `${stateRoot}${path.sep}`;
  const holder = commands.find((line) => line.includes(needle));
  return holder === undefined ? null : { reason: 'live-session', detail: `pid ${PID.exec(holder)?.[1] ?? '?'}` };
}

/**
 * Первое занятое место среди проектов индекса дома. Каталог состояния проекта — под любым из двух имён: хост мог
 * перенести проект на `.parley` раньше, чем окно добралось до дома, а агент прежней сборки держит `.harnas`.
 */
async function busyInIndex(index: WorksIndex, nowMs: number, processes: ProcessTable): Promise<BusyWork | null> {
  for (const projectPath of new Set(index.works.map((work) => work.projectPath))) {
    for (const dirName of STATE_DIRS) {
      const stateRoot = path.join(projectPath, dirName);
      if ((await lstatOrNull(stateRoot)) === null) continue;
      const busy = await busyWork(stateRoot, nowMs, processes);
      if (busy !== null) return { reason: busy.reason, detail: `${stateRoot}: ${busy.detail}` };
    }
  }
  return null;
}

/**
 * Путь артефакта внутри прежнего каталога состояния — тот же путь под новым именем; `null` — путь не оттуда.
 * Путь в карте относительный корню проекта и начинается с каталога состояния (`.harnas/works/<id>/artifacts/…`),
 * поэтому после переноса он вёл бы в никуда. Начало `./` остаётся как записано; `.harnas-backup/…` и `sub/.harnas/…`
 * к каталогу состояния проекта не относятся.
 */
function movedArtifactPath(artifactPath: string): string | null {
  const dot = artifactPath.startsWith('./') ? 2 : 0;
  if (!artifactPath.startsWith(LEGACY_STATE_DIR, dot)) return null;
  const rest = artifactPath.slice(dot + LEGACY_STATE_DIR.length);
  if (rest !== '' && !rest.startsWith('/') && !rest.startsWith('\\')) return null;
  return `${artifactPath.slice(0, dot)}${STATE_DIR}${rest}`;
}

/**
 * `.harnas` в тексте, когда это начало относительного пути в каталог работ. Не хвост другого имени
 * (`my.harnas/works/`) и не середина абсолютного пути (`/где/то/.harnas/works/`): чужой проект своё имя
 * каталога мог ещё не сменить.
 */
const LEGACY_STATE_REF = new RegExp(`(?<![\\w~./\\\\-])${LEGACY_STATE_DIR.replaceAll('.', '\\.')}(?=/works/)`, 'g');

async function rewriteBrief(file: string): Promise<void> {
  const text = await readFile(file, 'utf8');
  const moved = text.replace(LEGACY_STATE_REF, STATE_DIR);
  if (moved !== text) await writeFile(file, moved, 'utf8');
}

/** Пути артефактов в карте одной работы переехавшего каталога. Карта, где переписывать нечего, не трогается. */
async function rewriteArtifactPaths(projectPath: string, workId: string): Promise<void> {
  const stale = (await readMap(projectPath, workId)).sessions.some((session) =>
    session.artifacts.some((artifact) => movedArtifactPath(artifact.path) !== null),
  );
  if (stale) {
    // Не событие работы: `updatedAt` остаётся, работа не всплывает в начало списка.
    await updateMap(
      projectPath,
      workId,
      (map) => {
        for (const session of map.sessions) {
          for (const artifact of session.artifacts) artifact.path = movedArtifactPath(artifact.path) ?? artifact.path;
        }
      },
      { touch: false },
    );
  }
}

/**
 * Правит то, что переехавший каталог хранит о самом себе. Вызывается после `rename`, и её сбой перенос не
 * отменяет: каждая работа и каждый бриф — сами по себе, не поправленное остаётся как было до переноса.
 */
async function rewriteStateRefs(projectPath: string, stateRoot: string): Promise<void> {
  const worksDir = path.join(stateRoot, 'works');
  for (const item of await readdir(worksDir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    await rewriteArtifactPaths(projectPath, item.name).catch(() => undefined);
    const briefs = path.join(worksDir, item.name, 'briefs');
    for (const name of await readdir(briefs).catch(() => [] as string[])) {
      if (name.endsWith('.md')) await rewriteBrief(path.join(briefs, name)).catch(() => undefined);
    }
  }
}

async function migrateProject(
  projectPath: string,
  home: string,
  now: () => Date,
  processes: ProcessTable,
): Promise<MigrationResult> {
  const from = path.join(projectPath, LEGACY_STATE_DIR);
  const to = path.join(projectPath, STATE_DIR);
  try {
    const legacy = await lstatOrNull(from);
    if (legacy === null) return skipped('no-legacy', from);
    if (!legacy.isDirectory()) return skipped('legacy-not-directory', from);
    if ((await lstatOrNull(to)) !== null) return skipped('current-exists', from);
    const busy = await busyWork(from, now().getTime(), processes);
    if (busy !== null) return skipped(busy.reason, from, busy.detail);
    if (await hasTrackedFiles(projectPath, LEGACY_STATE_DIR)) return skipped('tracked', from);

    try {
      await rename(from, to);
    } catch (error) {
      return skipped('rename-failed', from, errorText(error));
    }
    // Каталог состояния сам прячет себя от git, как созданный кодом `.parley` (R5). Не получилось — он
    // остаётся таким же видимым, каким был под прежним именем: переезд от этого не откатывается.
    await writeSelfIgnore(to).catch(() => undefined);
    await rewriteStateRefs(projectPath, to).catch(() => undefined);
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
 * `.parley`, если у его работ нет живого процесса сессии (по карте и по командным строкам процессов) и
 * блокировки записи `map.lock`, а git не отслеживает файлы `.harnas`. Проект переносится целиком или остаётся как
 * есть. Записи индекса, чей проект исчез, пропускаются. Зовёт хост на старте — под замком единственности, до
 * сокета и наблюдателей. Индекс не прочитался — исключение: хост его и так покажет.
 */
export async function migrateProjects(
  options: { now?: () => Date } = {},
): Promise<ProjectMigration[]> {
  const now = options.now ?? (() => new Date());
  const home = parleyHome();
  const projects = new Set((await readWorksIndex()).works.map((work) => work.projectPath));
  const processes = processTable();
  const results: ProjectMigration[] = [];
  for (const projectPath of projects) {
    results.push({ projectPath, ...(await migrateProject(projectPath, home, now, processes)) });
  }
  return results;
}
