import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

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

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-term-'));
  });

  test.afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('ввод hello и Enter дают echo: hello; новый запуск восстанавливает экран из снимка', async () => {
    // `HARNAS_CLAUDE_BIN` — тот же оверрайд, что использует core/host для
    // подмены бинаря: настоящий `claude` в автотестах не запускается никогда
    // (план этапа 1, «Правила проверки»).
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent };

    let app = await electron.launch({ args: [mainEntry], env });
    let window = await app.firstWindow();
    await expect(window.getByText('Работ пока нет')).toBeVisible();

    if (!(await hostSupportsPty(window))) {
      await app.close();
      test.skip(true, 'хост ещё не завёл sessions.create/pty.attach (куски 1.6/1.7 плана окна) — тест сам включится, когда они landят');
      return;
    }

    const work = await window.evaluate(
      () =>
        (globalThis as { harnas: { call: (m: string, p: unknown) => Promise<{ workId: string }> } }).harnas.call(
          'works.create',
          { projectPath: '/tmp/harnas-e2e-terminal', title: 'e2e-terminal', goal: '' },
        ),
    );
    const session = await window.evaluate(
      ({ workId }: { workId: string }) =>
        (
          globalThis as {
            harnas: { call: (m: string, p: unknown) => Promise<{ ref: { sessionId: string } }> };
          }
        ).harnas.call('sessions.create', {
          projectPath: '/tmp/harnas-e2e-terminal',
          workId,
          provider: 'claude',
          label: 'терминал',
          task: '',
          parent: null,
        }),
      { workId: work.workId },
    );

    await window.locator(`[data-session-id="${session.ref.sessionId}"]`).click();

    const terminalInput = window.locator('.xterm-helper-textarea');
    await terminalInput.click();
    await terminalInput.type('hello');
    await terminalInput.press('Enter');

    await expect(window.getByText('echo: hello')).toBeVisible();

    await app.close();

    app = await electron.launch({ args: [mainEntry], env });
    window = await app.firstWindow();
    await window.locator(`[data-session-id="${session.ref.sessionId}"]`).click();

    // Экран восстановлен из снимка хоста — без нового ввода.
    await expect(window.getByText('echo: hello')).toBeVisible();

    await app.close();
  });
});
