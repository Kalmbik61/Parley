import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { assertUnderTmpdir, makeTempHome, makeTempProject, trackRunHome } from './tmp.js';

/**
 * Перенос данных с прежнего имени при старте окна (план переименования harnas → parley, R6 и R7).
 *
 * Данные — как их оставила прежняя сборка, но под временными каталогами: «домашний каталог человека» (`HOME` окна) со
 * старым `.harnas` (индекс работ, настройки, данные окна) и проект со старым `.harnas` (карта работы, артефакт).
 * Свой дом (`PARLEY_HOME`) тесту задавать нельзя: при заданном доме перенос не идёт. Поэтому окно запускается с `HOME`
 * во временный каталог, а `PARLEY_APP_DATA` уводит под него и userData (главный процесс считает его от настоящего
 * `appData`, а тот от `HOME` не зависит) — настоящие `~/.harnas`, `~/.parley`, userData человека и лок одного
 * экземпляра с его окном тест не трогает. Агент — заглушка: сессий тест не запускает.
 *
 * Окно стартует → главный процесс переносит дом до поиска хоста, хост переносит проект до сокета → оба каталога
 * переехали `rename`-ом, работа видна в сайдбаре, `.parley/.gitignore` на месте, окно читает данные из нового дома
 * (тема из `desktop/ui.json`, настройка из `config.json` через хост), а userData остался прежним
 * `<appData>/@harnas/desktop`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const TITLE = 'Legacy work';
const NOTE = 'заметка из прежней сборки\n';
const AT = '2026-09-01T10:00:00.000Z';
/** Холодный старт окна, хоста и переноса под нагрузкой машины дольше обычных 5 с ожидания. */
const STARTED = { timeout: 15_000 };

