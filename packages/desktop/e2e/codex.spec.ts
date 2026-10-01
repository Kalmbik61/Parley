import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Codex — агент комнаты (кусок 11a плана «Organic», спека окна 2026-09-29, 3.6): состояние сессии без хуков
 * Codex — из заголовка окна и уведомлений его терминала, конец хода — скриптом `notify`, письмо занятому
 * агенту — в очередь клавишей Tab.
 *
 * Агент — заглушка `stub-codex-agent.mjs`, подмена бинаря — `PARLEY_CODEX_BIN`, как `PARLEY_CLAUDE_BIN` у
 * claude: настоящий codex в E2E не запускается даже с `--version` (проба версий отключена в
 * `global-setup.ts`). Заглушка пишет те же заголовки и OSC 9, что описывает исследование Codex, а `notify`
 * запускает по `-c notify=[…]` из своего argv — то есть настоящий скрипт харнесса с настоящими флагами запуска.
 *
 * Команды заглушке идут строкой `STUB_*`: отправка окна (`pty.send`, вставкой и Enter — как письмо агенту) или
 * ввод человека (`pty.input`) — там, где сессия «нужен ты» и `pty.send` честно отказывает.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

type Parley = { parley: { call: (m: string, p: unknown) => Promise<unknown>; notify: (m: string, p: unknown) => void } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as Parley).parley.call(m, p), [method, params] as const) as Promise<T>;
}

/** Текст экрана терминала: строки DOM-рендера подряд — перенесённая строка склеивается (`terminal-send.spec.ts`). */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

/** Строка «в терминал агента», как набрал бы человек: уведомление `pty.input` хоста. */
async function humanTypes(window: Page, ref: Ref, text: string): Promise<void> {
  await window.evaluate(([target, data]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref: target, data }), [ref, text] as const);
}

interface SendResult {
  inserted: boolean;
  submitted: boolean;
  reason: string | null;
}

/** Отправка окна агенту вставкой и клавишей — `pty.send`; отказ хоста приходит результатом, а не ошибкой. */
async function sendToAgent(window: Page, ref: Ref, text: string): Promise<SendResult> {
  return call<SendResult>(window, 'pty.send', { ref, text, submit: true });
}

