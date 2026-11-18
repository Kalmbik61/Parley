import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Settings → About (план about-section, A3): заголовок `Parley`, строка `Build`, неактивная «Check now» и строка
 * «Update checks are off in this build» (в E2E `PARLEY_UPDATE_CHECK=off`, `playwright.config.ts`); снимок раздела —
 * `test-results/settings-about.png`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.describe('Settings → About', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('settings-about');
    project = await makeTempProject('settings-about');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('раздел показывает версию, сборку и неактивную «Check now»', async () => {
    app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' },
    });
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();

    await window.getByRole('button', { name: 'Search ⌘J' }).first().click();
    await window.getByRole('dialog').getByRole('combobox').fill('Settings');
    await window.keyboard.press('Enter');
    await window.getByRole('tab', { name: 'About' }).click();

    const dialog = window.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /^Parley/ })).toBeVisible();
    await expect(dialog.getByText(/^Build /)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Check now' })).toBeDisabled();
    await expect(dialog.getByText('Update checks are off in this build')).toBeVisible();

    const shot = path.resolve(dirname, '../test-results/settings-about.png');
    await mkdir(path.dirname(shot), { recursive: true });
    await dialog.screenshot({ path: shot });
  });
});
