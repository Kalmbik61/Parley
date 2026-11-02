/**
 * Доверие к папке для Claude Code (спека мобильного приложения 2026-10-29, 4.2 «Claude и экран доверия»; план A29).
 *
 * Ни один запуск, в том числе с телефона, не должен ждать нажатия в терминале. Codex получает доверие флагом
 * `projects=…` (`trustArgs`), у Claude Code флага нет: он читает `projects[<папка>].hasTrustDialogAccepted` из файла
 * состояния профиля. Поэтому перед запуском Claude (и GLM, и своих провайдеров на его базе) в папке, у которой есть
 * запись в `trust.json`, Parley отмечает эту же папку (её realpath — ключ `trust.json`) принятой в файле профиля, а при
 * отзыве согласия снимает отметку — только ту, что поставил сам (`trust.ts`: `syncClaudeTrust`, `revokeTrust`).
 *
 * Как устроено у самого CLI (проверено на Claude Code 2.1.316):
 * - файл состояния лежит в `CLAUDE_CONFIG_DIR`, без неё — в HOME; прежний `<папка конфигурации>/.config.json` главнее,
 *   если он есть (`getGlobalClaudeFile`; имена — в `claudeStateFile`);
 * - ключ доверия — канонический корень git-репозитория (worktree сводится к главному), затем папки вверх от cwd до
 *   корня: отметка папки проекта снимает экран и в её подпапках, и в worktree этого репозитория. Не покрыто: проект —
 *   подпапка git-репозитория, а сессия идёт в worktree; CLI спросит корень репозитория, отметки на нём нет, и экран
 *   доверия будет (корень — уже другая папка, доверия к нему человек не давал);
 * - CLI пишет файл часто и под блокировкой proper-lockfile (каталог, созданный `mkdir`) с явным `lockfilePath` —
 *   `<путь файла как есть>.lock`, без раскрытия ссылки; под ней перечитывает файл и сливает `projects` с диском.
 *   Parley берёт эту же блокировку и, если файл — ссылка, ещё и `<realpath>.lock` (замок proper-lockfile по
 *   умолчанию): запись CLI после нашей нашу отметку не потеряет, наша — его поля тоже.
 *
 * Граница записи: меняется только `projects[<эта папка>].hasTrustDialogAccepted`, остальное содержимое файла идёт как
 * было; нет файла, он не разбирается или занят дольше срока — ничего не пишется, запуск идёт дальше, а CLI покажет
 * свой экран, как раньше. Каждая отметка Parley записана в `<дом Parley>/claude-trust-marks.json` до записи в файл
 * Claude: снять можно только записанное, а отметку, поставленную человеком в самом CLI, Parley не трогает.
 */

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Чем кончилась правка файла Claude. */
export type ClaudeTrustOutcome =
  /** Отметка уже стояла (принятие): файл не переписывался. */
  | 'present'
  /** Отметки нет (снятие): файл не переписывался. */
  | 'absent'
  | 'written'
  /** Файла состояния профиля нет (CLI ещё не запускался с этим профилем): Parley его не создаёт. */
  | 'no-config'
  /** Файл не разбирается как JSON-объект или `projects` чужой формы: не трогаем. */
  | 'unreadable'
  /** Блокировку держали дольше срока или файл менялся на каждой попытке. */
  | 'busy';

export interface ClaudeTrustOptions {
  /** Сколько ждать блокировку CLI, мс. */
  lockWaitMs?: number;
  /** Сколько раз перечитать файл, если он изменился между чтением и заменой. */
  attempts?: number;
  /** Для тестов: зовётся после записи временного файла, перед проверкой и заменой. */
  beforeCommit?: () => Promise<void>;
}

const LOCK_WAIT_MS = 2_000;
const ATTEMPTS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);

/**
 * Файл состояния Claude Code профиля — как его выбирает CLI. `configDir` — `CLAUDE_CONFIG_DIR` процесса (уже
 * разрешённый в абсолютный путь), `undefined` — профиль по умолчанию в `home`.
 */
export async function claudeStateFile(configDir: string | undefined, home: string): Promise<string> {
  const current = path.join(configDir ?? home, '.claude.json');
  const legacy = path.join(configDir ?? path.join(home, '.claude'), '.config.json');
  try {
    const info = await stat(legacy);
    if (info.isFile() && (info.size > 0 || ((info.mode & 0o222) !== 0 && !(await exists(current))))) return legacy;
  } catch { /* нет прежнего файла — обычный */ }
  return current;
}

