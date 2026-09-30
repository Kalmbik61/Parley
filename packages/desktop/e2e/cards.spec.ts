import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Карточки сайдбара (кусок 3.5, приёмка этапа 3, спека 6.2 и 6.6): порядок по вниманию, а не
 * по времени создания, и диалог «New workspace» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.7).
 *
 * Внимание двигается настоящими событиями хуков: тест дописывает строки в журнал сессии
 * (`<project>/.harnas/works/<workId>/events/<sessionId>.jsonl`), как это сделал бы хук
 * Claude Code, — stub-агент хуков не зовёт. Указатель держится вне сайдбара: под ним
 * пересортировка отложена (спека 6.2).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';
/** Ожидание закрытия диалога «New workspace»: `works.create` и `sessions.create` под нагрузкой отвечают и за 5 с. */
const DIALOG_CLOSED = { timeout: 15_000 };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
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

/** Порядок карточек сверху вниз — по `data-work-key` (кусок 3.3); с 4.3 его носят и вкладки. */
const cardOrder = (window: Page): Promise<string[]> =>
  window.evaluate(() =>
    [...document.querySelectorAll('[data-work-key]:not([role="tab"])')].map((el) => el.getAttribute('data-work-key') ?? ''),
  );

/** Указатель — над центром раскладки, вне сайдбара: иначе пересортировка ждёт его ухода. */
async function pointerAway(window: Page): Promise<void> {
  const box = await window.getByTestId('app-shell').boundingBox();
  if (box === null) throw new Error('нет app-shell');
  await window.mouse.move(box.x + box.width - 50, box.y + box.height / 2);
}

test.describe('карточки сайдбара и диалог новой работы (куски 3.5 и 7)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('cards');
    project = await makeTempProject('cards');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
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

  test('диалог «New workspace»: проект от «+» заголовка, название из первого промпта или введённое (⌘Enter); у каждой работы своя первая сессия', async () => {
    const { window } = await launch();
    // Проект уже известен по этой работе — «+» заголовка есть с первого кадра. Сессии в ней
    // нет: первая работа нового проекта без сессии попадает в снимок и так (core 087d3c8).
    await createWork(window, 'e2e-cards-seed');
    await expect(window.getByTestId('app-shell')).toBeVisible();

    await window.getByRole('button', { name: /^New workspace in / }).click();
    const dialog = window.getByRole('dialog');
    const chosen = dialog.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { checked: true });
    await expect(chosen).toHaveAttribute('title', project);

    // Агента диалог подставляет по ответу providers.list. Под нагрузкой «Create workspace» успевали нажать
    // раньше: проверка молча отказывала («Select an agent»), и название оставалось.
    await expect(dialog.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio', { checked: true })).toHaveText('Claude Code');

    // Без названия: оно берётся из первой строки промпта, до 40 знаков.
    await dialog.getByLabel(/^First prompt/).fill('e2e-cards-from-prompt\nsecond line of the task');
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(dialog).toBeHidden(DIALOG_CLOSED);

    // Второй раз — введённое название и ⌘Enter.
    await window.getByRole('button', { name: /^New workspace in / }).click();
    const again = window.getByRole('dialog');
    await again.getByLabel(/^Title/).fill('e2e-cards-typed');
    await again.getByLabel(/^Title/).press('Meta+Enter');
    await expect(again).toBeHidden(DIALOG_CLOSED);

    // Обе работы — с первой сессией; у первой её задача — весь промпт, у второй — тихий старт; последняя активна, терминал открыт.
    const created = async (): Promise<Array<{ title: string; sessions: number; task: string }>> => {
      const snapshot = await call<{ entries: Array<{ map: { work: { title: string }; sessions: Array<{ task: string }> } }> }>(window, 'works.list', {});
      return snapshot.entries
        .map((entry) => ({ title: entry.map.work.title, sessions: entry.map.sessions.length, task: entry.map.sessions[0]?.task ?? '' }))
        .filter((entry) => entry.title !== 'e2e-cards-seed')
        .sort((a, b) => a.title.localeCompare(b.title));
    };
    await expect.poll(created, DIALOG_CLOSED).toEqual([
      { title: 'e2e-cards-from-prompt', sessions: 1, task: 'e2e-cards-from-prompt\nsecond line of the task' },
      { title: 'e2e-cards-typed', sessions: 1, task: '' },
    ]);
    await expect(window.locator('[data-work-key]:not([role="tab"])')).toHaveCount(3);
    await expect(window.locator('#titlebar-tabs [role="tab"][data-tab-id^="terminal:"]')).toHaveCount(1);
  });

  test('диалог в новом проекте: «Choose a folder…» — папка в сегменте проектов; работа с первой сессией видна в сайдбаре', async () => {
    const { electronApp, window } = await launch();
    // Нативный выбор папки E2E не нажмёт — `showOpenDialog` в main отвечает сразу этим проектом.
    await electronApp.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, project);

    await window.getByTestId('landing').getByRole('button', { name: 'New workspace' }).click();
    const dialog = window.getByRole('dialog');
    // Работ нет — сегмента проектов нет, есть только «Choose a folder…».
    await expect(dialog.getByRole('radiogroup', { name: 'Project' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Choose a folder…' }).click();
    await expect(dialog.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { checked: true })).toHaveAttribute('title', project);
    await dialog.getByLabel(/^Title/).fill('e2e-cards-bare');
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(dialog).toBeHidden(DIALOG_CLOSED);

    // Работа видна с первой сессией: диалог 1.7 сессию запускает всегда.
    const card = window.locator('[data-work-key]:not([role="tab"])');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('e2e-cards-bare');
    const snapshot = await call<{ entries: Array<{ projectPath: string; map: { work: { id: string; title: string }; sessions: unknown[] } }> }>(
      window,
      'works.list',
      {},
    );
    expect(snapshot.entries.map((entry) => ({ title: entry.map.work.title, sessions: entry.map.sessions.length }))).toEqual([
      { title: 'e2e-cards-bare', sessions: 1 },
    ]);
    const workId = snapshot.entries[0]?.map.work.id ?? '';
    await expect(card).toHaveAttribute('data-work-key', `${project} ${workId}`);
  });
});
