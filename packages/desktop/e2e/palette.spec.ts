import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Палитра ⌘J (кусок 6.3, тесты 10–12; спека 9, строка 6 таблицы 14.3) и перенос ревью 6.2-B
 * (Important 1): выбор строки сессии отдаёт фокус её терминалу. ⌘J, ⌘2 и Enter — настоящие
 * нажатия Playwright: их ловит обработчик окна в рендерере (`keys/handler.ts`), а не меню.
 * Настоящий `claude` не запускается — `HARNAS_CLAUDE_BIN` указывает на эхо-заглушку.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

const term = (sessionId: string): string => `terminal:${sessionId}`;
// `data-session-id` уникален только внутри работы (хост нумерует s-01… в каждой).
const rowSel = (workKey: string, sessionId: string): string => `[data-work-key="${workKey}"] [data-session-id="${sessionId}"]`;
const options = (window: Page) => window.locator('[data-palette] [role="option"]');

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function createWork(window: Page, title: string): Promise<{ workId: string; key: string }> {
  const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title, goal: '' });
  return { workId, key: `${project} ${workId}` };
}

async function createSession(window: Page, workId: string, label: string): Promise<string> {
  const result = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
    projectPath: project,
    workId,
    provider: 'claude',
    label,
    task: '',
    parent: null,
  });
  return result.ref.sessionId;
}

/** Вкладка выбрана в своей работе, и эта работа — в центре (контейнер виден). */
async function activeTabOfShownWork(window: Page): Promise<{ workKey: string; tabId: string } | null> {
  return window.evaluate(() => {
    const shown = [...document.querySelectorAll<HTMLElement>('[data-work-container]')].find((el) => el.style.visibility !== 'hidden');
    const workKey = shown?.dataset.workContainer;
    if (workKey === undefined) return null;
    const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"][data-work-key][data-tab-id]')].find(
      (el) => el.dataset.workKey === workKey,
    );
    return tab === undefined ? null : { workKey, tabId: tab.dataset.tabId ?? '' };
  });
}

test.describe('палитра ⌘J: поиск, выбор, ⌘1–9, форма новой работы (кусок 6.3)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('palette');
    project = await makeTempProject('palette');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<Page> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    app = await electron.launch({ args: [mainEntry], env });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    return window;
  }

  /** Две работы и три сессии; строки всех сессий видны в сайдбаре — сторы окна их уже знают. */
  async function twoWorks(window: Page) {
    const a = await createWork(window, 'e2e-palette-a');
    const planner = await createSession(window, a.workId, 'планировщик');
    const executor = await createSession(window, a.workId, 'исполнитель');
    const b = await createWork(window, 'e2e-palette-b');
    const reviewer = await createSession(window, b.workId, 'ревьюер');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    for (const [key, id] of [[a.key, planner], [a.key, executor], [b.key, reviewer]] as const) {
      await expect(window.locator(rowSel(key, id))).toBeVisible();
    }
    return { a, b, planner, executor, reviewer };
  }

  async function openPalette(window: Page, query: string): Promise<void> {
    await window.keyboard.press('Meta+J');
    const input = window.locator('[data-palette] [cmdk-input]');
    await expect(input).toBeFocused();
    await window.keyboard.type(query);
  }

  test('тест 10: ⌘J и «исп» — первая строка S02 исполнитель; Enter делает её вкладку активной', async () => {
    const window = await launch();
    const { a, executor } = await twoWorks(window);

    await openPalette(window, 'исп');
    await expect(options(window).first()).toContainText('S02 исполнитель');
    await window.keyboard.press('Enter');

    await expect(window.locator('[data-palette]')).toHaveCount(0);
    await expect.poll(() => activeTabOfShownWork(window)).toEqual({ workKey: a.key, tabId: term(executor) });
  });

  test('тест 11: ⌘J, «S0» и ⌘2 — открыта вкладка второй строки списка, а не вторая работа сайдбара', async () => {
    const window = await launch();
    const { a, b, planner, executor, reviewer } = await twoWorks(window);

    await openPalette(window, 'S0');
    await expect(options(window)).not.toHaveCount(0);
    const second = (await options(window).nth(1).textContent()) ?? '';
    // Строка сессии — «S0N ярлык» и название работы подписью.
    const expected = second.includes('ревьюер')
      ? { workKey: b.key, tabId: term(reviewer) }
      : second.includes('исполнитель')
        ? { workKey: a.key, tabId: term(executor) }
        : { workKey: a.key, tabId: term(planner) };
    expect(second).toMatch(/S0\d/);

    await window.keyboard.press('Meta+2');
    await expect(window.locator('[data-palette]')).toHaveCount(0);
    await expect.poll(() => activeTabOfShownWork(window)).toEqual(expected);
  });

  test('тест 12: пустой результат по «нетакойработы» — Enter открывает форму новой работы с этим названием', async () => {
    const window = await launch();
    await twoWorks(window);

    await openPalette(window, 'нетакойработы');
    await expect(options(window)).toHaveCount(1);
    await expect(options(window).first()).toContainText('Create workspace');
    await window.keyboard.press('Enter');

    const dialog = window.getByRole('dialog');
    await expect(dialog.getByLabel('Title')).toHaveValue('нетакойработы');
    // Палитра работу не создаёт: в списке по-прежнему две.
    const works = await call<{ entries: unknown[] }>(window, 'works.list', {});
    expect(works.entries).toHaveLength(2);
  });

  test('перенос ревью 6.2-B: ⌘J, S01, Enter — фокус в терминале, набранное приходит в эхо-заглушку, Enter выбора агенту не ушёл', async () => {
    const window = await launch();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    const work = await createWork(window, 'e2e-palette-focus');
    const session = await createSession(window, work.workId, 'эхо');
    await expect(window.locator(rowSel(work.key, session))).toBeVisible();

    await openPalette(window, 'S01');
    await expect(options(window).first()).toContainText('S01 эхо');
    await window.keyboard.press('Enter');

    await expect.poll(() => activeTabOfShownWork(window)).toEqual({ workKey: work.key, tabId: term(session) });
    await expect(window.getByText('stub-echo готов', { exact: true })).toBeVisible();
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false))
      .toBe(true);

    // Без клика в терминал: ввод идёт туда, куда палитра отдала фокус.
    await window.keyboard.type('palette-focus');
    await window.keyboard.press('Enter');
    await expect(window.getByText('echo: palette-focus', { exact: true })).toBeVisible();
    // Enter выбора строки до PTY не дошёл: пустой строки эха нет.
    const emptyEchoes = await window.evaluate(
      () => [...document.querySelectorAll('.xterm-rows > div')].filter((row) => /^echo:\s*$/.test(row.textContent ?? '')).length,
    );
    expect(emptyEchoes).toBe(0);
    expect(errors).toEqual([]);
  });
});
