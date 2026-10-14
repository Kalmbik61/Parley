import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Значок и поповер расхода токенов комнаты в окне 800×500 (спека расхода токенов, 3.1–3.2, 8): длинные названия комнаты
 * и сессий, масштаб 1 и 2. Настоящий `claude` не запускается (стаб): `sessions.create` сразу запускает стаб-сессии (с `providerSessionId`), а лога Claude стаб не пишет —
 * по спеке (5.2) такой участник `unavailable / log-missing` (`n/a — log not found`), итог неизвестен (`?`). Проверяется раскладка; цифры — модульными тестами ядра и хоста. Снимки — в `test-results/room-usage/`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/room-usage');
const LONG_LABEL = 'backend-refactor-of-the-payments-ledger-and-invoices';
const LONG_TITLE = 'Payments ledger refactor with invoices, refunds, reconciliation and reporting';
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

test.describe('расход токенов комнаты в окне 800×500', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-usage');
    project = await makeTempProject('room-usage');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  for (const dpr of [1, 2]) {
    test(`значок в шапке и поповер в границах окна (масштаб ${dpr})`, async () => {
      test.setTimeout(90_000);
      const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry, `--force-device-scale-factor=${dpr}`], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
      await expect(window.getByTestId('landing')).toBeVisible();

      const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-usage', goal: '' });
      const members: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
          projectPath: project,
          workId,
          provider: 'claude',
          label: LONG_LABEL,
          task: '',
          parent: null,
        });
        members.push(ref.sessionId);
      }
      const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
        projectPath: project,
        workId,
        title: LONG_TITLE,
        members,
        lead: members[0],
        quiet: true,
      });
      await expect(window.getByTestId('app-shell')).toBeVisible();

      const roomRow = window.locator(`[data-room-row="${roomId}"]`);
      await roomRow.locator('> div').first().click();
      await expect(window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`)).toHaveAttribute('data-active', 'true');
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
      await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(800);

      // Стаб не пишет лог Claude — итог неизвестен (`?`), строки участников `n/a — log not found`.
      const chip = window.getByTestId('room-usage-chip');
      await expect(chip).toHaveText('↑? ↓?', { timeout: 15_000 });
      const header = window.locator('[data-room-header]');
      const chipBox = await chip.boundingBox();
      const headerBox = await header.boundingBox();
      expect(chipBox).not.toBeNull();
      expect(headerBox).not.toBeNull();
      expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(headerBox!.x + headerBox!.width + 0.5);

      await chip.click();
      const popover = window.getByTestId('room-usage-popover');
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('n/a — log not found');
      const box = await popover.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(800.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(500.5);

      // Длинное название сессии обрезано многоточием, а цифры и прочерки — целиком.
      const label = popover.locator('[data-usage-label]').filter({ hasText: 'S01' }).first();
      expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
      for (const value of await popover.locator('[data-usage-value]').all()) {
        expect(await value.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      }
      await mkdir(shots, { recursive: true });
      await window.waitForTimeout(300);
      await window.screenshot({ path: path.join(shots, `room-usage-800x500-dpr${dpr}.png`) });
    });
  }
});
