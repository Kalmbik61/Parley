import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SKILL_MD, SKILL_NAME } from './skill.js';

const run = promisify(execFile);

/**
 * Установка скилла `harnas` в проект и в worktree сессий (образец — Orca, `agent-skill-provider-paths`;
 * пути и симлинки — открытая документация провайдеров).
 *
 * - Канонная копия — `<корень>/.agents/skills/harnas/SKILL.md`: Codex читает `.agents/skills` от текущего
 *   каталога до корня репозитория (developers.openai.com/codex/skills, «Build skills»).
 * - Для Claude Code — относительный симлинк `<корень>/.claude/skills/harnas` → `../../.agents/skills/harnas`:
 *   документация Claude Code («Extend Claude with skills») разрешает папке навыка быть симлинком, а
 *   `.agents/skills` он не читает. Симлинк нельзя (файловая система, права) — копия, и это записано в учёте.
 * - Корни — папка проекта и worktree сессии: Codex и Claude Code ищут навыки только до корня своей
 *   рабочей копии, а worktree — другая копия. В `~/.claude`, `~/.codex` и `~/.agents` ничего не пишется.
 * - Учёт своего — `<проект>/.harnas/skills-receipt.json`: путь и его содержимое. Что в учёте и не тронуто
 *   человеком — своё, его обновляют; что уже есть, а в учёте нет, — чужое, к нему не прикасаются.
 * - От git всё скрыто строками в `info/exclude` общего каталога репозитория: файлы не попадают ни в
 *   `git status`, ни в «Commit all» окна.
 *
 * Функция быстрая и идемпотентная: повторный вызов читает учёт и пару файлов и ничего не пишет.
 */

const SKILL_DIR = ['.agents', 'skills', SKILL_NAME] as const;
const ALIAS_DIR = ['.claude', 'skills', SKILL_NAME] as const;
/** Куда ведёт симлинк, если считать от каталога `.claude/skills`. */
const ALIAS_TARGET = path.join('..', '..', ...SKILL_DIR);
const SKILL_FILE = 'SKILL.md';
/** Комментарий к своим строкам в `info/exclude`: человек, открывший файл, узнает, откуда они. */
const EXCLUDE_MARKER = '# harnas: скилл агентов, ставится харнессом';

/**
 * Что записано в учёте про свой путь. `dir` и `copy` держат хеш `SKILL.md`, который харнесс положил: по
 * нему видно, правил ли файл человек. `symlink` — куда ссылка вела при установке.
 */
type ReceiptEntry = { kind: 'dir' | 'copy'; sha256: string } | { kind: 'symlink'; target: string };

interface Receipt {
  version: 1;
  /** Ключ — абсолютный путь папки навыка (у симлинка — самой ссылки). */
  entries: Record<string, ReceiptEntry>;
}

/**
 * Почему путь не тронут:
 * - `foreign` — путь уже есть, а в учёте его нет: чужой навык (в том числе закоммиченный в репозиторий);
 * - `edited` — путь в учёте, но человек его изменил (правил `SKILL.md`, заменил папку): правку не затираем;
 * - `unsafe` — по дороге к пути лежит симлинк или файл вместо каталога: через ссылку не пишем, иначе
 *   `.claude` → `~/.claude` в чужом репозитории увёл бы запись в каталог агента.
 */
export type SkillSkipReason = 'foreign' | 'edited' | 'unsafe';

export interface SkillSkip {
  path: string;
  reason: SkillSkipReason;
}

export interface SkillInstallResult {
  /** Пути, к которым харнесс не прикоснулся, — хост пишет их в лог и, для чужих, в `host.notice`. */
  skipped: SkillSkip[];
  /** Что создано или обновлено в этот вызов; пусто — всё уже было в порядке. */
  written: string[];
}

export interface SkillInstallOptions {
  /** Папка проекта: её корень получает скилл, и в её `.harnas/` лежит учёт. */
  projectPath: string;
  /** Worktree сессии, если он уже есть на диске; его корень получает скилл тоже. */
  worktreePath?: string;
  /** Как класть симлинк. По умолчанию `fs.symlink`; подмена нужна тесту запасной копии. */
  symlink?: (target: string, linkPath: string) => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEntry = (value: unknown): value is ReceiptEntry =>
  isRecord(value) &&
  (value['kind'] === 'symlink'
    ? typeof value['target'] === 'string'
    : (value['kind'] === 'dir' || value['kind'] === 'copy') && typeof value['sha256'] === 'string');

const sha256 = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** `lstat` без следования по симлинку; `null` — пути нет. */
async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null;
    throw error;
  }
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return null;
    throw error;
  }
}

