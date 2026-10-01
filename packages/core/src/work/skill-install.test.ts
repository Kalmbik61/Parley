import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installAgentSkill } from './skill-install.js';
import { SKILL_MD } from './skill.js';

const run = promisify(execFile);
const git = async (dir: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', dir, ...args])).stdout;

let root = '';
let project = '';
let savedHome: string | undefined;

beforeEach(async () => {
  // realpath: на macOS `tmpdir()` лежит за симлинком, а корень скилла сверяется с realpath домашней папки.
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-skill-')));
  project = path.join(root, 'project');
  await mkdir(project);
  savedHome = process.env['HOME'];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  await rm(root, { recursive: true, force: true });
});

/** Репозиторий с одним коммитом на `main`. */
async function initRepo(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await run('git', ['init', '-b', 'main', dir]);
  await git(dir, 'config', 'user.email', 'тест@parley');
  await git(dir, 'config', 'user.name', 'тест');
  await writeFile(path.join(dir, 'README.md'), 'старт\n', 'utf8');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-m', 'первый');
}

const canonical = (dir: string): string => path.join(dir, '.agents', 'skills', 'parley');
const alias = (dir: string): string => path.join(dir, '.claude', 'skills', 'parley');
const receiptFile = (dir: string): string => path.join(dir, '.parley', 'skills-receipt.json');
const readReceipt = async (
  dir: string,
): Promise<{ version: number; entries: Record<string, Record<string, string>> }> =>
  JSON.parse(await readFile(receiptFile(dir), 'utf8'));
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Метка своих строк в `info/exclude` (`# <имя скилла>: …`), та же метка в записи сборок до перевода текстов
 * (она по-прежнему своя) и метка прежней установки под именем `harnas`.
 */
const MARKER = '# parley: agent skill, installed by Parley';
const RUSSIAN_MARKER = '# parley: скилл агентов, ставится Parley';
const LEGACY_MARKER = '# harnas: скилл агентов, ставится харнессом';
/** Шаблоны путей своих строк в `info/exclude` и сколько раз строка встречается в тексте файла. */
const PATTERNS = ['/.agents/skills/parley', '/.claude/skills/parley'];
const count = (text: string, line: string): number =>
  text.split('\n').filter((item) => item === line).length;
const exists = (target: string): Promise<boolean> =>
  lstat(target).then(
    () => true,
    () => false,
  );
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `git status --porcelain` папки: скилл в нём не виден, пока его строки лежат в `info/exclude`. */
const porcelain = (dir: string): Promise<string> => git(dir, 'status', '--porcelain', '-uall');

describe('установка с нуля', () => {
  it('канонная копия и относительный симлинк на неё; учёт называет оба пути', async () => {
    await initRepo(project);
    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([canonical(project), alias(project)]);
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    // Симлинк — относительный и указывает в канонную копию, а не в абсолютный путь этой машины.
    expect((await lstat(alias(project))).isSymbolicLink()).toBe(true);
    expect(await readlink(alias(project))).toBe(
      path.join('..', '..', '.agents', 'skills', 'parley'),
    );
    expect(await readFile(path.join(alias(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);

    expect(await readReceipt(project)).toEqual({
      version: 1,
      entries: {
        [canonical(project)]: { kind: 'dir', sha256: sha256(SKILL_MD) },
        [alias(project)]: { kind: 'symlink', target: '../../.agents/skills/parley' },
      },
    });
  });

  it('не git-проект: файлы на месте, ошибок нет, строк для git писать некуда', async () => {
    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([]);
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect((await lstat(alias(project))).isSymbolicLink()).toBe(true);
    expect(await exists(path.join(project, '.git'))).toBe(false);
  });

  it('повторный вызов ничего не меняет: ни файлов, ни учёта, ни info/exclude, written пуст', async () => {
    await initRepo(project);
    await installAgentSkill({ projectPath: project });
    const touched = [
      path.join(canonical(project), 'SKILL.md'),
      receiptFile(project),
      path.join(project, '.git', 'info', 'exclude'),
    ];
    const before = await Promise.all(
      touched.map(async (file) => ({
        text: await readFile(file, 'utf8'),
        at: (await stat(file)).mtimeMs,
      })),
    );
    await delay(30);

    const again = await installAgentSkill({ projectPath: project });

    expect(again).toEqual({ skipped: [], written: [], removed: [] });
    const after = await Promise.all(
      touched.map(async (file) => ({
        text: await readFile(file, 'utf8'),
        at: (await stat(file)).mtimeMs,
      })),
    );
    expect(after).toEqual(before);
  });
});

describe('обновление своего', () => {
  /** Как будто скилл поставила прошлая версия харнесса: файл и запись учёта — про старый текст. */
  async function backdate(dir: string, target: string, old: string): Promise<void> {
    await writeFile(path.join(target, 'SKILL.md'), old, 'utf8');
    const receipt = await readReceipt(dir);
    receipt.entries[target] = { ...receipt.entries[target], sha256: sha256(old) };
    await writeFile(receiptFile(dir), JSON.stringify(receipt), 'utf8');
  }

  it('устаревший SKILL.md заменяется текущей заглушкой; симлинк и остальное не тронуты', async () => {
    await installAgentSkill({ projectPath: project });
    await backdate(project, canonical(project), 'старая заглушка\n');

    const result = await installAgentSkill({ projectPath: project });

    expect(result).toEqual({ skipped: [], written: [canonical(project)], removed: [] });
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect((await readReceipt(project)).entries[canonical(project)]).toEqual({
      kind: 'dir',
      sha256: sha256(SKILL_MD),
    });
    // Ссылка вела в ту же папку и ведёт: обновлять её нечем и незачем.
    expect(await readlink(alias(project))).toBe('../../.agents/skills/parley');
  });

  it('обновление успело записать файл, а учёт нет: файл — свой, учёт чинится без записи файла', async () => {
    await installAgentSkill({ projectPath: project });
    const receipt = await readReceipt(project);
    receipt.entries[canonical(project)] = { kind: 'dir', sha256: sha256('старая заглушка\n') };
    await writeFile(receiptFile(project), JSON.stringify(receipt), 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result).toEqual({ skipped: [], written: [], removed: [] });
    expect((await readReceipt(project)).entries[canonical(project)]).toEqual({
      kind: 'dir',
      sha256: sha256(SKILL_MD),
    });
  });

  it('запасная копия обновляется так же, как канонная', async () => {
    const failing = async (): Promise<void> => {
      throw Object.assign(new Error('нельзя'), { code: 'EPERM' });
    };
    await installAgentSkill({ projectPath: project, symlink: failing });
    await backdate(project, alias(project), 'старая копия\n');

    const result = await installAgentSkill({ projectPath: project, symlink: failing });

    expect(result).toEqual({ skipped: [], written: [alias(project)], removed: [] });
    expect(await readFile(path.join(alias(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
  });

  it('запись атомарная: временный файл после обновления не остаётся', async () => {
    await installAgentSkill({ projectPath: project });
    await backdate(project, canonical(project), 'старая заглушка\n');
    await installAgentSkill({ projectPath: project });

    expect(await readdir(canonical(project))).toEqual(['SKILL.md']);
  });

  it('убранный человеком SKILL.md возвращается: папка своя, файла в ней нет', async () => {
    await installAgentSkill({ projectPath: project });
    await rm(path.join(canonical(project), 'SKILL.md'));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.written).toEqual([canonical(project)]);
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
  });

  it('убранная человеком папка навыка ставится заново вместе со ссылкой', async () => {
    await installAgentSkill({ projectPath: project });
    await rm(path.join(project, '.agents'), { recursive: true });
    await rm(path.join(project, '.claude'), { recursive: true });

    const result = await installAgentSkill({ projectPath: project });

    expect(result.written).toEqual([canonical(project), alias(project)]);
    expect(await readFile(path.join(alias(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
  });
});

describe('чужое и правленное не трогается', () => {
  it('чужая канонная папка на месте, ссылка на неё не ставится, в учёте пусто', async () => {
    await mkdir(canonical(project), { recursive: true });
    await writeFile(path.join(canonical(project), 'SKILL.md'), 'чужой навык\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result).toEqual({
      skipped: [{ path: canonical(project), reason: 'foreign' }],
      written: [],
      removed: [],
    });
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe('чужой навык\n');
    expect(await exists(alias(project))).toBe(false);
    expect(await exists(receiptFile(project))).toBe(false);
  });

  it('чужая ссылка Claude Code на месте: канонная копия ставится, ссылка не тронута', async () => {
    await mkdir(path.dirname(alias(project)), { recursive: true });
    await mkdir(path.join(project, 'свой-навык'));
    await symlink(path.join('..', '..', 'свой-навык'), alias(project));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: alias(project), reason: 'foreign' }]);
    expect(result.written).toEqual([canonical(project)]);
    expect(await readlink(alias(project))).toBe(path.join('..', '..', 'свой-навык'));
    expect(Object.keys((await readReceipt(project)).entries)).toEqual([canonical(project)]);
  });

  it('чужая папка вместо ссылки тоже остаётся как есть', async () => {
    await mkdir(alias(project), { recursive: true });
    await writeFile(path.join(alias(project), 'SKILL.md'), 'копия чужого\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: alias(project), reason: 'foreign' }]);
    expect(await readFile(path.join(alias(project), 'SKILL.md'), 'utf8')).toBe('копия чужого\n');
  });

  it('повторные вызовы по-прежнему не трогают чужое и по-прежнему о нём сообщают', async () => {
    await mkdir(canonical(project), { recursive: true });
    await writeFile(path.join(canonical(project), 'SKILL.md'), 'чужой навык\n', 'utf8');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await installAgentSkill({ projectPath: project });
      expect(result.skipped, `вызов ${attempt}`).toEqual([
        { path: canonical(project), reason: 'foreign' },
      ]);
    }
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe('чужой навык\n');
  });

  it('свой SKILL.md, правленный человеком, не затирается новой заглушкой', async () => {
    await installAgentSkill({ projectPath: project });
    const file = path.join(canonical(project), 'SKILL.md');
    await writeFile(file, `${SKILL_MD}\nмои правила проекта\n`, 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result).toEqual({
      skipped: [{ path: canonical(project), reason: 'edited' }],
      written: [],
      removed: [],
    });
    expect(await readFile(file, 'utf8')).toBe(`${SKILL_MD}\nмои правила проекта\n`);
    // Учёт прежний: правка человека — не повод забыть, что папка когда-то была нашей.
    expect((await readReceipt(project)).entries[canonical(project)]).toEqual({
      kind: 'dir',
      sha256: sha256(SKILL_MD),
    });
  });

  it('своя папка, заменённая файлом или ссылкой, — правка человека, а не повод писать поверх', async () => {
    await installAgentSkill({ projectPath: project });
    await rm(canonical(project), { recursive: true });
    await mkdir(path.join(project, 'другое'));
    await symlink(path.join(project, 'другое'), canonical(project));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: canonical(project), reason: 'edited' }]);
    expect(await readdir(path.join(project, 'другое'))).toEqual([]);
  });

  it('своя ссылка, перенаправленная человеком, не переписывается', async () => {
    await installAgentSkill({ projectPath: project });
    await rm(alias(project));
    await symlink(path.join('..', '..', 'другое'), alias(project));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: alias(project), reason: 'edited' }]);
    expect(await readlink(alias(project))).toBe(path.join('..', '..', 'другое'));
  });

  it('учёт не читается (битый JSON) — всё существующее чужое; на пустом месте ставится и учёт чинится', async () => {
    await installAgentSkill({ projectPath: project });
    await writeFile(receiptFile(project), '{это не JSON', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.written).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(['foreign']);

    const fresh = path.join(root, 'fresh');
    await mkdir(path.join(fresh, '.parley'), { recursive: true });
    await writeFile(receiptFile(fresh), '{это не JSON', 'utf8');
    const installed = await installAgentSkill({ projectPath: fresh });
    expect(installed.skipped).toEqual([]);
    expect((await readReceipt(fresh)).version).toBe(1);
  });

  it('запись учёта, которую не разобрать (null, чужая форма), не роняет вызов и не делает путь своим', async () => {
    await installAgentSkill({ projectPath: project });
    const receipt = await readReceipt(project);
    receipt.entries[canonical(project)] = null as unknown as Record<string, string>;
    receipt.entries[alias(project)] = { kind: 'что-то' };
    await writeFile(receiptFile(project), JSON.stringify(receipt), 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([{ path: canonical(project), reason: 'foreign' }]);
  });
});

describe('корень — ссылка на каталог', () => {
  it('путь проекта, заданный симлинком на каталог, годится: скилл ложится в каталог за ссылкой', async () => {
    const real = path.join(root, 'настоящий');
    const link = path.join(root, 'ссылка');
    await mkdir(real);
    await symlink(real, link);

    const result = await installAgentSkill({ projectPath: link });

    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([canonical(link), alias(link)]);
    expect(await readFile(path.join(real, '.agents', 'skills', 'parley', 'SKILL.md'), 'utf8')).toBe(
      SKILL_MD,
    );
    expect(await installAgentSkill({ projectPath: link })).toEqual({ skipped: [], written: [], removed: [] });
  });
});

describe('запись за симлинк не идёт', () => {
  it('подложенная ссылка на месте временного файла не уводит запись: ни SKILL.md.tmp, ни учёта', async () => {
    await installAgentSkill({ projectPath: project });
    const victim = path.join(root, 'жертва.txt');
    await writeFile(victim, 'не трогать\n', 'utf8');
    // Обновление своего файла и записи учёта пойдут через временные файлы — оба на месте занимают ссылки.
    const receipt = await readReceipt(project);
    receipt.entries[canonical(project)] = { kind: 'dir', sha256: sha256('старая заглушка\n') };
    await writeFile(path.join(canonical(project), 'SKILL.md'), 'старая заглушка\n', 'utf8');
    await writeFile(receiptFile(project), JSON.stringify(receipt), 'utf8');
    await symlink(victim, path.join(canonical(project), 'SKILL.md.tmp'));
    await symlink(victim, `${receiptFile(project)}.tmp`);

    const result = await installAgentSkill({ projectPath: project });

    expect(result.written).toEqual([canonical(project)]);
    expect(await readFile(victim, 'utf8')).toBe('не трогать\n');
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(await readdir(canonical(project))).toEqual(['SKILL.md']);
    expect((await readReceipt(project)).entries[canonical(project)]).toEqual({
      kind: 'dir',
      sha256: sha256(SKILL_MD),
    });
  });

  it('.claude — ссылка на другой каталог: в него ничего не пишется, канонная копия ставится', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(project, '.claude'));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: alias(project), reason: 'unsafe' }]);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
  });

  it('.agents — ссылка на другой каталог: ни канонной копии, ни ссылки на неё', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(project, '.agents'));

    const result = await installAgentSkill({ projectPath: project });

    expect(result).toEqual({
      skipped: [{ path: canonical(project), reason: 'unsafe' }],
      written: [],
      removed: [],
    });
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await exists(path.join(project, '.claude'))).toBe(false);
  });

  it('.claude/skills — файл, а не каталог: отказ без записи', async () => {
    await mkdir(path.join(project, '.claude'));
    await writeFile(path.join(project, '.claude', 'skills'), 'файл\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: alias(project), reason: 'unsafe' }]);
    expect(await readFile(path.join(project, '.claude', 'skills'), 'utf8')).toBe('файл\n');
  });
});

