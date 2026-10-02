import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Вид «Chat» на живых HTTP-хуках (план 2026-10-01, Task 5, п. 2). Хост ждёт от Claude Code хуки по
 * HTTP; настоящий `claude` в E2E не запускается никогда, поэтому его играет стаб `stub-echo-agent.mjs`:
 * он читает из `--settings` адрес и заголовки HTTP-хука, а строка `STUB_HOOK <json>` в его терминале —
 * POST события на хост от имени сессии (так же событие дописывается в файловый журнал `events/`, по
 * которому хост считает активность). Ответ хоста стаб печатает как `HOOK<<json>>` и дописывает строкой
 * в `STUB_HOOK_LOG`: в виде Chat терминала не видно, поэтому решения окна спек читает из этого файла.
 *
 * Строки STUB_HOOK спек печатает в терминал стаба сырым вводом `pty.input` (уведомление хоста), а не
 * `pty.send`: после запроса разрешения активность сессии `blocked` до конца хода, и `pty.send` отказал бы
 * (так и должно быть — хост не вставляет текст в диалог агента). Стаб — в режиме bracketed paste
 * (`STUB_BRACKETED=1`, сырой режим tty): длинные тела событий не упираются в предел строки tty в 1024 байта.
 *
 * Рамка проекта: автоответов за человека нет ни в стабе, ни здесь — решение по карточке в тесте всегда клик
 * по кнопке карточки. События, на которые хост отвечает сразу (всё, кроме удержанных `PermissionRequest` и
 * `PreToolUse(AskUserQuestion)`), спек ждёт по строке ответа в журнале: события идут строго по одному и в
 * порядке отправки, иначе два POST на разных соединениях могли бы прийти в другом порядке.
 *
 * Не покрыто: бейдж агентов в сайдбаре и у участника комнаты (кусок 4b ещё не сделан); хост без `feed.*`
 * (подменить `hello` без правки кода окна нечем).
 *
 * Снимки — в `.omc/reviews/shots/` worktree (не коммитится).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const shots = path.resolve(dirname, '../../../.omc/reviews/shots');

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
  };
};

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

async function providerSessionIdOf(window: Page, ref: Ref): Promise<string | null> {
  const list = await call<{ entries: Array<{ map: { sessions: Array<{ id: string; providerSessionId: string | null }> } }> }>(
    window,
    'works.list',
    {},
  );
  return list.entries.flatMap((entry) => entry.map.sessions).find((candidate) => candidate.id === ref.sessionId)?.providerSessionId ?? null;
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

async function pickTheme(window: Page, label: 'Theme: dark' | 'Theme: light'): Promise<void> {
  await window.keyboard.press('Meta+J');
  await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
  await window.keyboard.type(label);
  await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(label);
  await window.keyboard.press('Enter');
  await expect(window.locator('[data-palette]')).toHaveCount(0);
}

/** Снимок после смены темы или размера: переходы цвета (`transition-colors`) должны догореть. */
async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(500);
  await window.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }),
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

interface Opened {
  app: ElectronApplication;
  window: Page;
  ref: Ref;
  hooks: Hooks;
  errors: string[];
}

