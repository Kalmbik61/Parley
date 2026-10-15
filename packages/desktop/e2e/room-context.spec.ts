/**
 * Заполненность контекста и сжатие в комнате (спека 2026-10-15, 3.2–3.3, 5, 7.2): `claude` играет стаб
 * `stub-echo-agent.mjs`, файл `context/<сессия>.json` пишет сам тест (как строка статуса), хуки — строки
 * `STUB_HOOK <json>` через `pty.input`. Окно 800×500 с длинными названиями; `dpr` 1 и 2. Снимки —
 * в `test-results/room-context/` (не коммитятся).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/room-context');
const LONG_LABEL = 'backend-refactor-of-the-payments-ledger-and-invoices';
const LONG_TITLE = `Payments ledger refactor with invoices, refunds, reconciliation, reporting and audit trail ${'x'.repeat(30)}`.slice(0, 120);
type Ref = { projectPath: string; workId: string; sessionId: string };
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function hook(window: Page, ref: Ref, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const body = JSON.stringify({ hook_event_name: event, ...fields });
  await window.evaluate(
    ({ target, data }) =>
      (globalThis as unknown as { parley: { notify: (m: string, p: unknown) => void } }).parley.notify('pty.input', { ref: target, data }),
    { target: ref, data: `STUB_HOOK ${body}\r` },
  );
}

async function writeContext(ref: Ref, usedPercent: number): Promise<void> {
  const dir = path.join(ref.projectPath, '.parley', 'works', ref.workId, 'context');
  await mkdir(dir, { recursive: true });
  const fill = { usedPercent, windowTokens: 200_000, usedTokens: usedPercent * 2_000, at: new Date().toISOString() };
  await writeFile(path.join(dir, `${ref.sessionId}.json`), `${JSON.stringify(fill)}\n`);
}

async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

test.describe('контекст и сжатие в комнате (800×500)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-context');
    project = await makeTempProject('room-context');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  for (const dpr of [1, 2]) {
    test(`чипы, поповер в границах окна, сжатие свободного и занятого агента (масштаб ${dpr})`, async () => {
      test.setTimeout(120_000);
      const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent,
        // Проба версий включена: HTTP-хуки (PostCompact, ход) есть только при известной версии `claude` (стаб отвечает 2.1.286).
        PARLEY_SKIP_VERSION_PROBE: '', PARLEY_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry, `--force-device-scale-factor=${dpr}`], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
      await expect(window.getByTestId('landing')).toBeVisible();

      const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-context', goal: '' });
      const refs: Ref[] = [];
      for (let index = 0; index < 2; index += 1) {
        const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
          projectPath: project,
          workId,
          provider: 'claude',
          label: `${LONG_LABEL}-${index}`,
          task: '',
          parent: null,
        });
        refs.push({ projectPath: project, workId, sessionId: ref.sessionId });
      }
      const [idle, busy] = refs as [Ref, Ref];
      const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
        projectPath: project,
        workId,
        title: LONG_TITLE,
        members: refs.map((ref) => ref.sessionId),
        lead: idle.sessionId,
        quiet: true,
      });
      await expect(window.getByTestId('app-shell')).toBeVisible();
      await window.locator(`[data-room-row="${roomId}"]`).locator('> div').first().click();

      await writeContext(idle, 82);
      await writeContext(busy, 41);
      const idleChip = window.locator(`[data-participant="${idle.sessionId}"] [data-testid="participant-context-chip"]`);
      const busyChip = window.locator(`[data-participant="${busy.sessionId}"] [data-testid="participant-context-chip"]`);
      await expect(idleChip).toHaveText('82%', { timeout: 15_000 });
      await expect(busyChip).toHaveText('41%', { timeout: 15_000 });
      await expect(window.getByTestId('room-context-chip')).toHaveText('Ctx 82%');

      // Узкое окно: значок и поповер комнаты — в границах.
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
      await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(800);
      await window.getByTestId('room-context-chip').click();
      const popover = window.getByTestId('room-context-popover');
      await expect(popover).toBeVisible();
      const box = await popover.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(-0.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(800.5);
      expect(box!.y + box!.height).toBeLessThanOrEqual(500.5);
      await mkdir(shots, { recursive: true });
      await window.waitForTimeout(500); // появление поповера — с переходом прозрачности
      await window.screenshot({ path: path.join(shots, `room-context-popover-dpr${dpr}.png`) });
      await window.keyboard.press('Escape');
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));

      // Занятый агент: просьба ждёт конца хода.
      await hook(window, busy, 'UserPromptSubmit', { prompt: 'work' });
      // Хост узнаёт о ходе из журнала событий с задержкой: без ожидания просьба ушла бы как к свободному.
      await expect(window.locator(`[data-participant="${busy.sessionId}"] [data-testid="agent-state-dot"][data-state="working"]`)).toBeVisible({ timeout: 10_000 });
      await busyChip.click();
      await window.getByTestId('compact-submit').click();
      await expect(busyChip).toHaveText('⏳');
      await window.keyboard.press('Escape');
      await expect(window.getByRole('dialog')).toHaveCount(0);

      // Свободный агент: печать сразу, затем PostCompact и свежая цифра. Stop — чтобы стаб точно считался свободным.
      await hook(window, idle, 'Stop');
      await idleChip.click();
      await expect(window.getByTestId('compact-instructions')).toHaveValue(new RegExp(`^Focus on room "${LONG_TITLE.slice(0, 20)}`));
      await window.getByTestId('compact-submit').click();
      await expect(idleChip).toHaveText('…');
      await window.keyboard.press('Escape');
      await expect(window.getByRole('dialog')).toHaveCount(0);
      await hook(window, idle, 'PostCompact', { trigger: 'manual' });
      await expect(idleChip).toHaveText('compacted', { timeout: 10_000 });
      await writeContext(idle, 12);
      await expect(idleChip).toHaveText('12%', { timeout: 15_000 });

      await hook(window, busy, 'Stop');
      await expect(busyChip).toHaveText('…', { timeout: 10_000 });

      // В терминале занятого — команда с фокусом комнаты.
      await window.locator(`[data-participant="${busy.sessionId}"] button`).first().click();
      // Со включёнными хуками сессия открывается видом Chat — к терминалу переключаемся.
      await window.getByRole('radio', { name: 'Terminal' }).click();
      await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain('echo: /compact Focus on room');
    });
  }
});
