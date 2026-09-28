import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Живой повод обновления спеки 11.1 (раунд fix-8b, пункт 2): сессия с worktree переводится в
 * `working` и обратно строками журнала хуков (stub-агент хуков не пишет — как `attention.spec.ts`).
 * Пока она работает, в worktree правится файл и делается коммит в ветке сессии; правка мимо
 * повода окно не трогает (так по спеке). После выхода из `working` вкладка «Изменения» (счётчики,
 * секции, «Branch commits») и открытая вкладка диффа (стороны живого редактора, прокрутка
 * сохранена) обновляются сами, без Refresh; вкладка диффа коммита — нет.
 * Git-репозиторий и worktree сессии — только во временных каталогах (`HARNAS_WORKTREE_ROOT`).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 300 строк; чётные — с меткой `tag`: правка в каждой второй строке держит редактор длинным. */
function aText(tag: string | null): string {
  return `${Array.from({ length: 300 }, (_, i) => `export const a${i} = '${tag !== null && i % 2 === 0 ? `${tag}-${i}` : i}';`).join('\n')}\n`;
}

test.describe('живой повод обновления «Изменений» и диффа (спека 11.1)', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('diff-live');
    project = await makeTempProject('diff-live');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src', 'a.ts'), aText(null));
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 'e2e@example.com');
    git(project, 'config', 'user.name', 'e2e');
    git(project, 'config', 'commit.gpgsign', 'false');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'first');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('выход из working — «Изменения» и открытый дифф обновились сами, прокрутка редактора прежняя; дифф коммита — нет', async () => {
    test.setTimeout(120_000);
    const env = {
      ...process.env,
      HARNAS_HOME: home,
      HARNAS_CLAUDE_BIN: stubAgent,
      HARNAS_TERMINAL_RENDERER: 'dom',
      HARNAS_WORKTREE_ROOT: path.join(home, 'worktrees'),
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
    });

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-diff-live', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'live',
      task: '',
      parent: null,
      worktree: true,
    });
    const sessionId = created.ref.sessionId;
    // Worktree заводит запуск сессии: путь — из карты, когда `createdAt` записан.
    type Snapshot = { entries: Array<{ map: { work: { id: string }; sessions: Array<{ id: string; worktree: { path: string; createdAt: string | null } | null }> } }> };
    const worktreeOf = async (): Promise<string | null> => {
      const snapshot = await call<Snapshot>(window, 'works.list', {});
      const session = snapshot.entries.find((entry) => entry.map.work.id === workId)?.map.sessions.find((s) => s.id === sessionId);
      return session?.worktree?.createdAt === null || session?.worktree === undefined ? null : (session.worktree?.path ?? null);
    };
    await expect.poll(worktreeOf, { timeout: 10_000 }).not.toBeNull();
    const worktree = (await worktreeOf()) as string;
    expect(worktree.startsWith(home)).toBe(true);

    // Ветка сессии: один коммит и незакоммиченная правка каждой второй строки a.ts.
    await writeFile(path.join(worktree, 'src', 'first.ts'), 'export const first = 1;\nexport const second = 2;\nexport const third = 3;\n');
    git(worktree, 'add', 'src/first.ts');
    git(worktree, 'commit', '-q', '-m', 'first in branch');
    await writeFile(path.join(worktree, 'src', 'a.ts'), aText('v1'));

    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Changes' }).click();
    await sidebar.getByRole('combobox', { name: 'Session' }).click();
    await window.getByRole('option', { name: /live/ }).click();
    const panel = sidebar.getByTestId('changes-panel');
    const chip = panel.getByText(/^\+\d+ −\d+$/);
    const commits = panel.getByRole('region', { name: 'Branch commits' });
    const branchChanges = panel.getByRole('region', { name: 'Branch changes' });
    await expect(chip).toHaveText('+153 −150');
    await expect(panel.getByText('1 commit', { exact: true })).toBeVisible();
    await expect(commits.getByRole('listitem')).toHaveCount(1);
    await expect(branchChanges.getByRole('button', { name: /first\.ts/ })).toHaveCount(1);

    // Дифф коммита — первой вкладкой; дифф ветки на a.ts — второй, активной.
    await commits.getByRole('button', { name: /first in branch/ }).click();
    const commitTab = window.locator(`[role="tab"][data-tab-id^="diff:${sessionId}:"]`);
    await expect(commitTab).toHaveAttribute('data-active', 'true');
    await expect(window.getByTestId('diff-tab').getByTestId('diff-file-list').getByRole('button')).toHaveCount(1);
    await panel.getByRole('region', { name: 'Uncommitted' }).getByRole('button', { name: /a\.ts/ }).click();
    const branchTab = window.locator(`[role="tab"][data-tab-id="diff:${sessionId}"]`);
    await expect(branchTab).toHaveAttribute('data-active', 'true');

    const tab = window.getByTestId('diff-tab').filter({ visible: true });
    const aSection = tab.locator('[data-diff-path="src/a.ts"]');
    const modified = aSection.locator('.monaco-diff-editor .editor.modified');
    // Строки самой модели: удалённые строки одной колонки — тоже `.view-lines`, но в `.view-zones`.
    const text = modified.locator('.lines-content > .view-lines');
    await expect(text).toContainText("'v1-0'");
    // Прокрутка внутри живого редактора — колесом над ним: сторона длинная, редактор её забирает.
    const box = await modified.boundingBox();
    if (box === null) throw new Error('нет редактора a.ts');
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 1500);
    const slider = modified.locator('.overflow-guard > .monaco-scrollable-element > .scrollbar.vertical > .slider');
    await expect.poll(() => slider.evaluate((el) => (el as HTMLElement).style.top)).not.toBe('0px');
    const sliderTop = await slider.evaluate((el) => (el as HTMLElement).style.top);
    await expect(text).not.toContainText("'v1-0'");
    await expect(text).toContainText("'v1-");

    const key = `${project} ${workId}`;
    const state = (name: string) => window.locator(`[data-work-key="${key}"]:not([role="tab"]) [data-session-id="${sessionId}"] [data-state="${name}"]`);
    const events = path.join(project, '.harnas', 'works', workId, 'events');
    await mkdir(events, { recursive: true });
    const hook = (event: Record<string, string>) => appendFile(path.join(events, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);

    await hook({ hook_event_name: 'UserPromptSubmit' });
    await expect(state('working')).toHaveCount(1, { timeout: 5_000 });
    // Агент работает: правит a.ts (тот же объём правки — высота редактора прежняя) и коммитит новый файл.
    await writeFile(path.join(worktree, 'src', 'a.ts'), aText('v2'));
    await writeFile(path.join(worktree, 'src', 'second.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    git(worktree, 'add', 'src/second.ts');
    git(worktree, 'commit', '-q', '-m', 'second in branch');
    // Правка мимо повода окно не трогает (спека 11.1): дроссель в 2 с прошёл, а всё прежнее.
    await window.waitForTimeout(3_000);
    await expect(chip).toHaveText('+153 −150');
    await expect(commits.getByRole('listitem')).toHaveCount(1);
    await expect(text).toContainText("'v1-");

    await hook({ hook_event_name: 'Stop' });
    await expect(state('working')).toHaveCount(0, { timeout: 5_000 });
    // «Изменения» — сами, без Refresh.
    await expect(chip).toHaveText('+156 −150', { timeout: 6_000 });
    await expect(panel.getByText('2 commits', { exact: true })).toBeVisible();
    await expect(commits.getByRole('listitem')).toHaveCount(2);
    await expect(commits.getByRole('button', { name: /second in branch/ })).toHaveCount(1);
    await expect(branchChanges.getByRole('button', { name: /second\.ts/ })).toHaveCount(1);
    // Дифф ветки: новый файл в списке и секциях, сторона живого редактора — новая, прокрутка прежняя.
    await expect(tab.getByTestId('diff-file-list').getByRole('button', { name: /second\.ts/ })).toHaveCount(1);
    await expect(tab.locator('[data-diff-path="src/second.ts"]')).toHaveCount(1);
    await expect(text).toContainText("'v2-", { timeout: 6_000 });
    await expect(text).not.toContainText("'v1-");
    expect(await slider.evaluate((el) => (el as HTMLElement).style.top)).toBe(sliderTop);

    // Дифф коммита неизменен: тот же единственный файл, нового коммита в нём нет.
    await commitTab.click();
    await expect(commitTab).toHaveAttribute('data-active', 'true');
    const commitView = window.getByTestId('diff-tab').filter({ visible: true });
    await expect(commitView.getByTestId('diff-file-list').getByRole('button')).toHaveCount(1);
    await expect(commitView.getByTestId('diff-file-list').getByRole('button', { name: /first\.ts/ })).toHaveCount(1);

    expect(problems).toEqual([]);
  });
});
