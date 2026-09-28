import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Ввод без связи с хостом (раунд lane-r3, п. 2): хост пропал — вкладка терминала говорит
 * «Disconnected — reconnecting…» и ввод не берёт (main без сокета выбросил бы его молча);
 * связь вернулась — терминал цепляется заново, и ввод доходит. Хост гасится SIGKILL своего
 * pid из дома теста — окно поднимает новый само. Агент — эхо-заглушка.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

type SessionRef = { projectPath: string; workId: string; sessionId: string };

async function hostPid(home: string): Promise<number> {
  return Number((await readFile(path.join(home, 'host', 'host.pid'), 'utf8')).trim());
}

/** Поверхность терминала сессии (корень с `data-mount-id`, не ярлык вкладки). */
function surfaceOf(window: Page, ref: SessionRef): Locator {
  return window.locator(`[data-tab-id="terminal:${ref.sessionId}"][data-mount-id]`);
}

test.describe('терминал без связи с хостом (раунд lane-r3, п. 2)', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('disconnect');
    project = await makeTempProject('disconnect');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function openSession(window: Page, label: string, workId: string): Promise<SessionRef> {
    const { ref } = await call<{ ref: SessionRef }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label,
      task: '',
      parent: null,
    });
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    return ref;
  }

  /** Окно с журналом main: `notify` без сокета пишет туда «… dropped». */
  async function launch(): Promise<{ window: Page; mainLog: () => string }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const launched = await electron.launch({ args: [mainEntry], env });
    app = launched;
    let log = '';
    launched.process().stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString('utf8');
    });
    const window = await launched.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    return { window, mainLog: () => log };
  }

  test('хост закрыл соединение — «Disconnected — reconnecting…», ввод не уходит; связь вернулась — снимок и ввод доходит', async () => {
    const { window, mainLog } = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-disconnect', goal: '' });
    const ref = await openSession(window, 'обрыв', workId);
    const terminalInput = window.locator('.xterm-helper-textarea');
    await expect(window.getByText('stub-echo готов')).toBeVisible();
    await terminalInput.click();
    await terminalInput.type('one');
    await terminalInput.press('Enter');
    await expect(window.getByText('echo: one', { exact: true })).toBeVisible();
    const pid = await hostPid(home);

    // Хост сам рвёт соединение клиента, чья строка длиннее MAX_LINE_BYTES (8 МБ), — как и без
    // hello за 5 с. Агент при этом жив: после переподключения вкладка берёт его снимок.
    await window.evaluate(
      (target) =>
        (globalThis as unknown as { harnas: { notify: (m: string, p: unknown) => void } }).harnas.notify('pty.input', {
          ref: target,
          data: 'x'.repeat(8 * 1024 * 1024 + 16),
        }),
      ref,
    );
    const offline = window.getByTestId('terminal-offline');
    await expect(offline).toBeVisible();
    await expect(offline).toHaveText('Disconnected — reconnecting…');
    // Фокус в поле xterm: нажатия доходят до терминала, но не уходят ни в main, ни в очередь.
    await window.keyboard.type('lost');

    await expect(offline).toBeHidden({ timeout: 15_000 });
    expect(await hostPid(home)).toBe(pid);
    // Снимок того же агента после переподключения.
    await expect(window.getByText('echo: one', { exact: true })).toBeVisible();
    await terminalInput.click();
    await terminalInput.type('hello');
    await terminalInput.press('Enter');
    // Точное совпадение: «lost» не попал в строку агента ни тогда, ни после переподключения.
    await expect(window.getByText('echo: hello', { exact: true })).toBeVisible();
    expect(mainLog()).not.toContain('pty.input dropped');
  });

  test('хост остановлен — состояние видно, ввод не уходит; хост поднят заново — ввод доходит', async () => {
    const { window, mainLog } = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-host-down', goal: '' });
    const before = await openSession(window, 'до', workId);
    const terminalInput = window.locator('.xterm-helper-textarea');
    await expect(window.getByText('stub-echo готов')).toBeVisible();
    await terminalInput.click();

    const firstHost = await hostPid(home);
    process.kill(firstHost, 'SIGKILL');
    const offline = window.getByTestId('terminal-offline');
    await expect(offline).toBeVisible();
    await window.keyboard.type('lost');
    await window.keyboard.press('Enter');

    // Окно поднимает новый хост само. Агент ушёл вместе с прежним: его вкладка — «isn't running»
    // над последним выводом, не «Disconnected» (слияние с main-r2). Ввод проверяем новой сессией.
    await expect(offline).toBeHidden({ timeout: 20_000 });
    expect(await hostPid(home)).not.toBe(firstHost);
    const beforeSurface = surfaceOf(window, before);
    await expect(beforeSurface.getByTestId('terminal-not-running')).toBeVisible({ timeout: 15_000 });
    await expect(beforeSurface.getByText('stub-echo готов')).toBeVisible();
    const after = await openSession(window, 'после', workId);
    // Вкладка прежней сессии хранит свой вывод — текст ищем в поверхности новой.
    const afterSurface = surfaceOf(window, after);
    await expect(afterSurface.getByText('stub-echo готов')).toBeVisible();
    await terminalInput.last().click();
    await terminalInput.last().type('hello');
    await terminalInput.last().press('Enter');
    await expect(afterSurface.getByText('echo: hello', { exact: true })).toBeVisible();
    expect(mainLog()).not.toContain('pty.input dropped');
  });
});
