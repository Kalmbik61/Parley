import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acceptClaudeFolderTrust, claudeStateFile, preacceptClaudeTrust } from './claude-trust.js';
import { grantTrust } from './trust.js';

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

describe('preacceptClaudeTrust', () => {
  it('папка с записью в trust.json — отметка под её realpath', async () => {
    await writeState(CLI_STATE);
    const link = path.join(root, 'project-link');
    await symlink(project, link);
    await grantTrust(link, 'window');
    expect(await preacceptClaudeTrust(link, { configDir: config, home: '/unused' })).toEqual({ outcome: 'written' });
    expect(Object.keys((await readState())['projects'] as object).sort()).toEqual(['/elsewhere/other-project', project].sort());
  });

  it('папка без записи доверия — файл Claude не меняется (ни байт, ни время)', async () => {
    await writeState(CLI_STATE);
    await grantTrust(path.join(root, 'another-project'), 'window');
    const before = await stat(file);
    await delay(20);
    expect(await preacceptClaudeTrust(project, { configDir: config, home: '/unused' })).toEqual({ outcome: 'not-trusted' });
    expect(await readState()).toEqual(CLI_STATE);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

  it('сбой записи не бросает: строка для лога без содержимого файла', async () => {
    await writeState(CLI_STATE);
    await grantTrust(project, 'window');
    await chmod(config, 0o500);
    const result = await preacceptClaudeTrust(project, { configDir: config, home: '/unused' });
    expect(result.outcome).toBe('failed');
    expect(result.warning).toMatch(/could not mark the project folder as trusted for Claude Code \(EACCES\)/);
    expect(result.warning).not.toContain('secret-marker');
    await chmod(config, 0o700);
    expect(await readState()).toEqual(CLI_STATE);
  });

  it('файл не разбирается — строка с путём файла и причиной, без содержимого', async () => {
    await writeState('{"oauthAccount": "secret-marker", ');
    await grantTrust(project, 'window');
    const result = await preacceptClaudeTrust(project, { configDir: config, home: '/unused' });
    expect(result).toEqual({
      outcome: 'unreadable',
      warning: `Parley could not mark ${project} as trusted in ${file} (unreadable); Claude Code may ask to trust the folder in the terminal.`,
    });
  });
});