/** Временный файл и `rename`: агент, стартующий в этот миг, читает либо старый файл, либо новый целиком. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const temp = `${file}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, file);
}

/**
 * Учёт с диска. Нет файла или он не читается — пустой: тогда всё существующее считается чужим и не
 * трогается, а это безопасная сторона ошибки.
 */
async function readReceipt(file: string): Promise<Receipt> {
  const receipt: Receipt = { version: 1, entries: {} };
  const raw = await readOrNull(file).catch(() => null);
  if (raw === null) return receipt;
  try {
    const data: unknown = JSON.parse(raw.toString('utf8'));
    const entries = isRecord(data) ? data['entries'] : undefined;
    if (!isRecord(entries)) return receipt;
    // Запись, которую не разобрать (файл правили руками), в учёт не идёт: путь останется чужим.
    for (const [target, entry] of Object.entries(entries)) {
      if (isEntry(entry)) receipt.entries[target] = entry;
    }
  } catch {
    // Битый JSON — пустой учёт.
  }
  return receipt;
}

async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

/**
 * Каталоги по дороге от корня к папке навыка — настоящие каталоги или ещё не созданы. Симлинк или файл
 * на пути — отказ: запись пошла бы за ссылкой, а в чужом репозитории `.claude` может вести в `~/.claude`.
 */
async function parentsAreSafe(root: string, segments: readonly string[]): Promise<boolean> {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await lstatOrNull(current);
    if (info === null) return true;
    if (!info.isDirectory()) return false;
  }
  return true;
}

/**
 * Корень, в который писать нельзя: домашняя папка сама (тогда `.claude` и `.agents` под ней — каталоги
 * агентов) и сами каталоги агентов внутри неё. Проект «в `~`» — редкий, но возможный выбор человека, а
 * рамка проекта не терпит записи в `~/.claude`, `~/.codex` и `~/.agents` ни при каких условиях.
 */
async function isAgentHome(root: string): Promise<boolean> {
  const resolve = (target: string): Promise<string> =>
    realpath(target).catch(() => path.resolve(target));
  const home = await resolve(homedir());
  const actual = await resolve(root);
  if (actual === home) return true;
  return ['.claude', '.codex', '.agents'].some((name) => {
    const dir = path.join(home, name);
    return actual === dir || actual.startsWith(`${dir}${path.sep}`);
  });
}

/** Состояние одного прохода: учёт с его файлом, что он изменился, и накопленный результат. */
interface Pass {
  receipt: Receipt;
  receiptFile: string;
  dirty: boolean;
  result: SkillInstallResult;
  symlink: NonNullable<SkillInstallOptions['symlink']>;
}

/** Правит запись учёта в памяти; на диск она уйдёт в конце прохода (`saveReceipt`). */
function record(pass: Pass, target: string, entry: ReceiptEntry): void {
  pass.receipt.entries[target] = entry;
  pass.dirty = true;
}

/**
 * Своё, ещё не созданное: запись ложится в учёт на диске ДО самого пути. Сбой между ними оставит запись про
 * несуществующий путь — его создадут заново, а не файл без записи, который при следующем запуске сочли бы
 * чужим и не обновляли бы никогда.
 */
async function claim(pass: Pass, target: string, entry: ReceiptEntry): Promise<void> {
  pass.receipt.entries[target] = entry;
  await writeReceipt(pass.receiptFile, pass.receipt);
}

function skip(pass: Pass, target: string, reason: SkillSkipReason): void {
  pass.result.skipped.push({ path: target, reason });
}

/**
 * Папка с `SKILL.md` — канонная копия или запасная копия для Claude Code. `true` — папка своя и в
 * порядке (или приведена в порядок); `false` — чужая, правленная или небезопасная, её не тронули.
 */
