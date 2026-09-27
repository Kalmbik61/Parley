import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';

/**
 * Внимание в строке статуса (кусок 4.2, спека 7.3, 7.6): сессия, ждущая разрешения, даёт
 * сегмент «1 needs you», а клик по нему открывает вкладку её терминала в её работе.
 *
 * «Просмотрено» по видимости здесь не проверяется: оно зависит от фокуса окна ОС, а E2E идут
 * в несколько окон параллельно — фокус между ними гуляет. Его держат тесты `attention/seen`
 * и `App.test.tsx`, живую проверку делает контролёр.
 *
 * Внимание двигается настоящими событиями хуков, как в `cards.spec.ts`: stub-агент хуков не зовёт.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const project = '/tmp/harnas-e2e-attention';

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Строка в журнал событий сессии — то, что дописал бы хук Claude Code. */
async function hookEvent(workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.harnas', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

test.describe('внимание в строке статуса (кусок 4.2)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-attention-'));
    // Проект общий между прогонами: без очистки в нём копятся работы прошлых запусков.
    await rm(project, { recursive: true, force: true });
    await mkdir(project, { recursive: true });
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
  });

  test('сессия ждёт разрешения — «1 needs you»; клик открывает вкладку её терминала', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-attention', goal: '' });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'один',
      task: '',
      parent: null,
    });
    const sessionId = created.ref.sessionId;
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await expect(window.locator('[data-attention-segment]')).toHaveCount(0);

    await hookEvent(workId, sessionId, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    const segment = window.getByRole('button', { name: '1 needs you' });
    await expect(segment).toBeVisible({ timeout: 5_000 });

    await segment.click();
    const tab = window.locator(`[role="tab"][data-tab-id="terminal:${sessionId}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    // Сессия всё ещё ждёт — вкладка с отметкой и значком вопроса (спека 7.3).
    await expect(tab).toHaveAttribute('data-unread', 'true');
    await expect(tab.locator('[data-state="blocked"]')).toHaveCount(1);
  });
});
