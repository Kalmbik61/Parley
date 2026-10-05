import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Рецепты комнат в диалоге «New session or room» (P26, спека рецептов 5.2, 6): выбор встроенного рецепта заполняет состав,
 * режим и ведущего; комната создаётся с `mode` и снимком рецепта, её шапка показывает чип и плейбук только для чтения;
 * Save as recipe пишет файл проекта через main, занятое имя не перезаписывается без выбора человека. Настоящий хост,
 * вместо `claude` — заглушка агента, окно Electron; `shell.openPath` в E2E — запись в журнал main (`PARLEY_SHELL=log`).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

interface RoomInMap {
  id: string;
  title: string;
  members: string[];
  lead: string | null;
  mode?: string;
  recipe?: { id: string; name: string; playbook: string } | null;
}

async function roomsOf(window: Page, workId: string): Promise<RoomInMap[]> {
  const snapshot = await call<{ entries: Array<{ map: { work: { id: string }; rooms: RoomInMap[] } }> }>(window, 'works.list', {});
  const entry = snapshot.entries.find((item) => item.map.work.id === workId);
  if (entry === undefined) throw new Error(`работы ${workId} нет в снимке`);
  return entry.map.rooms;
}

const shellLog = (app: ElectronApplication): Promise<Array<{ action: string; path?: string }>> =>
  app.evaluate(() => [...((globalThis as { __parleyShell?: Array<{ action: string; path?: string }> }).__parleyShell ?? [])]);

