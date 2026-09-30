import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Строка вкладок на узком окне (раунд fix-7-accept, п. 3): 800×500, правый сайдбар открыт, девять
 * вкладок с именами по 255 байт — шире видимой строки. Открытая или ставшая активной вкладка любым
 * путём (дерево, клик, ⌃1–9, ⌃Tab, ⌘P, восстановление раскладки) — целиком в видимой части строки,
 * а обычный клик Playwright по любой вкладке активирует её: полоса прокрутки строки его не перехватывает.
 *
 * Девять, а не четыре: с облика Organic (спека окна 2026-09-29, 1.1) пилюли вкладок делят строку и
 * сжимаются до 72 px, и четыре вкладки на 800×500 влезали целиком — строка не прокручивалась, а
 * проверка «активная видна» ничего не проверяла. Девять сжатых не влезают и в узкую строку рядом с
 * правым сайдбаром.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/**
 * Девять имён по 255 байт: даже сжатые до 72 px вкладки шире видимой строки окна 800×500. Первые буквы
 * разные — по ней тест узнаёт вкладку (`visible m`); порядок первых четырёх (m, p, c, q) — тот, что
 * ждут ⌃1, ⌃4 и ⌘P ниже.
 */
const FILES = ['m', 'p', 'c', 'q', 'a', 'b', 'd', 'e', 'f'].map((letter) => `${letter.repeat(252)}.ts`);
/** Последняя вкладка строки — правый край прокрутки, самый трудный случай для «активная видна». */
const LAST = FILES[FILES.length - 1] ?? '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('строка вкладок', () => {
  let home: string;
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('tab-strip');
    base = await makeTempProject('tab-strip');
    project = path.join(base, 'project');
    await mkdir(project, { recursive: true });
    for (const name of FILES) await writeFile(path.join(project, name), `// ${name.slice(0, 1)}\n`);
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  /** Активная вкладка строки целиком внутри видимой рамки строки (±1 px) — или что не так. */
  async function activeTabPlacement(window: Page): Promise<string> {
    return window.evaluate(() => {
      const list = document.querySelector<HTMLElement>('[role="tablist"]');
      const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (list === null || list === undefined || tab === null || tab === undefined) return 'no active tab';
      const outer = list.getBoundingClientRect();
      const inner = tab.getBoundingClientRect();
      if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
        return `${(tab.dataset.tabId ?? '').slice(7, 8)} at ${Math.round(inner.left)}..${Math.round(inner.right)} outside ${Math.round(outer.left)}..${Math.round(outer.right)} (scrollLeft ${list.scrollLeft})`;
      }
      return `visible ${(tab.dataset.tabId ?? '').slice(7, 8)}`;
    });
  }

  async function launch(): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    return { electronApp, window };
  }

  const tabOf = (window: Page, name: string) => window.locator(`[role="tab"][data-tab-id="file:p:${name}"]`);

  test('800×500, девять длинных имён: дерево, клик, ⌃1–9, ⌃Tab, ⌘P и восстановление — активная вкладка видна целиком', async () => {
    test.setTimeout(120_000);
    const first = await launch();
    let { window } = first;
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'works.create', { projectPath: project, title: 'tab-strip', goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    // 800 px: рядом с левым сайдбаром правому нет места (раунд main-r2, п. 7) — левый прячем.
    await window.keyboard.press('Meta+B');
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

    // Открытие из дерева: каждая новая вкладка — в видимой части строки.
    for (const name of FILES) {
      await sidebar.locator(`[data-tree-path="${name}"]`).click();
      await expect(tabOf(window, name)).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => activeTabPlacement(window)).toBe(`visible ${name.slice(0, 1)}`);
    }
    // Строка действительно уже вкладок: иначе проверка ничего не значит.
    expect(await window.evaluate(() => {
      const list = document.querySelector<HTMLElement>('[role="tablist"]');
      return list === null ? 0 : list.scrollWidth - list.clientWidth;
    })).toBeGreaterThan(200);

    // Обычный клик (в центр рамки) по каждой вкладке, от последней к первой и обратно.
    for (const name of [...FILES].reverse().concat(FILES)) {
      await tabOf(window, name).click({ timeout: 5_000 });
      await expect(tabOf(window, name)).toHaveAttribute('aria-selected', 'true');
      await expect.poll(() => activeTabPlacement(window)).toBe(`visible ${name.slice(0, 1)}`);
    }

    // ⌃1 и ⌃4, ⌃Tab — к предыдущей по недавности.
    await window.keyboard.press('Control+1');
    await expect.poll(() => activeTabPlacement(window)).toBe('visible m');
    await window.keyboard.press('Control+4');
    await expect.poll(() => activeTabPlacement(window)).toBe('visible q');
    await window.keyboard.press('Control+Tab');
    await expect.poll(() => activeTabPlacement(window)).toBe('visible m');

    // ⌘P — открыть уже открытый файл.
    await window.keyboard.press('Meta+P');
    await window.keyboard.type('ccc');
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText('ccc');
    await window.keyboard.press('Enter');
    await expect(window.locator('[data-palette]')).toHaveCount(0);
    await expect.poll(() => activeTabPlacement(window)).toBe('visible c');
    expect(problems).toEqual([]);

    // Восстановление раскладки: активная — последняя вкладка, её и видно после перезапуска.
    await tabOf(window, LAST).click();
    await expect.poll(() => activeTabPlacement(window)).toBe(`visible ${LAST.slice(0, 1)}`);
    // Раскладка пишется с тишиной 500 мс (спека 5.8).
    await window.waitForTimeout(1_000);
    await quitApp(first.electronApp);
    ({ window } = await launch());
    await expect(tabOf(window, LAST)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => activeTabPlacement(window)).toBe(`visible ${LAST.slice(0, 1)}`);
  });

  test('800×500, две группы: активная у правого края строки; открыли правый сайдбар — строка сузилась, активная видна (раунд 8, пункт 8)', async () => {
    test.setTimeout(120_000);
    const { electronApp, window } = await launch();
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'works.create', { projectPath: project, title: 'tab-strip', goal: '' });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.keyboard.press('Meta+B');
    const sidebar = window.getByTestId('right-sidebar');
    await expect(sidebar).toBeVisible();
    for (const name of FILES) {
      await sidebar.locator(`[data-tree-path="${name}"]`).click();
      await expect(tabOf(window, name)).toHaveAttribute('aria-selected', 'true');
    }
    const problems: string[] = [];
    window.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

    // Одна группа рисует строку в заголовке окна — её ширина от сайдбаров не зависит. Две группы
    // одна под другой: строка верхней — во всю ширину центра, и правый сайдбар её сужает.
    await window.keyboard.press('Meta+L');
    await expect(sidebar).toBeHidden();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'group.splitDown'));
    await window.getByRole('dialog').getByRole('option').first().click();
    // Последняя вкладка — у правого края строки: при сужении строки её обязана дотянуть прокрутка.
    const strip = window.locator('[role="tablist"]', { has: tabOf(window, LAST) });
    await expect(strip).toHaveCount(1);

    /** Последняя вкладка — активная в своей строке и целиком внутри её видимой рамки (±1 px). */
    const placement = (): Promise<string> =>
      strip.evaluate((list, id) => {
        const tab = list.querySelector<HTMLElement>(`[role="tab"][data-tab-id="${id}"]`);
        if (tab === null) return 'no tab';
        if (tab.getAttribute('aria-selected') !== 'true') return 'not active';
        const outer = list.getBoundingClientRect();
        const inner = tab.getBoundingClientRect();
        if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
          return `at ${Math.round(inner.left)}..${Math.round(inner.right)} outside ${Math.round(outer.left)}..${Math.round(outer.right)} (scrollLeft ${list.scrollLeft})`;
        }
        return 'visible';
      }, `file:p:${LAST}`);
    const width = (): Promise<number> => strip.evaluate((list) => list.clientWidth);

    await tabOf(window, LAST).click();
    await expect.poll(placement).toBe('visible');
    const wide = await width();

    // Открыли правый сайдбар: строка уже, активная — по-прежнему целиком в видимой части.
    await window.keyboard.press('Meta+L');
    await expect(sidebar).toBeVisible();
    await expect.poll(width).toBeLessThan(wide - 100);
    await expect.poll(placement).toBe('visible');
    expect(problems).toEqual([]);
  });
});
