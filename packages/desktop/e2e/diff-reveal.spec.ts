import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Переход к файлу во вкладке диффа на длинном списке (раунд fix-8b, пункт 1; живая линза 8.3 B,
 * Important 1): 35 изменённых файлов — 32 коротких по 5 строк и 3 длинных по 150 вперемешку.
 * Клик по файлу в списке вкладки сразу после появления списка доводит секцию до видимой части
 * с первого раза, хотя секции над ней после прокрутки домонтируются и меняют высоту; ручная
 * прокрутка человека после перехода не перебивается. Git-репозиторий — только во временном каталоге.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

const NAMES = Array.from({ length: 35 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`);
/** Длинные — вперемешку с короткими: их заглушка и живой редактор расходятся по высоте сильнее всех. */
const LONG = new Set(['f05.ts', 'f17.ts', 'f29.ts']);

function lines(name: string, count: number, tag: string): string {
  return `${Array.from({ length: count }, (_, i) => `export const ${name.replace('.ts', '')}_${i} = '${tag}${i}';`).join('\n')}\n`;
}

/** Где секция относительно видимой части прокрутки вкладки. */
async function place(window: Page, name: string): Promise<{ top: number; viewTop: number; viewBottom: number; scrollTop: number }> {
  return window.evaluate((target) => {
    const section = document.querySelector<HTMLElement>(`[data-testid="diff-tab"] [data-diff-path="src/${target}"]`);
    const scroller = section?.parentElement;
    if (section === null || section === undefined || scroller === null || scroller === undefined) throw new Error(`нет секции ${target}`);
    const view = scroller.getBoundingClientRect();
    return { top: section.getBoundingClientRect().top, viewTop: view.top, viewBottom: view.bottom, scrollTop: scroller.scrollTop };
  }, name);
}

/** Заголовок секции (28px) целиком в видимой части. */
function inView(at: { top: number; viewTop: number; viewBottom: number }): boolean {
  return at.top >= at.viewTop - 1 && at.top + 28 <= at.viewBottom + 1;
}

test.describe('переход к файлу во вкладке диффа на 35 файлах', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('diff-reveal');
    project = await makeTempProject('diff-reveal');
    await mkdir(path.join(project, 'src'), { recursive: true });
    for (const name of NAMES) await writeFile(path.join(project, 'src', name), lines(name, LONG.has(name) ? 150 : 5, 'old'));
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'config', 'user.email', 'e2e@example.com');
    git(project, 'config', 'user.name', 'e2e');
    git(project, 'config', 'commit.gpgsign', 'false');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'first');
    for (const name of NAMES) await writeFile(path.join(project, 'src', name), lines(name, LONG.has(name) ? 150 : 5, 'new'));
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('клик по последнему, среднему и первому файлу — секция в видимой части с первого клика; ручная прокрутка не перебивается', async () => {
    test.setTimeout(120_000);
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
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

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-diff-reveal', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'reveal', task: '', parent: null });
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    await sidebar.getByRole('tab', { name: 'Changes' }).click();
    await sidebar.getByRole('combobox', { name: 'Session' }).click();
    await window.getByRole('option', { name: /reveal/ }).click();
    await sidebar.getByRole('button', { name: /f00\.ts/ }).first().click();

    const tab = window.getByTestId('diff-tab');
    const list = tab.getByTestId('diff-file-list');
    await expect(list).toBeVisible();
    await expect(list.getByRole('button')).toHaveCount(35);

    // Сразу после появления списка — без ожидания, пока секции наверху осядут (так ловила линза).
    for (const name of ['f34.ts', 'f17.ts', 'f00.ts']) {
      await list.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click();
      await expect(tab.locator(`[data-diff-path="src/${name}"] .monaco-diff-editor`)).toHaveCount(1);
      await expect.poll(async () => inView(await place(window, name)), { message: `${name} в видимой части`, timeout: 5_000 }).toBe(true);
      // И держится, когда живые редакторы вокруг досчитали высоту.
      await window.waitForTimeout(1_500);
      const settled = await place(window, name);
      expect(inView(settled), `${name}: ${JSON.stringify(settled)}`).toBe(true);
    }

    // Ручная прокрутка после перехода: колесо сразу после клика — вкладка не возвращает к цели.
    await list.getByRole('button', { name: /f29\.ts/ }).click();
    await expect(tab.locator('[data-diff-path="src/f29.ts"] .monaco-diff-editor')).toHaveCount(1);
    const box = await tab.locator('[data-diff-path="src/f29.ts"]').boundingBox();
    if (box === null) throw new Error('нет секции f29.ts');
    // Над заголовком секции: колесо над редактором Monaco с запасом прокрутки забрал бы редактор.
    await window.mouse.move(box.x + 200, box.y + 14);
    await window.mouse.wheel(0, -600);
    await window.waitForTimeout(1_500);
    const after = await place(window, 'f29.ts');
    expect(after.top - after.viewTop, JSON.stringify(after)).toBeGreaterThan(200);

    expect(problems).toEqual([]);
  });
});
