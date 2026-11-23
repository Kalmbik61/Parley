import { chmod, copyFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { MethodName, Params, Result, SessionRef } from '@parley/protocol';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../host/src/kimi/fixtures/acp.cjs', import.meta.url));

async function call<M extends MethodName>(window: Page, method: M, params: Params<M>): Promise<Result<M>> {
  return window.evaluate(([name, args]) => {
    const bridge = (globalThis as unknown as { parley: { call(name: string, params: unknown): Promise<unknown> } }).parley;
    return bridge.call(name, args);
  }, [method, params] as const) as Promise<Result<M>>;
}

async function send(chat: Locator, text: string): Promise<void> {
  const composer = chat.getByTestId('chat-composer');
  await composer.getByRole('textbox', { name: 'Message to Kimi Code' }).fill(text);
  await composer.getByRole('button', { name: 'Send', exact: true }).click();
}

async function workSession(window: Page, ref: Pick<SessionRef, 'projectPath' | 'workId'>) {
  const { entries } = await call(window, 'works.list', {});
  return entries.find(({ projectPath, map }) => projectPath === ref.projectPath && map.work.id === ref.workId)
    ?.map.sessions.find(({ provider }) => provider === 'kimi');
}

test('Kimi Code model, permissions, text answers and resume work in the desktop window', async () => {
  const testInfo = test.info();
  test.setTimeout(60_000);
  const home = await makeTempHome('kimi');
  const projectPath = await makeTempProject('kimi');
  const binary = path.join(home, 'kimi');
  const note = path.join(projectPath, 'notes.md');
  let app: ElectronApplication | null = null;

  try {
    await copyFile(fixture, binary);
    await chmod(binary, 0o755);
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_KIMI_BIN: binary,
        KIMI_FIXTURE_EXPECT_FORMS: '1',
        KIMI_FIXTURE_MODEL_FILE: path.join(home, 'kimi-model'),
        KIMI_FIXTURE_BOOLEAN_CONFIG: '1',
      },
    });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call(window, 'works.create', { projectPath, title: 'Kimi ACP', goal: '' });
    const workspace = { projectPath, workId };
    await window.locator(`[data-work-key="${projectPath} ${workId}"]:not([role="tab"]) [data-work-title]`).first().click();

    await window.keyboard.press('Meta+T');
    const start = window.getByRole('dialog', { name: 'New session', exact: true });
    await start.getByRole('radio', { name: 'Kimi Code', exact: true }).click();
    await start.getByPlaceholder('Optional').fill('Kimi ACP chat');
    await start.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(start).toBeHidden();
    await expect.poll(() => workSession(window, workspace)).toMatchObject({
      id: 's-01', providerSessionId: 'acp-session', lifecycle: 'active',
    });

    const chat = window.getByTestId('chat-view');
    await expect(chat.getByRole('textbox', { name: 'Message to Kimi Code' })).toHaveAttribute(
      'placeholder', 'Message Kimi Code — Enter to send',
    );
    const settings = (model: string) => chat.getByRole('button', { name: new RegExp(`^Kimi Code settings \\(.*${model}`) });
    await settings('Alpha').click();
    await window.getByRole('menuitemradio', { name: 'Beta', exact: true }).click();
    await expect(settings('Beta')).toBeVisible();

    await send(chat, 'approve and write');
    const denied = chat.getByTestId('chat-card').filter({ has: window.getByRole('button', { name: 'Deny', exact: true }) });
    await expect(denied).toContainText('Write the release notes to notes.md');
    await expect(denied).toContainText('before');
    await expect(denied).toContainText('after');
    const approvalImage = testInfo.outputPath('kimi-approval.png');
    await window.screenshot({ path: approvalImage });
    await testInfo.attach('Kimi permission preview', { path: approvalImage, contentType: 'image/png' });
    await denied.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(chat.getByText('deny', { exact: true })).toBeVisible();
    await expect(readFile(note)).rejects.toHaveProperty('code', 'ENOENT');

    await send(chat, 'approve and write');
    await chat.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(chat.getByText('allow', { exact: true })).toBeVisible();
    expect(await readFile(note, 'utf8')).toBe('after');

    await send(chat, 'question');
    const answer = 'Release candidate';
    const field = chat.getByTestId('card-other-text');
    await field.fill(answer);
    const questionImage = testInfo.outputPath('kimi-question.png');
    await window.screenshot({ path: questionImage });
    await testInfo.attach('Kimi text question', { path: questionImage, contentType: 'image/png' });
    await chat.getByTestId('card-submit').click();
    await expect(chat.getByTestId('chat-text').filter({ hasText: answer })).toBeVisible();

    await send(chat, 'call Parley');
    await expect(chat.getByText('Parley session: s-01', { exact: true })).toBeVisible();
    await send(chat, 'disconnect');
    const asleep = window.getByTestId('terminal-not-running');
    await expect(asleep).toContainText('asleep');
    await asleep.getByRole('button', { name: 'Resume', exact: true }).click();

    await expect(settings('Beta')).toBeVisible();
    await expect.poll(() => workSession(window, workspace)).toMatchObject({
      id: 's-01', providerSessionId: 'acp-session', lifecycle: 'active',
    });
    await send(chat, 'hello');
    await expect(chat.getByText('Hello Parley', { exact: true })).toBeVisible();
  } finally {
    await stopApp(app);
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(projectPath, { recursive: true, force: true });
  }
});