test.describe('перенос данных harnas → parley при старте окна (R6, R7)', () => {
  /** Корень теста: внутри «домашний каталог человека» и «appData». */
  let base: string;
  let userHome: string;
  let appData: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    base = await makeTempHome('migr');
    userHome = path.join(base, 'h');
    appData = path.join(base, 'ad');
    await mkdir(userHome);
    await mkdir(appData);
    assertUnderTmpdir(userHome);
    assertUnderTmpdir(appData);
    // Хост живёт в доме под новым именем: уборка прогона должна знать этот каталог, а не только корень теста.
    await trackRunHome(path.join(userHome, '.parley'));
    project = await makeTempProject('migr');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(path.join(userHome, '.parley'));
    await stopHost(path.join(userHome, '.harnas'));
    await rm(base, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Дом и проект, какими их оставила прежняя сборка, и userData окна под прежним именем пакета. */
  async function seedLegacy(): Promise<void> {
    const legacyHome = path.join(userHome, '.harnas');
    await mkdir(path.join(legacyHome, 'desktop'), { recursive: true });
    await writeFile(path.join(legacyHome, 'config.json'), `${JSON.stringify({ fontSize: 17 })}\n`);
    await writeFile(path.join(legacyHome, 'desktop', 'ui.json'), `${JSON.stringify({ version: 1, appearance: 'dark' })}\n`);
    const entry = { id: 'w-0001', projectPath: project, title: TITLE, status: 'active', updatedAt: AT };
    await writeFile(path.join(legacyHome, 'works-index.json'), `${JSON.stringify({ schemaVersion: 1, works: [entry] }, null, 2)}\n`);

    const work = path.join(project, '.harnas', 'works', 'w-0001');
    await mkdir(path.join(work, 'briefs'), { recursive: true });
    await mkdir(path.join(work, 'artifacts'), { recursive: true });
    const map = {
      schemaVersion: 2,
      work: { id: 'w-0001', title: TITLE, goal: '', status: 'active', createdAt: AT, updatedAt: AT },
      sessions: [],
      messages: [],
      rooms: [],
    };
    await writeFile(path.join(work, 'map.json'), `${JSON.stringify(map, null, 2)}\n`);
    await writeFile(path.join(work, 'artifacts', 'note.txt'), NOTE);

    // userData окна, каким он остался от прежней сборки (Electron считал его от имени пакета @harnas/desktop).
    await mkdir(path.join(appData, '@harnas', 'desktop'), { recursive: true });
  }

  async function launch(): Promise<{ electronApp: ElectronApplication; window: Page }> {
    // Дом прогона (`global-setup` ставит PARLEY_HOME) тесту не нужен: с заданным домом окно ничего не переносит.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'PARLEY_HOME' && key !== 'HARNAS_HOME') env[key] = value;
    }
    Object.assign(env, { HOME: userHome, PARLEY_APP_DATA: appData, PARLEY_CLAUDE_BIN: stubAgent });
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    return { electronApp, window: await electronApp.firstWindow() };
  }

  test('окно стартует: ~/.harnas и проект со старым .harnas переехали, работа видна, userData прежний', async () => {
    test.setTimeout(60_000);
    await seedLegacy();

    const { electronApp, window } = await launch();
    await expect(window.getByTestId('app-shell')).toBeVisible(STARTED);
    await expect(window.locator('[data-work-title]')).toHaveText(TITLE);

    // Дом переехал целиком, rename-ом: прежнего каталога нет, данные на месте.
    const home = path.join(userHome, '.parley');
    expect(existsSync(path.join(userHome, '.harnas'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'))).toEqual({ fontSize: 17 });
    expect(existsSync(path.join(home, 'works-index.json'))).toBe(true);
    // Хост поднят в новом доме, а не в прежнем.
    expect(existsSync(path.join(home, 'host', 'host.sock'))).toBe(true);

    // Проект переехал: карта и артефакт на месте, каталог состояния прячет себя от git.
    expect(existsSync(path.join(project, '.harnas'))).toBe(false);
    const work = path.join(project, '.parley', 'works', 'w-0001');
    expect(await readFile(path.join(work, 'artifacts', 'note.txt'), 'utf8')).toBe(NOTE);
    expect(JSON.parse(await readFile(path.join(work, 'map.json'), 'utf8'))).toMatchObject({ work: { id: 'w-0001', title: TITLE } });
    expect(await readFile(path.join(project, '.parley', '.gitignore'), 'utf8')).toBe('*\n');

    // Записи о переносах — в новом доме: дом, затем проект.
    const record = JSON.parse(await readFile(path.join(home, 'migrated-from-harnas.json'), 'utf8')) as {
      migrated: Array<{ what: string; from: string; to: string; at: string }>;
    };
    expect(record.migrated).toMatchObject([
      { what: 'home', from: path.join(userHome, '.harnas'), to: home },
      { what: 'project', from: path.join(project, '.harnas'), to: path.join(project, '.parley') },
    ]);

    // Окно читает данные из нового дома: тема — из desktop/ui.json, настройка — через хост из config.json.
    expect(await electronApp.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
    const settings = await window.evaluate(() =>
      (globalThis as unknown as { parley: { call: (method: string, params: unknown) => Promise<unknown> } }).parley.call('settings.get', {}),
    );
    expect((settings as { config: { fontSize: number } }).config.fontSize).toBe(17);

    // userData закреплён на прежнем <appData>/@harnas/desktop; пустой @parley/desktop рядом не заводился.
    const userData = await electronApp.evaluate(({ app: electronMain }) => electronMain.getPath('userData'));
    expect(await realpath(userData)).toBe(await realpath(path.join(appData, '@harnas', 'desktop')));
    expect(existsSync(path.join(appData, '@parley'))).toBe(false);
    // Куки встроенного браузера (раздел persist:harnas-browser, R7) лежат в нём же: раздел остался под прежним именем.
    await expect.poll(() => existsSync(path.join(userData, 'Partitions', 'harnas-browser')), { timeout: 10_000 }).toBe(true);
  });

  test('новая установка без прежних данных: ничего не переносится, userData — @parley/desktop, хост в ~/.parley', async () => {
    test.setTimeout(60_000);

    const { electronApp, window } = await launch();
    await expect(window.getByTestId('landing')).toBeVisible(STARTED);

    expect(existsSync(path.join(userHome, '.harnas'))).toBe(false);
    expect(existsSync(path.join(userHome, '.parley', 'host', 'host.sock'))).toBe(true);
    expect(existsSync(path.join(userHome, '.parley', 'migrated-from-harnas.json'))).toBe(false);
    const userData = await electronApp.evaluate(({ app: electronMain }) => electronMain.getPath('userData'));
    expect(await realpath(userData)).toBe(await realpath(path.join(appData, '@parley', 'desktop')));
    expect(existsSync(path.join(appData, '@harnas'))).toBe(false);
  });
});
