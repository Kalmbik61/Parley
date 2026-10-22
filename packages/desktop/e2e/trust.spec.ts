import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Согласие на папку проекта (спека 2026-10-21, 4.2 и 4.4; приёмка, раздел 9, пункты 1, 4 и 7). Хост удерживает каждый
 * запуск Codex в проекте без записи в `<PARLEY_HOME>/trust.json`: сессия остаётся `pending`, на острове встаёт карточка
 * согласия, а клик «Trust» пишет согласие и запускает сессию. Композер новой работы спрашивает то же самое до
 * `works.create`: «Cancel» работы не создаёт, «Trust» создаёт. Согласие здесь НЕ сеется (`trust-seed.ts`) — это и проверяется.
 *
 * Агенты — стабы (`stub-codex-agent.mjs`, `stub-echo-agent.mjs`), настоящие CLI в E2E не запускаются. Остров включается
 * пустым значением `PARLEY_ISLAND` (конфиг Playwright гасит его для всех спеков); главное окно берётся по адресу
 * страницы, остров — по `island.html`, как в `island.spec.ts`; решение по карточке — всегда клик по её кнопке на острове.
 *
 * Окно 800×500: диалог доверия не даёт горизонтальной прокрутки страницы, ничего не торчит за правый край диалога, а
 * кнопки «Trust» и «Cancel» остаются в окне — путь папки длинный (проверка с длинными значениями).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubEcho = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');

/** Имя папки заведомо шире любого диалога: путь в заголовке сокращается по середине, полный — в подсказке. */
const LONG_FOLDER = `a-rather-long-project-folder-name-${'x'.repeat(40)}`;

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

interface SessionView {
  id: string;
  provider: string;
  lifecycle: string;
  startedAt: string | null;
}
interface WorksList {
  entries: Array<{ projectPath: string; map: { work: { id: string; title: string }; sessions: SessionView[] } }>;
}
interface ConsentItem {
  id: string;
  folder: string;
  state: string;
  requestedBy: { source: string; sessionId?: string };
}

/** Сессии всех работ из снимка хоста. */
async function sessionsOf(window: Page): Promise<SessionView[]> {
  return (await call<WorksList>(window, 'works.list', {})).entries.flatMap((entry) => entry.map.sessions);
}

/** Названия работ из снимка хоста по порядку. */
async function workTitles(window: Page): Promise<string[]> {
  return (await call<WorksList>(window, 'works.list', {})).entries.map((entry) => entry.map.work.title).sort();
}

/** Ждущие карточки согласий хоста. */
async function pendingConsents(window: Page): Promise<ConsentItem[]> {
  return (await call<{ items: ConsentItem[] }>(window, 'consents.list', {})).items;
}

/** Записи `trust.json` дома теста; нет файла — пустой список. */
async function trustedFolders(home: string): Promise<Record<string, { grantedAt: string; by: string }>> {
  try {
    return (JSON.parse(await readFile(path.join(home, 'trust.json'), 'utf8')) as { folders: Record<string, { grantedAt: string; by: string }> }).folders;
  } catch {
    return {};
  }
}

/** Страница острова, если его окно есть; нет окна — `undefined`. */
function islandPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().endsWith('/island.html'));
}

/** Окно острова показано на экране; читается в main: скрытое окно страницей не проверить. */
async function islandVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/island.html'))?.isVisible() ?? false,
  );
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

/**
 * Клик по кнопке карточки с повтором: кнопки новой карточки выключены первые 500 мс (защита от случайного клика), а клик,
 * пришедший раньше решения хоста, решения не даёт. Повторяем, пока результат не наступит; решённая карточка кнопку
 * уже не показывает — повторного клика нет.
 */