async function ensureCopy(
  pass: Pass,
  root: string,
  segments: readonly string[],
  kind: 'dir' | 'copy',
): Promise<boolean> {
  const dir = path.join(root, ...segments);
  const file = path.join(dir, SKILL_FILE);
  const wanted = sha256(SKILL_MD);
  if (!(await parentsAreSafe(root, segments))) {
    skip(pass, dir, 'unsafe');
    return false;
  }

  const info = await lstatOrNull(dir);
  if (info === null) {
    await claim(pass, dir, { kind, sha256: wanted });
    await mkdir(dir, { recursive: true });
    await writeAtomic(file, SKILL_MD);
    pass.result.written.push(dir);
    return true;
  }

  const entry = pass.receipt.entries[dir];
  if (entry === undefined) {
    skip(pass, dir, 'foreign');
    return false;
  }
  // В учёте, но это уже не наша папка (заменена файлом или ссылкой) или запись про другой вид пути.
  if (entry.kind === 'symlink' || entry.kind !== kind || !info.isDirectory()) {
    skip(pass, dir, 'edited');
    return false;
  }

  const current = await readOrNull(file);
  if (current === null) {
    // Папка наша, файла в ней нет: человек его убрал или прервалась запись — возвращаем.
    await writeAtomic(file, SKILL_MD);
    record(pass, dir, { kind, sha256: wanted });
    pass.result.written.push(dir);
    return true;
  }
  // Свой файл — тот, что харнесс положил по учёту, и тот, что положил бы сейчас: второй бывает, когда
  // обновление успело записать файл, а учёт нет.
  const seen = sha256(current);
  if (seen !== entry.sha256 && seen !== wanted) {
    skip(pass, dir, 'edited');
    return false;
  }
  if (seen !== wanted) {
    await writeAtomic(file, SKILL_MD);
    pass.result.written.push(dir);
  }
  if (entry.sha256 !== wanted) record(pass, dir, { kind, sha256: wanted });
  return true;
}

/**
 * Путь для Claude Code: относительный симлинк на канонную копию, а если ссылку положить нельзя, — копия.
 * Зовётся, только когда канонная копия своя: иначе ссылка вела бы на чужой навык.
 */
async function ensureAlias(pass: Pass, root: string): Promise<void> {
  const link = path.join(root, ...ALIAS_DIR);
  if (!(await parentsAreSafe(root, ALIAS_DIR))) {
    skip(pass, link, 'unsafe');
    return;
  }

  const info = await lstatOrNull(link);
  if (info === null) {
    await claim(pass, link, { kind: 'symlink', target: ALIAS_TARGET });
    await mkdir(path.dirname(link), { recursive: true });
    try {
      await pass.symlink(ALIAS_TARGET, link);
      pass.result.written.push(link);
    } catch {
      // Файловая система или права ссылок не дают: тот же навык, но копией — она тоже в учёте. Записи про
      // ссылку, которой нет, в учёте не остаётся: путь свободен, и копия встанет на него как новая.
      delete pass.receipt.entries[link];
      await ensureCopy(pass, root, ALIAS_DIR, 'copy');
    }
    return;
  }

  const entry = pass.receipt.entries[link];
  if (entry === undefined) {
    skip(pass, link, 'foreign');
    return;
  }
  if (entry.kind === 'symlink') {
    const intact = info.isSymbolicLink() && (await readlink(link)) === entry.target;
    if (!intact) skip(pass, link, 'edited');
    return;
  }
  await ensureCopy(pass, root, ALIAS_DIR, 'copy');
}

/** Один корень: канонная копия и, если она своя, путь для Claude Code. */
async function installInRoot(pass: Pass, root: string): Promise<void> {
  if (await ensureCopy(pass, root, SKILL_DIR, 'dir')) await ensureAlias(pass, root);
}

/**
 * Где лежит общий каталог репозитория и как называется корень относительно вершины рабочей копии.
 * `null` — не репозиторий или git не отвечает: скрывать нечего. Пробы зовут git с `core.fsmonitor=false`
 * (как остальные вызовы git в core): программа из конфигурации репозитория здесь не нужна.
 */
async function gitLocation(root: string): Promise<{ commonDir: string; prefix: string } | null> {
  try {
    const { stdout } = await run(
      'git',
      ['-c', 'core.fsmonitor=false', '-C', root, 'rev-parse', '--git-common-dir', '--show-prefix'],
      { timeout: 5000 },
    );
    const [common = '', prefix = ''] = stdout.split('\n');
    return common === '' ? null : { commonDir: path.resolve(root, common), prefix };
  } catch {
    return null;
  }
}

/** Шаблон gitignore для пути внутри рабочей копии: якорь в её вершине, служебные знаки экранированы. */
const excludePattern = (prefix: string, segments: readonly string[]): string =>
  `/${prefix.replace(/[\\*?[\]]/g, '\\$&')}${segments.join('/')}`;

