import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { WorkMap } from '@parley/core';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';
import { seedTrust } from './trust-seed.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonl = (records: unknown[]): string =>
  `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const description = 'Check the ledger migration against the room acceptance criteria.';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) =>
      (
        globalThis as unknown as {
          parley: { call: (method: string, params: unknown) => Promise<unknown> };
        }
      ).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Подтверждённые вызовы с настоящими ID; сначала создаём весь список, затем обновляем статусы. */
function claudePlan(id: string, cwd: string, count = 3, current = 2): string {
  const records: unknown[] = [];
  const timestamp = new Date().toISOString();
  for (const name of ['TaskCreate', 'TaskUpdate']) {
    for (let index = 1; index <= count; index++) {
      const taskId = String(100 + index);
      const subject = `Ledger step ${index}${index === 2 ? ' — verify migration compatibility across all existing ledger accounts and retained transaction history' : ''}`;
      const input =
        name === 'TaskCreate'
          ? { subject, description, activeForm: `Checking ledger step ${index}` }
          : {
              taskId,
              status: index === current ? 'in_progress' : index < current ? 'completed' : 'pending',
            };
      const result =
        name === 'TaskCreate' ? { task: { id: taskId, subject } } : { success: true, taskId };
      const toolId = `${name}-${index}`;
      records.push({
        type: 'assistant',
        sessionId: id,
        cwd,
        timestamp,
        message: {
          id: `message-${toolId}`,
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolId, name, input }],
        },
      });
      records.push({
        type: 'user',
        sessionId: id,
        cwd,
        timestamp,
        toolUseResult: result,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolId, content: JSON.stringify(result) }],
        },
      });
    }
  }
  return jsonl(records);
}

// Приёмка на журналах-фикстурах: отдельные дома провайдеров, без платных запусков агентов.
test('план из журнала доходит до карточки комнаты и панели Agents участника', async () => {
  test.setTimeout(120_000);
  const home = await makeTempHome('agent-plans');
  const project = await makeTempProject('agent-plans');
  const claudeRoot = path.join(home, 'claude-projects');
  const codexRoot = path.join(home, 'codex-sessions');
  let app: ElectronApplication | null = null;
  try {
    await mkdir(path.join(claudeRoot, '-fixture'), { recursive: true });
    await mkdir(path.join(codexRoot, '2026', '10', '18'), { recursive: true });
    // Сессия Codex в проекте без согласия удерживалась бы до решения человека (спека 2026-10-21, 4.2).
    await seedTrust(home, project);
    app = await electron.launch({
      args: [path.resolve(dirname, '../out/main/index.js')],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_SKIP_VERSION_PROBE: '1', // Personal plans remain usable without Chat support.
        PARLEY_CLAUDE_PROJECTS_DIR: claudeRoot,
        PARLEY_CODEX_SESSIONS_DIR: codexRoot,
        PARLEY_CLAUDE_BIN: path.resolve(dirname, 'stub-echo-agent.mjs'),
        PARLEY_CODEX_BIN: path.resolve(dirname, 'stub-codex-agent.mjs'),
        PARLEY_TERMINAL_RENDERER: 'dom',
        STUB_NO_HOOKS: '1',
      },
    });
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(window, 'works.create', {
      projectPath: project,
      title: 'Ledger migration with deliberately long acceptance criteria',
      goal: '',
    });
    const members: string[] = [];
    for (const provider of ['claude', 'claude', 'codex']) {
      const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
        projectPath: project,
        workId,
        provider,
        label: `${provider} ledger reviewer`,
        task: 'Review the ledger migration',
        parent: null,
      });
      members.push(ref.sessionId);
    }
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'Ledger acceptance',
      members,
      lead: members[0],
      quiet: true,
    });
    // Задаём только привязки провайдеров; метрики и планы проходят через настоящий индекс и activity service.
    const mapFile = path.join(project, '.parley', 'works', workId, 'map.json');
    const map = JSON.parse(await readFile(mapFile, 'utf8')) as WorkMap;
    const nativeIds = [
      'fixture-claude-a',
      'fixture-claude-b',
      '019e8ab0-1111-7111-8111-111111111111',
    ];
    for (const [index, sessionId] of members.entries()) {
      const session = map.sessions.find((item) => item.id === sessionId)!;
      session.providerSessionId = nativeIds[index]!;
      session.lifecycle = 'active';
      session.startedAt = new Date().toISOString();
    }
    // Назначение плана комнаты связывается с тем же участником, но не подменяет его собственный план.
    map.rooms.find((room) => room.id === roomId)!.mode = 'checklist';
    map.planSeq = 1;
    map.plans = [
      {
        id: 'pl-01',
        roomId,
        mode: 'checklist',
        status: 'active',
        rev: 0,
        goal: 'Review the ledger migration',
        backlog: [],
        acceptedAt: new Date().toISOString(),
        completedAt: null,
        cancelledAt: null,
        completionSummary: null,
        items: [
          {
            id: 1,
            title: 'Room ledger acceptance',
            owner: members[0]!,
            scope: 'Ledger migration acceptance scope',
            after: [],
            criteria: ['Ledger reviewed'],
            verifier: null,
            status: 'in_progress',
            evidence: null,
            note: null,
            log: [],
          },
        ],
      },
    ];
    await writeFile(mapFile, JSON.stringify(map));
    const claudeFile = path.join(claudeRoot, '-fixture', `${nativeIds[0]}.jsonl`);
    await writeFile(claudeFile, claudePlan(nativeIds[0]!, project));
    await writeFile(
      path.join(claudeRoot, '-fixture', `${nativeIds[1]}.jsonl`),
      claudePlan(nativeIds[1]!, project, 2, 1),
    );
    const timestamp = new Date().toISOString();
    await writeFile(
      path.join(codexRoot, '2026', '10', '18', `rollout-2026-10-18T12-00-00-${nativeIds[2]}.jsonl`),
      jsonl([
        {
          timestamp,
          type: 'session_meta',
          payload: { id: nativeIds[2], cwd: project, source: 'cli' },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'update_plan',
            call_id: 'plan-1',
            arguments: JSON.stringify({
              explanation: 'Codex fixture acceptance',
              plan: [{ step: 'Codex ledger check', status: 'in_progress' }],
            }),
          },
        },
        {
          timestamp,
          type: 'response_item',
          payload: { type: 'function_call_output', call_id: 'plan-1', output: 'Plan updated' },
        },
      ]),
    );
    await window.locator(`[data-room-row="${roomId}"]`).locator('> div').first().click();
    const roomTab = window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`);
    const card = window.locator(`[data-participant="${members[0]}"]`);
    await expect(card).toContainText('Ledger step 2', { timeout: 30_000 });
    await expect(card.getByRole('button', { name: '1/3', exact: true })).toBeVisible();
    await expect(window.locator(`[data-participant="${members[2]}"]`)).toContainText(
      'Codex ledger check',
    );
    await card.getByRole('button', { name: '1/3', exact: true }).hover();
    await expect(window.getByText(description, { exact: true }).first()).toBeVisible();
    await window.mouse.move(0, 0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }),
    );
    await expect.poll(() => window.evaluate(() => innerWidth)).toBe(800);
    await expect(window.locator('[data-work-sidebar]')).toBeVisible();
    await card.getByRole('button', { name: '1/3', exact: true }).click();
    await expect(window.locator('[data-work-sidebar]')).toHaveCount(0);
    await expect(roomTab).toHaveAttribute('data-active', 'true');
    const panel = window
      .getByTestId('right-sidebar')
      .getByRole('region', { name: 'Plan', exact: true });
    await expect(panel).toContainText('Ledger step 2');
    const roomLink = panel.getByRole('button', {
      name: 'pl-01 · item 1: Room ledger acceptance',
      exact: true,
    });
    await expect(roomLink).toHaveAttribute('title', 'Ledger migration acceptance scope');
    await panel.getByRole('button', { name: 'Ledger step 1', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Ledger step 1', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await roomLink.click();
    await expect(roomTab).toHaveAttribute('data-active', 'true');
    await expect(window.getByTestId('right-sidebar')).toBeVisible();
    await mkdir(path.resolve(dirname, '../test-results/agent-plans'), { recursive: true });
    await expect(window.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 15_000 });
    const cardBounds = await card.boundingBox();
    const chipBounds = await card.getByRole('button', { name: '1/3', exact: true }).boundingBox();
    expect(chipBounds!.x + chipBounds!.width).toBeLessThanOrEqual(
      cardBounds!.x + cardBounds!.width,
    );
    for (const theme of ['light', 'dark']) {
      await window.keyboard.press('Meta+J');
      await window.locator('[data-palette] [cmdk-input]').fill(`Theme: ${theme}`);
      await window.keyboard.press('Enter');
      await expect(window.locator('[data-palette]')).toHaveCount(0);
      await window.screenshot({
        path: path.resolve(dirname, `../test-results/agent-plans/${theme}-800x500.png`),
      });
    }
    // Пин A снимается при активации терминала B, в том числе пока правый сайдбар скрыт.
    const otherCard = window.locator(`[data-participant="${members[1]}"]`);
    await otherCard.getByRole('button').first().click();
    const otherTab = window.locator(`[role="tab"][data-tab-id="terminal:${members[1]}"]`);
    await expect(otherTab).toHaveAttribute('data-active', 'true');
    await expect(panel).toContainText('Plan · 0/2');
    await expect(panel.getByRole('button', { name: 'Ledger step 3', exact: true })).toHaveCount(0);
    await roomTab.click();
    await card.getByRole('button', { name: '1/3', exact: true }).click();
    await expect(panel).toContainText('Plan · 1/3');
    await window.getByRole('button', { name: 'Right sidebar', exact: true }).click();
    await expect(window.getByTestId('right-sidebar')).toHaveCount(0);
    await otherTab.click();
    await window.getByRole('button', { name: 'Right sidebar', exact: true }).click();
    await expect(panel).toContainText('Plan · 0/2');
    await roomTab.click();
    await card.getByRole('button', { name: '1/3', exact: true }).click();
    await expect(panel).toContainText('Plan · 1/3');
    // Ротация журнала сбрасывает инкрементальный курсор; переписывание более длинного файла на месте не является append.
    await writeFile(`${claudeFile}.next`, claudePlan(nativeIds[0]!, project, 60, 51));
    await rename(`${claudeFile}.next`, claudeFile);
    await expect(card).toContainText('Ledger step 51', { timeout: 30_000 });
    await expect(panel).toContainText('Ledger step 51');
    await expect(panel).toContainText('+10 more');
    await writeFile(`${claudeFile}.next`, claudePlan(nativeIds[0]!, project, 60, 61));
    await rename(`${claudeFile}.next`, claudeFile);
    await expect(card).toContainText('Review the ledger migration', { timeout: 30_000 });
    await expect(card.getByRole('button', { name: '60/60', exact: true })).toHaveCount(0);
    await expect(panel).toContainText('Plan · 60/60');
    const partialAt = new Date().toISOString();
    await writeFile(
      `${claudeFile}.next`,
      jsonl([
        {
          type: 'assistant',
          sessionId: nativeIds[0],
          cwd: project,
          timestamp: partialAt,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'partial-create',
                name: 'TaskCreate',
                input: { subject: 'Recovered task without an ID' },
              },
            ],
          },
        },
        {
          type: 'user',
          sessionId: nativeIds[0],
          cwd: project,
          timestamp: partialAt,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'partial-create', content: 'Created' }],
          },
        },
      ]),
    );
    await rename(`${claudeFile}.next`, claudeFile);
    await expect(card.getByRole('button', { name: 'Plan', exact: true })).toBeVisible();
    await expect(panel).toContainText('Plan may be incomplete');
    await expect(panel).not.toContainText('0/1');
    // A session with no native plan still has an entry point; explicit publication uses the same map watcher.
    const codexCard = window.locator(`[data-participant="${members[2]}"]`);
    const currentMap = JSON.parse(await readFile(mapFile, 'utf8')) as WorkMap;
    const codexSession = currentMap.sessions.find(session => session.id === members[2])!;
    codexSession.agentPlan = { items: [], explanation: null, partial: false, updatedAt: new Date().toISOString() };
    await writeFile(`${mapFile}.next`, JSON.stringify(currentMap));
    await rename(`${mapFile}.next`, mapFile);
    await expect(codexCard.getByRole('button', { name: 'Plan', exact: true })).toBeVisible();
    await codexCard.getByRole('button', { name: 'Plan', exact: true }).click();
    await expect(panel).toContainText('No personal steps published yet');
    const publishedMap = JSON.parse(await readFile(mapFile, 'utf8')) as WorkMap;
    publishedMap.sessions.find(session => session.id === members[2])!.agentPlan = {
      items: [
        { id: '1', subject: 'Inspect the flow', status: 'completed', description: null, activeForm: null },
        { id: '2', subject: 'Verify published progress', status: 'in_progress', description: 'Visible without sending the lead a message', activeForm: null },
      ], explanation: null, partial: false, updatedAt: new Date().toISOString(),
    };
    await writeFile(`${mapFile}.next`, JSON.stringify(publishedMap));
    await rename(`${mapFile}.next`, mapFile);
    await expect(codexCard).toContainText('Verify published progress');
    await expect(panel).toContainText('Plan · 1/2');
    await expect(panel).toContainText('Visible without sending the lead a message');
    await window.screenshot({ path: path.resolve(dirname, '../test-results/agent-plans/published-800x500.png') });

  } finally {
    await stopApp(app);
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
