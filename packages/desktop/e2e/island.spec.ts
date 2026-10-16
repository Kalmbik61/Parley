import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Остров одобрений (спека 2026-10-12): отдельное окно поверх экрана с карточкой запроса разрешения. Запросы идут живыми
 * HTTP-хуками стаба — каркас тот же, что у `chat-hooks.spec.ts` (стаб `stub-echo-agent.mjs` вместо `claude`, строка
 * `STUB_HOOK <json>` в его терминале — POST события на хост, ответ хоста — строкой в `STUB_HOOK_LOG`), поэтому `Hooks`,
 * `clickUntil` и `open()` скопированы оттуда, а `loggedNotes` — из `attention.spec.ts`. Конфиг Playwright гасит остров
 * для всех спеков (`PARLEY_ISLAND=off`); этот спек включает его пустым значением переменной.
 *
 * Рамка проекта: автоответов за человека нет — решение по карточке всегда клик по кнопке карточки (здесь — на острове).
 * Активность `blocked` даёт сам `PermissionRequest`: стаб дописывает его в файловый журнал событий (`JOURNAL_EVENTS`),
 * и хост по записи считает сессию ждущей, поэтому отдельный `Notification(permission_prompt)` не нужен.
 *
 * Остров создаётся вместе с главным окном (скрытым): `firstWindow()` и `getAllWindows()[0]` могут отдать его, поэтому
 * главное окно берётся по адресу страницы, остров — по `island.html`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');

const MODEL = 'claude-sonnet-4-5';

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

/** Строка `STUB_HOOK_LOG`: событие, код ответа хоста и его тело. */
interface HookLine {
  event: string;
  status: number;
  response: Record<string, unknown>;
}

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
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

/** Окно острова показано на экране (`showInactive`); нет окна — `false`. Читается в main: скрытое окно страницей не проверить. */
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
 * События хуков одной сессии: отправка строкой STUB_HOOK и чтение ответов хоста из `STUB_HOOK_LOG`.
 */
class Hooks {
  constructor(
    private readonly window: Page,
    private readonly ref: Ref,
    private readonly logFile: string,
  ) {}

  /** Ответы хоста, записанные стабом; недописанная строка пропускается. */
  async lines(event?: string): Promise<HookLine[]> {
    let text: string;
    try {
      text = await readFile(this.logFile, 'utf8');
    } catch {
      return [];
    }
    const lines: HookLine[] = [];
    for (const raw of text.split('\n')) {
      if (raw === '') continue;
      try {
        lines.push(JSON.parse(raw) as HookLine);
      } catch {
        // Строка ещё пишется — прочтётся при следующем опросе.
      }
    }
    return event === undefined ? lines : lines.filter((line) => line.event === event);
  }

  /** Печатает строку STUB_HOOK в терминал стаба сырым вводом (`pty.input`); ответа не ждёт. */
  async hold(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const body = JSON.stringify({ hook_event_name: event, ...fields });
    await this.window.evaluate(
      ({ ref, data }) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data }),
      { ref: this.ref, data: `STUB_HOOK ${body}\r` },
    );
  }

  /** Шлёт событие, на которое хост отвечает сразу, и ждёт его строку в журнале ответов (код 200). */
  async fire(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const before = (await this.lines(event)).length;
    await this.hold(event, fields);
    await expect
      .poll(async () => (await this.lines(event)).length, { message: `ответ хоста на ${event}`, timeout: 15_000 })
      .toBeGreaterThan(before);
    expect((await this.lines(event))[before]?.status, `код ответа на ${event}`).toBe(200);
  }

  /** Ответ хоста на удержанный запрос: `index`-й по счёту ответ на это событие. */
  async answer(event: string, index: number): Promise<HookLine> {
    await expect
      .poll(async () => (await this.lines(event)).length, { message: `решение окна по ${event} №${index + 1}`, timeout: 15_000 })
      .toBeGreaterThan(index);
    return (await this.lines(event))[index]!;
  }
}

/**
 * Клик по кнопке карточки с повтором: хук ждёт ответа не сразу после появления карточки, и клик, пришедший
 * раньше удержанного запроса, хост отвечает `applied: false` (под кнопками «Not applied yet»). Повторяем,
 * пока ответ не окажется в журнале; сложившаяся карточка кнопку уже не показывает — повторного клика нет.
 */
async function clickUntil(button: Locator, answered: () => Promise<boolean>): Promise<void> {
  await expect(async () => {
    if (await button.isVisible()) await button.click({ timeout: 2000 });
    expect(await answered()).toBe(true);
  }).toPass({ timeout: 20_000, intervals: [300, 500, 1000] });
}

interface LoggedNote {
  title: string;
  body: string;
  silent: boolean;
}

/** Уведомления окна в журнале main (`PARLEY_NOTIFICATIONS=log` из конфига Playwright). */
async function loggedNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  return app.evaluate(() =>
    ((globalThis as { __parleyNotifications?: LoggedNote[] }).__parleyNotifications ?? []).map(({ title, body, silent }) => ({
      title,
      body,
      silent,
    })),
  );
}

interface Opened {
  app: ElectronApplication;
  window: Page;
  ref: Ref;
  hooks: Hooks;
}

