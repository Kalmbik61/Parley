import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

/**
 * Settings → Remote access (mobile app plan A10): the real window and host, the real launcher and control client,
 * a stub bridge process (`stub-bridge.mjs`, the control socket of spec 5.3) instead of the bridge of A22.
 * Screenshots go to `REMOTE_SHOTS` when it is set: off / on / pairing dialog / device list.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubBridge = path.resolve(dirname, 'stub-bridge.mjs');
const shotsDir = process.env['REMOTE_SHOTS'];

async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  const found = (): Page | undefined => app.windows().find((page) => page.url() !== '' && page.url() !== 'about:blank' && !page.url().endsWith('/island.html'));
  await expect.poll(() => found() !== undefined, { message: 'main window loaded', timeout: 30_000 }).toBe(true);
  return found()!;
}

test.describe('Settings → Remote access', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('remote-access');
  });
  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('switch on → pair a device → Allow → device list → switch off stops the bridge', async () => {
    test.setTimeout(120_000);
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, PARLEY_HOME: home, PARLEY_BRIDGE_ENTRY: stubBridge, PARLEY_TERMINAL_RENDERER: 'dom' },
    });
    const window = await mainWindowOf(app);
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setBounds({ x: 0, y: 0, width: 1000, height: 760 });
    });
    const shot = async (name: string): Promise<void> => {
      if (shotsDir !== undefined) await window.screenshot({ path: path.join(shotsDir, `${name}.png`) });
    };

    await window.keyboard.press('Meta+,');
    await window.getByRole('tab', { name: 'Remote access' }).click();
    await expect(window.getByTestId('remote-section')).toBeVisible();
    await expect(window.getByTestId('remote-status')).toContainText('Remote access is off');
    await shot('1-settings-off');

    // On: the launcher starts the stub as a separate process and connects to its control socket.
    await window.getByTestId('remote-enabled').click();
    await expect(window.getByTestId('remote-status')).toContainText('Relay: connected', { timeout: 20_000 });
    await expect(window.getByTestId('remote-allow-create')).toHaveAttribute('aria-checked', 'true');
    await shot('2-settings-on');

    // The remoteCreate switch round-trips through the host.
    await window.getByTestId('remote-allow-create').click();
    await expect(window.getByTestId('remote-allow-create')).toHaveAttribute('aria-checked', 'false');
    await window.getByTestId('remote-allow-create').click();
    await expect(window.getByTestId('remote-allow-create')).toHaveAttribute('aria-checked', 'true');

    // Pair: QR, a wrong code → new QR + notice, then a request → dialog with the SAS → Allow.
    await window.getByTestId('remote-pair-start').click();
    await expect(window.getByTestId('remote-qr')).toBeVisible();
    await writeFile(path.join(home, 'remote', 'trigger-wrong-code'), '');
    await expect(window.getByTestId('remote-wrong-code')).toHaveText('Someone tried to pair with a wrong code');
    await expect(window.getByTestId('remote-qr')).toBeVisible();
    await writeFile(path.join(home, 'remote', 'trigger-request'), '');
    await expect(window.getByTestId('remote-pair-dialog')).toBeVisible();
    await expect(window.getByTestId('remote-pair-name')).toContainText('(unverified)');
    // The dialog fades in; the shot is taken once it has settled.
    await window.waitForTimeout(600);
    await shot('3-pairing-dialog');
    await window.getByTestId('remote-pair-allow').click();
    await expect(window.getByTestId('remote-connected')).toBeVisible();
    await expect(window.getByTestId('remote-device')).toHaveCount(1);
    // The pane has its own scroll: bring the devices into view.
    await window.getByTestId('remote-devices').scrollIntoViewIfNeeded();
    await window.waitForTimeout(300);
    await shot('4-device-list');

    // Off: the bridge is stopped through the control socket.
    await window.getByTestId('remote-enabled').click();
    await expect(window.getByTestId('remote-status')).toContainText('Remote access is off');
  });
});
