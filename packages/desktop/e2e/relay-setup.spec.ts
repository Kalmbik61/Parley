import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

/**
 * «Set up on my server…» on the real window (relay wizard spec 10, «Снимки окна»): the real service and window against a
 * scripted server (`fake-relay-ssh.mjs`, the seam `PARLEY_RELAY_SETUP_FAKE_SSH` that exists in an unpackaged build only).
 * Screenshots go to `RELAY_SHOTS` when it is set: plan with the foreign edit / pull progress / cancelling / reopened
 * running setup / done.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubBridge = path.resolve(dirname, 'stub-bridge.mjs');
const fakeSsh = path.resolve(dirname, 'fake-relay-ssh.mjs');
const shotsDir = process.env['RELAY_SHOTS'];

async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  const found = (): Page | undefined => app.windows().find((page) => page.url() !== '' && page.url() !== 'about:blank' && !page.url().endsWith('/island.html'));
  await expect.poll(() => found() !== undefined, { message: 'main window loaded', timeout: 30_000 }).toBe(true);
  return found()!;
}

test.describe('Settings → Remote access → Set up on my server', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('relay-setup');
  });
  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('plan with a foreign edit → live run survives ×, Esc, a click outside and a reload → cancel during start → run again → done', async () => {
    test.setTimeout(240_000);
    const release = path.join(home, 'release-start');
    const fakeLog = path.join(home, 'fake-ssh.log');
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_BRIDGE_ENTRY: stubBridge,
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_RELAY_SETUP_FAKE_SSH: fakeSsh,
        PARLEY_RELAY_SETUP_FAKE_RELEASE: release,
        PARLEY_RELAY_SETUP_FAKE_LOG: fakeLog,
      },
    });
    const window = await mainWindowOf(app);
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.setBounds({ x: 0, y: 0, width: 1000, height: 900 });
    });
    const shot = async (name: string): Promise<void> => {
      // Dialogs fade in; the shot is taken once they have settled.
      await window.waitForTimeout(700);
      if (shotsDir !== undefined) await window.screenshot({ path: path.join(shotsDir, `${name}.png`) });
    };
    const fakeCalls = async (): Promise<string> => readFile(fakeLog, 'utf8').catch(() => '');

    const openWizard = async (): Promise<void> => {
      await window.keyboard.press('Meta+,');
      await window.getByRole('tab', { name: 'Remote access' }).click();
      await expect(window.getByTestId('remote-section')).toBeVisible();
      await window.getByTestId('remote-wizard').scrollIntoViewIfNeeded();
      await window.getByTestId('remote-wizard').click();
      await expect(window.getByTestId('relay-setup-dialog')).toBeVisible();
    };
    const connectAndPlan = async (): Promise<void> => {
      await window.getByTestId('relay-setup-host').fill('82.146.37.224');
      await window.getByTestId('relay-setup-auth-password').click();
      await window.getByTestId('relay-setup-password').fill('stand-password');
      await window.getByTestId('relay-setup-connect').click();
    };

    // Remote access on (the stub bridge), so the Relay block with the wizard button is there.
    await window.keyboard.press('Meta+,');
    await window.getByRole('tab', { name: 'Remote access' }).click();
    await window.getByTestId('remote-enabled').click();
    await expect(window.getByTestId('remote-status')).toContainText('Relay: connected', { timeout: 20_000 });
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('remote-section')).toBeHidden();

    // 1. Host key → plan with the foreign edit of the Caddy of the person.
    await openWizard();
    await connectAndPlan();
    await expect(window.getByTestId('relay-setup-fingerprint')).toBeVisible({ timeout: 20_000 });
    await window.getByTestId('relay-setup-trust').click();
    const web = window.getByTestId('relay-setup-web');
    await expect(web).toBeVisible({ timeout: 30_000 });
    const edit = window.getByTestId('relay-setup-web-edit');
    await expect(edit).toContainText('/opt/evdev-site/caddy/parley-relay.caddy');
    await expect(edit).toContainText('replace the file');
    await expect(edit).toContainText('reverse_proxy parley-relay:8787');
    await expect(web).toContainText('course-platform-prod_default');
    await shot('1-plan-with-foreign-edit');

    // Esc and a click on the backdrop close nothing.
    await window.keyboard.press('Escape');
    await window.mouse.click(8, 8);
    await window.waitForTimeout(400);
    await expect(window.getByTestId('relay-setup-dialog')).toBeVisible();
    await expect(window.getByTestId('relay-setup-run')).toBeVisible();

    // 2. Run: the image step streams; the bar and the text of spec 7.1.
    await window.getByTestId('relay-setup-run').click();
    await expect(window.getByTestId('relay-setup-progress-text')).toContainText('Downloading images:', { timeout: 30_000 });
    // Once a layer or two are done, so the text shows both bytes and layers.
    await expect(window.getByTestId('relay-setup-progress-text')).toHaveText(/MB · [1-9] of 5 layers/, { timeout: 30_000 });
    await shot('2-pull-progress');
    await expect(window.getByTestId('relay-setup-progress')).toBeVisible();

    // Esc and a click on the backdrop during the run: the window stays, the run goes on, no cancel reaches the server.
    await window.keyboard.press('Escape');
    await window.mouse.click(8, 8);
    await window.waitForTimeout(400);
    await expect(window.getByTestId('relay-setup-dialog')).toBeVisible();
    await expect(window.getByTestId('relay-setup-record')).toBeVisible();
    await expect(window.getByTestId('relay-setup-cancel-run')).toBeEnabled();
    expect(await fakeCalls()).not.toContain('kill');

    // × during the run only hides the window: no cancel reaches the server.
    await window.getByRole('button', { name: 'Close' }).first().click();
    await expect(window.getByTestId('relay-setup-dialog')).toBeHidden();
    expect(await fakeCalls()).not.toContain('kill');
    await window.getByTestId('remote-wizard').click();
    await expect(window.getByTestId('relay-setup-record')).toBeVisible();
    await expect(window.getByTestId('relay-setup-log')).toContainText('Relay image');

    // The window is reloaded: the run is in main and comes back.
    await window.reload();
    await mainWindowOf(app);
    await openWizard();
    await expect(window.getByTestId('relay-setup-record')).toBeVisible();
    await expect(window.getByTestId('relay-setup-host')).toHaveCount(0);
    await shot('4-reopened-running-setup');

    // 3. The start step is held by the scripted server: Cancel → «Cancelling after this step…».
    await expect(window.getByTestId('relay-setup-log')).toContainText('Start the relay', { timeout: 60_000 });
    await expect(window.getByTestId('relay-setup-log')).toContainText('Container parley-relay-relay-1  Recreate', { timeout: 60_000 });
    await window.getByTestId('relay-setup-cancel-run').click();
    await expect(window.getByTestId('relay-setup-cancelling')).toHaveText('Cancelling after this step…');
    await expect(window.getByTestId('relay-setup-cancel-run')).toBeDisabled();
    await shot('3-cancelling');
    // The step cannot be interrupted: no kill went to the server.
    expect(await fakeCalls()).not.toContain('kill');

    // Release the start: it finishes, the run stops, the outcome is «cancelled» (not red).
    await writeFile(release, '');
    const cancelled = window.getByTestId('relay-setup-cancelled');
    await expect(cancelled).toBeVisible({ timeout: 60_000 });
    await expect(cancelled).toContainText('Cancelled.');
    await expect(window.getByTestId('relay-setup-failed')).toHaveCount(0);

    // 4. New setup → the form; the server key is known, so Connect goes straight to the plan; Run → done.
    await window.getByTestId('relay-setup-new').click();
    await expect(window.getByTestId('relay-setup-host')).toBeVisible();
    await connectAndPlan();
    await expect(window.getByTestId('relay-setup-run')).toBeVisible({ timeout: 30_000 });
    await window.getByTestId('relay-setup-run').click();
    const done = window.getByTestId('relay-setup-done');
    await expect(done).toBeVisible({ timeout: 90_000 });
    await expect(done).toContainText('82-146-37-224.sslip.io');
    await shot('5-done');

    // Close forgets the record: the next open shows the form.
    await window.getByTestId('relay-setup-close').click();
    await expect(window.getByTestId('relay-setup-dialog')).toBeHidden();
    await window.getByTestId('remote-wizard').click();
    await expect(window.getByTestId('relay-setup-host')).toBeVisible();
    expect(await fakeCalls()).not.toContain('unknown:');
  });
});
