import { appendFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { setProposal, updateMap } from '@parley/core';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Строка комнаты в карточке сайдбара (кусок 5 плана «Organic», спека окна 2026-09-29, 1.2, 2.6, 2.7): комната стоит
 * на месте своих участников, а не рядом с ними; свёрнутая показывает значки провайдеров с числом агентов,
 * развёрнутая — участников со `★` у ведущего; решение, ждущее человека, подкрашивает строку, входит в «нужен ты»
 * строки статуса, и клик по счётчику ведёт во вкладку комнаты; под строками активной карточки — «New session or room».
 *
 * Комнату создаёт хост (`rooms.create` с `lead` и тихим стартом, заглушка агента писем не читает), решение кладёт в
 * карту тест ядром — так его положил бы `propose_decision`: настоящий `parley-mcp` заглушка не зовёт (сквозной
 * сценарий со стабом — кусок 8).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Строка в журнал событий сессии — то, что дописал бы хук Claude Code (как в `attention.spec.ts`). */
async function hookEvent(workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.harnas', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

async function createSession(window: Page, workId: string, label: string): Promise<string> {
  const result = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
    projectPath: project,
    workId,
    provider: 'claude',
    label,
    task: '',
    parent: null,
  });
  return result.ref.sessionId;
}

test.describe('строка комнаты в карточке (кусок 5)', () => {
  let home: string;
  let app: ElectronApplication | null = null;
  let homeBefore: string | undefined;

  test.beforeEach(async () => {
    home = await makeTempHome('room-row');
    project = await makeTempProject('room-row');
    // Ядро, которым тест кладёт решение в карту, читает дом из окружения этого процесса.
    homeBefore = process.env.HARNAS_HOME;
    process.env.HARNAS_HOME = home;
  });

  test.afterEach(async () => {
    if (homeBefore === undefined) delete process.env.HARNAS_HOME;
    else process.env.HARNAS_HOME = homeBefore;
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('комната вместо участников, значки провайдеров, ★ у ведущего; решение ждёт — подкраска, «1 needs you» и переход в комнату', async () => {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-row', goal: '' });
    const key = `${project} ${workId}`;
    const lead = await createSession(window, workId, 'lead');
    const second = await createSession(window, workId, 'second');
    const third = await createSession(window, workId, 'third');
    const solo = await createSession(window, workId, 'solo');
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'e2e-room',
      members: [lead, second, third],
      lead,
      quiet: true,
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();

    const card = window.locator(`[data-work-key="${key}"]:not([role="tab"])`);
    const row = card.locator(`[data-room-row="${roomId}"]`);
    // Комната на месте участников: их отдельных строк нет, сессия вне комнаты — есть.
    await expect(row).toHaveCount(1);
    await expect(card.locator(`[data-session-id="${lead}"]`)).toHaveCount(0);
    await expect(card.locator(`[data-session-id="${solo}"]`)).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    // Значок провайдера с числом ВСЕХ агентов провайдера в комнате и тултипом «3 Claude Code agents».
    const badge = row.locator('[data-provider-badge="claude"]');
    await expect(badge.locator('[data-provider-count]')).toHaveText('3');
    await expect(badge).toHaveAttribute('title', '3 Claude Code agents');
    await expect(row.locator('> div').first()).toHaveAttribute('title', `Room · lead S01 · S01, S02, S03`);

    // Шеврон разворачивает: три строки участников, `★` — только у ведущего, значков-счётчиков больше нет.
    await row.getByRole('button', { name: 'Show agents' }).click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row.locator('[data-session-id]')).toHaveCount(3);
    await expect(row.locator('[data-lead]')).toHaveCount(1);
    await expect(row.locator(`[data-session-id="${lead}"] [data-lead]`)).toHaveCount(1);
    await expect(row.locator('[data-provider-badge]')).toHaveCount(0);
    await row.getByRole('button', { name: 'Hide agents' }).click();
    await expect(row.locator('[data-session-id]')).toHaveCount(0);

    // «New session or room» — только у активной карточки (единственная работа активна сразу; вторая её сменит);
    // клик открывает прежний диалог ⌘T этой работы.
    const newRow = card.getByRole('button', { name: 'New session or room' });
    await expect(newRow).toHaveCount(1);
    const other = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-row-other', goal: '' });
    const otherCard = window.locator(`[data-work-key="${project} ${other.workId}"]:not([role="tab"])`);
    await otherCard.locator('[data-work-title]').first().click();
    await expect(newRow).toHaveCount(0);
    await expect(otherCard.getByRole('button', { name: 'New session or room' })).toHaveCount(1);
    await card.locator('[data-work-title]').first().click();
    await expect(otherCard.getByRole('button', { name: 'New session or room' })).toHaveCount(0);
    await newRow.click();
    await expect(window.getByRole('dialog', { name: 'New session' })).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog')).toHaveCount(0);

    // Решение ждёт человека: строка подкрашена, слово «decision», значок вопроса у карточки, «1 needs you» в строке статуса.
    await expect(window.locator('[data-attention-segment]')).toHaveCount(0);
    await updateMap(project, workId, (map) => {
      setProposal(map, roomId, lead, 'Split the work: refund.ts to S02, the review to S03.');
    });
    await expect(row).toContainText('decision');
    await expect(row).toHaveClass(/bg-accent-200/);
    await expect(card.locator('[data-work-glyph] [data-state="blocked"]')).toHaveCount(1);
    const segment = window.getByRole('button', { name: '1 needs you' });
    await expect(segment).toBeVisible({ timeout: 5_000 });

    // «Следующая, где нужен ты» — единственная цель здесь комната с решением: клик открывает её вкладку, строка выбрана.
    // Развёрнутость — ручной выбор выше (строку свернули шевроном), он перекрывает правило 2.6 до перезапуска окна.
    await segment.click();
    const tab = window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    await expect(row).toHaveAttribute('data-selected', 'true');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    // Клик по выбранной свёрнутой строке разворачивает её (по развёрнутой и открытой — сворачивает).
    await row.locator('> div').first().click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row.locator('[data-session-id]')).toHaveCount(3);
    await row.locator('> div').first().click();
    await expect(row).toHaveAttribute('aria-expanded', 'false');

    // Blocked-сессия рядом с решением (сцена dark-04): «2 need you», а клики по счётчику идут по кругу — цели одного списка
    // blocked → комната с решением, а не застревают на первой blocked (2.7). Текущая вкладка — комната, после неё — blocked.
    await hookEvent(workId, solo, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    const both = window.getByRole('button', { name: '2 need you' });
    await expect(both).toBeVisible({ timeout: 5_000 });
    const soloTab = window.locator(`[role="tab"][data-tab-id="terminal:${solo}"]`);
    await both.click();
    await expect(soloTab).toHaveAttribute('data-active', 'true');
    await both.click();
    await expect(tab).toHaveAttribute('data-active', 'true');
    await both.click();
    await expect(soloTab).toHaveAttribute('data-active', 'true');
  });
});
