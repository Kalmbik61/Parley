import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome } from './tmp.js';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));

test('язык настроек применяется в главном окне и на острове после перезапуска', async () => {
  const home = await makeTempHome('locale');
  let app: ElectronApplication | null = null;
  const uiFile = path.join(home, 'desktop', 'ui.json');

  async function launch(locale: 'en' | 'ru') {
    const launched = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home, PARLEY_ISLAND: '' } });
    app = launched;
    const page = (name: 'index' | 'island') => launched.windows().find((window) => window.url().split('?', 1)[0]?.endsWith(`/${name}.html`));
    await expect.poll(() => page('index')).toBeDefined();
    await expect.poll(() => page('island')).toBeDefined();
    const main = page('index')!;
    await expect(main.locator('html')).toHaveAttribute('lang', locale);
    await expect(page('island')!.locator('html')).toHaveAttribute('lang', locale);
    return main;
  }

  try {
    await mkdir(path.dirname(uiFile), { recursive: true });
    await writeFile(uiFile, JSON.stringify({ version: 1, locale: 'en' }), 'utf8');
    const en = await launch('en');
    await en.keyboard.press('Meta+,');
    await en.getByRole('combobox', { name: 'Interface language' }).selectOption('ru');
    await expect.poll(async () => JSON.parse(await readFile(uiFile, 'utf8')).locale).toBe('ru');

    await quitApp(app!);
    app = null;
    const ru = await launch('ru');
    await ru.keyboard.press('Meta+,');
    await expect(ru.getByRole('combobox', { name: 'Язык интерфейса' })).toHaveValue('ru');
  } finally {
    await stopApp(app);
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  }
});