/** Блокировка: каталог `lock`. `false` — не дождались до `deadline`; чужую блокировку не снимаем никогда. */
async function acquireLock(lock: string, deadline: number): Promise<boolean> {
  for (;;) {
    try {
      await mkdir(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (Date.now() >= deadline) return false;
    await delay(25 + Math.floor(Math.random() * 50));
  }
}

/** Правка содержимого: новое содержимое, `unchanged` — менять нечего, `unreadable` — форма чужая, не трогаем. */
type Mutation = (data: Record<string, unknown>) => Record<string, unknown> | 'unchanged' | 'unreadable';

/**
 * Правка файла состояния под блокировками CLI: перечитать, применить `mutate`, временный файл с прежними правами,
 * сверка перед заменой, повтор при чужой записи. Ссылку (менеджер дотфайлов) не заменяем файлом: пишем в её цель.
 */
async function editClaudeState(file: string, mutate: Mutation, options: ClaudeTrustOptions): Promise<'changed' | 'unchanged' | 'no-config' | 'unreadable' | 'busy'> {
  // Нет файла — не создаём его и блокировку рядом с ним не заводим.
  let target: string;
  try {
    target = await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'no-config';
    throw error;
  }
  const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  // Второй замок — только если ссылка сам файл: ссылки в каталогах над ним (`/var` → `/private/var`) дают тот же
  // каталог замка под другим написанием, и второй `mkdir` ждал бы сам себя.
  const ownLink = path.join(await realpath(path.dirname(file)), path.basename(file)) !== target;
  const locks = ownLink ? [`${file}.lock`, `${target}.lock`] : [`${file}.lock`];
  const held: string[] = [];
  try {
    for (const lock of locks) {
      if (!(await acquireLock(lock, deadline))) return 'busy';
      held.push(lock);
    }
    for (let attempt = 0; attempt < (options.attempts ?? ATTEMPTS); attempt++) {
      // Ссылку перенаправили, пока ждали замок: замок цели уже не тот.
      if ((await realpath(file).catch(() => null)) !== target) return 'busy';
      const raw = await readFile(target, 'utf8');
      const mode = (await stat(target)).mode & 0o777;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return 'unreadable';
      }
      if (!isRecord(data)) return 'unreadable';
      const next = mutate(data);
      if (next === 'unchanged' || next === 'unreadable') return next;

      const tmp = `${target}.parley-${randomUUID()}.tmp`;
      try {
        // Форма файла — как у CLI: два пробела отступа, права прежние.
        await writeFile(tmp, JSON.stringify(next, null, 2), { mode });
        await chmod(tmp, mode);
        await options.beforeCommit?.();
        // Писатель без блокировки (другая сборка CLI) успел между чтением и заменой — перечитываем и сливаем заново.
        if ((await readFile(target, 'utf8')) !== raw) continue;
        await rename(tmp, target);
        return 'changed';
      } finally {
        await rm(tmp, { force: true });
      }
    }
    return 'busy';
  } finally {
    for (const lock of held.reverse()) await rmdir(lock).catch(() => undefined);
  }
}

/** Ставит `projects[folder].hasTrustDialogAccepted = true`, ничего больше. `folder` — уже ключ: realpath. */
export async function acceptClaudeFolderTrust(file: string, folder: string, options: ClaudeTrustOptions = {}): Promise<ClaudeTrustOutcome> {
  const result = await editClaudeState(file, (data) => {
    const projects = data['projects'] ?? {};
    if (!isRecord(projects)) return 'unreadable';
    const entry = projects[folder] ?? {};
    if (!isRecord(entry)) return 'unreadable';
    if (entry['hasTrustDialogAccepted'] === true) return 'unchanged';
    return { ...data, projects: { ...projects, [folder]: { ...entry, hasTrustDialogAccepted: true } } };
  }, options);
  return result === 'changed' ? 'written' : result === 'unchanged' ? 'present' : result;
}

/** Снимает отметку: `hasTrustDialogAccepted = false` (умолчание самого CLI); прочие поля записи остаются. */
export async function withdrawClaudeFolderTrust(file: string, folder: string, options: ClaudeTrustOptions = {}): Promise<ClaudeTrustOutcome> {
  const result = await editClaudeState(file, (data) => {
    const projects = data['projects'];
    if (projects === undefined) return 'unchanged';
    if (!isRecord(projects)) return 'unreadable';
    const entry = projects[folder];
    if (entry === undefined) return 'unchanged';
    if (!isRecord(entry)) return 'unreadable';
    if (entry['hasTrustDialogAccepted'] !== true) return 'unchanged';
    return { ...data, projects: { ...projects, [folder]: { ...entry, hasTrustDialogAccepted: false } } };
  }, options);
  return result === 'changed' ? 'written' : result === 'unchanged' ? 'absent' : result;
}

/** Отметка, которую поставил Parley: папка (realpath) в файле состояния профиля (путь, как его выбрал `claudeStateFile`). */
export interface ClaudeTrustMark {
  folder: string;
  file: string;
  at: string;
}

interface MarksFile {
  version: 1;
  marks: ClaudeTrustMark[];
}

export function claudeTrustMarksFile(home: string): string {
  return path.join(home, 'claude-trust-marks.json');
}

/** Нет файла — отметок нет. Битый — ошибка: отметки, которые нельзя прочитать, нельзя и снять, новых не ставим. */
export async function readClaudeTrustMarks(home: string): Promise<ClaudeTrustMark[]> {
  let raw: string;
  try {
    raw = await readFile(claudeTrustMarksFile(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['marks'])) throw new Error('claude-trust-marks: unknown format');
  return parsed['marks'].filter((mark): mark is ClaudeTrustMark =>
    isRecord(mark) && typeof mark['folder'] === 'string' && typeof mark['file'] === 'string' && typeof mark['at'] === 'string');
}

async function writeMarks(home: string, marks: ClaudeTrustMark[]): Promise<void> {
  const target = claudeTrustMarksFile(home);
  await mkdir(home, { recursive: true });
  const tmp = `${target}.${randomUUID()}.tmp`;
  const file: MarksFile = { version: 1, marks };
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Одна очередь процесса на отметки: проверка `trust.json` с записью отметки при запуске и снятие при отзыве не
 * перемежаются, и файл отметок не теряет строк от одновременных запусков.
 */
export function serialClaudeTrust<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Отмечает папку принятой и записывает отметку как свою. Намерение пишется до правки файла Claude: сбой между ними
 * оставит лишнюю строку, а не отметку, которую нельзя снять. Строка остаётся, только если отметку поставили мы сейчас
 * (`written`) или раньше (строка уже была); чужую `present` — отметку человека — своей не считаем. Звать в очереди.
 */
export async function markClaudeFolderTrust(home: string, file: string, folder: string, options: ClaudeTrustOptions = {}): Promise<ClaudeTrustOutcome> {
  const marks = await readClaudeTrustMarks(home);
  const known = marks.some((mark) => mark.folder === folder && mark.file === file);
  if (!known) await writeMarks(home, [...marks, { folder, file, at: new Date().toISOString() }]);
  let outcome: ClaudeTrustOutcome;
  try {
    outcome = await acceptClaudeFolderTrust(file, folder, options);
  } catch (error) {
    if (!known) await dropMarks(home, (mark) => mark.folder === folder && mark.file === file);
    throw error;
  }
  if (!known && outcome !== 'written') await dropMarks(home, (mark) => mark.folder === folder && mark.file === file);
  return outcome;
}

async function dropMarks(home: string, match: (mark: ClaudeTrustMark) => boolean): Promise<void> {
  const marks = await readClaudeTrustMarks(home);
  const left = marks.filter((mark) => !match(mark));
  if (left.length !== marks.length) await writeMarks(home, left);
}

/**
 * Снимает свои отметки, которые выбирает `match` (папка отозвана). Строка уходит, когда отметки в файле больше нет
 * (`written`, `absent`, `no-config`); занятый или нечитаемый файл оставляет её до следующей попытки — при следующем
 * запуске Claude (`syncClaudeTrust`). Возвращает строки для лога, без содержимого файлов. Звать в очереди.
 */
export async function withdrawClaudeTrustMarks(home: string, match: (mark: ClaudeTrustMark) => boolean, options: ClaudeTrustOptions = {}): Promise<string[]> {
  const warnings: string[] = [];
  const done = new Set<ClaudeTrustMark>();
  const marks = (await readClaudeTrustMarks(home)).filter(match);
  for (const mark of marks) {
    let outcome: ClaudeTrustOutcome | string;
    try {
      outcome = await withdrawClaudeFolderTrust(mark.file, mark.folder, options);
    } catch (error) {
      outcome = (error as NodeJS.ErrnoException).code ?? 'error';
    }
    if (outcome === 'written' || outcome === 'absent' || outcome === 'no-config') done.add(mark);
    else warnings.push(`Parley could not remove its trust mark for ${mark.folder} from ${mark.file} (${outcome}); it retries on the next Claude Code launch.`);
  }
  if (done.size > 0) {
    await dropMarks(home, (mark) => [...done].some((item) => item.folder === mark.folder && item.file === mark.file));
  }
  return warnings;
}
