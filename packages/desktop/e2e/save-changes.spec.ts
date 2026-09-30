import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Вопрос о несохранённых правках при закрытии окна и ⌘Q на собранном окне (кусок 7.3a, тест 11):
 * правка файла → крестик окна — вопрос в самом окне, «Cancel» оставляет окно и правку; выход
 * приложения — тот же вопрос, «Don't save» — приложение закрылось, файл на диске прежний. Имя
 * файла на 255 символов: диалог и строка вкладок не вылезают за окно 800×500.
 *
 * «Save» (раунд fix-7-accept, п. 2) — на каждом пути вопроса: крестик, выход, перезагрузка, работа
 * удалена не из окна, несколько файлов, ошибка записи одного. Окно закрывается за доли секунды; число
 * в журнале прогона. Прежние «58 с» — выход процесса, которого после крестика на macOS нет вовсе.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/** 255 байт — предел имени на APFS; без пробелов, переносить нечему. */
const LONG_FILE = `${'s'.repeat(252)}.ts`;

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Что из диалога вылезло за его край или за окно — пустой список, если ничего. */
async function dialogOverflow(window: Page): Promise<string[]> {
  return window.getByTestId('save-changes-dialog').evaluate((el) => {
    const problems: string[] = [];
    const box = el.getBoundingClientRect();
    if (box.left < 0 || box.right > window.innerWidth + 0.5) problems.push(`dialog ${Math.round(box.left)}..${Math.round(box.right)} vs ${window.innerWidth}`);
    for (const node of el.querySelectorAll('h2, button, li')) {
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.right > box.right + 0.5) problems.push(`${node.tagName.toLowerCase()} right ${Math.round(rect.right)} > ${Math.round(box.right)}`);
    }
    return problems;
  });
}

