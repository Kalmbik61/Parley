import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
// Тот же защитный skip, что в `smoke.spec.ts`: без сборки @harnas/host этому
// тесту нечего запускать.
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const hostReady = existsSync(hostEntry);
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!hostReady, `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

/**
 * `sessions.create`/`pty.attach` — методы кусков 1.6/1.7 хоста
 * (`packages/host/src/methods/index.ts`), которые на момент этого куска
 * (1.11, окно) ещё не заведены: сервер отвечает `{code: 'unknown_method',
 * message: 'метод пока не реализован: …'}` (`packages/host/src/server.ts`).
 * Тест написан по приёмке плана заранее — включится сам, как только 1.6/1.7
 * landят. До тех пор он проверяет это в рантайме и пропускает себя явным
 * `test.skip`, а не падает и не подделывает результат.
 */
async function hostSupportsPty(window: Page): Promise<boolean> {
  return window.evaluate(async () => {
    const harnas = (globalThis as { harnas: { call: (method: string, params: unknown) => Promise<unknown> } }).harnas;
    try {
      await harnas.call('pty.attach', {
        ref: { projectPath: '/harnas-pty-probe', workId: 'probe', sessionId: 'probe' },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes('метод пока не реализован');
    }
  });
}

test.describe('панель терминала: ввод стаба и восстановление после перезапуска', () => {
  let home: string;
  let project: string;
  /** Окно теста — его гасит afterEach, и после упавшего теста тоже. */
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('term');
    project = await makeTempProject('terminal');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('ввод hello и Enter дают echo: hello; новый запуск восстанавливает экран из снимка', async () => {
    // `HARNAS_CLAUDE_BIN` — тот же оверрайд, что использует core/host для
    // подмены бинаря: настоящий `claude` в автотестах не запускается никогда
    // (план этапа 1, «Правила проверки»).
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };

    let app = await electron.launch({ args: [mainEntry], env });
    running = app;
    let window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();

    if (!(await hostSupportsPty(window))) {
      await app.close();
      test.skip(true, 'хост ещё не завёл sessions.create/pty.attach (куски 1.6/1.7 плана окна) — тест сам включится, когда они landят');
      return;
    }

    const work = await window.evaluate(
      (projectPath: string) =>
        (globalThis as { harnas: { call: (m: string, p: unknown) => Promise<{ workId: string }> } }).harnas.call(
          'works.create',
          { projectPath, title: 'e2e-terminal', goal: '' },
        ),
      project,
    );
    const session = await window.evaluate(
      ({ workId, projectPath }: { workId: string; projectPath: string }) =>
        (
          globalThis as {
            harnas: { call: (m: string, p: unknown) => Promise<{ ref: { sessionId: string } }> };
          }
        ).harnas.call('sessions.create', {
          projectPath,
          workId,
          provider: 'claude',
          label: 'терминал',
          task: '',
          parent: null,
        }),
      { workId: work.workId, projectPath: project },
    );

    await window.locator(`[data-session-id="${session.ref.sessionId}"]`).click();

    const terminalInput = window.locator('.xterm-helper-textarea');
    await terminalInput.click();
    await terminalInput.type('hello');
    await terminalInput.press('Enter');

    await expect(window.getByText('echo: hello', { exact: true })).toBeVisible();

    await quitApp(app);

    app = await electron.launch({ args: [mainEntry], env });
    running = app;
    window = await app.firstWindow();
    await window.locator(`[data-session-id="${session.ref.sessionId}"]`).click();

    // Экран восстановлен из снимка хоста — без нового ввода.
    await expect(window.getByText('echo: hello', { exact: true })).toBeVisible();
  });

  test('тест 15 (кусок 5.3): указатель по строкам с URL и путём — ни pageerror, ни ошибок console', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src', 'a.ts'), 'export {};\n');

    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    try {
      const window = await app.firstWindow();
      // Неперехваченное исключение (как SyntaxError `WebLinksAddon` на флагах `gg`) Playwright
      // отдаёт событием `pageerror`, а не `console`: собираем оба.
      const errors: string[] = [];
      window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      window.on('console', (message) => {
        if (message.type() === 'error') errors.push(`console: ${message.text()}`);
      });
      await expect(window.getByTestId('landing')).toBeVisible();

      const work = await window.evaluate(
        (projectPath: string) =>
          (globalThis as { harnas: { call: (m: string, p: unknown) => Promise<{ workId: string }> } }).harnas.call(
            'works.create',
            { projectPath, title: 'e2e-links', goal: '' },
          ),
        project,
      );
      const session = await window.evaluate(
        ({ workId, projectPath }: { workId: string; projectPath: string }) =>
          (
            globalThis as {
              harnas: { call: (m: string, p: unknown) => Promise<{ ref: { sessionId: string } }> };
            }
          ).harnas.call('sessions.create', { projectPath, workId, provider: 'claude', label: 'links', task: '', parent: null }),
        { workId: work.workId, projectPath: project },
      );

      await window.locator(`[data-session-id="${session.ref.sessionId}"]`).click();
      const terminalInput = window.locator('.xterm-helper-textarea');
      await terminalInput.click();
      await terminalInput.type('https://example.com/x ./src/a.ts:12');
      await terminalInput.press('Enter');
      await expect(window.getByText('echo: https://example.com/x ./src/a.ts:12', { exact: true })).toBeVisible();

      // Указатель проходит по каждой строке экрана в нескольких точках: xterm зовёт
      // провайдеры ссылок на строку под указателем.
      const box = await window.locator('.xterm-screen').first().boundingBox();
      if (box === null) throw new Error('нет .xterm-screen');
      const rowHeight = 12;
      for (let y = box.y + rowHeight / 2; y < box.y + Math.min(box.height, rowHeight * 12); y += rowHeight / 2) {
        for (let x = box.x + 8; x < box.x + Math.min(box.width, 400); x += 24) {
          await window.mouse.move(x, y);
        }
      }
      await window.waitForTimeout(300);

      expect(errors).toEqual([]);
    } finally {
      await stopApp(app);
    }
  });
});