test.describe('остров одобрений', () => {
  test.setTimeout(120_000);

  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('island');
    project = await makeTempProject('island');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Окно со стабом вместо `claude`, работа и одна сессия; вкладка сессии открыта кликом по сайдбару. */
  async function open(extraEnv: Record<string, string> = {}): Promise<Opened> {
    const logFile = path.join(home, 'hook-log.jsonl');
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      // Проба версий включена: вид Chat доступен только при известной версии `claude` (стаб отвечает 2.1.286).
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_BRACKETED: '1',
      STUB_HOOK_LOG: logFile,
      ...extraEnv,
    };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    // Главное окно — сразу после запуска, до любого запроса: позже первым в списке мог бы оказаться остров.
    const window = await mainWindowOf(app);
    await resizeMain(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();

    const work = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-island', goal: '' });
    const session = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId: work.workId,
      provider: 'claude',
      label: 'island',
      task: '',
      parent: null,
    });
    const ref = session.ref;
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    // Чат виден — значит, стаб уже прошёл весь свой старт (журнал пишется до приглашения, сырой режим — сразу за ним):
    // строка STUB_HOOK, пришедшая раньше, ушла бы в tty, пока стаб ещё не в сыром режиме.
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { app, window, ref, hooks: new Hooks(window, ref, logFile) };
  }

  test('разрешение: остров с карточкой → Allow на острове → стаб получает allow', async () => {
    const { app, hooks } = await open({ PARLEY_ISLAND: '' });
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch /tmp/island-e2e' }, permission_mode: 'default', permission_suggestions: [] });

    // Окно острова создано при старте скрытым — ждём не его появления, а показа: остров виден, только когда есть запрос.
    await expect.poll(() => islandVisible(app), { message: 'остров показан' }).toBe(true);
    const island = islandPage(app)!;
    await expect(island.getByTestId('island-card')).toContainText('Run: touch /tmp/island-e2e');
    // Кнопки новой карточки выключены первые 500 мс (защита от случайного клика) — клик Playwright ждёт включения.
    await clickUntil(island.getByTestId('island-allow'), async () => (await hooks.lines('PermissionRequest')).length >= 1);
    const allowed = await hooks.answer('PermissionRequest', 0);
    expect(allowed.status).toBe(200);
    expect(allowed.response).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await expect(island.getByTestId('island-card')).toHaveCount(0);
  });

  test('«×» прячет остров до следующего запроса', async () => {
    const { app, hooks } = await open({ PARLEY_ISLAND: '' });
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default', permission_suggestions: [] });

    await expect.poll(() => islandVisible(app), { message: 'остров показан' }).toBe(true);
    const island = islandPage(app)!;
    await island.getByRole('button', { name: 'Hide until the next request' }).click();
    await expect.poll(() => islandVisible(app), { message: 'остров спрятан' }).toBe(false);

    // Второй запрос той же сессии (первый всё ещё ждёт человека): новая карточка снимает «×».
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' }, permission_mode: 'default', permission_suggestions: [] });
    await expect.poll(() => islandVisible(app), { message: 'остров показан снова' }).toBe(true);
  });

  test('остров выключен в настройках — окна нет, запрос приходит уведомлением', async () => {
    const { app, window, ref, hooks } = await open({ PARLEY_ISLAND: '' });
    // Остров был: иначе проверка «окна нет» ниже прошла бы и без выключателя.
    await expect.poll(() => islandPage(app) !== undefined, { message: 'остров создан при старте' }).toBe(true);
    await window.evaluate(() => (globalThis as unknown as Parley).parley.app.saveUi({ island: { enabled: false } }));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { message: 'окно острова закрыто' }).toBe(1);
    await expect.poll(() => islandPage(app) === undefined, { message: 'страница острова закрыта' }).toBe(true);

    // Первое значение активности сессии уведомитель считает базой без уведомления (спека 7.4): сначала окно видит
    // «working», потом запрос разрешения — это переход «ждёт тебя».
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.fire('UserPromptSubmit', { prompt: 'Run ls', permission_mode: 'default' });
    await expect(window.locator(`[data-session-id="${ref.sessionId}"] [data-state="working"]`)).toHaveCount(1, { timeout: 15_000 });
    // Окно без фокуса: видимая вкладка сессии в фокусе окна уведомления не шлёт (цель «уже на виду»). Фокус окна ведут
    // события `focus`/`blur` рендерера — тест шлёт их сам, фокус ОС между параллельными окнами гуляет.
    await window.evaluate(() => window.dispatchEvent(new Event('blur')));
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default', permission_suggestions: [] });
    await expect.poll(() => loggedNotes(app), { timeout: 10_000 }).toContainEqual(expect.objectContaining({ body: expect.stringContaining('Run: ls') }));
  });

  test('карточка на острове — системного уведомления о запросе нет', async () => {
    const { app, window, ref, hooks } = await open({ PARLEY_ISLAND: '' });
    // Тот же переход «working → blocked» и окно без фокуса, что в предыдущем тесте: без острова уведомление пришло бы.
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.fire('UserPromptSubmit', { prompt: 'Run ls', permission_mode: 'default' });
    await expect(window.locator(`[data-session-id="${ref.sessionId}"] [data-state="working"]`)).toHaveCount(1, { timeout: 15_000 });
    await window.evaluate(() => window.dispatchEvent(new Event('blur')));
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'echo island-only' }, permission_mode: 'default', permission_suggestions: [] });

    await expect.poll(() => islandVisible(app), { message: 'остров показан' }).toBe(true);
    await expect(islandPage(app)!.getByTestId('island-card')).toContainText('Run: echo island-only');
    // Уведомление, будь оно, ушло бы после запроса карточки (до 0,5 с на повтор): ждём с запасом и только потом проверяем,
    // что строки запроса ни в одном уведомлении нет. `expect.poll(...).not` тут не годится — он проходит с первого опроса.
    await window.waitForTimeout(2000);
    const notes = await loggedNotes(app);
    expect(notes.filter((note) => note.body.includes('Run: echo island-only'))).toEqual([]);
  });
});