test.describe('вид Chat на HTTP-хуках стаба (план 2026-10-01, Task 5)', () => {
  test.setTimeout(120_000);

  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('chat-hooks');
    project = await makeTempProject('chat-hooks');
    await mkdir(shots, { recursive: true });
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
    const window = await app.firstWindow();
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    const work = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-chat-hooks', goal: '' });
    const session = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId: work.workId,
      provider: 'claude',
      label: 'chat',
      task: '',
      parent: null,
    });
    const ref = session.ref;
    await pickTheme(window, 'Theme: light');
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    return { app, window, ref, hooks: new Hooks(window, ref, logFile), errors };
  }

  /**
   * Стаб поднялся и читает ввод: до этого строка STUB_HOOK ушла бы в tty, пока он ещё не в сыром режиме.
   * Годится, пока вкладка показывает терминал (экран читается из DOM xterm).
   */
  async function stubReady(window: Page): Promise<void> {
    await expect.poll(() => screenText(window)).toContain('stub-echo');
  }

  test('автопоказ чата по SessionStart, текст по порциям, вызов с диффом, переключатель, меню режима', async () => {
    // Сессия «на вопросе доверия»: хуков нет вовсе, вкладка открывается терминалом.
    const { window, ref, hooks, errors } = await open({ STUB_NO_HOOKS: '1' });
    await expect(window.getByTestId('terminal-body')).toBeVisible();
    await expect(window.locator('.xterm').first()).toBeVisible();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await stubReady(window);

    // a) Первый хук — SessionStart: вкладка сама становится чатом, в ленте строка старта.
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await expect(window.locator('.xterm')).toHaveCount(0);
    await expect(chat.locator('[data-testid="chat-notice"][data-notice="session-start"]')).toContainText('Session started');
    await expect(chat.getByTestId('chat-model')).toContainText(MODEL);

    // b) Текст по порциям: после первой — первая строка, после второй — обе; Stop закрывает текст и ставит черту хода.
    await hooks.fire('UserPromptSubmit', { prompt: 'Say hello in two lines', permission_mode: 'default' });
    await expect(chat.getByTestId('chat-prompt')).toContainText('Say hello in two lines');
    await hooks.fire('MessageDisplay', { message_id: 'msg-hello', index: 0, final: false, delta: 'First line\n\n' });
    await expect(chat.getByTestId('chat-text')).toContainText('First line');
    await expect(chat.getByTestId('chat-text')).not.toContainText('Second line');
    await expect(chat.getByTestId('chat-streaming')).toHaveCount(1);
    await hooks.fire('MessageDisplay', { message_id: 'msg-hello', index: 1, final: true, delta: 'Second line' });
    await expect(chat.getByTestId('chat-text')).toContainText('First line');
    await expect(chat.getByTestId('chat-text')).toContainText('Second line');
    await expect(chat.getByTestId('chat-streaming')).toHaveCount(0);
    await hooks.fire('Stop', { last_assistant_message: 'First line\n\nSecond line', stop_hook_active: false });
    await expect(chat.getByTestId('chat-turn')).toHaveCount(1);
    // Stop с тем же текстом закрывает уже стоящий элемент, а не заводит второй.
    await expect(chat.getByTestId('chat-text')).toHaveCount(1);

    // c) Вызов Edit: PreToolUse — running, PostToolUse с structuredPatch — done, раскрытие показывает дифф.
    const filePath = path.join(project, 'notes.txt');
    const editInput = { file_path: filePath, old_string: 'beta', new_string: 'gamma', replace_all: false };
    await hooks.fire('UserPromptSubmit', { prompt: 'Change beta to gamma in notes.txt', permission_mode: 'default' });
    await hooks.fire('PreToolUse', { tool_name: 'Edit', tool_input: editInput, tool_use_id: 'toolu_edit1', permission_mode: 'default' });
    const edit = chat.getByTestId('chat-tool').filter({ hasText: 'Edit' });
    await expect(edit).toHaveCount(1);
    await expect(edit).toHaveAttribute('data-tool-status', 'running');
    await hooks.fire('PostToolUse', {
      tool_name: 'Edit',
      tool_input: editInput,
      tool_use_id: 'toolu_edit1',
      permission_mode: 'default',
      tool_response: {
        filePath,
        oldString: 'beta',
        newString: 'gamma',
        originalFile: 'alpha\nbeta\n',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' alpha', '-beta', '+gamma'] }],
        userModified: false,
        replaceAll: false,
      },
    });
    await expect(edit).toHaveAttribute('data-tool-status', 'done');
    await edit.getByRole('button').first().click();
    await expect(edit.getByTestId('chat-diff')).toContainText('gamma');
    await expect(edit.locator('[data-diff-row="added"]')).toContainText('gamma');
    await expect(edit.locator('[data-diff-row="removed"]')).toContainText('beta');
    await hooks.fire('Stop', { last_assistant_message: 'Edited notes.txt.', stop_hook_active: false });
    await expect(chat.getByTestId('chat-turn')).toHaveCount(2);

    // c2) Прерывание Esc (решение 5; живая проверка 2026-10-02): пока идёт вызов, в поле ввода Stop, под
    // лентой «Working…». `Stop`-хука при прерывании нет — хост видит запись «[Request interrupted by
    // user]» в журнале сессии (индекс логов узнаёт журнал по `sessionId` записей) и закрывает ход чертой
    // «Interrupted»: вызов отклонён, Stop и «Working…» пропали.
    await hooks.fire('UserPromptSubmit', { prompt: 'Run a slow command', permission_mode: 'default' });
    await hooks.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'sleep 30', description: 'A slow command' },
      tool_use_id: 'toolu_slow1',
      permission_mode: 'default',
    });
    await expect(chat.getByTestId('chat-stop')).toBeVisible();
    await expect(chat.getByTestId('chat-working')).toBeVisible();
    await expect.poll(() => providerSessionIdOf(window, ref)).not.toBeNull();
    const providerSessionId = (await providerSessionIdOf(window, ref))!;
    const historyRoot = process.env.PARLEY_CLAUDE_PROJECTS_DIR;
    if (historyRoot === undefined) throw new Error('нет PARLEY_CLAUDE_PROJECTS_DIR — global-setup не отработал');
    const historyDir = path.join(historyRoot, `-e2e-chat-hooks-${ref.sessionId}-${Date.now()}`);
    await mkdir(historyDir, { recursive: true });
    // Запись новее начала хода на секунду: часы хоста и теста одни, но запас не повредит.
    const interruptedAt = new Date(Date.now() + 1000).toISOString();
    const record = (text: string, uuid: string): string =>
      JSON.stringify({
        parentUuid: null,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        uuid,
        timestamp: interruptedAt,
        sessionId: providerSessionId,
        cwd: project,
        userType: 'external',
        entrypoint: 'cli',
        version: '2.1.286',
      });
    await writeFile(
      path.join(historyDir, `${providerSessionId}.jsonl`),
      `${record('Run a slow command', 'u-slow-1')}\n${record('[Request interrupted by user]', 'u-slow-2')}\n`,
    );
    await expect(chat.locator('[data-testid="chat-turn"][data-turn-interrupted]')).toHaveCount(1, { timeout: 20_000 });
    await expect(chat.locator('[data-testid="chat-turn"][data-turn-interrupted]')).toContainText('Interrupted');
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'sleep 30' })).toHaveAttribute('data-tool-status', 'rejected');
    await expect(chat.getByTestId('chat-stop')).toHaveCount(0);
    await expect(chat.getByTestId('chat-working')).toHaveCount(0);
    await expect(chat.getByTestId('chat-turn')).toHaveCount(3);

    // h) Сегмент Terminal: поверхность xterm, чата нет, ответы хоста видны в экране стаба; обратно — лента на месте.
    const before = await call<{ items: unknown[]; revision: number }>(window, 'feed.snapshot', { ref });
    const promptsBefore = await chat.getByTestId('chat-prompt').count();
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect(window.locator('.xterm').first()).toBeVisible();
    await expect.poll(() => screenText(window)).toContain('HOOK<<{}>>');
    await window.getByRole('radio', { name: 'Chat' }).click();
    await expect(chat).toBeVisible();
    await expect(window.locator('.xterm')).toHaveCount(0);
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'Edit' })).toHaveCount(1);
    await expect(chat.getByTestId('chat-prompt')).toHaveCount(promptsBefore);
    await expect(chat.getByTestId('chat-turn')).toHaveCount(3);
    // Ревизия ленты хоста не обнуляется переключением: событий за это время не было, снимок тот же.
    const after = await call<{ items: unknown[]; revision: number }>(window, 'feed.snapshot', { ref });
    expect(after.revision).toBe(before.revision);
    expect(after.items.length).toBe(before.items.length);

    // i) Меню режима: три пункта; у стаба нет подвала с режимом — хост не может сверить смену, окно говорит об этом тостом.
    await chat.getByTestId('chat-mode').click();
    const options = window.getByTestId('chat-mode-option');
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toHaveText('Manual');
    await expect(options.nth(1)).toHaveText('Accept edits');
    await expect(options.nth(2)).toHaveText('Plan');
    await expect(options.nth(2)).toHaveAttribute('data-mode', 'plan');
    await options.nth(2).click();
    await expect(window.locator('[data-sonner-toast]').filter({ hasText: 'Open the terminal to switch the mode' })).toBeVisible({ timeout: 20_000 });

    expect(errors).toEqual([]);
  });

  test('карточки: разрешение (allow, always, deny с текстом), вопрос, план, карточка агента', async () => {
    const { window, hooks, errors } = await open();
    // Стаб сам дописывает в журнал нейтральное событие при старте: вкладка открывается чатом без SessionStart.
    // Чат виден — значит, стаб уже прошёл весь свой старт (журнал пишется до приглашения, сырой режим — сразу за ним).
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    const pendingCard = (kind: string): Locator => chat.locator(`[data-testid="chat-card"][data-card-kind="${kind}"][data-card-state="pending"]`);
    const settledCard = (kind: string, state: string): Locator => chat.locator(`[data-testid="chat-card"][data-card-kind="${kind}"][data-card-state="${state}"]`);

    // d) Разрешение: Bash с подсказкой правила — три кнопки; «Allow» — ответ allow хука, карточка allowed.
    await hooks.fire('UserPromptSubmit', { prompt: 'Run the build', permission_mode: 'default' });
    const build = { command: 'npm run build', description: 'Build the project' };
    await hooks.fire('PreToolUse', { tool_name: 'Bash', tool_input: build, tool_use_id: 'toolu_bash1', permission_mode: 'default' });
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'npm run build' })).toHaveAttribute('data-tool-status', 'running');
    await hooks.hold('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: build,
      permission_mode: 'default',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }], behavior: 'allow', destination: 'localSettings' }],
    });
    const first = pendingCard('permission');
    await expect(first).toHaveCount(1);
    await expect(first.getByTestId('card-allow')).toBeVisible();
    await expect(first.getByTestId('card-allow-always')).toHaveText("Allow and don't ask again");
    await expect(first.getByTestId('card-deny')).toBeVisible();
    // Карточка ждёт человека — баннер «агент ждёт в терминале» не нужен.
    await expect(chat.getByTestId('chat-waiting-banner')).toHaveCount(0);
    await clickUntil(first.getByTestId('card-allow'), async () => (await hooks.lines('PermissionRequest')).length >= 1);
    const allowed = await hooks.answer('PermissionRequest', 0);
    expect(allowed.status).toBe(200);
    expect(allowed.response).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await expect(settledCard('permission', 'allowed')).toHaveCount(1);
    await hooks.fire('PostToolUse', { tool_name: 'Bash', tool_input: build, tool_use_id: 'toolu_bash1', permission_mode: 'default', tool_response: { stdout: 'built', stderr: '' } });
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'npm run build' })).toHaveAttribute('data-tool-status', 'done');

    // Вторая просьба без подсказки правила: кнопки «always» нет; «Deny» с текстом — ответ deny с message.
    const remove = { command: 'rm -rf build', description: 'Remove the build output' };
    await hooks.fire('PreToolUse', { tool_name: 'Bash', tool_input: remove, tool_use_id: 'toolu_bash2', permission_mode: 'default' });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: remove, permission_mode: 'default', permission_suggestions: [] });
    const second = pendingCard('permission');
    await expect(second).toHaveCount(1);
    await expect(second.getByTestId('card-allow')).toBeVisible();
    await expect(second.getByTestId('card-allow-always')).toHaveCount(0);
    await second.getByTestId('card-deny-message').fill('Use npm run clean instead');
    await clickUntil(second.getByTestId('card-deny'), async () => (await hooks.lines('PermissionRequest')).length >= 2);
    const denied = await hooks.answer('PermissionRequest', 1);
    expect(denied.status).toBe(200);
    expect(denied.response).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Use npm run clean instead' } },
    });
    const deniedCard = settledCard('permission', 'denied');
    await expect(deniedCard).toHaveCount(1);
    await expect(deniedCard).toContainText('Use npm run clean instead');
    // Отказанный вызов в ленте — «rejected».
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'rm -rf build' })).toHaveAttribute('data-tool-status', 'rejected');
    // Конец хода снимает `blocked` активности (его выставил PermissionRequest в журнале).
    await hooks.fire('Stop', { last_assistant_message: 'Skipped the removal.', stop_hook_active: false });

    // e) Вопрос агента: карточка question, выбор варианта и Submit — ответ хука с updatedInput.answers.
    await hooks.fire('UserPromptSubmit', { prompt: 'Pick a database', permission_mode: 'default' });
    const questions = [
      {
        question: 'Which database should we use?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'Relational, the default choice' },
          { label: 'SQLite', description: 'Embedded, a single file' },
        ],
        multiSelect: false,
      },
    ];
    await hooks.hold('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_ask1', permission_mode: 'default' });
    const question = pendingCard('question');
    await expect(question).toHaveCount(1);
    await expect(question).toContainText('Which database should we use?');
    await question.locator('[data-testid="card-option"][data-option-label="Postgres"]').check();
    await clickUntil(question.getByTestId('card-submit'), async () => (await hooks.lines('PreToolUse')).some((line) => line.response['hookSpecificOutput'] !== undefined));
    const asked = (await hooks.lines('PreToolUse')).find((line) => line.response['hookSpecificOutput'] !== undefined)!;
    expect(asked.status).toBe(200);
    expect(asked.response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { questions, answers: { 'Which database should we use?': 'Postgres' } },
      },
    });
    const answered = settledCard('question', 'answered');
    await expect(answered).toHaveCount(1);
    await expect(answered.getByTestId('card-answers')).toContainText('Which database should we use?');
    await expect(answered.getByTestId('card-answers')).toContainText('Postgres');
    await hooks.fire('PostToolUse', {
      tool_name: 'AskUserQuestion',
      tool_input: { questions, answers: { 'Which database should we use?': 'Postgres' } },
      tool_use_id: 'toolu_ask1',
      permission_mode: 'default',
      tool_response: { questions, answers: { 'Which database should we use?': 'Postgres' } },
    });
    await hooks.fire('Stop', { last_assistant_message: 'Postgres it is.', stop_hook_active: false });

    // f) План: ExitPlanMode — карточка plan; запрос разрешения держится; «Approve, auto-accept edits» —
    // allow с updatedPermissions setMode acceptEdits.
    await hooks.fire('UserPromptSubmit', { prompt: 'Plan the migration', permission_mode: 'plan' });
    const plan = '## Migration plan\n\n1. Add the new table\n2. Copy the data\n3. Drop the old table';
    await hooks.fire('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan }, tool_use_id: 'toolu_plan1', permission_mode: 'plan' });
    await hooks.hold('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan }, permission_mode: 'plan', permission_suggestions: [] });
    const planCard = pendingCard('plan');
    await expect(planCard).toHaveCount(1);
    await expect(planCard.getByTestId('card-plan')).toContainText('Add the new table');
    await expect(planCard.getByTestId('card-approve-manual')).toBeVisible();
    await clickUntil(planCard.getByTestId('card-approve-auto'), async () => (await hooks.lines('PermissionRequest')).length >= 3);
    const approved = await hooks.answer('PermissionRequest', 2);
    expect(approved.status).toBe(200);
    expect(approved.response).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] },
      },
    });
    await expect(settledCard('plan', 'allowed')).toContainText('auto-accept edits');
    await hooks.fire('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan }, tool_use_id: 'toolu_plan1', permission_mode: 'acceptEdits', tool_response: { plan } });
    await hooks.fire('Stop', { last_assistant_message: 'Starting the migration.', stop_hook_active: false });

    // g) Агент: Agent + async_launched — карточка running; вложенный Bash с agent_id; SubagentStop — done с итогом и счётчиком.
    await hooks.fire('UserPromptSubmit', { prompt: 'Explore the repository', permission_mode: 'acceptEdits' });
    const agentInput = { description: 'List project files', prompt: 'List all files in the project root', subagent_type: 'Explore' };
    const agentId = 'a1b2c3d4e5f60718';
    await hooks.fire('PreToolUse', { tool_name: 'Agent', tool_input: agentInput, tool_use_id: 'toolu_agent1', permission_mode: 'acceptEdits' });
    await hooks.fire('PostToolUse', {
      tool_name: 'Agent',
      tool_input: agentInput,
      tool_use_id: 'toolu_agent1',
      permission_mode: 'acceptEdits',
      tool_response: { isAsync: true, status: 'async_launched', agentId, description: 'List project files' },
    });
    const agent = chat.getByTestId('chat-agent');
    await expect(agent).toHaveCount(1);
    await expect(agent).toHaveAttribute('data-agent-status', 'running');
    await expect(agent).toContainText('List project files');
    await hooks.fire('SubagentStart', { agent_id: agentId, agent_type: 'Explore' });
    const child = { command: 'ls -la', description: 'List the project root' };
    await hooks.fire('PreToolUse', { tool_name: 'Bash', tool_input: child, tool_use_id: 'toolu_child1', agent_id: agentId, agent_type: 'Explore', permission_mode: 'acceptEdits' });
    await expect(agent).toContainText('1 tool call');
    await hooks.fire('PostToolUse', {
      tool_name: 'Bash',
      tool_input: child,
      tool_use_id: 'toolu_child1',
      agent_id: agentId,
      agent_type: 'Explore',
      permission_mode: 'acceptEdits',
      tool_response: { stdout: 'README.md\nnotes.txt', stderr: '' },
    });
    await expect(agent).toHaveAttribute('data-agent-status', 'running');
    await hooks.fire('SubagentStop', {
      agent_id: agentId,
      agent_type: 'Explore',
      last_assistant_message: 'The project has README.md and notes.txt',
      agent_transcript_path: path.join(project, 'subagents', `agent-${agentId}.jsonl`),
      stop_hook_active: false,
    });
    await expect(agent).toHaveAttribute('data-agent-status', 'done');
    await expect(agent).toContainText('1 tool call');
    await agent.getByRole('button', { name: 'Show agent details' }).click();
    await expect(agent.getByTestId('chat-agent-details')).toContainText('The project has README.md and notes.txt');
    await expect(agent.getByTestId('chat-agent-children').getByTestId('chat-tool')).toHaveCount(1);
    await hooks.fire('Stop', { last_assistant_message: 'Done exploring.', stop_hook_active: false });

    expect(errors).toEqual([]);
  });

  test('800×500 в обеих темах: длинная команда в карточке разрешения, вопрос, план и агент — кнопки в окне', async () => {
    const { app, window, hooks, errors } = await open();
    // Чат виден — стаб уже поднялся (см. выше).
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.fire('UserPromptSubmit', { prompt: 'Run a very long command', permission_mode: 'default' });
    await resize(app, 800, 500);
    await expect(chat).toBeVisible();
    const pendingCard = (kind: string): Locator => chat.locator(`[data-testid="chat-card"][data-card-kind="${kind}"][data-card-state="pending"]`);

    // j) Разрешение с командой в 320 знаков без пробелов: кнопки остаются в окне, строка не раздвигает карточку.
    const long = { command: 'a'.repeat(320), description: 'A command without spaces' };
    await hooks.fire('PreToolUse', { tool_name: 'Bash', tool_input: long, tool_use_id: 'toolu_long1', permission_mode: 'default' });
    await hooks.hold('PermissionRequest', {
      tool_name: 'Bash',
      tool_input: long,
      permission_mode: 'default',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: long.command }], behavior: 'allow', destination: 'localSettings' }],
    });
    const permission = pendingCard('permission');
    await expect(permission).toHaveCount(1);
    await expect(permission.getByTestId('card-allow')).toBeInViewport();
    await expect(permission.getByTestId('card-deny')).toBeInViewport();
    await shot(window, 'task5-permission-light');
    await pickTheme(window, 'Theme: dark');
    await expect(permission.getByTestId('card-allow')).toBeInViewport();
    await expect(permission.getByTestId('card-deny')).toBeInViewport();
    await shot(window, 'task5-permission-dark');
    await pickTheme(window, 'Theme: light');
    await clickUntil(permission.getByTestId('card-allow'), async () => (await hooks.lines('PermissionRequest')).length >= 1);
    expect((await hooks.answer('PermissionRequest', 0)).response).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    await hooks.fire('PostToolUse', { tool_name: 'Bash', tool_input: long, tool_use_id: 'toolu_long1', permission_mode: 'default', tool_response: { stdout: '', stderr: 'not found' } });
    await hooks.fire('Stop', { last_assistant_message: 'The command failed.', stop_hook_active: false });

    // Вопрос с длинным вариантом.
    await hooks.fire('UserPromptSubmit', { prompt: 'Pick one', permission_mode: 'default' });
    const questions = [
      {
        question: 'Which of these long-named deployment targets should the release go to first?',
        header: 'Target',
        options: [
          { label: 'production-eu-west-1-primary-cluster-without-spaces-in-the-name', description: 'The main cluster, serves most of the traffic' },
          { label: 'staging', description: 'The pre-production environment' },
        ],
        multiSelect: false,
      },
    ];
    await hooks.hold('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_ask2', permission_mode: 'default' });
    const question = pendingCard('question');
    await expect(question).toHaveCount(1);
    await question.locator('[data-testid="card-option"][data-option-label="staging"]').check();
    await expect(question.getByTestId('card-submit')).toBeInViewport();
    await shot(window, 'task5-question');
    await clickUntil(question.getByTestId('card-submit'), async () => (await hooks.lines('PreToolUse')).some((line) => line.response['hookSpecificOutput'] !== undefined));
    await hooks.fire('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_ask2', permission_mode: 'default', tool_response: { questions } });
    await hooks.fire('Stop', { last_assistant_message: 'Staging first.', stop_hook_active: false });

    // План.
    await hooks.fire('UserPromptSubmit', { prompt: 'Plan it', permission_mode: 'plan' });
    const plan = '## Release plan\n\n1. Deploy to staging\n2. Run the smoke tests\n3. Promote to production';
    await hooks.fire('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan }, tool_use_id: 'toolu_plan2', permission_mode: 'plan' });
    await hooks.hold('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan }, permission_mode: 'plan', permission_suggestions: [] });
    const planCard = pendingCard('plan');
    await expect(planCard).toHaveCount(1);
    await expect(planCard.getByTestId('card-approve-auto')).toBeInViewport();
    await expect(planCard.getByTestId('card-approve-manual')).toBeInViewport();
    await shot(window, 'task5-plan');
    await clickUntil(planCard.getByTestId('card-approve-manual'), async () => (await hooks.lines('PermissionRequest')).length >= 2);
    expect((await hooks.answer('PermissionRequest', 1)).response).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } });
    await hooks.fire('PostToolUse', { tool_name: 'ExitPlanMode', tool_input: { plan }, tool_use_id: 'toolu_plan2', permission_mode: 'default', tool_response: { plan } });
    await hooks.fire('Stop', { last_assistant_message: 'Plan approved.', stop_hook_active: false });

    // Агент: идущая карточка в окне.
    await hooks.fire('UserPromptSubmit', { prompt: 'Explore', permission_mode: 'default' });
    const agentInput = { description: 'List project files and summarise what each one is for', prompt: 'List all files', subagent_type: 'Explore' };
    await hooks.fire('PreToolUse', { tool_name: 'Agent', tool_input: agentInput, tool_use_id: 'toolu_agent2', permission_mode: 'default' });
    await hooks.fire('PostToolUse', {
      tool_name: 'Agent',
      tool_input: agentInput,
      tool_use_id: 'toolu_agent2',
      permission_mode: 'default',
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'ff00ee11dd22cc33' },
    });
    const agent = chat.getByTestId('chat-agent');
    await expect(agent).toHaveAttribute('data-agent-status', 'running');
    await expect(agent).toBeInViewport();
    await shot(window, 'task5-agent');

    expect(errors).toEqual([]);
  });
});
