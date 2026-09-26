import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
// Тот же защитный skip, что в `e2e/terminal.spec.ts` и `e2e/grid.spec.ts`:
// `sessions.create`/`pty.attach` — методы кусков 1.6/1.7 хоста, которые на
// момент этого куска (2.2, раскладка) ещё могут быть не собраны.
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const hostReady = existsSync(hostEntry);
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!hostReady, `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function hostSupportsPty(window: Page): Promise<boolean> {
  return window.evaluate(async () => {
    const harnas = (globalThis as { harnas: { call: (method: string, params: unknown) => Promise<unknown> } }).harnas;
    try {
      await harnas.call('pty.attach', {
        ref: { projectPath: '/harnas-layout-probe', workId: 'probe', sessionId: 'probe' },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes('метод пока не реализован');
    }
  });
}

test.describe('раскладка сетки переживает перезапуск окна (кусок 2.2 плана окна)', () => {
  let home: string;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-layout-'));

    // Проект общий между прогонами: без очистки в нём копятся работы прошлых запусков.
    await rm('/tmp/harnas-e2e-layout', { recursive: true, force: true });
    await mkdir('/tmp/harnas-e2e-layout', { recursive: true });
  });

  test.afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('три открытые панели на месте после нового запуска', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };

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
          { projectPath: '/tmp/harnas-e2e-layout', title: 'e2e-layout', goal: '' },
        ),
    );

    const createSession = (label: string): Promise<{ ref: { sessionId: string } }> =>
      window.evaluate(
        ({ workId, label: sessionLabel }: { workId: string; label: string }) =>
          (
            globalThis as {
              harnas: { call: (m: string, p: unknown) => Promise<{ ref: { sessionId: string } }> };
            }
          ).harnas.call('sessions.create', {
            projectPath: '/tmp/harnas-e2e-layout',
            workId,
            provider: 'claude',
            label: sessionLabel,
            task: '',
            parent: null,
          }),
        { workId: work.workId, label },
      );

    const a = await createSession('раз');
    await createSession('два');
    await createSession('три');

    // Три панели рядом — тот же приём ⌘D, что в `e2e/grid.spec.ts`.
    await window.locator(`[data-session-id="${a.ref.sessionId}"]`).click();
    // Акселератор ⌘D живёт в нативном меню, а keyboard.press шлёт клавиши только
    // в страницу — поэтому действие меню отправляется тем же IPC, что и из меню.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'split-right');
    });
    await window.getByRole('dialog').getByText('S02 два').click();
    // Акселератор ⌘D живёт в нативном меню, а keyboard.press шлёт клавиши только
    // в страницу — поэтому действие меню отправляется тем же IPC, что и из меню.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'split-right');
    });
    await window.getByRole('dialog').getByText('S03 три').click();

    await expect(window.locator('.xterm-helper-textarea')).toHaveCount(3);

    // Тишина сохранения — 500 мс (план, кусок 2.2). Под нагрузкой фиксированной
    // паузы не хватало: закрытие обгоняло запись. Ждём, пока на диске окажутся
    // все три панели.
    const layoutsFile = path.join(home, 'desktop', 'layouts.json');
    await expect
      .poll(
        async () => {
          try {
            // id панели встречается в JSON dockview в нескольких местах —
            // считаем сами панели сохранённой раскладки, а не вхождения строки.
            const file = JSON.parse(await readFile(layoutsFile, 'utf8')) as {
              layouts: Record<string, { panels?: Record<string, unknown> }>;
            };
            return Object.keys(file.layouts.window?.panels ?? {}).length >= 3;
          } catch {
            return false;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    await app.close();

    app = await electron.launch({ args: [mainEntry], env });
    window = await app.firstWindow();

    // Раскладка восстановлена без нового клика по сайдбару — три панели уже
    // на месте, как их оставили (план, «Приёмка этапа 2»).
    await expect(window.locator('.xterm-helper-textarea')).toHaveCount(3);

    await app.close();
  });
});
