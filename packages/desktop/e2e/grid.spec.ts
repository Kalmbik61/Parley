import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
// Тот же защитный skip, что в `e2e/terminal.spec.ts`: `sessions.create`/
// `pty.attach` — методы кусков 1.6/1.7 хоста, которые на момент этого куска
// (2.1, сетка) ещё могут быть не собраны.
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const hostReady = existsSync(hostEntry);
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!hostReady, `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function hostSupportsPty(window: Page): Promise<boolean> {
  return window.evaluate(async () => {
    const harnas = (globalThis as { harnas: { call: (method: string, params: unknown) => Promise<unknown> } }).harnas;
    try {
      await harnas.call('pty.attach', {
        ref: { projectPath: '/harnas-grid-probe', workId: 'probe', sessionId: 'probe' },
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return !message.includes('метод пока не реализован');
    }
  });
}

test.describe('сетка панелей: три терминала рядом (кусок 2.1 плана окна)', () => {
  let home: string;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-grid-'));
  });

  test.afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test('ввод в одну панель не попадает в две другие', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent };

    const app = await electron.launch({ args: [mainEntry], env });
    const window = await app.firstWindow();
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
          { projectPath: '/tmp/harnas-e2e-grid', title: 'e2e-grid', goal: '' },
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
            projectPath: '/tmp/harnas-e2e-grid',
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

    // Открыть первую панель из сайдбара, затем ⌘D (кусок 2.1: «Разделить
    // справа») — открывает `SessionPicker`, куда встаёт вторая, потом третья
    // сессия. Итог — три группы рядом, каждая видна целиком одновременно
    // (в отличие от вкладок в одной группе, где видна только активная).
    await window.locator(`[data-session-id="${a.ref.sessionId}"]`).click();

    await window.keyboard.press('Meta+D');
    await window.getByText('S02 два').click();

    await window.keyboard.press('Meta+D');
    await window.getByText('S03 три').click();

    const inputs = window.locator('.xterm-helper-textarea');
    await expect(inputs).toHaveCount(3);

    // Группы стоят рядом слева направо в порядке появления — тот же порядок,
    // что и у `.xterm-helper-textarea` в DOM.
    await inputs.nth(0).click();
    await inputs.nth(0).type('один');
    await inputs.nth(0).press('Enter');

    await inputs.nth(1).click();
    await inputs.nth(1).type('второй');
    await inputs.nth(1).press('Enter');

    await inputs.nth(2).click();
    await inputs.nth(2).type('третий');
    await inputs.nth(2).press('Enter');

    await expect(window.getByText('echo: один')).toBeVisible();
    await expect(window.getByText('echo: второй')).toBeVisible();
    await expect(window.getByText('echo: третий')).toBeVisible();

    // Каждая панель видит только свой ввод — эхо чужих строк на экране нет.
    expect(await window.getByText('echo: второй').count()).toBe(1);
    expect(await window.getByText('echo: третий').count()).toBe(1);
    expect(await window.getByText('echo: один').count()).toBe(1);

    await app.close();
  });
});