/**
 * Дописывает в `info/exclude` только недостающие строки: чужие не трогаются и не переставляются, файл,
 * оставшийся без перевода строки в конце, продолжается с новой строки. `info/exclude` общий у всех
 * worktree репозитория, поэтому строк для worktree сессии отдельного файла не требуют.
 */
async function ensureExclude(commonDir: string, lines: readonly string[]): Promise<void> {
  const file = path.join(commonDir, 'info', 'exclude');
  const current = (await readOrNull(file))?.toString('utf8') ?? '';
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) return;

  const marker = present.has(EXCLUDE_MARKER) ? [] : [EXCLUDE_MARKER];
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${separator}${[...marker, ...missing].join('\n')}\n`, 'utf8');
}

/**
 * Очередь по проекту: хост запускает сессии пачками (комната из четырёх агентов, `autoLaunch`), и два
 * прохода одного проекта, читающие учёт одновременно, приняли бы свежую папку соседа за чужую. Ключ —
 * файл учёта: он один на проект.
 */
const queues = new Map<string, Promise<void>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return next;
}

/**
 * Ставит скилл в проект и в worktree сессии. Не бросает из-за «чужого»: такие пути возвращаются в
 * `skipped`. Бросает только настоящий сбой ввода-вывода — хост его логирует и запускает сессию дальше.
 * Корень, которого нет на диске или который — каталог агента, пропускается молча: `mkdir -p` воскресил
 * бы пропавший worktree пустой папкой.
 */
export function installAgentSkill(options: SkillInstallOptions): Promise<SkillInstallResult> {
  const receiptFile = path.join(options.projectPath, '.harnas', 'skills-receipt.json');
  return serialized(receiptFile, () => installNow(options, receiptFile));
}

async function installNow(
  options: SkillInstallOptions,
  receiptFile: string,
): Promise<SkillInstallResult> {
  const pass: Pass = {
    receipt: await readReceipt(receiptFile),
    receiptFile,
    dirty: false,
    result: { skipped: [], written: [] },
    symlink: options.symlink ?? symlink,
  };

  const roots: string[] = [];
  for (const root of [options.projectPath, options.worktreePath]) {
    if (root === undefined) continue;
    const info = await lstatOrNull(root);
    if (info === null || !info.isDirectory()) continue;
    if (await isAgentHome(root)) continue;
    roots.push(root);
  }

  try {
    for (const root of roots) await installInRoot(pass, root);
  } finally {
    // Учёт пишется и при сбое посреди прохода: то, что успело лечь на диск, должно остаться своим, а
    // не стать «чужим» при следующем запуске.
    await saveReceipt(pass);
  }

  await hideFromGit(options.projectPath, roots, pass.receipt);
  return pass.result;
}

/** Убирает из учёта пути, которых больше нет (удалённые worktree, убранное человеком), и пишет его, если он изменился. */
async function saveReceipt(pass: Pass): Promise<void> {
  for (const target of Object.keys(pass.receipt.entries)) {
    if ((await lstatOrNull(target)) === null) {
      delete pass.receipt.entries[target];
      pass.dirty = true;
    }
  }
  if (pass.dirty) await writeReceipt(pass.receiptFile, pass.receipt);
}

/**
 * Прячет свои пути от git строками в `info/exclude`: только те, что в учёте, — чужой навык
 * (закоммиченный, например) остаётся видимым. Вершину рабочей копии и общий каталог спрашивают у git один
 * раз для проекта; корень worktree — вершина своей копии того же репозитория, отдельной пробы ему не нужно.
 */
async function hideFromGit(projectPath: string, roots: string[], receipt: Receipt): Promise<void> {
  const oursIn = (root: string): (readonly string[])[] =>
    [SKILL_DIR, ALIAS_DIR].filter(
      (segments) => receipt.entries[path.join(root, ...segments)] !== undefined,
    );
  if (roots.every((root) => oursIn(root).length === 0)) return;

  const location = await gitLocation(projectPath);
  if (location === null) return;
  // Строки у корней совпадают (вершина копии — везде `/.agents/…`), а недостающими считаются относительно
  // файла до записи: без свёртки повторов одна и та же строка легла бы дважды.
  const lines = new Set(
    roots.flatMap((root) =>
      oursIn(root).map((segments) =>
        excludePattern(root === projectPath ? location.prefix : '', segments),
      ),
    ),
  );
  await ensureExclude(location.commonDir, [...lines]).catch(() => {
    // Файл исключений — удобство: не вышло записать, скилл всё равно на месте.
  });
}