test.describe('Codex — агент комнаты (кусок 11a)', () => {
  let home: string;
  let app: ElectronApplication | null = null;
  let window: Page;
  let ref: Ref;

  test.beforeEach(async () => {
    home = await makeTempHome('codex');
    project = await makeTempProject('codex');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Окно с заглушкой codex и одной запущенной сессией codex (тихий старт — задачи нет), терминал открыт. */
  async function launch(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CODEX_BIN: stubCodex, PARLEY_TERMINAL_RENDERER: 'dom', ...extraEnv };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-codex', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'codex',
      label: 'кодекс',
      task: '',
      parent: null,
    });
    ref = { projectPath: project, workId, sessionId: created.ref.sessionId };
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    await expect.poll(() => screenText(window)).toContain('stub-codex готов');
  }

  /** Строка сессии в сайдбаре и её значок состояния. */
  const row = (): ReturnType<Page['locator']> => window.locator(`[data-session-id="${ref.sessionId}"]`);
  const dot = (state: string): ReturnType<Page['locator']> => row().locator(`[data-state="${state}"]`);

  /** Заглушка присылает `Ready` — хост знает, что у агента на экране, и `pty.send` больше не отказывает. */
  async function sendWhenReady(text: string): Promise<void> {
    await expect
      .poll(async () => (await sendToAgent(window, ref, text)).submitted, { timeout: 15_000 })
      .toBe(true);
  }

  test('заголовок «[ ! ] Action Required» — сессия «нужен ты» в окне; ответ человека возвращает её', async () => {
    await launch();
    await sendWhenReady('STUB_APPROVAL');

    // Заглушка получила текст так, как его отдаёт Codex: вставкой и Enter.
    await expect.poll(() => screenText(window)).toContain('paste: STUB_APPROVAL');
    await expect.poll(() => screenText(window)).toContain('enter: STUB_APPROVAL');

    // То, что видит человек: сегмент «1 needs you», значок вопроса и слово в строке, отметка на вкладке.
    const segment = window.getByRole('button', { name: '1 needs you' });
    await expect(segment).toBeVisible({ timeout: 5_000 });
    await expect(dot('blocked')).toHaveCount(1);
    await expect(row()).toContainText('needs you');
    const tab = window.locator(`[role="tab"][data-tab-id="terminal:${ref.sessionId}"]`);
    await expect(tab.locator('[data-state="blocked"]')).toHaveCount(1);

    // Пока Codex ждёт человека, окно ему ничего не отправляет: Enter ответил бы за человека на диалог.
    expect(await sendToAgent(window, ref, 'не сюда')).toEqual({ inserted: false, submitted: false, reason: 'blocked' });

    // Человек ответил в терминале — у Codex снова приглашение, заголовок Ready, «нужен ты» ушло.
    await humanTypes(window, ref, 'STUB_READY\r');
    await expect(segment).toHaveCount(0, { timeout: 5_000 });
    await expect(dot('blocked')).toHaveCount(0);
  });

  test('вызов notify — конец хода: строка Stop в журнале событий и сессия перестаёт «работать»', async () => {
    await launch();
    await sendWhenReady('STUB_WORK');
    await expect(dot('working')).toHaveCount(1, { timeout: 5_000 });

    // Ход кончился без заголовка Ready: заглушка молча остановила спиннер и запустила настоящий notify.
    await humanTypes(window, ref, 'STUB_NOTIFY\r');
    await expect.poll(() => screenText(window)).toContain('notify: запущен');

    const journal = path.join(project, '.parley', 'works', ref.workId, 'events', `${ref.sessionId}.jsonl`);
    await expect
      .poll(async () => readFile(journal, 'utf8').catch(() => ''), { timeout: 10_000 })
      .toContain('"hook_event_name":"Stop"');
    const lines = (await readFile(journal, 'utf8')).split('\n').filter((line) => line !== '');
    const stop = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    expect(stop).toMatchObject({ hook_event_name: 'Stop', last_assistant_message: 'Готово.', 'thread-id': '019ce3d5-584a-7be2-922e-b8185a8d7c19' });

    // Хост прочёл журнал так же, как хуки Claude Code: ход закончен.
    await expect(dot('working')).toHaveCount(0, { timeout: 10_000 });
    await expect(dot('blocked')).toHaveCount(0);
  });

  test('письмо занятому агенту уходит в очередь клавишей Tab, а не Enter', async () => {
    await launch();
    await sendWhenReady('STUB_WORK');
    await expect(dot('working')).toHaveCount(1, { timeout: 5_000 });

    // Прямое письмо человека сессии: будильник печатает указатель на него, а агент занят.
    await call(window, 'rooms.send', { projectPath: project, workId: ref.workId, roomId: null, to: [ref.sessionId], text: 'привет', kind: 'note' });

    const pointer = 'Новые письма (1). Вызови check_inbox.';
    await expect.poll(() => screenText(window), { timeout: 15_000 }).toContain(`paste: ${pointer}`);
    await expect.poll(() => screenText(window), { timeout: 15_000 }).toContain(`tab: ${pointer}`);
    // В идущий ход указатель не вмешался: Enter с ним не приходил.
    expect(await screenText(window)).not.toContain(`enter: ${pointer}`);
    // Агент всё это время работал.
    await expect(dot('working')).toHaveCount(1);
  });

  test('экран старта без заголовков — «нужен ты» с причиной; окно ничего не отправляет и не отвечает за человека', async () => {
    await launch({ STUB_CODEX_NO_TITLE: '1', PARLEY_CODEX_STARTUP_MS: '1500' });

    // Ни одного известного сигнала: хост не знает, что у агента на экране, и пишет в него нечего.
    expect(await sendToAgent(window, ref, 'привет')).toEqual({ inserted: false, submitted: false, reason: 'blocked' });

    await expect(window.getByRole('button', { name: '1 needs you' })).toBeVisible({ timeout: 15_000 });
    await expect(dot('blocked')).toHaveCount(1);
    // Причина — в строке сессии: ⚠ с тултипом про вход и доверие к папке (текст — из strings.ts окна).
    await expect(row().locator('[title="Waiting at startup — Codex may need sign-in or folder trust in its terminal"]')).toHaveCount(1);

    const screen = await screenText(window);
    expect(screen).toContain('Do you trust the contents of this directory?');
    expect(screen).not.toContain('paste:');
    expect(screen).not.toContain('enter:');
  });
});
