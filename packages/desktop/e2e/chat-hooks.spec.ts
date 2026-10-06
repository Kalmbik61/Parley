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
 * Вложения поля ввода (живая проверка 2026-10-02): скриншот — `PARLEY_DROPS=fake` (main кладёт в `drops/` картинку 1×1,
 * буфер обмена человека тесты не читают и не пишут), файл с диска — синтетический бросок `File` из скрытого `<input
 * type=file>` (как в `terminal-send.spec.ts`). Отправленное стабу видно в экране терминала: `PASTE<<…>>` и `echo: …`.
 *
 * Агенты (кусок 4b): бейдж «N agents» в строке сессии сайдбара с поповером, «N agents running» в тулбаре чата и
 * прокрутка ленты к карточке — тест «агенты» ниже; у участника комнаты тот же поповер — юнит-тесты (комнату в этом файле
 * не заводим). Не покрыто: хост без `feed.*` (подменить `hello` без правки кода окна нечем).
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
    app: { imageThumbnail: (file: string) => Promise<string | null> };
  };
};

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

/** Ответ main на запрос миниатюры картинки-вложения: data-URL или `null`. */
async function thumbnailOf(window: Page, file: string): Promise<string | null> {
  return window.evaluate((target) => (globalThis as unknown as Parley).parley.app.imageThumbnail(target), file);
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
 * Бросок файла с диска на вид «Chat»: у `File` есть путь только у выбранного в `<input type=file>`
 * (`setInputFiles` обходится без системного окна), из него и собирается синтетический `DataTransfer`.
 */
async function dropFileOnChat(window: Page, file: string): Promise<void> {
  await window.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'e2e-drop-input';
    input.style.display = 'none';
    document.body.appendChild(input);
  });
  await window.locator('#e2e-drop-input').setInputFiles(file);
  await window.getByTestId('chat-view').evaluate((view) => {
    const input = document.getElementById('e2e-drop-input') as HTMLInputElement;
    const picked = input.files?.[0];
    if (picked === undefined) throw new Error('файл не выбран');
    const data = new DataTransfer();
    data.items.add(picked);
    view.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    view.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    input.remove();
  });
}

