import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Скилл `parley` в проекте (кусок 10 плана комнат): после запуска сессии хост кладёт в проект
 * `.agents/skills/parley/SKILL.md` и относительный симлинк `.claude/skills/parley`, а строки в
 * `info/exclude` прячут их от `git status`. Агент — стаб (`PARLEY_CLAUDE_BIN`), настоящие claude и codex
 * не запускаются; проект и дом — свои временные каталоги теста, `~/.claude` не трогается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const run = promisify(execFile);

const git = async (dir: string, ...args: string[]): Promise<string> => (await run('git', ['-C', dir, ...args])).stdout;

/** Репозиторий с одним коммитом на `main`: worktree сессии отводится от него. */
async function initRepo(dir: string): Promise<void> {
  await run('git', ['init', '-b', 'main', dir]);
  await git(dir, 'config', 'user.email', 'e2e@parley');
  await git(dir, 'config', 'user.name', 'e2e');
  await writeFile(path.join(dir, 'README.md'), 'старт\n', 'utf8');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-m', 'первый');
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) =>
      (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

const skillFile = (dir: string): string => path.join(dir, '.agents', 'skills', 'parley', 'SKILL.md');
const aliasPath = (dir: string): string => path.join(dir, '.claude', 'skills', 'parley');
const gitStatus = (dir: string): Promise<string> => git(dir, 'status', '--porcelain', '-uall');

test.describe('скилл parley в проекте', () => {
  let home: string;
  let base: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('skills');
    base = await makeTempProject('skills');
    project = path.join(base, 'shop');
    await mkdir(project);
    await initRepo(project);
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  async function openApp(): Promise<{ app: ElectronApplication; window: Page }> {
    // Корень worktree — тоже во временном каталоге теста: по умолчанию он в `~/parley/worktrees` человека.
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_WORKTREE_ROOT: path.join(base, 'worktrees'),
    };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    return { app, window };
  }

  async function newSession(window: Page, dir: string, worktree = false): Promise<{ workId: string; sessionId: string }> {
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: dir, title: 'e2e-skills', goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: dir,
      workId,
      provider: 'claude',
      label: 'скилл',
      task: '',
      parent: null,
      ...(worktree ? { worktree: true } : {}),
    });
    return { workId, sessionId: ref.sessionId };
  }

  test('после запуска сессии лежат .agents/skills/parley/SKILL.md и симлинк .claude/skills/parley; git status их не показывает', async () => {
    const { window } = await openApp();

    await newSession(window, project);

    // Скилл ставится до старта процесса: к моменту ответа sessions.create он уже на диске.
    const text = await readFile(skillFile(project), 'utf8');
    expect(text).toMatch(/^---\nname: parley\ndescription: "/);
    expect(text).toContain('`read_guide`');
    expect((await lstat(aliasPath(project))).isSymbolicLink()).toBe(true);
    // Симлинк относительный и ведёт в канонную копию: Claude Code читает через него тот же файл.
    expect(await readlink(aliasPath(project))).toBe(path.join('..', '..', '.agents', 'skills', 'parley'));
    expect(await readFile(path.join(aliasPath(project), 'SKILL.md'), 'utf8')).toBe(text);

    const status = await gitStatus(project);
    expect(status).not.toContain('.agents');
    expect(status).not.toContain('.claude');
    const exclude = await readFile(path.join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('/.agents/skills/parley');
    expect(exclude).toContain('/.claude/skills/parley');
  });

  test('сессия со своим worktree: скилл и там, и в проекте; git status обоих чист от скилла', async () => {
    const { window } = await openApp();

    const { workId, sessionId } = await newSession(window, project, true);

    // Карта — на диске сразу; снимок работ у хоста обновляется по наблюдателю и мог отстать.
    const map = JSON.parse(await readFile(path.join(project, '.parley', 'works', workId, 'map.json'), 'utf8')) as {
      sessions: Array<{ id: string; worktree: { path: string } | null }>;
    };
    const worktree = map.sessions.find((session) => session.id === sessionId)?.worktree?.path;
    if (worktree === undefined) throw new Error('у сессии нет worktree');

    for (const dir of [project, worktree]) {
      expect(await readFile(skillFile(dir), 'utf8'), dir).toContain('name: parley');
      expect((await lstat(aliasPath(dir))).isSymbolicLink(), dir).toBe(true);
      const status = await gitStatus(dir);
      expect(status, dir).not.toContain('.agents');
      expect(status, dir).not.toContain('.claude');
    }
  });

  test('чужой скилл в проекте не тронут, а в строке статуса — короткое сообщение', async () => {
    await mkdir(path.dirname(skillFile(project)), { recursive: true });
    await writeFile(skillFile(project), 'скилл команды\n', 'utf8');
    // PARLEY.md уже есть: иначе уведомление о его создании вытеснило бы из строки статуса сообщение о скилле.
    await writeFile(path.join(project, 'PARLEY.md'), '# Правила команды\n', 'utf8');
    const { window } = await openApp();

    await newSession(window, project);

    await expect(window.getByText("Agent skill not installed — that path already exists and wasn't created by Parley.")).toBeVisible();
    expect(await readFile(skillFile(project), 'utf8')).toBe('скилл команды\n');
    await expect(lstat(aliasPath(project))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('переключатель «Install agent skills into projects» в Settings: выключен — в новом проекте скилла нет; на 800×500 доступен', async () => {
    const { app, window } = await openApp();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    // Хотя бы одна работа, чтобы окно показало оболочку и палитра открылась.
    await newSession(window, project);

    await window.getByRole('button', { name: 'Search ⌘J' }).first().click();
    await window.getByRole('dialog').getByRole('combobox').fill('Settings');
    await window.keyboard.press('Enter');
    await expect(window.getByRole('dialog')).toContainText('Settings');
    await window.getByRole('tab', { name: 'Agents' }).click();

    const toggle = window.getByRole('switch', { name: 'Install agent skills into projects' });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect((await call<{ config: { agentSkills: boolean } }>(window, 'settings.get', {})).config.agentSkills).toBe(false);
    // Подвал диалога в окне 800×500 на месте: кнопка «Done» не ушла за нижний край.
    const done = window.getByRole('dialog').getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeVisible();
    const box = await done.boundingBox();
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(500);
    await window.keyboard.press('Escape');

    const other = path.join(base, 'other');
    await mkdir(other);
    await newSession(window, other);

    await expect(lstat(path.join(other, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(other, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Уже поставленное в первом проекте выключение не удаляет.
    expect(await readFile(skillFile(project), 'utf8')).toContain('name: parley');
  });
});
