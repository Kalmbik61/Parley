import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Помощник на острове (спека 2026-10-14): палитра «Ask the assistant» → вид помощника на острове → вопрос → карточка с письмом
 * в комнату → Send → в комнате письмо «You (via assistant)» со значком помощника → второй вопрос и ответ → Esc.
 * Вместо `claude` — `stub-assistant-agent.mjs`: ход помощника он ведёт по-настоящему через маршруты хоста (обзор,
 * предложение письма), сессии работы и `--version` уходят в обычную заглушку. Каркас — как у `island.spec.ts`:
 * остров включается пустым `PARLEY_ISLAND` (конфиг Playwright гасит его для всех спеков), главное окно берётся по
 * адресу страницы, остров — по `island.html`. Работа и комната — шаги `room-actions.spec.ts`; названия длинные
 * (правило визуальных проверок), окно 800×500.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-assistant-agent.mjs');

const WORK_TITLE = 'A very long workspace title for the assistant end-to-end check';
const ROOM_TITLE = 'A very long room title that should not break the island layout';
const LETTER = 'Skip the Safari tests.';

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    app: { saveUi: (patch: unknown) => Promise<unknown> };
  };
};

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

/** Страница острова, если его окно есть; нет окна — `undefined`. */
function islandPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().endsWith('/island.html'));
}

/** Главное окно: страница загружена и это не остров (остров создаётся вместе с ним и мог оказаться первым). */
async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  const found = (): Page | undefined =>
    app.windows().find((page) => page.url() !== '' && page.url() !== 'about:blank' && !page.url().endsWith('/island.html'));
  await expect.poll(() => found() !== undefined, { message: 'главное окно загрузилось', timeout: 30_000 }).toBe(true);
  return found()!;
}

/** Размер главного окна: `getAllWindows()[0]` мог бы оказаться островом, у которого размер ведёт его содержимое. */
async function resizeMain(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().endsWith('/island.html'))
        ?.setBounds({ x: 0, y: 0, ...size }),
    { width, height },
  );
}

test.describe('помощник на острове', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('assistant');
    project = await makeTempProject('assistant');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('вопрос → карточка с письмом комнате → Send → «You (via assistant)» в комнате → ответ → Esc', async () => {
    test.setTimeout(120_000);
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_CLAUDE_BIN: stubAgent,
        PARLEY_GLM_BIN: path.join(home, 'no-glm'),
        // Проба версий включена: помощник требует claude 2.1.300, версию отдаёт стаб.
        PARLEY_SKIP_VERSION_PROBE: '',
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_ISLAND: '',
      },
    });
    const window = await mainWindowOf(app);
    await resizeMain(app, 800, 500);
    await expect(window.getByTestId('landing')).toBeVisible();

    // 1. Помощник выключен по умолчанию — включаем.
    await window.evaluate(() => (globalThis as unknown as Parley).parley.app.saveUi({ assistant: { enabled: true, provider: 'claude' } }));

    // 2. Работа и комната с одной сессией.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'planner',
      task: '',
      parent: null,
    });
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: ROOM_TITLE,
      members: [ref.sessionId],
      lead: ref.sessionId,
      quiet: true,
    });

    // Снимок работ хоста обновляется из файлов с задержкой, а помощник смотрит именно его: ждём комнату в снимке,
    // иначе его обзор ещё не знает комнаты и ответ — «Nothing is open right now».
    type WorksList = { entries: Array<{ map: { work: { id: string }; rooms: unknown[] } }> };
    await expect
      .poll(
        async () => (await call<WorksList>(window, 'works.list', {})).entries.find((entry) => entry.map.work.id === workId)?.map.rooms.length ?? 0,
        { message: 'комната в снимке работ хоста', timeout: 30_000 },
      )
      .toBe(1);

    // 3. Палитра ⌘J → «Ask the assistant» → на острове вид помощника.
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type('Ask the assistant');
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText('Ask the assistant');
    await window.keyboard.press('Enter');
    await expect.poll(() => islandPage(app!) !== undefined, { message: 'остров создан' }).toBe(true);
    const island = islandPage(app)!;
    await expect(island.getByTestId('assistant-view')).toBeVisible();

    // 4. Просьба передать письмо → карточка → Send (кнопка взводится через 500 мс) → «Sent».
    await island.getByTestId('assistant-input').fill('tell the room to skip Safari tests');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-card')).toContainText(LETTER, { timeout: 30_000 });
    await island.waitForTimeout(600);
    await island.getByTestId('assistant-send').click();
    await expect(island.getByTestId('assistant-sent')).toBeVisible();

    // 5. В главном окне открыта комната: последнее письмо — от человека через помощника, со значком помощника.
    const row = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"]) [data-room-row="${roomId}"]`);
    await expect(row).toHaveCount(1);
    await row.click();
    const letter = window.locator('[data-room-feed] [data-message-id]').filter({ hasText: LETTER }).last();
    await expect(letter).toBeVisible();
    await expect(letter.locator('[data-message-meta]')).toContainText('You (via assistant)');
    await expect(letter.locator('[data-assistant-mark]')).toHaveCount(1);

    // 6. Второй вопрос — ответ текстом; Esc закрывает вид помощника.
    await island.getByTestId('assistant-input').fill('what is going on?');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-answer')).toContainText('The room is working.', { timeout: 30_000 });
    await island.keyboard.press('Escape');
    await expect(island.getByTestId('assistant-view')).toHaveCount(0);
  });
});
