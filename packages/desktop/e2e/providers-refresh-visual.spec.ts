import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

// A separate native window and host. Only local fixture logs and the echo stub are used;
// no GLM key is saved and no real agent, account configuration, or quota transport is used.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = process.env.PARLEY_REFRESH_SHOTS ?? path.resolve(dirname, '../test-results/providers-refresh-visual');
const refreshName = 'Refresh provider limits';

interface RefreshMotion {
  clickedAt: number | null;
  endedAt: number | null;
  busyTrace: Array<string | null>;
  frames: Array<{ at: number; transform: string; dataReady: boolean }>;
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(({ method, params }) =>
    (globalThis as unknown as { parley: { call: (method: string, params: unknown) => Promise<unknown> } }).parley.call(method, params),
  { method, params }) as Promise<T>;
}

async function writeClaude(project: string, workId: string, sessionId: string, fiveHour: number, week: number): Promise<void> {
  const dir = path.join(project, '.parley', 'works', workId, 'limits');
  await mkdir(dir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const file = path.join(dir, `${sessionId}.json`);
  await writeFile(`${file}.tmp`, `${JSON.stringify({
    at: new Date().toISOString(),
    rateLimits: {
      five_hour: { used_percentage: fiveHour, resets_at: nowSec + 7200 },
      seven_day: { used_percentage: week, resets_at: nowSec + 259200 },
    },
  })}\n`);
  await rename(`${file}.tmp`, file);
}

async function writeCodex(root: string, usedPercent: number): Promise<void> {
  const now = new Date();
  const dir = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-10-04T18-00-00-01234567-89ab-cdef-0123-456789abcdef.jsonl');
  await writeFile(`${file}.tmp`, `${JSON.stringify({
    timestamp: now.toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 10800 } },
    },
  })}\n`);
  await rename(`${file}.tmp`, file);
}

async function pickTheme(window: Page, theme: 'light' | 'dark'): Promise<void> {
  await window.getByRole('button', { name: 'Search ⌘J', exact: true }).first().click();
  await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
  await window.keyboard.type(`Theme: ${theme}`);
  await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(`Theme: ${theme}`);
  await window.keyboard.press('Enter');
  await expect(window.locator('[data-palette]')).toHaveCount(0);
  await expect.poll(() => window.locator('html').evaluate((el) => el.classList.contains('dark'))).toBe(theme === 'dark');
}

test.describe('isolated native provider refresh and hover close', () => {
  let home = '';
  let project = '';
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('providers-refresh-visual');
    project = await makeTempProject('providers-refresh-visual');
    await mkdir(path.join(home, 'user'), { recursive: true });
    await mkdir(shots, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('both local limits refresh immediately; hover closes the background tab; both themes at narrow and wide sizes', async () => {
    test.setTimeout(120_000);
    const codexRoot = path.join(home, 'codex-sessions');
    await writeCodex(codexRoot, 21);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|ZAI_|Z_AI_|GLM_|AWS_|AZURE_|GOOGLE_|GEMINI_|BEDROCK_|VERTEX_)/i.test(name) &&
      !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) && !/^(PARLEY|HARNAS)_.*_BIN$/i.test(name),
    )) as Record<string, string>;
    Object.assign(env, {
      HOME: path.join(home, 'user'), PARLEY_HOME: home, HARNAS_HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'user', '.config'),
      PARLEY_CLAUDE_PROJECTS_DIR: path.join(home, 'claude-projects'),
      PARLEY_CODEX_SESSIONS_DIR: codexRoot,
      PARLEY_CLAUDE_BIN: stubAgent, PARLEY_CODEX_BIN: stubAgent,
      PARLEY_GLM_BIN: path.join(home, 'absent-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_LIMITS_POLL_MS: '3600000',
      PARLEY_LOGIN_SHELL: 'skip', PARLEY_UPDATE_CHECK: 'off',
    });
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    await window.emulateMedia({ reducedMotion: 'no-preference' });
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'Refresh visual fixture', goal: '' });
    const create = async (label: string): Promise<string> => {
      const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
        projectPath: project, workId, provider: 'claude', label, task: '', parent: null,
      });
      return ref.sessionId;
    };
    const backgroundId = await create('Background fixture');
    const activeId = await create('Active fixture');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    for (const sessionId of [backgroundId, activeId]) await window.locator(`[data-session-id="${sessionId}"]`).first().click();
    const tabs = window.locator('[role="tab"][data-tab-id]');
    const background = tabs.filter({ hasText: 'Background fixture' });
    const active = tabs.filter({ hasText: 'Active fixture' });
    await expect(background).toHaveAttribute('aria-selected', 'false');
    await expect(active).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveCount(2);

    const refresh = window.getByRole('button', { name: refreshName, exact: true });
    await expect(refresh).toBeEnabled();
    expect(await refresh.evaluate((el) => el.parentElement?.firstElementChild === el)).toBe(true);
    const claude = window.locator('[data-provider-segment="claude"] [data-limits]');
    const codex = window.locator('[data-provider-segment="codex"] [data-limits]');
    await writeClaude(project, workId, backgroundId, 34, 18);
    await refresh.click();
    await expect(claude).toHaveText('34% 5h · 18% wk', { timeout: 5000 });
    await expect(codex).toHaveText('21% 5h', { timeout: 5000 });
    await expect(refresh).toBeEnabled();

    await writeClaude(project, workId, backgroundId, 79, 62);
    await writeCodex(codexRoot, 87);
    await expect(claude).toHaveText('34% 5h · 18% wk');
    await expect(codex).toHaveText('21% 5h');
    await refresh.evaluate((el) => {
      const trace: RefreshMotion = { clickedAt: null, endedAt: null, busyTrace: [], frames: [] };
      (globalThis as unknown as { refreshMotion: RefreshMotion }).refreshMotion = trace;
      let frameId = 0;
      let started = false;
      el.addEventListener('click', () => { trace.clickedAt = performance.now(); }, { once: true, capture: true });
      const sample = (): void => {
        if (el.getAttribute('aria-busy') !== 'true') return;
        const svg = el.querySelector('svg');
        const limits = [...(el.parentElement?.querySelectorAll('[data-limits]') ?? [])].map((item) => item.textContent);
        trace.frames.push({
          at: performance.now(),
          transform: svg === null ? 'missing' : getComputedStyle(svg).transform,
          dataReady: limits.includes('79% 5h · 62% wk') && limits.includes('87% 5h'),
        });
        frameId = requestAnimationFrame(sample);
      };
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) trace.busyTrace.push(mutation.oldValue, el.getAttribute('aria-busy'));
        if (el.getAttribute('aria-busy') === 'true' && !started && trace.clickedAt !== null) {
          started = true;
          frameId = requestAnimationFrame(sample);
        } else if (started && el.getAttribute('aria-busy') === 'false') {
          trace.endedAt = performance.now();
          cancelAnimationFrame(frameId);
          observer.disconnect();
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: ['aria-busy'], attributeOldValue: true });
    });
    const started = Date.now();
    await refresh.click();
    await expect(claude).toHaveText('79% 5h · 62% wk', { timeout: 5000 });
    await expect(codex).toHaveText('87% 5h', { timeout: 5000 });
    expect(Date.now() - started).toBeLessThan(5000);
    await expect(refresh).toHaveAttribute('aria-busy', 'true');
    await refresh.screenshot({ path: path.join(shots, 'refresh-spinner-frame-1.png'), animations: 'allow' });
    await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await refresh.screenshot({ path: path.join(shots, 'refresh-spinner-frame-2.png'), animations: 'allow' });
    await expect(refresh).toBeEnabled();
    await expect(refresh).toHaveAttribute('aria-busy', 'false');
    const motion = await window.evaluate(() => (globalThis as unknown as { refreshMotion: RefreshMotion }).refreshMotion);
    expect(motion.busyTrace).toContain('true');
    expect(motion.clickedAt).not.toBeNull();
    expect(motion.endedAt).not.toBeNull();
    // Allow 10 ms for renderer observation; the product feedback timer is 600 ms.
    expect(motion.endedAt! - motion.clickedAt!).toBeGreaterThanOrEqual(590);
    const afterData = motion.frames.filter((frame) => frame.dataReady);
    expect(afterData.length).toBeGreaterThan(1);
    expect(new Set(afterData.map((frame) => frame.transform)).size).toBeGreaterThan(1);
    expect(afterData.every((frame) => frame.transform !== 'none' && frame.transform !== 'missing')).toBe(true);
    await writeFile(path.join(shots, 'refresh-motion.json'), `${JSON.stringify({
      feedbackMs: motion.endedAt! - motion.clickedAt!,
      dataReadyMs: afterData[0]!.at - motion.clickedAt!,
      frameCount: motion.frames.length,
      distinctTransformsAfterData: new Set(afterData.map((frame) => frame.transform)).size,
      frames: motion.frames.map((frame) => ({ ...frame, at: frame.at - motion.clickedAt! })),
    }, null, 2)}\n`);
    await expect(window.locator('[data-provider-segment="glm"] [data-limits]')).toHaveCount(0);

    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      for (const size of [{ width: 800, height: 500 }, { width: 1400, height: 900 }]) {
        await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds }), size);
        await window.mouse.move(0, 0);
        const close = background.getByRole('button', { name: 'Close', exact: true });
        await expect.poll(() => close.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
        const activeBefore = await active.boundingBox();
        const activeCloseBefore = await active.getByRole('button', { name: 'Close', exact: true }).boundingBox();
        await window.screenshot({ path: path.join(shots, `refresh-${theme}-${size.width}x${size.height}-rest.png`), animations: 'disabled' });
        await background.hover();
        await expect.poll(() => close.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
        await expect(close).toBeInViewport({ ratio: 1 });
        expect(await active.boundingBox()).toEqual(activeBefore);
        expect(await active.getByRole('button', { name: 'Close', exact: true }).boundingBox()).toEqual(activeCloseBefore);
        const rowBoxes = await refresh.locator('..').evaluate((row) => {
          const buttons = [...row.querySelectorAll('button')].map((button) => {
            const box = button.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
          }).filter((box) => box.right > box.left);
          return { buttons, width: innerWidth, height: innerHeight };
        });
        rowBoxes.buttons.forEach((box, index) => {
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(rowBoxes.width + 1);
          expect(box.top).toBeGreaterThanOrEqual(0);
          expect(box.bottom).toBeLessThanOrEqual(rowBoxes.height + 1);
          if (index > 0) expect(box.left).toBeGreaterThanOrEqual(rowBoxes.buttons[index - 1]!.right - 1);
        });
        await window.screenshot({ path: path.join(shots, `refresh-${theme}-${size.width}x${size.height}-hover.png`), animations: 'disabled' });
      }
    }
    await background.getByRole('button', { name: 'Close', exact: true }).focus();
    await expect.poll(() => background.getByRole('button', { name: 'Close', exact: true }).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await background.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(background).toHaveCount(0);
    await expect(active).toHaveAttribute('aria-selected', 'true');
    await expect(tabs).toHaveCount(1);
    await window.screenshot({ path: path.join(shots, 'refresh-background-closed.png'), animations: 'disabled' });
    expect(errors).toEqual([]);
  });
});
