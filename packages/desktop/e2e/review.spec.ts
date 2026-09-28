import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Приёмка этапа 8 на собранном окне (кусок 8.4b, спека 14.3, строка 8): сессия в worktree —
 * заметка к строке диффа уходит stub-агенту блоком формата 11.4; коммит из «Changes» и слияние в
 * базу merge-коммитом; конфликт виден до попытки слияния.
 *
 * Подготовка (решение сверки I11): stub в режиме `STUB_BRACKETED=1` печатает вставку как
 * `PASTE<<…>>`; `HARNAS_HOME` и `HARNAS_WORKTREE_ROOT` — внутри временного каталога теста:
 * корень worktree по умолчанию — `~/harnas/worktrees` настоящего дома, `HARNAS_HOME` его не
 * переносит. Каждый сценарий проверяет, что worktree сессии лежит под этим корнем.
 * Git-репозитории — только во временных каталогах; буфер обмена человека не трогается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

const LINES = Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`);

interface Setup {
  app: ElectronApplication;
  window: Page;
  workId: string;
  sessionId: string;
  worktree: string;
  branch: string;
}

test.describe('ревью изменений: заметки, коммит, слияние, конфликт (этап 8)', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('review');
    project = await makeTempProject('review');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src', 'base.ts'), `${LINES.join('\n')}\n`);
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

  /** Окно, работа и сессия в worktree под корнем внутри дома теста; stub в режиме bracketed paste. */
  async function start(): Promise<Setup> {
    const root = path.join(home, 'worktrees');
    const env = {
      ...process.env,
      HARNAS_HOME: home,
      HARNAS_CLAUDE_BIN: stubAgent,
      HARNAS_TERMINAL_RENDERER: 'dom',
      HARNAS_WORKTREE_ROOT: root,
      STUB_BRACKETED: '1',
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1500, height: 950 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-review', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'reviewer',
      task: '',
      parent: null,
      worktree: true,
    });
    const sessionId = created.ref.sessionId;
    type Snapshot = {
      entries: Array<{ map: { work: { id: string }; sessions: Array<{ id: string; worktree: { path: string; branch: string; createdAt: string | null } | null }> } }>;
    };
    const worktreeOf = async (): Promise<{ path: string; branch: string } | null> => {
      const snapshot = await call<Snapshot>(window, 'works.list', {});
      const info = snapshot.entries.find((entry) => entry.map.work.id === workId)?.map.sessions.find((s) => s.id === sessionId)?.worktree;
      return info === undefined || info === null || info.createdAt === null ? null : { path: info.path, branch: info.branch };
    };
    await expect.poll(worktreeOf, { timeout: 10_000 }).not.toBeNull();
    const worktree = (await worktreeOf()) as { path: string; branch: string };
    // Worktree — под корнем теста, а не в `~/harnas/worktrees` настоящего дома.
    expect(worktree.path.startsWith(`${root}${path.sep}`)).toBe(true);
    return { app: electronApp, window, workId, sessionId, worktree: worktree.path, branch: worktree.branch };
  }

  /** Вкладка «Changes» правого сайдбара на сессии теста. */
  async function openChanges(window: Page): Promise<ReturnType<Page['getByTestId']>> {
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Changes' }).click();
    const picker = sidebar.getByRole('combobox', { name: 'Session' });
    // Терминал сессии открыт — она в фокусе, и выбирать её не нужно.
    if (!(await picker.textContent())?.includes('reviewer')) {
      await picker.click();
      await window.getByRole('option', { name: /reviewer/ }).click();
    }
    return sidebar.getByTestId('changes-panel');
  }

  test('заметка к строке диффа → Send — stub получил PASTE<<Review notes for S01 и echo:; заметка — Sent to S01', async () => {
    test.setTimeout(120_000);
    const { window, sessionId, worktree } = await start();
    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
    });

    // Терминал сессии: stub готов и включил bracketed paste — ждём ещё чуть, пока хост его увидит.
    await window.locator(`[data-session-id="${sessionId}"]`).first().click();
    await expect.poll(() => screenText(window)).toContain('stub-echo готов');
    await window.waitForTimeout(300);

    await writeFile(path.join(worktree, 'src', 'note.ts'), 'export const alpha = 1;\nexport const beta = 2;\nexport const gamma = 3;\n');
    const panel = await openChanges(window);
    const uncommitted = panel.getByRole('region', { name: 'Uncommitted' });
    await expect(uncommitted.getByRole('button', { name: /note\.ts/ })).toHaveCount(1, { timeout: 10_000 });
    await uncommitted.getByRole('button', { name: /note\.ts/ }).click();

    const tab = window.getByTestId('diff-tab').filter({ visible: true });
    const section = tab.locator('[data-diff-path="src/note.ts"]');
    const modified = section.locator('.monaco-diff-editor .editor.modified');
    await expect(modified.locator('.lines-content > .view-lines')).toContainText('beta');

    // «+» гаттера: наведение на номер строки 2 и клик — поле заметки под строкой.
    const strip = section.locator('[data-testid="gutter-add"][data-side="modified"]');
    const number = modified.locator('.line-numbers').filter({ hasText: /^\s*2\s*$/ }).first();
    const [stripBox, numberBox] = await Promise.all([strip.boundingBox(), number.boundingBox()]);
    if (stripBox === null || numberBox === null) throw new Error('нет гаттера или номера строки');
    const x = stripBox.x + stripBox.width / 2;
    const y = numberBox.y + numberBox.height / 2;
    await window.mouse.move(x, y);
    await expect(strip.getByRole('button', { name: 'Add note' })).toBeVisible();
    await window.mouse.down();
    await window.mouse.up();

    const field = section.getByPlaceholder('Note for the agent — ⌘Enter to save');
    await expect(field).toBeFocused();
    await field.fill('Rename beta to betaValue');
    await window.keyboard.press('Meta+Enter');
    const zone = section.getByTestId('note-zone');
    await expect(zone).toContainText('Rename beta to betaValue');
    await expect(zone).toContainText('You');
    // Сохранение агенту ничего не шлёт.
    await window.waitForTimeout(500);

    await zone.getByRole('button', { name: /^Send/ }).click();
    await expect(zone).toContainText('Sent to S01 ·', { timeout: 10_000 });

    // Терминал сессии: вставка блоком формата 11.4 и Enter.
    await window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`).click();
    await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('PASTE<<Review notes for S01');
    await expect.poll(() => screenText(window)).toContain('echo:');
    expect(await screenText(window)).toContain('File: src/note.ts');
    expect(problems).toEqual([]);
  });

  test('fix-8.4b п. 2: свёрнутый регион разворачивается кнопкой Monaco «Show Unchanged Region» — гаттер заметок её не закрывает (обе стороны); «+» и протяжка работают', async () => {
    test.setTimeout(120_000);
    // Длинный файл в базе до создания сессии: правка одной строки в ветке — остальное свёрнуто.
    const long = Array.from({ length: 60 }, (_, i) => `export const w${i + 1} = ${i + 1};`);
    await writeFile(path.join(project, 'src', 'long.ts'), `${long.join('\n')}\n`);
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'long');
    const { app: electronApp, window, sessionId, worktree } = await start();
    // Две колонки: у узкого окна Monaco сам рисует одну (useInlineViewWhenSpaceIsLimited).
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 2000, height: 1000 }));
    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
    });
    await window.locator(`[data-session-id="${sessionId}"]`).first().click();
    await expect.poll(() => screenText(window)).toContain('stub-echo готов');
    await window.waitForTimeout(300);

    const edited = [...long];
    edited[2] = 'export const w3 = 333;';
    await writeFile(path.join(worktree, 'src', 'long.ts'), `${edited.join('\n')}\n`);
    const panel = await openChanges(window);
    const uncommitted = panel.getByRole('region', { name: 'Uncommitted' });
    await expect(uncommitted.getByRole('button', { name: /long\.ts/ })).toHaveCount(1, { timeout: 10_000 });
    await uncommitted.getByRole('button', { name: /long\.ts/ }).click();

    const tab = window.getByTestId('diff-tab').filter({ visible: true });
    const section = tab.locator('[data-diff-path="src/long.ts"]');
    const modified = section.locator('.monaco-diff-editor .editor.modified');
    const original = section.locator('.monaco-diff-editor .editor.original');
    await expect(modified.locator('.lines-content > .view-lines')).toContainText('333');
    await expect(section.locator('[data-testid="gutter-add"][data-side="original"]')).toHaveCount(1);
    const unfold = modified.locator('.diff-hidden-lines [title="Show Unchanged Region"]');
    await expect(unfold.first()).toBeVisible();

    // Ни одна кнопка плашек свёрнутых регионов (обе стороны) не накрыта гаттером заметок.
    const covered = await section.evaluate((root) =>
      Array.from(root.querySelectorAll<HTMLElement>('.diff-hidden-lines a, .diff-hidden-lines [role="button"], .diff-hidden-lines .center'))
        .map((element) => {
          const box = element.getBoundingClientRect();
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return top?.closest('[data-testid="gutter-add"]') === null || top === null ? null : element.className || element.tagName;
        })
        .filter((name) => name !== null),
    );
    expect(covered).toEqual([]);

    // Обычный клик по кнопке Monaco разворачивает регион: строка 30 (была свёрнута) видна, плашки нет.
    await expect(modified.locator('.lines-content > .view-lines')).not.toContainText('export const w30 = 30;');
    await unfold.first().click({ timeout: 5_000 });
    await expect(modified.locator('.lines-content > .view-lines')).toContainText('export const w30 = 30;');
    await expect(modified.locator('.diff-hidden-lines')).toHaveCount(0);

    // «+» стороны original — наведением на номер строки.
    const originalStrip = section.locator('[data-testid="gutter-add"][data-side="original"]');
    const originalNumber = original.locator('.line-numbers').filter({ hasText: /^\s*5\s*$/ }).first();
    const [originalStripBox, originalNumberBox] = await Promise.all([originalStrip.boundingBox(), originalNumber.boundingBox()]);
    if (originalStripBox === null || originalNumberBox === null) throw new Error('нет гаттера или номера строки original');
    await window.mouse.move(originalStripBox.x + originalStripBox.width / 2, originalNumberBox.y + originalNumberBox.height / 2);
    await expect(originalStrip.getByRole('button', { name: 'Add note' })).toBeVisible();

    // Протяжка по «+» стороны modified со строки 5 до 7 — заметка на диапазон.
    const strip = section.locator('[data-testid="gutter-add"][data-side="modified"]');
    const numberBox = async (line: number): Promise<{ x: number; y: number }> => {
      const [stripBox, box] = await Promise.all([strip.boundingBox(), modified.locator('.line-numbers').filter({ hasText: new RegExp(`^\\s*${line}\\s*$`) }).first().boundingBox()]);
      if (stripBox === null || box === null) throw new Error(`нет гаттера или номера строки ${line}`);
      return { x: stripBox.x + stripBox.width / 2, y: box.y + box.height / 2 };
    };
    const from = await numberBox(5);
    const to = await numberBox(7);
    await window.mouse.move(from.x, from.y);
    await expect(strip.getByRole('button', { name: 'Add note' })).toBeVisible();
    await window.mouse.down();
    await window.mouse.move(to.x, to.y, { steps: 4 });
    await window.mouse.up();
    const field = section.getByPlaceholder('Note for the agent — ⌘Enter to save');
    await expect(field).toBeFocused();
    await field.fill('Range note');
    await window.keyboard.press('Meta+Enter');
    const zone = section.getByTestId('note-zone');
    await expect(zone).toContainText('Range note');
    await zone.getByRole('button', { name: /^Send/ }).click();
    await expect(zone).toContainText('Sent to S01 ·', { timeout: 10_000 });
    await window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`).click();
    await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('Lines: 5-7');
    expect(problems).toEqual([]);
  });

  test('коммит из Changes → Uncommitted пуст, файл в Branch changes; Merge into main с подтверждением → merge-коммит в базе', async () => {
    test.setTimeout(120_000);
    const { window, worktree, branch } = await start();

    await writeFile(path.join(worktree, 'src', 'feature.ts'), 'export const feature = true;\n');
    const panel = await openChanges(window);
    const uncommitted = panel.getByRole('region', { name: 'Uncommitted' });
    await expect(uncommitted.getByRole('button', { name: /feature\.ts/ })).toHaveCount(1, { timeout: 10_000 });

    await panel.getByPlaceholder('Commit message').fill('add feature');
    await panel.getByRole('button', { name: 'Commit', exact: true }).click();
    await expect(uncommitted.getByRole('listitem')).toHaveCount(0, { timeout: 10_000 });
    await expect(panel.getByRole('region', { name: 'Branch changes' }).getByRole('button', { name: /feature\.ts/ })).toHaveCount(1);
    expect(git(worktree, 'log', '-1', '--format=%s').trim()).toBe('add feature');

    await panel.getByRole('button', { name: 'Merge into main' }).click();
    const dialog = window.getByRole('dialog');
    await expect(dialog).toContainText(`Merge ${branch} into main?`);
    await dialog.getByRole('button', { name: 'Merge into main' }).click();
    await expect(window.locator('[data-sonner-toast]').filter({ hasText: 'Merged into main' })).toBeVisible({ timeout: 10_000 });

    // В базе — merge-коммит (`--no-ff`) с веткой сессии вторым родителем, файл ветки на диске базы.
    const merges = git(project, 'log', '--merges', '--format=%P').trim().split('\n').filter((line) => line !== '');
    expect(merges).toHaveLength(1);
    expect(merges[0]?.split(' ')[1]).toBe(git(worktree, 'rev-parse', 'HEAD').trim());
    expect(existsSync(path.join(project, 'src', 'feature.ts'))).toBe(true);
  });

  test('правка одной строки в базе и в ветке → секция Conflicts с файлом до попытки слияния', async () => {
    test.setTimeout(120_000);
    const { window, worktree } = await start();

    const inBase = [...LINES];
    inBase[5] = 'export const v5 = "base";';
    await writeFile(path.join(project, 'src', 'base.ts'), `${inBase.join('\n')}\n`);
    git(project, 'commit', '-q', '-am', 'base edit');
    const inBranch = [...LINES];
    inBranch[5] = 'export const v5 = "branch";';
    await writeFile(path.join(worktree, 'src', 'base.ts'), `${inBranch.join('\n')}\n`);
    git(worktree, 'commit', '-q', '-am', 'branch edit');

    const panel = await openChanges(window);
    const conflicts = panel.getByRole('region', { name: 'Conflicts' });
    await expect(conflicts.getByRole('button', { name: /src\/base\.ts/ })).toHaveCount(1, { timeout: 10_000 });
    // Слияния не было: в базе нет merge-коммита, главная кнопка — «Ask agent to resolve».
    await expect(panel.getByRole('button', { name: 'Ask agent to resolve' })).toBeVisible();
    expect(git(project, 'log', '--merges', '--format=%H').trim()).toBe('');
  });
});