async function clickUntil(button: Locator, done: () => Promise<boolean>): Promise<void> {
  await expect(async () => {
    if (await button.isVisible()) await button.click({ timeout: 2000 });
    expect(await done()).toBe(true);
  }).toPass({ timeout: 20_000, intervals: [300, 500, 1000] });
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window
    .locator('.xterm-rows')
    .first()
    .evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

/**
 * Что в открытом диалоге вылезло за правый или нижний край окна и торчит ли страница вбок: пустой список — всё на месте.
 * Диалог появляется с zoom-in: до конца анимации его рамка ещё меньше итоговой.
 */
async function overflowOf(dialog: Locator, name: string): Promise<string[]> {
  await expect(dialog).toBeVisible();
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined))));
  return dialog.evaluate((el, dialogName) => {
    const box = el.getBoundingClientRect();
    const problems: string[] = [];
    if (el.scrollWidth > el.clientWidth) problems.push(`${dialogName}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    if (document.documentElement.scrollWidth > window.innerWidth) {
      problems.push(`${dialogName}: страница шире окна (${document.documentElement.scrollWidth} > ${window.innerWidth})`);
    }
    if (box.top < -0.5 || box.bottom > window.innerHeight + 0.5) {
      problems.push(`${dialogName}: диалог ${Math.round(box.top)}..${Math.round(box.bottom)} вне окна 0..${window.innerHeight}`);
    }
    for (const node of el.querySelectorAll('button, h2')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      const what = (node.textContent ?? '').trim().slice(0, 30);
      if (rect.right > box.right + 0.5) problems.push(`${dialogName}: ${node.tagName.toLowerCase()} «${what}» right ${Math.round(rect.right)} > ${Math.round(box.right)}`);
      if (node.tagName === 'BUTTON' && /^(Trust|Cancel)$/.test(what) && rect.bottom > window.innerHeight + 0.5) {
        problems.push(`${dialogName}: «${what}» bottom ${Math.round(rect.bottom)} > ${window.innerHeight}`);
      }
    }
    return problems;
  }, name);
}

test.describe('согласие на папку проекта (спека 2026-10-21, 4.2 и 4.4)', () => {
  test.setTimeout(120_000);

  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('trust');
    project = await makeTempProject('trust');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Окно со стабами вместо `claude` и `codex`; `trust.json` не посеян. Остров включён пустым значением переменной. */
  async function open(width: number, height: number): Promise<{ app: ElectronApplication; window: Page }> {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubEcho,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_ISLAND: '',
    };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    // Главное окно — сразу после запуска, до любого запроса: позже первым в списке мог бы оказаться остров.
    const window = await mainWindowOf(app);
    await resizeMain(app, width, height);
    await expect(window.getByTestId('landing')).toBeVisible();
    return { app, window };
  }

  test('остров: запуск Codex без согласия держится — сессия pending, карточка с Trust; клик пишет trust.json и сессия стартует', async () => {
    const { app, window } = await open(1400, 900);
    expect(await trustedFolders(home)).toEqual({});

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-trust-island', goal: '' });
    // Ответ окна несёт только `ref`: пометка `held` есть у `create_session` агента, у окна о задержке говорит карта и карточка.
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'codex',
      label: 'кодекс',
      task: '',
      parent: null,
    });
    const sessionId = created.ref.sessionId;
    await expect(window.getByTestId('app-shell')).toBeVisible();

    // Запуск удержан: запись `pending` в карте, процесса нет, согласия нет, а у хоста ждёт карточка этой папки.
    await expect
      .poll(async () => (await pendingConsents(window)).map((card) => ({ folder: card.folder, state: card.state })), { message: 'карточка согласия на папку' })
      .toEqual([{ folder: project, state: 'pending' }]);
    const held = (await sessionsOf(window)).find((session) => session.id === sessionId);
    expect(held).toMatchObject({ provider: 'codex', lifecycle: 'pending', startedAt: null });
    expect(await trustedFolders(home)).toEqual({});

    // Остров показан ради карточки согласия: путь папки — в подсказке строки (в тексте он сокращён по середине).
    await expect.poll(() => islandVisible(app), { message: 'остров показан' }).toBe(true);
    const island = islandPage(app)!;
    await expect(island.getByTestId('island-card')).toBeVisible();
    await expect(island.getByTestId('island-consent-folder')).toHaveAttribute('title', project);
    await expect(island.getByTestId('island-consent-deny')).toBeVisible();

    await clickUntil(island.getByTestId('island-consent-trust'), async () => project in (await trustedFolders(home)));
    // Решённая карточка держит «Done ✓» около 8 с (`ANSWER_HOLD_MS`), потом уходит.
    await expect(island.getByTestId('island-consent-done')).toBeVisible();

    // Согласие записано: realpath папки, права 0600 (файл читает только владелец).
    const folders = await trustedFolders(home);
    expect(Object.keys(folders)).toEqual([project]);
    expect(Date.parse(folders[project]!.grantedAt)).not.toBeNaN();
    expect(['window', 'island']).toContain(folders[project]!.by);
    expect((await stat(path.join(home, 'trust.json'))).mode & 0o777).toBe(0o600);

    // Удержанный запуск продолжился сам: сессия активна, стаб Codex запущен и пишет в терминал.
    await expect
      .poll(async () => (await sessionsOf(window)).find((session) => session.id === sessionId)?.lifecycle, { message: 'сессия стартовала', timeout: 30_000 })
      .toBe('active');
    await expect.poll(async () => (await pendingConsents(window)).length, { message: 'карточка закрыта' }).toBe(0);
    await window.locator(`[data-session-id="${sessionId}"]`).click();
    await expect(window.locator('.xterm').first()).toBeVisible();
    await expect.poll(() => screenText(window), { timeout: 20_000 }).toContain('stub-codex готов');
    // Карточки на острове не осталось (после «Done ✓»), и главное окно не держит диалог согласия (ответ в одном месте
    // закрывает остальные).
    await expect(island.getByTestId('island-card')).toHaveCount(0, { timeout: 15_000 });
    await expect(window.getByRole('dialog', { name: /^Trust .* for agents\?$/ })).toHaveCount(0);
  });

  test('композер: «Cancel» работы не создаёт, «Trust» создаёт и пишет trust.json; во второй раз в той же папке диалога нет; окно 800×500 без горизонтальной прокрутки', async () => {
    const folder = path.join(project, LONG_FOLDER);
    await mkdir(folder);
    const { app, window } = await open(800, 500);
    // Нативный выбор папки E2E не нажмёт — `showOpenDialog` в main отвечает сразу этой папкой.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog;
    }, folder);

    await window.getByTestId('landing').getByRole('button', { name: 'New workspace' }).click();
    const composer = window.getByRole('dialog', { name: 'New workspace' });
    await composer.getByRole('button', { name: 'Choose a folder…' }).click();
    await expect(composer.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { checked: true })).toHaveAttribute('title', folder);
    await composer.getByLabel(/^Title/).fill('e2e-trust-composer');
    const create = composer.getByRole('button', { name: 'Create workspace' });
    const trustDialog = window.getByRole('dialog', { name: /^Trust .* for agents\?$/ });

    // «Cancel»: диалог закрылся, форма на месте и снова доступна, работы нет, согласия нет.
    await create.click();
    await expect(trustDialog).toBeVisible();
    expect(await overflowOf(trustDialog, 'Trust folder (800×500)')).toEqual([]);
    await expect(trustDialog).toContainText('.codex');
    await expect(trustDialog.getByRole('heading')).toHaveAttribute('title', folder);
    await trustDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trustDialog).toHaveCount(0);
    await expect(composer).toBeVisible();
    await expect(create).toBeEnabled();
    expect(await workTitles(window)).toEqual([]);
    expect(await trustedFolders(home)).toEqual({});

    // «Trust»: согласие записано окном, работа создана, диалог композера закрылся.
    await create.click();
    await expect(trustDialog).toBeVisible();
    await trustDialog.getByRole('button', { name: 'Trust', exact: true }).click();
    await expect(composer).toBeHidden({ timeout: 15_000 });
    await expect.poll(() => workTitles(window), { timeout: 15_000 }).toEqual(['e2e-trust-composer']);
    const folders = await trustedFolders(home);
    expect(Object.keys(folders)).toEqual([folder]);
    expect(folders[folder]!.by).toBe('window');

    // Папка доверена: вторая работа в ней создаётся без вопроса.
    await window.getByRole('button', { name: /^New workspace in / }).click();
    const again = window.getByRole('dialog', { name: 'New workspace' });
    await again.getByLabel(/^Title/).fill('e2e-trust-again');
    await again.getByRole('button', { name: 'Create workspace' }).click();
    await expect(again).toBeHidden({ timeout: 15_000 });
    await expect(trustDialog).toHaveCount(0);
    await expect.poll(() => workTitles(window), { timeout: 15_000 }).toEqual(['e2e-trust-again', 'e2e-trust-composer']);
  });
});
