import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptClaudeFolderTrust,
  claudeStateFile,
  claudeTrustMarksFile,
  readClaudeTrustMarks,
  withdrawClaudeFolderTrust,
  withdrawClaudeTrustMarks,
} from './claude-trust.js';
import { grantTrust, revokeTrust, syncClaudeTrust } from './trust.js';

/** Всё во временных каталогах: настоящий `~/.claude.json` тест не читает и не пишет. */
let root = '';
let parley = '';
let config = '';
let project = '';
let file = '';
const savedHome = process.env['PARLEY_HOME'];

/** Файл состояния, каким его оставляет CLI: свои поля, чужой проект, отступ в два пробела, права 0600. */
const CLI_STATE = {
  numStartups: 12,
  oauthAccount: { emailAddress: 'secret-marker@example.invalid' },
  projects: { '/elsewhere/other-project': { hasTrustDialogAccepted: false, allowedTools: ['Bash'] } },
};

async function writeState(data: unknown, target = file): Promise<void> {
  await writeFile(target, typeof data === 'string' ? data : JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(target, 0o600);
}

const readState = async (target = file): Promise<Record<string, unknown>> => JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-claude-trust-')));
  parley = path.join(root, 'parley-home');
  config = path.join(root, 'claude-config');
  project = path.join(root, 'project');
  await Promise.all([mkdir(parley), mkdir(config), mkdir(project)]);
  process.env['PARLEY_HOME'] = parley;
  file = path.join(config, '.claude.json');
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = savedHome;
  await chmod(config, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

describe('acceptClaudeFolderTrust', () => {
  it('ставит только hasTrustDialogAccepted этой папки; прочие проекты, поля записи и файла, права и форма — как были', async () => {
    await writeState({ ...CLI_STATE, projects: { ...CLI_STATE.projects, [project]: { allowedTools: ['Read'], lastCost: 1.5 } } });

    expect(await acceptClaudeFolderTrust(file, project)).toBe('written');

    const after = await readState();
    expect(after).toEqual({
      ...CLI_STATE,
      projects: { ...CLI_STATE.projects, [project]: { allowedTools: ['Read'], lastCost: 1.5, hasTrustDialogAccepted: true } },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify(after, null, 2));
    // Своя блокировка снята, временных файлов нет.
    await expect(lstat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(config)).toEqual(['.claude.json']);
  });

  it('отметка уже стоит — файл не переписывается', async () => {
    await writeState({ projects: { [project]: { hasTrustDialogAccepted: true } } });
    const before = await stat(file);
    await delay(20);
    expect(await acceptClaudeFolderTrust(file, project)).toBe('present');
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('CLI переписал файл между чтением и заменой — перечитываем: его поля и наша отметка обе на месте', async () => {
    await writeState(CLI_STATE);
    let raced = false;
    const outcome = await acceptClaudeFolderTrust(file, project, {
      beforeCommit: async () => {
        if (raced) return;
        raced = true;
        // Писатель без блокировки: новое поле и новый проект.
        await writeState({ ...CLI_STATE, numStartups: 13, projects: { ...CLI_STATE.projects, '/elsewhere/new': { hasTrustDialogAccepted: true } } });
      },
    });
    expect(outcome).toBe('written');
    expect(await readState()).toEqual({
      ...CLI_STATE,
      numStartups: 13,
      projects: { ...CLI_STATE.projects, '/elsewhere/new': { hasTrustDialogAccepted: true }, [project]: { hasTrustDialogAccepted: true } },
    });
  });

  it('файл меняется на каждой попытке — busy, наша версия не ложится поверх чужой', async () => {
    await writeState(CLI_STATE);
    let n = 0;
    const outcome = await acceptClaudeFolderTrust(file, project, {
      attempts: 2,
      beforeCommit: async () => { await writeState({ ...CLI_STATE, numStartups: 100 + ++n }); },
    });
    expect(outcome).toBe('busy');
    expect(await readState()).toEqual({ ...CLI_STATE, numStartups: 102 });
  });

  it('ждёт блокировку CLI (<файл>.lock) и пишет после её снятия', async () => {
    await writeState(CLI_STATE);
    await mkdir(`${file}.lock`);
    const pending = acceptClaudeFolderTrust(file, project, { lockWaitMs: 2_000 });
    await delay(150);
    // Пока блокировка у CLI, файл не тронут.
    expect(await readState()).toEqual(CLI_STATE);
    await rmdir(`${file}.lock`);
    expect(await pending).toBe('written');
    expect((await readState())['projects']).toMatchObject({ [project]: { hasTrustDialogAccepted: true } });
  });

  it('блокировка CLI держится дольше срока — busy: файл не тронут, чужую блокировку не снимаем', async () => {
    await writeState(CLI_STATE);
    await mkdir(`${file}.lock`);
    expect(await acceptClaudeFolderTrust(file, project, { lockWaitMs: 100 })).toBe('busy');
    expect(await readState()).toEqual(CLI_STATE);
    expect((await stat(`${file}.lock`)).isDirectory()).toBe(true);
  });

  it('битый JSON, не объект, projects или запись чужой формы — unreadable, файл как был', async () => {
    for (const content of ['{"projects": {', '[]', JSON.stringify({ projects: [] }), JSON.stringify({ projects: { [project]: 'yes' } })]) {
      await writeState(content);
      expect(await acceptClaudeFolderTrust(file, project), content).toBe('unreadable');
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });

  it('нет файла — no-config: ни файла, ни блокировки не появляется', async () => {
    expect(await acceptClaudeFolderTrust(file, project)).toBe('no-config');
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('файл — ссылка (менеджер дотфайлов): правится цель, ссылка остаётся ссылкой', async () => {
    const real = path.join(root, 'dotfiles-claude.json');
    await writeState(CLI_STATE, real);
    await symlink(real, file);
    expect(await acceptClaudeFolderTrust(file, project)).toBe('written');
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect((await readState(real))['projects']).toMatchObject({ [project]: { hasTrustDialogAccepted: true } });
  });
});

describe('claudeStateFile', () => {
  it('CLAUDE_CONFIG_DIR — <папка>/.claude.json; без неё — <home>/.claude.json', async () => {
    expect(await claudeStateFile(config, '/unused')).toBe(path.join(config, '.claude.json'));
    expect(await claudeStateFile(undefined, root)).toBe(path.join(root, '.claude.json'));
  });

  it('прежний <папка конфигурации>/.config.json с содержимым главнее, как у CLI', async () => {
    await writeFile(path.join(config, '.config.json'), '{}');
    expect(await claudeStateFile(config, '/unused')).toBe(path.join(config, '.config.json'));
    await mkdir(path.join(root, '.claude'));
    await writeFile(path.join(root, '.claude', '.config.json'), '{}');
    expect(await claudeStateFile(undefined, root)).toBe(path.join(root, '.claude', '.config.json'));
  });
});

describe('замок файла-ссылки (m8)', () => {
  it('файл — ссылка: Parley ждёт и замок CLI (<путь как есть>.lock), и замок цели (<realpath>.lock)', async () => {
    const real = path.join(root, 'dotfiles-claude.json');
    await writeState(CLI_STATE, real);
    await symlink(real, file);
    for (const lock of [`${file}.lock`, `${real}.lock`]) {
      await mkdir(lock);
      expect(await acceptClaudeFolderTrust(file, project, { lockWaitMs: 100 }), lock).toBe('busy');
      expect(await readState(real)).toEqual(CLI_STATE);
      await rmdir(lock);
    }
    expect(await acceptClaudeFolderTrust(file, project)).toBe('written');
    await expect(lstat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(`${real}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('замок при ссылке выше файла', () => {
  it('ссылка на каталоге (/var → /private/var), не на файле: один замок, запись не ждёт сама себя', async () => {
    await writeState(CLI_STATE);
    const spelled = path.join(root, 'config-link');
    await symlink(config, spelled);
    expect(await acceptClaudeFolderTrust(path.join(spelled, '.claude.json'), project, { lockWaitMs: 100 })).toBe('written');
    await expect(lstat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('withdrawClaudeFolderTrust', () => {
  it('снимает только флаг этой папки (false — умолчание CLI); прочие поля и проекты как были', async () => {
    await writeState({ ...CLI_STATE, projects: { ...CLI_STATE.projects, [project]: { hasTrustDialogAccepted: true, lastCost: 2 } } });
    expect(await withdrawClaudeFolderTrust(file, project)).toBe('written');
    expect(await readState()).toEqual({ ...CLI_STATE, projects: { ...CLI_STATE.projects, [project]: { hasTrustDialogAccepted: false, lastCost: 2 } } });
  });

  it('отметки нет — absent, файл не переписывается', async () => {
    await writeState(CLI_STATE);
    const before = await stat(file);
    await delay(20);
    expect(await withdrawClaudeFolderTrust(file, project)).toBe('absent');
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });
});

describe('syncClaudeTrust и revokeTrust (A29, M3)', () => {
  const profile = () => ({ configDir: config, home: '/unused' });
  const flag = async () => ((await readState())['projects'] as Record<string, Record<string, unknown>>)[project]?.['hasTrustDialogAccepted'];

  it('папка с записью в trust.json — отметка под её realpath и строка в файле отметок Parley', async () => {
    await writeState(CLI_STATE);
    const link = path.join(root, 'project-link');
    await symlink(project, link);
    await grantTrust(link, 'window');
    expect(await syncClaudeTrust(link, profile())).toEqual({ outcome: 'written', warnings: [] });
    expect(Object.keys((await readState())['projects'] as object).sort()).toEqual(['/elsewhere/other-project', project].sort());
    expect((await readClaudeTrustMarks(parley)).map(({ folder, file: marked }) => ({ folder, file: marked }))).toEqual([{ folder: project, file }]);
  });

  it('grant → запуск → revoke: отметка Parley снята, её строки нет, прочее содержимое файла как было', async () => {
    await writeState(CLI_STATE);
    await grantTrust(project, 'phone');
    expect((await syncClaudeTrust(project, profile())).outcome).toBe('written');
    expect(await revokeTrust(project)).toBe(true);
    expect(await readState()).toEqual({ ...CLI_STATE, projects: { ...CLI_STATE.projects, [project]: { hasTrustDialogAccepted: false } } });
    expect(await readClaudeTrustMarks(parley)).toEqual([]);
    // Следующий запуск Claude без согласия файл не трогает.
    expect(await syncClaudeTrust(project, profile())).toEqual({ outcome: 'not-trusted', warnings: [] });
    expect(await flag()).toBe(false);
  });

  it('отметку человека из самого CLI отзыв в Parley не трогает', async () => {
    await writeState({ ...CLI_STATE, projects: { ...CLI_STATE.projects, [project]: { hasTrustDialogAccepted: true } } });
    await grantTrust(project, 'window');
    expect((await syncClaudeTrust(project, profile())).outcome).toBe('present');
    expect(await readClaudeTrustMarks(parley)).toEqual([]);
    await revokeTrust(project);
    expect(await flag()).toBe(true);
  });

  it('при отзыве файл занят — отзыв проходит, строка остаётся, отметка снимается при следующем запуске Claude', async () => {
    await writeState(CLI_STATE);
    await grantTrust(project, 'window');
    await syncClaudeTrust(project, profile());
    await mkdir(`${file}.lock`);
    expect(await revokeTrust(project)).toBe(true);
    expect(await flag()).toBe(true);
    expect(await readClaudeTrustMarks(parley)).toHaveLength(1);
    await rmdir(`${file}.lock`);
    // Запуск Claude в другой папке снимает отложенную отметку отозванной.
    const other = path.join(root, 'other');
    await mkdir(other);
    expect(await syncClaudeTrust(other, profile())).toEqual({ outcome: 'not-trusted', warnings: [] });
    expect(await flag()).toBe(false);
    expect(await readClaudeTrustMarks(parley)).toEqual([]);
  });

  it('снятие при занятом файле — строка для лога без содержимого', async () => {
    await writeState(CLI_STATE);
    await grantTrust(project, 'window');
    await syncClaudeTrust(project, profile());
    await mkdir(`${file}.lock`);
    expect(await withdrawClaudeTrustMarks(parley, (mark) => mark.folder === project, { lockWaitMs: 100 })).toEqual([
      `Parley could not remove its trust mark for ${project} from ${file} (busy); it retries on the next Claude Code launch.`,
    ]);
    await rmdir(`${file}.lock`);
  });

  it('файл отметок не читается — новых отметок нет (снять их было бы нельзя), строка для лога', async () => {
    await writeState(CLI_STATE);
    await grantTrust(project, 'window');
    await writeFile(claudeTrustMarksFile(parley), 'not json');
    const result = await syncClaudeTrust(project, profile());
    expect(result.outcome).toBe('failed');
    expect(await readState()).toEqual(CLI_STATE);
  });

  it('папка без записи доверия — файл Claude не меняется (ни байт, ни время)', async () => {
    await writeState(CLI_STATE);
    await grantTrust(path.join(root, 'another-project'), 'window');
    const before = await stat(file);
    await delay(20);
    expect(await syncClaudeTrust(project, profile())).toEqual({ outcome: 'not-trusted', warnings: [] });
    expect(await readState()).toEqual(CLI_STATE);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('сбой записи не бросает: строка для лога без содержимого файла, своей строки отметки не остаётся', async () => {
    await writeState(CLI_STATE);
    await grantTrust(project, 'window');
    await chmod(config, 0o500);
    const result = await syncClaudeTrust(project, profile());
    expect(result.outcome).toBe('failed');
    expect(result.warnings).toEqual(['Parley could not mark the project folder as trusted for Claude Code (EACCES); Claude Code may ask to trust the folder in the terminal.']);
    expect(result.warnings.join('\n')).not.toContain('secret-marker');
    await chmod(config, 0o700);
    expect(await readState()).toEqual(CLI_STATE);
    expect(await readClaudeTrustMarks(parley)).toEqual([]);
  });

  it('файл не разбирается — строка с путём файла и причиной, без содержимого; строки отметки нет', async () => {
    await writeState('{"oauthAccount": "secret-marker", ');
    await grantTrust(project, 'window');
    expect(await syncClaudeTrust(project, profile())).toEqual({
      outcome: 'unreadable',
      warnings: [`Parley could not mark ${project} as trusted in ${file} (unreadable); Claude Code may ask to trust the folder in the terminal.`],
    });
    expect(await readClaudeTrustMarks(parley)).toEqual([]);
  });
});
