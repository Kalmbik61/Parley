import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { workPaths } from '@parley/core';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Метка режима сессии в шапке вкладки (план T12a-indicator): в настоящем окне, на сессиях с файлами записи запуска в рабочем
 * каталоге работы. Файлы — подставные (ни один настоящий запуск режима Code Mode не включён, пока T12a не прошёл свои
 * ворота): classic с причиной, replacement подтверждённый записью своего запуска, replacement без записи и сессия без файлов.
 * Проверяется то, что видит человек: текст метки, `data-mode`, тултип, отсутствие переполнения шапки; снимки — в каталог
 * `CODE_MODE_SHOTS` (по умолчанию `.omc/reviews/shots` рабочего дерева), не в репозиторий.
 *
 * Вместо `claude` — заглушка агента; провайдера нет, ничего не включается.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = process.env['CODE_MODE_SHOTS'] ?? path.resolve(dirname, '../../../.omc/reviews/shots');
const NONCE = 'e'.repeat(32);

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };
async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

const launch = (over: Record<string, unknown>): string =>
  JSON.stringify({ v: 1, nonce: NONCE, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: '2026-11-09T00:00:00.000Z', ...over });
const record = JSON.stringify({ v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: null, launchId: 'l', nonce: NONCE });

async function plant(dir: string, sessionId: string, files: { launch?: string; exposure?: string }): Promise<void> {
  const target = path.join(dir, 'code-mode');
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (files.launch !== undefined) await writeFile(path.join(target, `${sessionId}.launch.json`), files.launch, { mode: 0o600 });
  if (files.exposure !== undefined) await writeFile(path.join(target, `${sessionId}.exposure.json`), files.exposure, { mode: 0o600 });
}

async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(500);
  await mkdir(shots, { recursive: true });
  await window.screenshot({ path: path.join(shots, `${name}.png`) });
}

test.describe('метка режима Code Mode в шапке сессии', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('code-mode');
    project = await makeTempProject('code-mode');
  });
  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('classic с причиной, Code Mode по записи запуска, unknown без записи — на настоящих вкладках', async () => {
    test.setTimeout(120_000);
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' } });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1200, height: 700 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'code-mode-indicator', goal: '' });
    const ids: string[] = [];
    for (const label of ['classic', 'confirmed', 'unconfirmed', 'nofile', 'plain']) {
      const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null });
      ids.push(ref.sessionId);
    }
    const dir = workPaths(project, workId).dir;
    await plant(dir, ids[0]!, { launch: launch({ nonce: null, effective: 'classic', reason: 'not-requested' }) });
    await plant(dir, ids[1]!, { launch: launch({}), exposure: record });
    await plant(dir, ids[2]!, { launch: launch({}) });
    await plant(dir, ids[4]!, { launch: launch({ nonce: null, effective: 'classic', reason: 'provider-unproven' }) });
    // The real launcher (T12a) writes its own decision for every session it starts; the fourth one has none, as a session from before T12a.
    for (const kind of ['launch', 'exposure']) await rm(path.join(dir, 'code-mode', `${ids[3]!}.${kind}.json`), { force: true });

    const open = async (sessionId: string) => {
      await window.locator(`[data-session-id="${sessionId}"]`).click();
      return window.getByTestId('chat-code-mode');
    };
    const geometry = async () => window.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="chat-toolbar"]');
      const chip = document.querySelector<HTMLElement>('[data-testid="chat-code-mode"]');
      if (bar === null || chip === null) return { overflow: true, clipped: true };
      const b = bar.getBoundingClientRect(); const c = chip.getBoundingClientRect();
      return { overflow: bar.scrollWidth > bar.clientWidth, clipped: c.left < b.left || c.right > b.right };
    });

    let chip = await open(ids[0]!);
    await expect(chip).toHaveText('Classic · not requested');
    await expect(chip).toHaveAttribute('data-mode', 'classic');
    expect(await chip.getAttribute('title')).toContain('Code Mode is turned off in Parley settings.');
    expect(await chip.getAttribute('title')).toContain('not proof of what the agent runs');
    expect(await geometry()).toEqual({ overflow: false, clipped: false });
    await shot(window, 'code-mode-classic');

    chip = await open(ids[1]!);
    await expect(chip).toHaveText('Code Mode');
    await expect(chip).toHaveAttribute('data-mode', 'code-mode');
    await shot(window, 'code-mode-confirmed');

    chip = await open(ids[2]!);
    await expect(chip).toHaveText('Mode unknown');
    await expect(chip).toHaveAttribute('data-mode', 'unknown');
    expect(await chip.getAttribute('title')).toContain('its server has not confirmed it yet');
    await shot(window, 'code-mode-unconfirmed');

    chip = await open(ids[3]!);
    await expect(chip).toHaveText('Mode unknown');
    await shot(window, 'code-mode-no-file');

    // provider-unproven: plain "Classic", no short reason and no sentence about proof (human decision m-7348).
    chip = await open(ids[4]!);
    await expect(chip).toHaveText('Classic');
    await expect(chip).toHaveAttribute('data-mode', 'classic');
    expect(await chip.getAttribute('title')).not.toMatch(/proven|proof of the/i);
    expect(await chip.getAttribute('title')).toContain('not proof of what the agent runs');
    await shot(window, 'code-mode-classic-provider-unproven');

    // Узкая вкладка: метка не вылезает из шапки, а теряет место ярлык сессии.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    chip = await open(ids[0]!);
    await expect(chip).toHaveText('Classic · not requested');
    expect(await geometry()).toEqual({ overflow: false, clipped: false });
    await shot(window, 'code-mode-classic-800x500');

    // Метка только показывает: у неё нет кнопки, и клик по ней ничего не вызывает у хоста, кроме чтения.
    await chip.click();
    await expect(chip).toHaveText('Classic · not requested');
  });
});