/** Скриншот из буфера: синтетический `paste` с картинкой без текста; main подменяет её своей (`PARLEY_DROPS=fake`). */
async function pasteScreenshot(field: Locator): Promise<boolean> {
  return field.evaluate((textarea) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' }));
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('у элемента нет рамки — он не показан');
  return box;
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

/** Описание фонового субагента в ~200 знаков: длинное, чтобы поповер и строки с ним проверялись на переполнение. */
const LONG_DESCRIPTION =
  'Summarise every file in the repository root, explain what each one is for, group them by purpose and list the questions that are still open about the build setup and the release process';

/**
 * Фоновый субагент (кусок 4b): карточка в ленте (HTTP-хуки) и живой субагент у хоста — `background_tasks` в журнале событий,
 * по нему считаются `metrics.tasks`; `id` задачи совпадает с `agentId` карточки. Затем родитель пишет абзацы, и карточка
 * уходит вверх за экран, а в конце ход родителя кончается: сессию держит снимок с этим субагентом.
 */
async function launchBackgroundAgent(hooks: Hooks, agentId: string, paragraphs: number): Promise<void> {
  const agentInput = { description: LONG_DESCRIPTION, prompt: 'Look around the repository', subagent_type: 'Explore' };
  const snapshot = [{ id: agentId, type: 'subagent', status: 'running', agent_type: 'Explore', description: LONG_DESCRIPTION }];
  await hooks.fire('PreToolUse', { tool_name: 'Agent', tool_input: agentInput, tool_use_id: 'toolu_badge1', permission_mode: 'default' });
  await hooks.fire('PostToolUse', {
    tool_name: 'Agent',
    tool_input: agentInput,
    tool_use_id: 'toolu_badge1',
    permission_mode: 'default',
    tool_response: { isAsync: true, status: 'async_launched', agentId, description: LONG_DESCRIPTION },
  });
  await hooks.fire('SubagentStart', { agent_id: agentId, agent_type: 'Explore', background_tasks: snapshot });
  for (let at = 0; at < paragraphs; at += 1) {
    await hooks.fire('MessageDisplay', { message_id: `msg-badge-${at}`, index: 0, final: true, delta: `Paragraph ${at}: the explorer works in the background while the parent keeps writing.` });
  }
  await hooks.fire('Stop', { last_assistant_message: 'Waiting for the explorer.', stop_hook_active: false, background_tasks: snapshot });
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
    // Скилл проекта и файл для подсказок поля ввода (шаг j): лежат до запуска окна — хост читает их с диска.
    await mkdir(path.join(project, '.claude', 'skills', 'demo-skill'), { recursive: true });
    await writeFile(
      path.join(project, '.claude', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo skill for E2E\n---\n\nDemo body.\n',
    );
    await writeFile(path.join(project, 'notes.txt'), 'alpha\nbeta\n');
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
    await expect(options).toHaveCount(4);
    await expect(options.nth(0)).toHaveText('Manual');
    await expect(options.nth(1)).toHaveText('Accept edits');
    await expect(options.nth(2)).toHaveText('Plan');
    await expect(options.nth(2)).toHaveAttribute('data-mode', 'plan');
    await expect(options.nth(3)).toHaveText('Auto');
    await options.nth(2).click();
    await expect(window.locator('[data-sonner-toast]').filter({ hasText: 'Open the terminal to switch the mode' })).toBeVisible({ timeout: 20_000 });

    // j) Подсказки поля ввода (живая проверка 2026-10-02): скилл проекта по «/», файл проекта по «@»; по «/model » подсказок
    // нет — модель меняет меню тулбара (нормалайзер модели и effort 2026-10-06).
    const composer = chat.getByTestId('chat-composer');
    const field = composer.locator('textarea');
    const suggestions = window.getByTestId('chat-suggestions');
    await field.click();
    await field.pressSequentially('/dem');
    const skill = suggestions.locator('[data-testid="chat-suggestion"][data-value="/demo-skill "]');
    await expect(skill).toBeVisible({ timeout: 20_000 });
    await expect(skill).toContainText('Demo skill for E2E');
    await field.press('Enter');
    await expect(field).toHaveValue('/demo-skill ');
    await expect(suggestions).toHaveCount(0);
    await field.fill('');
    await field.pressSequentially('@not');
    await expect(suggestions.locator('[data-testid="chat-suggestion"][data-value="@notes.txt "]')).toBeVisible();
    await field.press('Escape');
    await expect(suggestions).toHaveCount(0);
    await field.fill('');
    await field.pressSequentially('/model ');
    await expect(suggestions).toHaveCount(0);
    await field.fill('');

    expect(errors).toEqual([]);
  });

  test('вложения: скриншот чипом с миниатюрой, отправка упоминанием @"путь", в ленте — миниатюра, длинное имя не раздвигает пузырь и поле', async () => {
    const { app, window, hooks, errors } = await open();
    // Чат виден — стаб уже прошёл свой старт (как в тесте карточек ниже).
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    const field = chat.getByRole('textbox', { name: 'Message to Claude' });
    const composer = chat.getByTestId('chat-composer');
    const composerChips = composer.getByTestId('chat-attachment');

    // k) Скриншот: чип над полем с настоящей миниатюрой (IPC → main → data-URL), текст поля не тронут, путь не вставлен.
    expect(await pasteScreenshot(field)).toBe(true);
    await expect(composerChips).toHaveCount(1);
    await expect(composerChips).toHaveAttribute('data-path', /[\\/]desktop[\\/]drops[\\/]\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
    await expect(composerChips).toHaveAttribute('data-thumbnail', '');
    const thumbnail = composerChips.locator('img');
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => thumbnail.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(field).toHaveValue('');
    const screenshotPath = (await composerChips.getAttribute('data-path'))!;

    // l) Отправка: агенту уходит «текст @"путь" » (пробел в конце — подсказка `@` у CLI не съест Enter хоста), поле и чипы очищаются.
    await field.fill('What is this?');
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await expect(composerChips).toHaveCount(0);
    const sent = `What is this? @"${screenshotPath}" `;
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect.poll(() => screenText(window), { timeout: 15_000 }).toContain(`PASTE<<${sent}>>`);
    await expect.poll(() => screenText(window)).toContain(`echo: ${sent}`);
    await window.getByRole('radio', { name: 'Chat' }).click();
    await expect(chat).toBeVisible();

    // m) Хук отдаёт промпт как набран: в пузыре чип с миниатюрой, пути текстом нет.
    await hooks.fire('UserPromptSubmit', { prompt: sent, permission_mode: 'default' });
    const prompt = chat.getByTestId('chat-prompt').filter({ hasText: 'What is this?' });
    await expect(prompt).toHaveCount(1);
    const promptChip = prompt.getByTestId('chat-attachment');
    await expect(promptChip).toHaveAttribute('data-path', screenshotPath);
    await expect(promptChip.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(prompt).not.toContainText('@"');
    await expect(prompt).not.toContainText('drops');
    await hooks.fire('MessageDisplay', { message_id: 'msg-shot', index: 0, final: true, delta: 'A one-pixel PNG.' });
    await hooks.fire('Stop', { last_assistant_message: 'A one-pixel PNG.', stop_hook_active: false });

    // n) 800×500: ещё скриншот и файл с именем в 124 знака (брошен на вид) — чипы над полем в пределах поля,
    // кнопки остаются в окне.
    await resize(app, 800, 500);
    await expect(chat).toBeVisible();
    expect(await pasteScreenshot(field)).toBe(true);
    const longName = `${'very-long-file-name-'.repeat(6)}.txt`;
    const longFile = path.join(project, longName);
    await writeFile(longFile, 'x');
    await dropFileOnChat(window, longFile);
    await expect(composerChips).toHaveCount(2);
    await expect(composerChips.nth(1)).toHaveAttribute('data-path', longFile);
    await expect(field).toBeFocused();
    await expect(composer).toBeInViewport();
    await expect(chat.getByRole('button', { name: 'Send' })).toBeInViewport();
    const composerBox = await boxOf(composer);
    for (const chip of await composerChips.all()) {
      const box = await boxOf(chip);
      expect(box.x).toBeGreaterThanOrEqual(composerBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(composerBox.x + composerBox.width + 0.5);
    }

    // Отказы main — `null`, а не исключение: картинки нет, файл не картинка, путь не абсолютный; настоящая картинка — data-URL.
    expect(await thumbnailOf(window, screenshotPath)).toMatch(/^data:image\/png;base64,/);
    expect(await thumbnailOf(window, path.join(project, 'missing', 'gone.png'))).toBeNull();
    expect(await thumbnailOf(window, longFile)).toBeNull();
    expect(await thumbnailOf(window, 'relative.png')).toBeNull();

    // o) Промпт ленты с несуществующими файлами — очень длинное имя (не картинка) и картинка, которой уже нет:
    // чипы без миниатюр, чип не шире пузыря, имя обрезано многоточием.
    const missingLong = path.join(project, 'missing', longName);
    const missingImage = path.join(project, 'missing', 'gone.png');
    await hooks.fire('UserPromptSubmit', { prompt: `Summarize these @"${missingLong}" @"${missingImage}"`, permission_mode: 'default' });
    const longPrompt = chat.getByTestId('chat-prompt').filter({ hasText: 'Summarize these' });
    await expect(longPrompt).toHaveCount(1);
    const promptChips = longPrompt.getByTestId('chat-attachment');
    await expect(promptChips).toHaveCount(2);
    const longChip = promptChips.nth(0);
    await expect(longChip).toHaveAttribute('data-path', missingLong);
    await expect(longChip).toBeInViewport();
    await expect(promptChips.nth(1)).toHaveText('gone.png');
    await expect(promptChips.locator('img')).toHaveCount(0);
    const bubbleBox = await boxOf(longPrompt.locator(':scope > div'));
    const chipBox = await boxOf(longChip);
    expect(chipBox.x).toBeGreaterThanOrEqual(bubbleBox.x - 0.5);
    expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(bubbleBox.x + bubbleBox.width + 0.5);
    const feed = chat.getByTestId('chat-feed');
    const feedBox = await boxOf(feed);
    expect(bubbleBox.x + bubbleBox.width).toBeLessThanOrEqual(feedBox.x + feedBox.width + 0.5);
    expect(await feed.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await longChip.locator('span.truncate').evaluate((name) => name.scrollWidth > name.clientWidth)).toBe(true);
    await shot(window, 'attachments-800x500');
    await pickTheme(window, 'Theme: dark');
    await shot(window, 'attachments-800x500-dark');
    await pickTheme(window, 'Theme: light');

    // Крестик чипа убирает вложение; поле остаётся в фокусе.
    await composerChips.nth(1).getByRole('button', { name: `Remove ${longName}` }).click();
    await expect(composerChips).toHaveCount(1);
    await expect(field).toBeFocused();

    expect(errors).toEqual([]);
  });

  test('Stop до ответа: записи о прерывании нет — хост закрывает ход сам (feed.interrupt), Stop и «Working…» пропадают', async () => {
    const { window, hooks, errors } = await open();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });

    // Ход начался, ответа ещё нет: настоящий Claude Code по Esc бросает такой ход без хука и без записи журнала.
    await hooks.fire('UserPromptSubmit', { prompt: 'Stop me before any output', permission_mode: 'default' });
    await expect(chat.getByTestId('chat-stop')).toBeVisible();
    await expect(chat.getByTestId('chat-working')).toBeVisible();
    await chat.getByTestId('chat-stop').click();

    await expect(chat.locator('[data-testid="chat-turn"][data-turn-interrupted]')).toHaveCount(1, { timeout: 10_000 });
    await expect(chat.getByTestId('chat-stop')).toHaveCount(0);
    await expect(chat.getByTestId('chat-working')).toHaveCount(0);
    // Следующее сообщение — обычный новый ход: лента не осталась «в ходе».
    await hooks.fire('UserPromptSubmit', { prompt: 'Next prompt', permission_mode: 'default' });
    await expect(chat.getByTestId('chat-prompt')).toHaveCount(2);
    await expect(chat.getByTestId('chat-stop')).toBeVisible();

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

  test('агенты: бейдж в строке сессии с поповером, «1 agent running» в тулбаре, прокрутка к карточке; Stop нет; 800×500 в обеих темах', async () => {
    const { app, window, ref, hooks, errors } = await open();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await resize(app, 800, 500);
    await expect(chat).toBeVisible();
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.fire('UserPromptSubmit', { prompt: 'Explore the repository and keep working', permission_mode: 'default' });

    // Фоновый субагент с описанием в ~200 знаков; родитель пишет дальше, карточка уходит вверх, ход родителя кончается.
    const agentId = 'b1c2d3e4f5061728';
    await launchBackgroundAgent(hooks, agentId, 24);

    // Строки ленты виртуализированы: карточка так далеко вверху, что в DOM её уже нет.
    const agent = chat.getByTestId('chat-agent');
    await expect.poll(() => agent.count()).toBe(0);

    // Строка сессии в сайдбаре: бейдж вместо ▤N.
    const badge = window.locator(`[data-session-id="${ref.sessionId}"]`).getByTestId('agents-badge');
    await expect(badge).toHaveText('1 agent', { timeout: 20_000 });

    // Тулбар чата: «1 agent running»; пока сессию держит один фоновый субагент, Stop нет, а поле ввода открыто.
    const running = chat.getByTestId('chat-agents-running');
    await expect(running).toHaveText('1 agent running');
    await expect(chat.getByTestId('chat-stop')).toHaveCount(0);
    const field = chat.getByRole('textbox', { name: 'Message to Claude' });
    await expect(field).toBeEnabled();
    await expect(chat.getByRole('button', { name: 'Send' })).toBeVisible();

    // Поповер в окне 800×500: целиком в окне, длинное описание обрезано тремя строками и не раздвигает его.
    const viewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const popover = window.getByTestId('agents-popover');
    const row = popover.getByTestId('agents-popover-row');
    const openPopover = async (): Promise<void> => {
      await badge.click();
      await expect(popover).toBeVisible();
      await expect(row).toHaveCount(1);
    };
    await openPopover();
    await expect(row).toHaveAttribute('aria-label', 'Open Explore');
    await expect(row).toContainText('background');
    await expect(row).toContainText('Summarise every file');
    const popoverBox = await boxOf(popover);
    expect(popoverBox.x).toBeGreaterThanOrEqual(0);
    expect(popoverBox.y).toBeGreaterThanOrEqual(0);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(viewport.height + 0.5);
    expect(await popover.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const rowBox = await boxOf(row);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(popoverBox.x + popoverBox.width + 0.5);
    // Поповер встаёт справа от всей строки сессии (как её тултип), а не от бейджа: слово состояния и время строки видны.
    const sessionRowBox = await boxOf(window.locator(`[data-session-id="${ref.sessionId}"]`));
    expect(popoverBox.x).toBeGreaterThanOrEqual(sessionRowBox.x + sessionRowBox.width - 0.5);
    // Описание обрезано тремя строками (текст длиннее — иначе обрезать нечего), полный — в подсказке строки.
    await expect(row).toHaveAttribute('title', LONG_DESCRIPTION);
    const clamp = await row.locator('span.line-clamp-3').evaluate((element) => ({
      lines: element.clientHeight / parseFloat(getComputedStyle(element).lineHeight),
      truncated: element.scrollHeight > element.clientHeight,
    }));
    expect(clamp.lines).toBeLessThanOrEqual(3.05);
    expect(clamp.truncated).toBe(true);
    // Тултип строки сессии, пока поповер открыт, спрятан.
    await expect(window.locator('[data-session-tooltip]')).toHaveCount(0);
    await shot(window, 'agents-800x500');
    // Палитра (смена темы) закрыла бы поповер сама — закрываем явно и открываем заново в другой теме.
    await window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await pickTheme(window, 'Theme: dark');
    await openPopover();
    await shot(window, 'agents-800x500-dark');
    await window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await pickTheme(window, 'Theme: light');

    // «1 agent running» → лента прокручивается к карточке (она была выше экрана), «Jump to latest» появляется.
    await running.click();
    await expect(agent).toBeInViewport();
    await expect(agent).toHaveAttribute('data-agent-status', 'running');
    await expect(chat.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
    await shot(window, 'agents-card-800x500');

    // Назад к низу — карточка снова вне экрана; теперь из поповера: клик по строке агента ведёт к его карточке, поповер закрывается.
    await chat.getByRole('button', { name: 'Jump to latest' }).click();
    await expect.poll(() => agent.count()).toBe(0);
    await openPopover();
    await row.click();
    await expect(popover).toHaveCount(0);
    await expect(agent).toBeInViewport();
    // Строка поповера — переход окна: вкладка сессии осталась в виде Chat, терминала нет.
    await expect(chat).toBeVisible();
    await expect(window.locator('.xterm')).toHaveCount(0);

    // Субагент закончил: карточка done, «agent running» и бейдж в сайдбаре пропадают.
    await hooks.fire('SubagentStop', {
      agent_id: agentId,
      agent_type: 'Explore',
      last_assistant_message: 'The repository has a build setup and a release process.',
      agent_transcript_path: path.join(project, 'subagents', `agent-${agentId}.jsonl`),
      stop_hook_active: false,
      background_tasks: [],
    });
    await expect(agent).toHaveAttribute('data-agent-status', 'done');
    await expect(chat.getByTestId('chat-agents-running')).toHaveCount(0);
    await expect(badge).toHaveCount(0, { timeout: 20_000 });

    expect(errors).toEqual([]);
  });

  test('комната: строка субагентов участника — бейдж с поповером; клик по агенту ведёт в чат его сессии к карточке агента (800×500)', async () => {
    const { app, window, ref, hooks, errors } = await open();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await resize(app, 800, 500);
    await hooks.fire('SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    await hooks.fire('UserPromptSubmit', { prompt: 'Explore the repository and keep working', permission_mode: 'default' });
    const agentId = 'c1d2e3f4a5b60718';
    await launchBackgroundAgent(hooks, agentId, 24);
    const agent = chat.getByTestId('chat-agent');
    await expect.poll(() => agent.count()).toBe(0);

    // Комната из этой сессии (ведущий) и второй: хост создаёт её тихо, заглушка писем не читает.
    const helper = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId: ref.workId,
      provider: 'claude',
      label: 'helper',
      task: '',
      parent: null,
    });
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId: ref.workId,
      title: 'e2e-room',
      members: [ref.sessionId, helper.ref.sessionId],
      lead: ref.sessionId,
      quiet: true,
    });
    await window.locator(`[data-room-row="${roomId}"] > div`).first().click();
    const roomTab = window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`);
    await expect(roomTab).toHaveAttribute('data-active', 'true');

    // Карточка участника: вторая строка — «Subagent: …» бейджем; у второго участника, ничем не занятого, её нет.
    const card = window.locator(`[data-participant="${ref.sessionId}"]`);
    const badge = card.getByTestId('agents-badge');
    await expect(badge).toContainText('Subagent: Summarise every file', { timeout: 20_000 });
    await expect(window.locator(`[data-participant="${helper.ref.sessionId}"]`).getByTestId('agents-badge')).toHaveCount(0);
    // Карточка остаётся кнопкой, а бейдж не вложен в неё; обрезка строки с многоточием — карточка не раздвигается.
    expect(await card.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(230, 0);
    expect(await badge.evaluate((element) => element.tagName === 'BUTTON' && element.parentElement?.closest('button') === null)).toBe(true);
    expect(await badge.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);

    const popover = window.getByTestId('agents-popover');
    const row = popover.getByTestId('agents-popover-row');
    await badge.click();
    await expect(popover).toBeVisible();
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-label', 'Open Explore');
    await expect(row).toContainText('background');
    const viewport = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const popoverBox = await boxOf(popover);
    expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(viewport.height + 0.5);
    // Бейдж открыл поповер, а не сессию: вкладка комнаты всё ещё активна.
    await expect(roomTab).toHaveAttribute('data-active', 'true');
    await shot(window, 'agents-room-800x500');
    await window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await pickTheme(window, 'Theme: dark');
    await badge.click();
    await expect(popover).toBeVisible();
    await shot(window, 'agents-room-800x500-dark');
    await window.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await pickTheme(window, 'Theme: light');

    // Клик по агенту: вкладка сессии — чат, лента прокручена к карточке агента, поповер закрыт.
    await badge.click();
    await row.click();
    await expect(popover).toHaveCount(0);
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${ref.sessionId}"]`)).toHaveAttribute('data-active', 'true');
    await expect(chat).toBeVisible();
    await expect(window.locator('.xterm')).toHaveCount(0);
    await expect(agent).toBeInViewport();
    await expect(agent).toHaveAttribute('data-agent-status', 'running');

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
