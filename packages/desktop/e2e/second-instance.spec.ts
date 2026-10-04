import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = process.env.PARLEY_LIFECYCLE_SHOTS ?? path.resolve(dirname, '../test-results/window-lifecycle');

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(({ method, params }) =>
    (globalThis as unknown as { parley: { call: (method: string, params: unknown) => Promise<unknown> } }).parley.call(method, params),
  { method, params }) as Promise<T>;
}

test.describe('macOS second-instance lifecycle in an isolated home', () => {
  test.skip(process.platform !== 'darwin', 'Closing the last window keeps the app alive on macOS');
  let home = '';
  let project = '';
  let primary: ElectronApplication | null = null;
  let env: Record<string, string>;
  let children: ChildProcess[];
  let stderr: string;
  let pageErrors: string[];

  test.beforeEach(async () => {
    home = await makeTempHome('second-instance');
    project = await makeTempProject('second-instance');
    children = [];
    stderr = '';
    pageErrors = [];
    await mkdir(path.join(home, 'user'), { recursive: true });
    await mkdir(shots, { recursive: true });
    env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|ZAI_|Z_AI_|GLM_|AWS_|AZURE_|GOOGLE_|GEMINI_|BEDROCK_|VERTEX_)/i.test(name) &&
      !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) && !/^(PARLEY|HARNAS)_.*_BIN$/i.test(name),
    )) as Record<string, string>;
    Object.assign(env, {
      HOME: path.join(home, 'user'), PARLEY_HOME: home, HARNAS_HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'user', '.config'),
      PARLEY_CLAUDE_PROJECTS_DIR: path.join(home, 'claude-projects'),
      PARLEY_CODEX_SESSIONS_DIR: path.join(home, 'codex-sessions'),
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: path.join(home, 'absent-codex'),
      PARLEY_GLM_BIN: path.join(home, 'absent-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_LOGIN_SHELL: 'skip', PARLEY_UPDATE_CHECK: 'off',
    });
  });

  test.afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await stopApp(primary);
    primary = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<{ app: ElectronApplication; window: Page }> {
    const app = await electron.launch({ args: [mainEntry], env });
    primary = app;
    app.process().stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    app.on('window', (window) => window.on('pageerror', (error) => pageErrors.push(error.message)));
    await app.evaluate(() => {
      const errors: string[] = [];
      (globalThis as unknown as { lifecycleErrors: string[] }).lifecycleErrors = errors;
      // Monitor only: do not intercept or suppress Electron's uncaught-exception handling.
      process.on('uncaughtExceptionMonitor', (error) => errors.push(`${error.name}: ${error.message}`));
    });
    const window = await app.firstWindow();
    window.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(window.getByTestId('landing')).toBeVisible();
    await expect.poll(() => readFile(path.join(home, 'host', 'host.pid'), 'utf8').catch(() => '')).not.toBe('');
    return { app, window };
  }

  async function hostPid(): Promise<string> {
    return (await readFile(path.join(home, 'host', 'host.pid'), 'utf8')).split('\n')[0]!;
  }

  async function windowCount(app: ElectronApplication): Promise<number> {
    return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length);
  }

  async function closeLastWindow(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect.poll(() => windowCount(app)).toBe(0);
    expect(app.process().exitCode).toBeNull();
  }

  async function launchSecondary(app: ElectronApplication): Promise<void> {
    const child = spawn(app.process().spawnfile, [mainEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let childErrors = '';
    child.stderr?.on('data', (chunk: Buffer) => { childErrors += chunk.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Secondary test process did not release the single-instance lock')), 10_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    expect(code).toBe(0);
    expect(childErrors).not.toMatch(/Object has been destroyed|uncaught|UnhandledPromiseRejection|TypeError/i);
  }

  async function assertNoErrors(app: ElectronApplication): Promise<void> {
    expect(await app.evaluate(() => (globalThis as unknown as { lifecycleErrors: string[] }).lifecycleErrors)).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(stderr).not.toMatch(/Object has been destroyed|uncaught|UnhandledPromiseRejection|TypeError/i);
  }

  test('closed main-window second-instance event safely creates one replacement', async () => {
    const { app } = await launch();
    const originalHost = await hostPid();
    await closeLastWindow(app);
    // This boundary safely reproduces the old destroyed-window TypeError without an
    // uncaught native error box blocking cleanup. It does not alter product listeners.
    const result = await app.evaluate(({ app: nativeApp }) => {
      try {
        nativeApp.emit('second-instance', {}, [], '', {});
        return { error: null };
      } catch (error) {
        return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
      }
    });
    console.log('closed-window second-instance probe:', result);
    expect(result.error).toBeNull();
    await expect.poll(() => windowCount(app)).toBe(1);
    const replacement = await app.firstWindow();
    await expect(replacement.getByTestId('landing')).toBeVisible();
    expect(await hostPid()).toBe(originalHost);
    await assertNoErrors(app);
  });

  test('a real second process reopens the primary window, repeated launches focus and restore it without restarting the host', async () => {
    test.skip(process.env.PARLEY_SECOND_INSTANCE_RED === '1', 'Run the caught event probe first on the old bundle');
    test.setTimeout(90_000);
    const { app, window } = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'Lifecycle fixture', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'Local echo fixture', task: '', parent: null });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    const originalHost = await hostPid();
    const originalWindowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
    await closeLastWindow(app);
    await launchSecondary(app);
    await expect.poll(() => windowCount(app)).toBe(1);
    const reopened = await app.firstWindow();
    await expect(reopened.getByTestId('app-shell')).toBeVisible();
    await expect(reopened.getByText('Lifecycle fixture', { exact: true })).toBeVisible();
    await expect(reopened.getByText('Connecting to host…')).toHaveCount(0);
    expect(await hostPid()).toBe(originalHost);
    const replacementId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id);
    expect(replacementId).not.toBe(originalWindowId);
    await reopened.screenshot({ path: path.join(shots, 'second-instance-reopened.png'), animations: 'disabled' });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.blur());
    await launchSecondary(app);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused())).toBe(true);
    expect(await windowCount(app)).toBe(1);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.id)).toBe(replacementId);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true);
    await launchSecondary(app);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFocused())).toBe(true);
    expect(await windowCount(app)).toBe(1);
    expect(await hostPid()).toBe(originalHost);
    await reopened.screenshot({ path: path.join(shots, 'second-instance-restored.png'), animations: 'disabled' });
    await assertNoErrors(app);
  });
});