describe('симлинк нельзя — запасная копия', () => {
  const denied = async (): Promise<void> => {
    throw Object.assign(new Error('операция не разрешена'), { code: 'EPERM' });
  };

  it('копия того же SKILL.md; в учёте она copy, а не symlink; повторный вызов ничего не пишет', async () => {
    const result = await installAgentSkill({ projectPath: project, symlink: denied });

    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([canonical(project), alias(project)]);
    expect((await lstat(alias(project))).isSymbolicLink()).toBe(false);
    expect((await lstat(alias(project))).isDirectory()).toBe(true);
    expect(await readFile(path.join(alias(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect((await readReceipt(project)).entries[alias(project)]).toEqual({
      kind: 'copy',
      sha256: sha256(SKILL_MD),
    });

    // Дальше симлинк, возможно, уже разрешён, но копия — своя, и её не заменяют.
    expect(await installAgentSkill({ projectPath: project })).toEqual({ skipped: [], written: [], removed: [] });
  });

  it('правленная человеком копия не затирается', async () => {
    await installAgentSkill({ projectPath: project, symlink: denied });
    await writeFile(path.join(alias(project), 'SKILL.md'), 'моя копия\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project, symlink: denied });

    expect(result.skipped).toEqual([{ path: alias(project), reason: 'edited' }]);
    expect(await readFile(path.join(alias(project), 'SKILL.md'), 'utf8')).toBe('моя копия\n');
  });

  it('копию тоже прячет info/exclude', async () => {
    await initRepo(project);
    await installAgentSkill({ projectPath: project, symlink: denied });

    const status = await porcelain(project);
    expect(status).not.toContain('.claude');
    expect(status).not.toContain('.agents');
  });
});

describe('скрыть от git: info/exclude', () => {
  const exclude = (dir: string): Promise<string> =>
    readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
  it('строки дописаны один раз: чужие остаются на месте, у своих — комментарий-метка', async () => {
    await initRepo(project);
    const original = await exclude(project);
    await installAgentSkill({ projectPath: project });
    await installAgentSkill({ projectPath: project });

    const text = await exclude(project);
    expect(text.startsWith(original)).toBe(true);
    for (const line of PATTERNS) expect(count(text, line), line).toBe(1);
    expect(count(text, MARKER)).toBe(1);
  });

  it('git status --porcelain не показывает ни канонную копию, ни симлинк', async () => {
    await initRepo(project);
    await installAgentSkill({ projectPath: project });

    const status = await porcelain(project);
    expect(status).not.toContain('.agents');
    expect(status).not.toContain('.claude');
    // Учёт лежит в `.parley/`, а созданный кодом каталог сам прячет себя от git: `.gitignore` со строкой `*` (R5).
    expect(status).not.toContain('.parley');
    expect(await readFile(path.join(project, '.parley', '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('файл без перевода строки в конце продолжается с новой строки, чужое не склеивается', async () => {
    await initRepo(project);
    const file = path.join(project, '.git', 'info', 'exclude');
    await writeFile(file, '*.log\nсвоё', 'utf8');

    await installAgentSkill({ projectPath: project });

    const text = await readFile(file, 'utf8');
    expect(text.startsWith('*.log\nсвоё\n# parley')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('часть строк уже есть — дописывается только недостающее, метка не дублируется', async () => {
    await initRepo(project);
    const file = path.join(project, '.git', 'info', 'exclude');
    await writeFile(file, `${MARKER}\n${PATTERNS[0]}\n`, 'utf8');

    await installAgentSkill({ projectPath: project });

    const text = await readFile(file, 'utf8');
    expect(count(text, PATTERNS[0] as string)).toBe(1);
    expect(count(text, PATTERNS[1] as string)).toBe(1);
    expect(count(text, MARKER)).toBe(1);
  });

  it('метка в прежней, русской записи — тоже своя: недостающее дописывается, второй метки нет', async () => {
    await initRepo(project);
    const file = path.join(project, '.git', 'info', 'exclude');
    await writeFile(file, `${RUSSIAN_MARKER}\n${PATTERNS[0]}\n`, 'utf8');

    await installAgentSkill({ projectPath: project });

    const text = await readFile(file, 'utf8');
    expect(count(text, PATTERNS[0] as string)).toBe(1);
    expect(count(text, PATTERNS[1] as string)).toBe(1);
    expect(count(text, RUSSIAN_MARKER)).toBe(1);
    expect(count(text, MARKER)).toBe(0);
  });

  it('файла и каталога info нет (git init --template без них) — создаются', async () => {
    await initRepo(project);
    await rm(path.join(project, '.git', 'info'), { recursive: true });

    await installAgentSkill({ projectPath: project });

    for (const line of PATTERNS) expect(await exclude(project)).toContain(line);
  });

  it('чужой навык не прячется: строк для него нет, git его видит', async () => {
    await initRepo(project);
    await mkdir(canonical(project), { recursive: true });
    await writeFile(path.join(canonical(project), 'SKILL.md'), 'чужой навык\n', 'utf8');
    const before = await exclude(project);

    await installAgentSkill({ projectPath: project });

    expect(await exclude(project)).toBe(before);
    expect(await porcelain(project)).toContain('.agents/skills/parley/SKILL.md');
  });

  it('проект в подкаталоге репозитория: строки с префиксом подкаталога, git status чист от скилла', async () => {
    await initRepo(root);
    const sub = path.join(root, 'apps', 'web');
    await mkdir(sub, { recursive: true });

    await installAgentSkill({ projectPath: sub });

    const text = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(text).toContain('/apps/web/.agents/skills/parley');
    expect(text).toContain('/apps/web/.claude/skills/parley');
    const status = await porcelain(root);
    expect(status).not.toContain('.agents');
    expect(status).not.toContain('.claude');
  });

  it('знаки шаблона в имени подкаталога экранируются: строка прячет ровно свой путь', async () => {
    await initRepo(root);
    const sub = path.join(root, 'we[ir]d*dir');
    await mkdir(sub, { recursive: true });
    // Соседи, которых неэкранированный шаблон задел бы: `[ir]` и `*` совпали бы и с ними.
    const neighbour = path.join(root, 'wei-dir');
    await mkdir(path.join(neighbour, '.agents', 'skills', 'parley'), { recursive: true });
    await writeFile(
      path.join(neighbour, '.agents', 'skills', 'parley', 'SKILL.md'),
      'сосед\n',
      'utf8',
    );

    await installAgentSkill({ projectPath: sub });

    const text = await readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
    expect(text).toContain('/we\\[ir\\]d\\*dir/.agents/skills/parley');
    const status = await porcelain(root);
    expect(status).toContain('wei-dir/.agents/skills/parley/SKILL.md');
    expect(status).not.toContain('we[ir]d*dir/.agents');
  });
});

describe('worktree сессии', () => {
  /** Worktree проекта: своя копия на своей ветке, как её заводит хост. */
  async function addWorktree(name = 'w-0001-s-02'): Promise<string> {
    const dir = path.join(root, 'worktrees', name);
    await mkdir(path.dirname(dir), { recursive: true });
    await git(project, 'worktree', 'add', '-b', `parley/${name}`, dir, 'main');
    return dir;
  }

  it('корень worktree получает скилл; строки — в общий info/exclude репозитория, без повторов', async () => {
    await initRepo(project);
    const worktree = await addWorktree();

    const result = await installAgentSkill({ projectPath: project, worktreePath: worktree });

    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([
      canonical(project),
      alias(project),
      canonical(worktree),
      alias(worktree),
    ]);
    expect(await readFile(path.join(alias(worktree), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(await readlink(alias(worktree))).toBe('../../.agents/skills/parley');

    // У worktree `.git` — файл: своего info/exclude там нет, а git читает общий каталог репозитория.
    expect((await lstat(path.join(worktree, '.git'))).isFile()).toBe(true);
    const common = await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(common.split('\n').filter((line) => line === '/.agents/skills/parley')).toHaveLength(1);
    expect(common.split('\n').filter((line) => line === '/.claude/skills/parley')).toHaveLength(1);

    for (const dir of [project, worktree]) {
      const status = await porcelain(dir);
      expect(status, dir).not.toContain('.agents');
      expect(status, dir).not.toContain('.claude');
    }
  });

  it('следующий запуск в том же worktree — без записей: пути в учёте свои', async () => {
    await initRepo(project);
    const worktree = await addWorktree();
    await installAgentSkill({ projectPath: project, worktreePath: worktree });

    const again = await installAgentSkill({ projectPath: project, worktreePath: worktree });

    expect(again).toEqual({ skipped: [], written: [], removed: [] });
  });

  it('второй worktree тоже получает скилл, а строк в exclude больше не становится', async () => {
    await initRepo(project);
    const first = await addWorktree('w-0001-s-02');
    const second = await addWorktree('w-0001-s-03');
    await installAgentSkill({ projectPath: project, worktreePath: first });
    const before = await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8');

    const result = await installAgentSkill({ projectPath: project, worktreePath: second });

    expect(result.written).toEqual([canonical(second), alias(second)]);
    expect(await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8')).toBe(before);
  });

  it('скилл, закоммиченный в репозиторий, в worktree — чужой: не тронут, о нём сообщено', async () => {
    await initRepo(project);
    await mkdir(canonical(project), { recursive: true });
    await writeFile(path.join(canonical(project), 'SKILL.md'), 'скилл команды\n', 'utf8');
    await git(project, 'add', '-f', '.agents');
    await git(project, 'commit', '-m', 'скилл команды');
    const worktree = await addWorktree();

    const result = await installAgentSkill({ projectPath: project, worktreePath: worktree });

    expect(result.skipped).toEqual([
      { path: canonical(project), reason: 'foreign' },
      { path: canonical(worktree), reason: 'foreign' },
    ]);
    expect(await readFile(path.join(canonical(worktree), 'SKILL.md'), 'utf8')).toBe(
      'скилл команды\n',
    );
  });

  it('worktree, которого нет на диске, не воскрешается пустой папкой', async () => {
    await initRepo(project);
    const gone = path.join(root, 'worktrees', 'исчез');

    const result = await installAgentSkill({ projectPath: project, worktreePath: gone });

    expect(result.written).toEqual([canonical(project), alias(project)]);
    expect(await exists(gone)).toBe(false);
  });

  it('записи удалённых worktree уходят из учёта; записи проекта остаются', async () => {
    await initRepo(project);
    const worktree = await addWorktree();
    await installAgentSkill({ projectPath: project, worktreePath: worktree });
    expect(Object.keys((await readReceipt(project)).entries)).toHaveLength(4);

    await git(project, 'worktree', 'remove', '--force', worktree);
    await installAgentSkill({ projectPath: project });

    expect(Object.keys((await readReceipt(project)).entries).sort()).toEqual(
      [canonical(project), alias(project)].sort(),
    );
  });
});

describe('прежняя установка под именем harnas (R8)', () => {
  const legacyCanonical = (dir: string): string => path.join(dir, '.agents', 'skills', 'harnas');
  const legacyAlias = (dir: string): string => path.join(dir, '.claude', 'skills', 'harnas');
  const LEGACY_PATTERNS = ['/.agents/skills/harnas', '/.claude/skills/harnas'];
  const OLD_STUB = 'заглушка скилла прежней сборки\n';
  const exclude = (dir: string): Promise<string> =>
    readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');

  /** Файлы прежней установки в корне: папка со `SKILL.md` и симлинк (или копия) для Claude Code. */
  async function legacyFiles(dir: string, copy = false): Promise<void> {
    await mkdir(legacyCanonical(dir), { recursive: true });
    await writeFile(path.join(legacyCanonical(dir), 'SKILL.md'), OLD_STUB, 'utf8');
    await mkdir(path.dirname(legacyAlias(dir)), { recursive: true });
    if (copy) {
      await mkdir(legacyAlias(dir));
      await writeFile(path.join(legacyAlias(dir), 'SKILL.md'), OLD_STUB, 'utf8');
    } else {
      await symlink(path.join('..', '..', '.agents', 'skills', 'harnas'), legacyAlias(dir));
    }
  }

  /**
   * Учёт, каким его оставила прошлая сборка: записи про прежние пути корней `roots` в каталоге состояния
   * проекта (по умолчанию — прежнем `.harnas`: проект ещё не переносили).
   */
  async function legacyReceipt(
    dir: string,
    roots: readonly string[],
    { state = '.harnas', copy = false }: { state?: string; copy?: boolean } = {},
  ): Promise<void> {
    const entries: Record<string, unknown> = {};
    for (const at of roots) {
      entries[legacyCanonical(at)] = { kind: 'dir', sha256: sha256(OLD_STUB) };
      entries[legacyAlias(at)] = copy
        ? { kind: 'copy', sha256: sha256(OLD_STUB) }
        : { kind: 'symlink', target: '../../.agents/skills/harnas' };
    }
    await mkdir(path.join(dir, state), { recursive: true });
    await writeFile(
      path.join(dir, state, 'skills-receipt.json'),
      JSON.stringify({ version: 1, entries }),
      'utf8',
    );
  }

  /** Строки `info/exclude`, как их дописывала прошлая сборка: метка и шаблоны путей. */
  async function legacyExclude(repo: string, lines: readonly string[] = LEGACY_PATTERNS): Promise<void> {
    const file = path.join(repo, '.git', 'info', 'exclude');
    await writeFile(file, `${await exclude(repo)}${LEGACY_MARKER}\n${lines.join('\n')}\n`, 'utf8');
  }

  /** Проект как его оставила прошлая сборка: репозиторий, прежняя установка, учёт в `.harnas` и строки exclude. */
  async function legacyProject(copy = false): Promise<void> {
    await initRepo(project);
    await legacyFiles(project, copy);
    await legacyReceipt(project, [project], { copy });
    await legacyExclude(project);
  }

  it('папка и ссылка по учёту убираются, ставится новый скилл; прежние строки exclude и записи учёта уходят', async () => {
    await legacyProject();
    const before = await exclude(project);

    const result = await installAgentSkill({ projectPath: project });

    expect(result).toEqual({
      skipped: [],
      written: [canonical(project), alias(project)],
      removed: [legacyAlias(project), legacyCanonical(project)],
    });
    expect(await exists(legacyCanonical(project))).toBe(false);
    expect(await exists(legacyAlias(project))).toBe(false);
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);

    // Проект со старым каталогом состояния остаётся при нём: учёт там же, нового `.parley` рядом не заводится (R5).
    expect(await exists(path.join(project, '.parley'))).toBe(false);
    const receipt = JSON.parse(
      await readFile(path.join(project, '.harnas', 'skills-receipt.json'), 'utf8'),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(receipt.entries).sort()).toEqual([canonical(project), alias(project)].sort());

    const text = await exclude(project);
    expect(text).not.toContain(LEGACY_MARKER);
    for (const line of LEGACY_PATTERNS) expect(count(text, line), line).toBe(0);
    expect(count(text, MARKER)).toBe(1);
    for (const line of PATTERNS) expect(count(text, line), line).toBe(1);
    // Чужие строки файла (шаблон git) на месте, и в начале.
    expect(text.startsWith(before.split(LEGACY_MARKER)[0] as string)).toBe(true);
    const status = await porcelain(project);
    expect(status).not.toContain('.agents');
    expect(status).not.toContain('.claude');
  });

  it('повторный вызов ничего не убирает и ничего не пишет', async () => {
    await legacyProject();
    await installAgentSkill({ projectPath: project });
    const receipt = await readFile(path.join(project, '.harnas', 'skills-receipt.json'), 'utf8');
    const excludeText = await exclude(project);

    expect(await installAgentSkill({ projectPath: project })).toEqual({
      skipped: [],
      written: [],
      removed: [],
    });
    expect(await readFile(path.join(project, '.harnas', 'skills-receipt.json'), 'utf8')).toBe(receipt);
    expect(await exclude(project)).toBe(excludeText);
  });

  it('запасная копия Claude Code (kind copy) убирается так же, как ссылка', async () => {
    await legacyProject(true);

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyAlias(project), legacyCanonical(project)]);
    expect(await exists(legacyAlias(project))).toBe(false);
  });

  it('учёт в .parley (проект уже переносили): то же самое', async () => {
    await initRepo(project);
    await legacyFiles(project);
    await legacyReceipt(project, [project], { state: '.parley' });
    await legacyExclude(project);

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyAlias(project), legacyCanonical(project)]);
    expect(await exists(path.join(project, '.harnas'))).toBe(false);
    expect(Object.keys((await readReceipt(project)).entries).sort()).toEqual(
      [canonical(project), alias(project)].sort(),
    );
  });

  it('SKILL.md правили вручную: папка остаётся, запись учёта и строки exclude — тоже', async () => {
    await legacyProject();
    const file = path.join(legacyCanonical(project), 'SKILL.md');
    await writeFile(file, `${OLD_STUB}мои правила\n`, 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    // Ссылка цела и убрана, папку с правкой не тронули; новый скилл встал рядом.
    expect(result.removed).toEqual([legacyAlias(project)]);
    expect(await readFile(file, 'utf8')).toBe(`${OLD_STUB}мои правила\n`);
    expect(await exists(legacyAlias(project))).toBe(false);
    expect(result.written).toEqual([canonical(project), alias(project)]);
    const receipt = JSON.parse(
      await readFile(path.join(project, '.harnas', 'skills-receipt.json'), 'utf8'),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(receipt.entries)).toContain(legacyCanonical(project));
    // Пока прежняя папка лежит на диске, её прячут от git те же строки.
    const text = await exclude(project);
    expect(text).toContain(LEGACY_MARKER);
    expect(text).toContain(LEGACY_PATTERNS[0] as string);
    expect(await porcelain(project)).not.toContain('.agents');
  });

  it('в прежней папке лежит ещё файл — в ней работал человек: ничего не тронуто', async () => {
    await legacyProject();
    await writeFile(path.join(legacyCanonical(project), 'NOTES.md'), 'заметка\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyAlias(project)]);
    expect((await readdir(legacyCanonical(project))).sort()).toEqual(['NOTES.md', 'SKILL.md']);
    expect(await readFile(path.join(legacyCanonical(project), 'SKILL.md'), 'utf8')).toBe(OLD_STUB);
  });

  it('.DS_Store от Finder в прежней папке — не правка: убирается вместе с ней', async () => {
    await legacyProject();
    await writeFile(path.join(legacyCanonical(project), '.DS_Store'), 'finder\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyAlias(project), legacyCanonical(project)]);
    expect(await exists(legacyCanonical(project))).toBe(false);
  });

  it('ссылка, перенаправленная человеком, остаётся; сама папка — по хешу — убирается', async () => {
    await legacyProject();
    await rm(legacyAlias(project));
    await symlink(path.join('..', '..', 'другое'), legacyAlias(project));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyCanonical(project)]);
    expect(await readlink(legacyAlias(project))).toBe(path.join('..', '..', 'другое'));
    expect(await exclude(project)).toContain(LEGACY_MARKER);
  });

  it('путь под прежним именем, которого в учёте нет, — чужой: не тронут и не упомянут', async () => {
    await initRepo(project);
    await mkdir(legacyCanonical(project), { recursive: true });
    await writeFile(path.join(legacyCanonical(project), 'SKILL.md'), OLD_STUB, 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(await readFile(path.join(legacyCanonical(project), 'SKILL.md'), 'utf8')).toBe(OLD_STUB);
  });

  it('запись учёта есть, а пути уже нет: не падает, запись уходит, убрано — ничего', async () => {
    await legacyProject();
    await rm(legacyCanonical(project), { recursive: true });
    await rm(legacyAlias(project));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([]);
    const receipt = JSON.parse(
      await readFile(path.join(project, '.harnas', 'skills-receipt.json'), 'utf8'),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(receipt.entries).sort()).toEqual([canonical(project), alias(project)].sort());
  });

  it('.claude — ссылка на другой каталог: прежняя копия за ней не трогается, остальное убирается', async () => {
    await initRepo(project);
    await legacyFiles(project, true);
    await legacyReceipt(project, [project], { copy: true });
    // `.claude` уводит в другое место: запись про прежнюю копию указывает туда, где человек держит своё.
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(path.join(elsewhere, 'skills'), { recursive: true });
    await rm(path.join(project, '.claude'), { recursive: true });
    await cp(path.join(project, '.agents', 'skills', 'harnas'), path.join(elsewhere, 'skills', 'harnas'), {
      recursive: true,
    });
    await symlink(elsewhere, path.join(project, '.claude'));

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyCanonical(project)]);
    expect(await readFile(path.join(elsewhere, 'skills', 'harnas', 'SKILL.md'), 'utf8')).toBe(OLD_STUB);
    expect(result.skipped).toEqual([{ path: alias(project), reason: 'unsafe' }]);
  });

  it('worktree сессии: прежнее убирается и там; строки exclude — когда прежнего не осталось нигде', async () => {
    await initRepo(project);
    const worktree = path.join(root, 'worktrees', 'w-0001-s-02');
    await mkdir(path.dirname(worktree), { recursive: true });
    await git(project, 'worktree', 'add', '-b', 'harnas/w-0001/s-02', worktree, 'main');
    await legacyFiles(project);
    await legacyFiles(worktree);
    await legacyReceipt(project, [project, worktree]);
    await legacyExclude(project);

    // Первый вызов — без worktree: его прежняя установка ещё на диске и прячется теми же строками.
    const first = await installAgentSkill({ projectPath: project });
    expect(first.removed).toEqual([legacyAlias(project), legacyCanonical(project)]);
    expect(await exclude(project)).toContain(LEGACY_MARKER);
    expect(await porcelain(worktree)).not.toContain('.agents');

    // Второй — с worktree: убрано и там, строки уходят.
    const second = await installAgentSkill({ projectPath: project, worktreePath: worktree });
    expect(second.removed).toEqual([legacyAlias(worktree), legacyCanonical(worktree)]);
    expect(await exists(legacyCanonical(worktree))).toBe(false);
    expect(await readFile(path.join(canonical(worktree), 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    const text = await exclude(project);
    expect(text).not.toContain(LEGACY_MARKER);
    expect(count(text, LEGACY_PATTERNS[0] as string)).toBe(0);
    for (const dir of [project, worktree]) {
      const status = await porcelain(dir);
      expect(status, dir).not.toContain('.agents');
      expect(status, dir).not.toContain('.claude');
    }
  });

  it('строки без прежней метки — чужие: остаются, даже если совпали с прежними шаблонами', async () => {
    await initRepo(project);
    await legacyFiles(project);
    await legacyReceipt(project, [project]);
    // Человек завёл такие же строки сам: метки харнесса над ними нет.
    const file = path.join(project, '.git', 'info', 'exclude');
    await writeFile(file, `${await exclude(project)}${LEGACY_PATTERNS.join('\n')}\n`, 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.removed).toEqual([legacyAlias(project), legacyCanonical(project)]);
    for (const line of LEGACY_PATTERNS) expect(count(await exclude(project), line), line).toBe(1);
  });

  it('проект в подкаталоге репозитория: уходят строки с его префиксом и вершины копии, чужие остаются', async () => {
    await initRepo(root);
    const sub = path.join(root, 'apps', 'web');
    await mkdir(sub, { recursive: true });
    await legacyFiles(sub);
    await legacyReceipt(sub, [sub]);
    const foreign = '/apps/api/.agents/skills/harnas';
    await legacyExclude(root, [
      '/apps/web/.agents/skills/harnas',
      '/apps/web/.claude/skills/harnas',
      foreign,
    ]);
    await writeFile(
      path.join(root, '.git', 'info', 'exclude'),
      `*.log\n${await exclude(root)}своё\n`,
      'utf8',
    );

    const result = await installAgentSkill({ projectPath: sub });

    expect(result.removed).toEqual([legacyAlias(sub), legacyCanonical(sub)]);
    const text = await exclude(root);
    expect(text).not.toContain(LEGACY_MARKER);
    expect(text).not.toContain('/apps/web/.agents/skills/harnas');
    expect(text).not.toContain('/apps/web/.claude/skills/harnas');
    expect(text.split('\n')).toEqual(expect.arrayContaining(['*.log', 'своё', foreign]));
    expect(text).toContain('/apps/web/.agents/skills/parley');
  });

  it('новый путь занят чужим скиллом: он не тронут, а прежняя установка всё равно убирается', async () => {
    await legacyProject();
    await mkdir(canonical(project), { recursive: true });
    await writeFile(path.join(canonical(project), 'SKILL.md'), 'скилл команды\n', 'utf8');

    const result = await installAgentSkill({ projectPath: project });

    expect(result.skipped).toEqual([{ path: canonical(project), reason: 'foreign' }]);
    expect(result.removed).toEqual([legacyAlias(project), legacyCanonical(project)]);
    expect(await readFile(path.join(canonical(project), 'SKILL.md'), 'utf8')).toBe('скилл команды\n');
    expect(await exclude(project)).not.toContain(LEGACY_MARKER);
  });

  it('сбой при уборке не лишает сессию нового скилла: запись остаётся, следующий запуск повторит', async () => {
    if (process.getuid?.() === 0) return; // от имени root права на каталог ничего не запрещают
    await legacyProject();
    await chmod(legacyCanonical(project), 0o555);
    try {
      const failed = await installAgentSkill({ projectPath: project });

      expect(failed.written).toEqual([canonical(project), alias(project)]);
      expect(failed.removed).toEqual([legacyAlias(project)]);
      expect(await exists(path.join(legacyCanonical(project), 'SKILL.md'))).toBe(true);
    } finally {
      await chmod(legacyCanonical(project), 0o755);
    }

    const again = await installAgentSkill({ projectPath: project });
    expect(again.removed).toEqual([legacyCanonical(project)]);
    expect(await exists(legacyCanonical(project))).toBe(false);
  });
});

describe('рамка: каталоги агентов не трогаются', () => {
  /** Домашняя папка теста: `os.homedir()` читает `HOME` в момент вызова. */
  async function fakeHome(): Promise<string> {
    const home = path.join(root, 'home');
    await mkdir(home);
    process.env['HOME'] = home;
    return home;
  }

  it('проект — сама домашняя папка: ни .claude, ни .agents, ни учёта', async () => {
    const home = await fakeHome();

    const result = await installAgentSkill({ projectPath: home });

    expect(result).toEqual({ skipped: [], written: [], removed: [] });
    expect(await readdir(home)).toEqual([]);
  });

  it('проект в каталоге агента (~/.claude, ~/.codex, ~/.agents и глубже): в него ничего не пишется', async () => {
    const home = await fakeHome();
    for (const dir of ['.claude', '.codex', '.agents', path.join('.claude', 'projects', 'x')]) {
      const inside = path.join(home, dir);
      await mkdir(inside, { recursive: true });

      const result = await installAgentSkill({ projectPath: inside });

      expect(result, dir).toEqual({ skipped: [], written: [], removed: [] });
      const names = await readdir(inside);
      for (const own of ['.parley', '.harnas', '.agents', '.claude']) expect(names, dir).not.toContain(own);
    }
    expect(await exists(path.join(home, '.claude', '.claude'))).toBe(false);
    expect(await exists(path.join(home, '.claude', '.agents'))).toBe(false);
    expect(await exists(path.join(home, '.parley'))).toBe(false);
    expect(await exists(path.join(home, '.harnas'))).toBe(false);
  });

  it('обычный проект под домашней папкой — как всегда', async () => {
    const home = await fakeHome();
    const inHome = path.join(home, 'Desktop', 'shop');
    await mkdir(inHome, { recursive: true });

    const result = await installAgentSkill({ projectPath: inHome });

    expect(result.written).toEqual([canonical(inHome), alias(inHome)]);
  });

  it('worktree внутри каталога агента пропускается, проект получает скилл', async () => {
    const home = await fakeHome();
    const inside = path.join(home, '.codex', 'worktrees', 'x');
    await mkdir(inside, { recursive: true });

    const result = await installAgentSkill({ projectPath: project, worktreePath: inside });

    expect(result.written).toEqual([canonical(project), alias(project)]);
    expect(await readdir(inside)).toEqual([]);
  });
});

describe('параллельные запуски одного проекта', () => {
  it('четыре вызова разом: одна установка, чужих нет, учёт целый', async () => {
    await initRepo(project);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => installAgentSkill({ projectPath: project })),
    );

    expect(results.flatMap((result) => result.skipped)).toEqual([]);
    expect(results.flatMap((result) => result.written)).toEqual([
      canonical(project),
      alias(project),
    ]);
    expect((await readReceipt(project)).version).toBe(1);
    const exclude = await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n').filter((line) => line === '/.agents/skills/parley')).toHaveLength(1);
  });

  it('сбой записи учёта (`.parley` — файл) отказывает вызову, ничего не создав, и очередь идёт дальше', async () => {
    await writeFile(path.join(project, '.parley'), 'файл вместо каталога\n', 'utf8');
    const first = installAgentSkill({ projectPath: project });
    const second = installAgentSkill({ projectPath: project });

    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    // Запись в учёт ложится до файлов: не вышла — не создано ничего, и сирот, которых потом сочли бы чужими, нет.
    expect(await exists(canonical(project))).toBe(false);
    expect(await exists(alias(project))).toBe(false);

    await rm(path.join(project, '.parley'));
    const third = await installAgentSkill({ projectPath: project });
    expect(third.skipped).toEqual([]);
    expect(third.written).toEqual([canonical(project), alias(project)]);
  });
});