test.describe('рецепты комнат (P26)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-recipes');
    project = await makeTempProject('room-recipes');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<{ window: Page; workId: string }> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-recipes', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'seed', task: '', parent: null });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator('[data-work-title]').first().click();
    return { window, workId };
  }

  /** Диалог открыт, список рецептов прочитан. */
  async function openDialog(window: Page): Promise<Locator> {
    await window.keyboard.press('Meta+T');
    const dialog = window.getByRole('dialog');
    await expect(dialog.getByRole('combobox', { name: 'Recipe' })).toBeVisible();
    return dialog;
  }

  async function chooseRecipe(window: Page, dialog: Locator, name: string): Promise<void> {
    await dialog.getByRole('combobox', { name: 'Recipe' }).click();
    await window.getByRole('option', { name }).click();
  }

  test('Review: рецепт заполняет состав и режим; комната создаётся со снимком, чип показывает плейбук только для чтения', async () => {
    test.setTimeout(90_000);
    const { window, workId } = await launch();
    const dialog = await openDialog(window);

    // Список: без рецепта, три встроенных.
    await dialog.getByRole('combobox', { name: 'Recipe' }).click();
    await expect(window.getByRole('option')).toHaveText(['No recipe', 'Plan & build', 'Review', 'Debug']);
    await window.getByRole('option', { name: 'Review' }).click();

    // Состав и режим из рецепта; поля остаются редактируемыми.
    await expect(dialog.getByRole('heading', { name: 'New room' })).toBeVisible();
    await expect(dialog.locator('[data-agent-row]')).toHaveCount(2);
    await expect(dialog.getByRole('combobox', { name: 'Mode', exact: true })).toHaveText('Free');
    await expect(dialog.locator('[data-recipe-description]')).toContainText('Review correctness and design');
    await expect(dialog.getByRole('button', { name: 'Lead', exact: true })).toHaveCount(1);
    await expect(dialog.getByRole('combobox', { name: 'Role' }).first()).toBeEnabled();
    await dialog.getByRole('combobox', { name: 'Mode', exact: true }).click();
    await window.getByRole('option', { name: 'Checklist' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Mode', exact: true })).toHaveText('Checklist');

    await dialog.getByPlaceholder('What the agents will discuss').fill('e2e review room');
    await dialog.getByRole('button', { name: 'Create room' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // Комната запомнила режим человека и снимок рецепта; ведущий — из рецепта (первая строка).
    await expect.poll(async () => (await roomsOf(window, workId)).length, { timeout: 15_000 }).toBe(1);
    const room = (await roomsOf(window, workId))[0] as RoomInMap;
    expect(room.title).toBe('e2e review room');
    expect(room.members).toHaveLength(2);
    expect(room.lead).toBe(room.members[0]);
    expect(room.mode).toBe('checklist');
    expect(room.recipe?.id).toBe('builtin:review');
    expect(room.recipe?.name).toBe('Review');
    expect(room.recipe?.playbook).toContain('Clarify the branch');

    // Шапка комнаты: чип рядом с режимом, по клику — плейбук только для чтения.
    const header = window.locator('[data-room-header]');
    await expect(header.locator('[data-room-mode]')).toBeVisible();
    await header.getByRole('button', { name: 'Review', exact: true }).click();
    const playbook = window.getByRole('group', { name: 'Lead playbook · Review' });
    await expect(playbook).toContainText('Clarify the branch');
    await expect(playbook.locator('textarea, input')).toHaveCount(0);
  });

  test('Save as recipe: файл проекта через main, занятое имя — Rename или Replace, ../ отвергается', async () => {
    test.setTimeout(90_000);
    const { window } = await launch();
    const dialog = await openDialog(window);
    const recipes = path.join(project, '.parley', 'recipes');

    await chooseRecipe(window, dialog, 'Review');
    await dialog.getByRole('button', { name: 'Save as recipe…' }).click();
    await expect(dialog.getByRole('heading', { name: 'Save as recipe' })).toBeVisible();
    await dialog.getByLabel('Recipe name').fill('My review');
    await expect(dialog.getByLabel('File name')).toHaveValue('my-review');
    await dialog.getByLabel('Description').fill('Review with my notes');

    // Имя файла с ../ и слешем: окно отказывает, диск не тронут.
    await dialog.getByLabel('File name').fill('../escape');
    await dialog.getByRole('button', { name: 'Save recipe' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Use letters, digits, - and _ in the file name.');
    await dialog.getByLabel('File name').fill('a/b');
    await dialog.getByRole('button', { name: 'Save recipe' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Use letters, digits, - and _ in the file name.');
    await expect(readdir(path.join(project, '.parley', 'recipes'))).rejects.toMatchObject({ code: 'ENOENT' });

    // Сохранение: файл есть, редактор (журнал shell) открыл именно его, форма вернулась с выбранным рецептом.
    await dialog.getByLabel('File name').fill('my-review');
    await dialog.getByRole('button', { name: 'Save recipe' }).click();
    await expect(dialog.getByRole('heading', { name: 'New room' })).toBeVisible();
    expect(await readdir(recipes)).toEqual(['my-review.md']);
    const file = path.join(recipes, 'my-review.md');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('name: "My review"');
    expect(text).toContain('mode: free');
    expect(text).toContain('Clarify the branch');
    expect(await shellLog(app as ElectronApplication)).toContainEqual({ action: 'openPath', path: file });
    await expect(dialog.getByRole('combobox', { name: 'Recipe' })).toHaveText('My review');

    // Новый рецепт виден в списке и собирается обратно в состав.
    await dialog.getByRole('combobox', { name: 'Recipe' }).click();
    await expect(window.getByRole('option')).toHaveText(['No recipe', 'Plan & build', 'Review', 'Debug', 'My review']);
    await window.getByRole('option', { name: 'My review' }).click();
    await expect(dialog.locator('[data-agent-row]')).toHaveCount(2);
    await expect(dialog.locator('[data-recipe-description]')).toHaveText('Review with my notes');

    // То же имя: файл не тронут, предлагается Rename или Replace.
    await dialog.getByRole('button', { name: 'Save as recipe…' }).click();
    await dialog.getByLabel('Recipe name').fill('My review');
    await dialog.getByLabel('Description').fill('Second take');
    await dialog.getByRole('button', { name: 'Save recipe' }).click();
    await expect(dialog.locator('[data-recipe-exists]')).toHaveText('my-review.md already exists. Rename the file or replace it.');
    expect(await readFile(file, 'utf8')).toBe(text);

    // Rename — другое имя файла, первый файл на месте.
    await dialog.getByRole('button', { name: 'Rename' }).click();
    await dialog.getByLabel('File name').fill('my-review-2');
    await dialog.getByRole('button', { name: 'Save recipe' }).click();
    await expect(dialog.getByRole('heading', { name: 'New room' })).toBeVisible();
    expect((await readdir(recipes)).sort()).toEqual(['my-review-2.md', 'my-review.md']);
    expect(await readFile(file, 'utf8')).toBe(text);

    // Replace — только по выбору человека: первый файл заменён.
    await dialog.getByRole('button', { name: 'Save as recipe…' }).click();
    await dialog.getByLabel('Recipe name').fill('My review');
    await dialog.getByLabel('Description').fill('Replaced description');
    await dialog.getByRole('button', { name: 'Save recipe' }).click();
    await dialog.getByRole('button', { name: 'Replace' }).click();
    await expect(dialog.getByRole('heading', { name: 'New room' })).toBeVisible();
    expect(await readFile(file, 'utf8')).toContain('description: "Replaced description"');
    expect((await readdir(recipes)).sort()).toEqual(['my-review-2.md', 'my-review.md']);
  });
});
