import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';

/**
 * Карточки сайдбара (кусок 3.5, приёмка этапа 3, спека 6.2 и 6.6): порядок по вниманию, а не
 * по времени создания, и форма новой работы с «Create more».
 *
 * Внимание двигается настоящими событиями хуков: тест дописывает строки в журнал сессии
 * (`<project>/.harnas/works/<workId>/events/<sessionId>.jsonl`), как это сделал бы хук
 * Claude Code, — stub-агент хуков не зовёт. Указатель держится вне сайдбара: под ним
 * пересортировка отложена (спека 6.2).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const project = '/tmp/harnas-e2e-cards';

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

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

/** Строка в журнал событий сессии — то, что дописал бы хук Claude Code. */
async function hookEvent(workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.harnas', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

/** Порядок карточек сверху вниз — по `data-work-key` (кусок 3.3). */
const cardOrder = (window: Page): Promise<string[]> =>
  window.evaluate(() => [...document.querySelectorAll('[data-work-key]')].map((el) => el.getAttribute('data-work-key') ?? ''));

/** Указатель — над центром раскладки, вне сайдбара: иначе пересортировка ждёт его ухода. */
async function pointerAway(window: Page): Promise<void> {
  const box = await window.getByTestId('app-shell').boundingBox();
  if (box === null) throw new Error('нет app-shell');
  await window.mouse.move(box.x + box.width - 50, box.y + box.height / 2);
}

test.describe('карточки сайдбара и форма новой работы (кусок 3.5)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-cards-'));
    // Проект общий между прогонами: без очистки в нём копятся работы прошлых запусков.
    await rm(project, { recursive: true, force: true });
    await mkdir(project, { recursive: true });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  async function launch(): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    return { electronApp, window };
  }

  test('порядок по вниманию: working выше idle, затем ждущая разрешения работа — первой, у строки значок вопроса', async () => {
    const { window } = await launch();
    const first = await createWork(window, 'e2e-cards-first');
    const s1 = await createSession(window, first.workId, 'один');
    // Время создания различимо: без событий при равном ранге выше более поздняя.
    await window.waitForTimeout(20);
    const second = await createWork(window, 'e2e-cards-second');
    const s2 = await createSession(window, second.workId, 'два');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await pointerAway(window);

    await expect.poll(() => cardOrder(window)).toEqual([second.key, first.key]);

    // Первая работает — выше простаивающей второй, хотя создана раньше.
    await hookEvent(first.workId, s1, { hook_event_name: 'UserPromptSubmit' });
    await expect.poll(() => cardOrder(window), { timeout: 2_000 }).toEqual([first.key, second.key]);

    // Вторая ждёт разрешения — снова первая, у её строки сессии значок «ждёт тебя».
    await hookEvent(second.workId, s2, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    await expect.poll(() => cardOrder(window), { timeout: 2_000 }).toEqual([second.key, first.key]);
    await expect(window.locator(`[data-work-key="${second.key}"] [data-session-id="${s2}"] [data-state="blocked"]`)).toHaveCount(1);
  });

  test('форма новой работы с «Create more» создаёт две работы подряд; проект — от «+» заголовка', async () => {
    const { window } = await launch();
    // Нативный `dialog.showOpenDialog` E2E не выберет — проект уже известен по этой работе.
    // Сессия в ней — не для формы: первая работа нового проекта без сессии в снимок хоста не
    // попадает (индекс пишется раньше карты, а за каталогом проекта ещё никто не следит),
    // появится только со следующей записью карты.
    const seed = await createWork(window, 'e2e-cards-seed');
    await createSession(window, seed.workId, 'seed');
    await expect(window.getByTestId('app-shell')).toBeVisible();

    await window.getByRole('button', { name: 'New workspace in project', exact: true }).click();
    const dialog = window.getByRole('dialog');
    await expect(dialog.getByRole('combobox', { name: 'Project' })).toHaveText(project);
    await dialog.getByRole('checkbox', { name: 'Create more' }).click();

    const titleField = dialog.getByLabel('Title');
    await titleField.fill('e2e-cards-one');
    await dialog.getByRole('button', { name: 'Create' }).click();
    // Форма осталась открытой и очистила название.
    await expect(titleField).toHaveValue('');
    await titleField.fill('e2e-cards-two');
    await titleField.press('Meta+Enter');
    await expect(titleField).toHaveValue('');

    // Обе работы — с первой сессией; последняя созданная активна, её терминал открыт.
    const created = async (): Promise<Array<{ title: string; sessions: number }>> => {
      const snapshot = await call<{ entries: Array<{ map: { work: { title: string }; sessions: unknown[] } }> }>(window, 'works.list', {});
      return snapshot.entries
        .map((entry) => ({ title: entry.map.work.title, sessions: entry.map.sessions.length }))
        .filter((entry) => entry.title !== 'e2e-cards-seed')
        .sort((a, b) => a.title.localeCompare(b.title));
    };
    await expect.poll(created).toEqual([
      { title: 'e2e-cards-one', sessions: 1 },
      { title: 'e2e-cards-two', sessions: 1 },
    ]);
    await expect(window.locator('[data-work-key]')).toHaveCount(3);
    await expect(window.locator('#titlebar-tabs [role="tab"][data-tab-id^="terminal:"]')).toHaveCount(1);
  });
});
