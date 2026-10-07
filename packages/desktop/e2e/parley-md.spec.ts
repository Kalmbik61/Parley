import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { makeTempHome, makeTempProject } from './tmp.js';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const CREATED = 'Parley added PARLEY.md — team rules for your agents';

async function call<T>(page: Page, method: string, params: unknown): Promise<T> {
  return page.evaluate(
    ([m, p]) =>
      (
        globalThis as unknown as {
          parley: { call: (method: string, params: unknown) => Promise<unknown> };
        }
      ).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('PARLEY.md create/open and host receipts', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;
  test.beforeEach(async () => {
    home = await makeTempHome('parley-md');
    project = await makeTempProject('parley-md');
  });
  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });
  async function start(): Promise<{ page: Page; workId: string }> {
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_CLAUDE_BIN: stubAgent,
        PARLEY_AGENT_SKILLS: '0',
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_WORKTREE_ROOT: path.join(home, 'worktrees'),
      },
    });
    const page = await app.firstWindow();
    await expect(page.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(page, 'works.create', {
      projectPath: project,
      title: 'PARLEY rules',
      goal: '',
    });
    await expect(page.getByTestId('app-shell')).toBeVisible();
    return { page, workId };
  }
  async function projectMenu(page: Page): Promise<void> {
    await page
      .locator('[data-section-key]')
      .filter({ has: page.getByRole('button', { name: 'Section options' }) })
      .getByRole('button', { name: 'Section options' })
      .click();
  }
  async function assertEditor(page: Page): Promise<void> {
    await expect(page.getByTestId('file-body')).toBeVisible();
    await page.getByTestId('file-body').getByRole('radio', { name: 'Code', exact: true }).click();
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(
      'Team rules for agents working together in Parley',
    );
  }
  async function newSession(
    page: Page,
    workId: string,
  ): Promise<{ projectPath: string; workId: string; sessionId: string }> {
    const { ref } = await call<{ ref: { projectPath: string; workId: string; sessionId: string } }>(
      page,
      'sessions.create',
      {
        projectPath: project,
        workId,
        provider: 'claude',
        label: 'Rules',
        task: '',
        parent: null,
      },
    );
    return ref;
  }

  test('Create opens the project editor; Open preserves a human edit', async () => {
    const { page } = await start();
    await projectMenu(page);
    await page.getByRole('menuitem', { name: 'Create PARLEY.md' }).click();
    await assertEditor(page);
    await writeFile(path.join(project, 'PARLEY.md'), 'HUMAN RULES\n');
    await projectMenu(page);
    await page.getByRole('menuitem', { name: 'Open PARLEY.md' }).click();
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toBe('HUMAN RULES\n');
    expect(
      JSON.parse(await readFile(path.join(project, '.parley', 'parley-md-receipt.json'), 'utf8'))
        .created,
    ).toBe(true);
  });

  test('automatic creation delivers Open action with agentSkills off; resume preserves deletion and explicit Create restores', async () => {
    const { page, workId } = await start();
    const ref = await newSession(page, workId);
    const notice = page.locator('[data-sonner-toast]').filter({ hasText: CREATED });
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'Open', exact: true }).click();
    await assertEditor(page);
    await expect(lstat(path.join(project, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    await call(page, 'sessions.stop', { ref });
    await rm(path.join(project, 'PARLEY.md'));
    await call(page, 'sessions.resume', { ref });
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await projectMenu(page);
    await page.getByRole('menuitem', { name: 'Create PARLEY.md' }).click();
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toContain(
      'Team rules for agents working together in Parley',
    );
  });

  test('an occupied directory remains intact, while the session starts and unreadable rules are shown safely', async () => {
    await mkdir(path.join(project, 'PARLEY.md'));
    await writeFile(path.join(project, 'PARLEY.md', 'keep.txt'), 'untouched');
    const { page, workId } = await start();
    await newSession(page, workId);
    expect(await readFile(path.join(project, 'PARLEY.md', 'keep.txt'), 'utf8')).toBe('untouched');
    await expect(
      page.getByText(
        "PARLEY.md couldn't be read — this session starts without its project rules.",
        { exact: false },
      ),
    ).toBeVisible();
    expect(
      JSON.parse(await readFile(path.join(project, '.parley', 'parley-md-receipt.json'), 'utf8'))
        .created,
    ).toBe(false);
  });

  test('truncation notice reaches the desktop without displaying the private rule body', async () => {
    const privateBody = 'PRIVATE_RULE_CONTENT'.repeat(2500);
    await writeFile(path.join(project, 'PARLEY.md'), privateBody);
    const { page, workId } = await start();
    await newSession(page, workId);
    await expect(
      page.getByText(
        'PARLEY.md was cut at 32 KB — shorten the project rules to include the remainder.',
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page.getByText('PRIVATE_RULE_CONTENT', { exact: false })).toHaveCount(0);
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toBe(privateBody);
  });
});
