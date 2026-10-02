import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Вид «Chat» вкладки сессии (план 2026-10-01, Task 3). Проба версий CLI в E2E выключена
 * (`global-setup.ts`), версия `claude` неизвестна — вид Chat доступен (решение контролёра Е), а хост
 * хуков ленты стабу не пишет. Поэтому лента берётся севом из журнала: в корень истории прогона
 * (`PARLEY_CLAUDE_PROJECTS_DIR`) кладётся настоящий журнал пробы p5b с `providerSessionId` сессии,
 * индекс логов хоста подхватывает его наблюдателем, и снимок ленты сеет из него промпты, вызовы
 * `Write`/`Edit` с диффом и текст ответа.
 *
 * Стаб — в режиме bracketed paste (`STUB_BRACKETED=1`), как настоящий Claude Code: отправка из поля
 * ввода (`pty.send`) печатает `PASTE<<текст>>` и после Enter — `echo: текст`. Хуков у стаба нет,
 * поэтому серый элемент очереди проверить нельзя (он только во время хода), — проверяется отправка.
 *
 * Снимки — в `.omc/reviews/shots/` worktree (не коммитится): 1400×900 и 800×500, светлая и тёмная.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const transcript = path.resolve(dirname, '../../core/src/feed/fixtures/transcript-p5b-write.jsonl');
/** `sessionId` записей журнала пробы p5b. */
const TRANSCRIPT_SESSION_ID = 'a879774d-1db9-4645-af69-cab9e03df081';
const shots = path.resolve(dirname, '../../../.omc/reviews/shots');

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

async function providerSessionIdOf(window: Page, ref: Ref): Promise<string | null> {
  const list = await call<{ entries: Array<{ map: { sessions: Array<{ id: string; providerSessionId: string | null }> } }> }>(
    window,
    'works.list',
    {},
  );
  return list.entries.flatMap((entry) => entry.map.sessions).find((candidate) => candidate.id === ref.sessionId)?.providerSessionId ?? null;
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

test.describe('вид Chat вкладки сессии (план 2026-10-01, Task 3)', () => {
  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('chat');
    project = await makeTempProject('chat-view');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('лента из журнала, переключение в терминал и обратно, отправка из поля ввода, снимки', async () => {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom', STUB_BRACKETED: '1' };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    const work = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-chat', goal: '' });
    const session = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId: work.workId,
      provider: 'claude',
      label: 'chat',
      task: '',
      parent: null,
    });
    const ref = session.ref;

    // providerSessionId сессии — из снимка работ; журнал пробы кладётся под ним в корень истории прогона.
    await expect.poll(() => providerSessionIdOf(window, ref)).not.toBeNull();
    const providerSessionId = (await providerSessionIdOf(window, ref))!;
    const historyRoot = process.env.PARLEY_CLAUDE_PROJECTS_DIR;
    if (historyRoot === undefined) throw new Error('нет PARLEY_CLAUDE_PROJECTS_DIR — global-setup не отработал');
    const dir = path.join(historyRoot, `-e2e-chat-${ref.sessionId}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    // Индекс логов узнаёт сессию по `sessionId` записей, а не по имени файла: id пробы заменяется на свой.
    const records = (await readFile(transcript, 'utf8')).replaceAll(TRANSCRIPT_SESSION_ID, providerSessionId);
    await writeFile(path.join(dir, `${providerSessionId}.jsonl`), records);
    // Индекс логов хоста узнаёт журнал наблюдателем; пока не узнал — снимок пуст и сев повторится.
    await expect
      .poll(async () => (await call<{ items: unknown[] }>(window, 'feed.snapshot', { ref })).items.length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    await pickTheme(window, 'Theme: light');
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();

    // Вкладка открывается чатом: промпт, вызов Edit с диффом и текст ответа.
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await expect(window.locator('.xterm')).toHaveCount(0);
    await expect(chat.getByTestId('chat-prompt').first()).toContainText('notes.txt');
    await expect(chat.getByTestId('chat-text').first()).toContainText('done');
    const edit = chat.getByTestId('chat-tool').filter({ hasText: 'Edit' });
    await expect(edit).toHaveCount(1);

    await shot(window, 'chat-1400x900-light');
    await edit.getByRole('button').first().click();
    await expect(edit.getByTestId('chat-diff')).toContainText('gamma');
    await expect(edit.locator('[data-diff-row="added"]')).toContainText('gamma');
    await shot(window, 'chat-tool-expanded');

    await pickTheme(window, 'Theme: dark');
    await shot(window, 'chat-1400x900-dark');
    await resize(app, 800, 500);
    await expect(chat).toBeVisible();
    await shot(window, 'chat-800x500-dark');
    await pickTheme(window, 'Theme: light');
    await shot(window, 'chat-800x500-light');
    await resize(app, 1400, 900);

    // Сегмент Terminal: поверхность xterm смонтирована, экран стаба виден; обратно — лента на месте.
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect.poll(() => screenText(window)).toContain('stub-echo');
    await window.getByRole('radio', { name: 'Chat' }).click();
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'Edit' })).toHaveCount(1);
    await expect(window.locator('.xterm')).toHaveCount(0);

    // Поле ввода: Enter — pty.send с Enter, стаб печатает echo; видно в терминале.
    const field = chat.getByRole('textbox', { name: 'Message to Claude' });
    await field.fill('hello from chat');
    await field.press('Enter');
    await expect(field).toHaveValue('');
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect.poll(() => screenText(window)).toContain('echo: hello from chat');
    await window.getByRole('radio', { name: 'Chat' }).click();
    await expect(chat).toBeVisible();

    expect(errors).toEqual([]);
  });
});