test.describe('несохранённые правки при закрытии окна', () => {
  let home: string;
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('save-changes');
    base = await makeTempProject('save-changes');
    project = path.join(base, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, LONG_FILE), 'export const answer = 42;\n');
    await writeFile(path.join(project, 'a.ts'), 'export const answer = 42;\n');
    await mkdir(path.join(project, 'locked'));
    await writeFile(path.join(project, 'locked', 'b.ts'), 'export const answer = 42;\n');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  test("крестик окна — вопрос, Cancel оставляет окно; выход — вопрос, Don't save — приложение закрылось", async () => {
    test.setTimeout(60_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    await call(window, 'works.create', { projectPath: project, title: 'save-changes', goal: '' });
    // 800 px: рядом с левым сайдбаром правому нет места (раунд main-r2, п. 7) — левый прячем.
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.keyboard.press('Meta+B');
    const sidebar = window.getByTestId('right-sidebar');
    await sidebar.locator(`[data-tree-path="${LONG_FILE}"]`).click();
    // Редактор — Monaco (кусок 7.3b): текст — в строках вида, ввод — через его поле.
    const lines = window.locator('.monaco-editor .view-lines').first();
    await expect(lines).toContainText('export const answer = 42;');
    await lines.click();
    await window.keyboard.press('Meta+ArrowDown');
    await window.keyboard.type('// edited');
    const tab = window.locator(`[role="tab"][data-tab-id="file:p:${LONG_FILE}"]`);
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    // Подсказка — путь и метка корня (раунд fix-live, D5).
    await expect(tab.locator(`[title="${LONG_FILE} · Project"]`)).toBeVisible();

    // Крестик окна: main отложил закрытие и спросил окно.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveAttribute('title', `Save changes to ${LONG_FILE}?`);
    expect(await dialogOverflow(window)).toEqual([]);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(tab.locator('[data-dirty-dot]')).toBeVisible();

    // Выход (⌘Q идёт тем же путём — `before-quit`): тот же вопрос, «Don't save» — приложение закрылось.
    const closed = electronApp.waitForEvent('close');
    await electronApp.evaluate(({ app: electronAppMain }) => electronAppMain.quit());
    await expect(dialog).toBeVisible();
    // Один файл — «Save», а не «Save all» (fix-7.3 п. 5).
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: "Don't save" }).click();
    await closed;
    app = null;
    expect(await readFile(path.join(project, LONG_FILE), 'utf8')).toBe('export const answer = 42;\n');
  });

  /**
   * Порог закрытия после «Save» (раунд fix-7-accept, п. 2): запись одного-двух файлов и закрытие
   * окна — доли секунды; прежде окно закрывалось только через ~58 с. 5 с — с запасом на нагрузку.
   */
  const CLOSE_AFTER_SAVE_MS = 5_000;

  /** Окно 800×500 с работой над проектом, файлы открыты из дерева и изменены в буфере. */
  async function launchDirty(names: string[]): Promise<{ electronApp: ElectronApplication; window: Page; problems: string[] }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'works.create', { projectPath: project, title: 'save-changes', goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.keyboard.press('Meta+B');
    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    window.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
    });
    // Отмена выгрузки страницей видна Playwright по CDP как диалог beforeunload (см. reload.spec):
    // без обработчика он отвечает на него сам ошибкой протокола.
    window.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') void dialog.dismiss().catch(() => {});
    });
    const sidebar = window.getByTestId('right-sidebar');
    for (const name of names) {
      // Файл в папке — сначала раскрыть папку.
      if (name.includes('/')) await sidebar.locator(`[data-tree-path="${name.slice(0, name.lastIndexOf('/'))}"]`).click();
      await sidebar.locator(`[data-tree-path="${name}"]`).click();
      const tab = window.locator(`[role="tab"][data-tab-id="file:p:${name}"]`);
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      const lines = window.locator('.monaco-editor:visible .view-lines').first();
      await expect(lines).toContainText('export const answer = 42;');
      await lines.click();
      await window.keyboard.press('Meta+ArrowDown');
      await window.keyboard.type('// edited');
      await expect(tab.locator('[data-dirty-dot]')).toBeVisible();
    }
    return { electronApp, window, problems };
  }

  const windowCount = (electronApp: ElectronApplication): Promise<number> =>
    electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  /** Метка `quit` main в stdout: сам процесс Chromium под нагрузкой разбирается десятки секунд (stop-app.ts). */
  async function quitMark(electronApp: ElectronApplication): Promise<{ seen: Promise<void> }> {
    const mark = 'parley-e2e: quit-after-save';
    const proc = electronApp.process();
    const seen = new Promise<void>((resolve) => {
      let text = '';
      const onData = (chunk: Buffer): void => {
        text += chunk.toString();
        if (!text.includes(mark)) return;
        proc.stdout?.off('data', onData);
        resolve();
      };
      proc.stdout?.on('data', onData);
    });
    await electronApp.evaluate(({ app: electronAppMain }, text) => {
      const fs = process.getBuiltinModule('node:fs');
      electronAppMain.once('quit', () => fs.writeSync(1, `${text}\n`));
    }, mark);
    // В обёртке: промис из async-функции иначе дождался бы самой метки.
    return { seen };
  }

  test('крестик окна — Save: файл записан, окно закрылось сразу', async () => {
    test.setTimeout(60_000);
    const { electronApp, window, problems } = await launchDirty(['a.ts']);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    // Окно, а не процесс: на macOS приложение без окон живёт дальше (`window-all-closed`), и
    // событие `close` Playwright — выход процесса — после крестика не приходит вовсе.
    await expect.poll(() => windowCount(electronApp), { timeout: CLOSE_AFTER_SAVE_MS }).toBe(0);
    expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(problems).toEqual([]);
  });

  test('крестик окна — Save, имя на 255 байт: файл записан, окно закрылось', async () => {
    test.setTimeout(60_000);
    const { electronApp, window, problems } = await launchDirty([LONG_FILE]);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => windowCount(electronApp), { timeout: CLOSE_AFTER_SAVE_MS }).toBe(0);
    expect(await readFile(path.join(project, LONG_FILE), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(problems).toEqual([]);
  });

  test('два файла — Save all: оба записаны, окно закрылось сразу', async () => {
    test.setTimeout(60_000);
    const { electronApp, window, problems } = await launchDirty(['a.ts', 'locked/b.ts']);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Save changes to 2 files?');
    await dialog.getByRole('button', { name: 'Save all' }).click();
    await expect.poll(() => windowCount(electronApp), { timeout: CLOSE_AFTER_SAVE_MS }).toBe(0);
    expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(await readFile(path.join(project, 'locked', 'b.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(problems).toEqual([]);
  });

  test('два файла — Save all, запись одного не удалась: окно остаётся, тост, его правка на месте; потом Save закрывает', async () => {
    test.setTimeout(90_000);
    const { electronApp, window, problems } = await launchDirty(['a.ts', 'locked/b.ts']);
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading')).toHaveText('Save changes to 2 files?');
    // Запись b.ts не удастся: его каталог только для чтения, временный файл рядом не создать.
    const locked = path.join(project, 'locked');
    await chmod(locked, 0o555);
    try {
      await dialog.getByRole('button', { name: 'Save all' }).click();
      await expect(window.getByText("Couldn't save all files — the window stays open")).toBeVisible();
      await expect.poll(() => windowCount(electronApp), { timeout: 2_000 }).toBe(1);
      expect(await windowCount(electronApp)).toBe(1);
      await expect(window.locator('[role="tab"][data-tab-id="file:p:locked/b.ts"] [data-dirty-dot]')).toBeVisible();
      await expect(window.locator('[role="tab"][data-tab-id="file:p:a.ts"] [data-dirty-dot]')).toHaveCount(0);
      expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    } finally {
      await chmod(locked, 0o755);
    }
    expect(await readFile(path.join(project, 'locked', 'b.ts'), 'utf8')).toBe('export const answer = 42;\n');
    // Ошибка записи — предупреждение в журнале рендерера, а не console.error и не pageerror.
    expect(problems).toEqual([]);

    // Каталог снова доступен: грязный остался один b.ts — «Save» пишет его и закрывает окно сразу.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => windowCount(electronApp), { timeout: CLOSE_AFTER_SAVE_MS }).toBe(0);
    expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(await readFile(path.join(project, 'locked', 'b.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
  });

  test('перезагрузка страницы — Save: файл записан, страница перезагрузилась сразу и без второго вопроса', async () => {
    test.setTimeout(60_000);
    const { electronApp, window, problems } = await launchDirty(['a.ts']);
    await window.evaluate(() => {
      (globalThis as { __parleyPageMark?: boolean }).__parleyPageMark = true;
    });
    await electronApp.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents;
      setImmediate(() => contents?.reload());
    });
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(() => window.evaluate(() => (globalThis as { __parleyPageMark?: boolean }).__parleyPageMark === true).catch(() => true), {
        timeout: CLOSE_AFTER_SAVE_MS,
      })
      .toBe(false);
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(problems).toEqual([]);
  });

  test('работа удалена не из окна — Save: файл записан', async () => {
    test.setTimeout(60_000);
    const { window, problems } = await launchDirty(['a.ts']);
    const snapshot = await call<{ entries: Array<{ map: { work: { id: string } } }> }>(window, 'works.list', {});
    const workId = snapshot.entries[0]?.map.work.id ?? '';
    await call(window, 'works.delete', { projectPath: project, workId });
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(problems).toEqual([]);
  });

  test('выход — Save: файл записан, приложение вышло сразу', async () => {
    test.setTimeout(60_000);
    const { electronApp, window, problems } = await launchDirty(['a.ts']);
    const { seen: quit } = await quitMark(electronApp);
    await electronApp.evaluate(({ app: electronAppMain }) => electronAppMain.quit());
    const dialog = window.getByTestId('save-changes-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), CLOSE_AFTER_SAVE_MS);
    });
    expect(await Promise.race([quit.then(() => 'quit' as const), late])).toBe('quit');
    clearTimeout(timer);
    expect(await readFile(path.join(project, 'a.ts'), 'utf8')).toBe('export const answer = 42;\n// edited');
    expect(problems).toEqual([]);
  });
});
