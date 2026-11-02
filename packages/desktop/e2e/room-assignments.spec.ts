import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  addRoom,
  addSession,
  DEFAULT_CONFIG,
  HUMAN,
  reservePlanEffects,
  setProposal,
  updateMap,
  type PlanCheckpoint,
  type PlanItem,
  type PlanItemInput,
} from '@parley/core';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Задания принятого плана комнаты глазами человека (сквозная приёмка, план 2026-10-19, разделы 5 P5–P6 и 6) в окне
 * 800×500 с длинными названиями и длинным путём проекта.
 *
 * Карту кладёт тест ядром, как положил бы хост и `plan_*`: verified-план в смешанных состояниях — пункт проверен,
 * два сданы и ждут проверки (у одного позиция проверяющего осталась от более ранней сдачи), один в работе с позицией
 * владельца, один ждёт зависимостей, один готов к началу. Поручения резервирует настоящий `reservePlanEffects`. Агентов
 * нет: сессии лежат в карте, будильник хоста на паузе. Второй этап — поправка этого плана: решение человека показывает только несделанное.
 *
 * Агентская сторона того же сценария — `core/src/work/room-assignments.acceptance.test.ts` (настоящий MCP).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
let project = '';

const UNBROKEN = `packages/desktop/src/renderer/components/rooms/${'PlanRemainingView-'.repeat(8)}.tsx`;
const LONG_WORDS = 'Rebuild the whole export pipeline so that every stage reports progress and recovers after a restart '.repeat(3).trim();
const LONG_LABEL = 'a-session-label-without-any-spaces-that-keeps-going-';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Клик по уведомлению без самого уведомления: main шлёт окну цель (`room-decision.spec.ts`). */
async function sendFocusTarget(app: ElectronApplication, target: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', value);
  }, target);
}

interface Overflow {
  /** Горизонтальная прокрутка самого блока. */
  scroll: number;
  /** Потомки, чей правый край дальше правого края блока (закрытые раскрытия не считаем: их не показывают). */
  outside: string[];
  /** Горизонтальная прокрутка ленты комнаты, в которой стоит блок. */
  feedScroll: number;
  windowFit: boolean;
}

/** Ничто в блоке не выходит за его правый край и за окно; ни блок, ни лента не прокручиваются вбок. */
function overflowOf(block: Locator, scope: string): Promise<Overflow> {
  return block.evaluate((node, selector) => {
    const right = node.getBoundingClientRect().right;
    const outside = Array.from(node.querySelectorAll<HTMLElement>(selector))
      .filter((child) => child.closest('details:not([open]) > :not(summary)') === null)
      .filter((child) => child.getBoundingClientRect().width > 0 && child.getBoundingClientRect().right > right + 1)
      .map((child) => `${child.tagName.toLowerCase()} right=${Math.round(child.getBoundingClientRect().right)}/${Math.round(right)} ${(child.textContent ?? '').slice(0, 30)}`);
    const feed = node.closest<HTMLElement>('[data-room-feed]');
    return {
      scroll: node.scrollWidth - node.clientWidth,
      outside,
      feedScroll: feed === null ? 0 : feed.scrollWidth - feed.clientWidth,
      windowFit: right <= globalThis.innerWidth,
    };
  }, scope);
}

test.describe('задания комнаты в окне: кто действует, позиции, число на проверке, поправка (сквозная приёмка)', () => {
  let home: string;
  let app: ElectronApplication | null = null;
  let homeBefore: string | undefined;

  test.beforeEach(async () => {
    home = await makeTempHome('room-assignments');
    // Длинный путь проекта (правило визуальных проверок).
    project = await makeTempProject(`room-assignments-${'very-long-project-directory-name-'.repeat(5)}`);
    // Ядро, которым тест кладёт карту, читает дом из окружения этого процесса.
    homeBefore = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = home;
  });

  test.afterEach(async () => {
    if (homeBefore === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = homeBefore;
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('план в смешанных состояниях: кто действует и почему, позиции, stale, «2 awaiting verification»; поправка показывает только несделанное', async () => {
    test.setTimeout(120_000);
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    // Будильник хоста стоит на паузе: сессий-процессов нет, письма-поручения никого не будят.
    await call(window, 'wake.pause', {});

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-assignments', goal: '' });
    const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    const row = (by: string, status: PlanItem['status'], minutes: number): PlanItem['log'][number] => ({ at: minutesAgo(minutes), by, status, note: null });
    const checkpoint = (by: string, patch: Partial<PlanCheckpoint>): PlanCheckpoint => ({
      by,
      at: minutesAgo(5),
      submission: null,
      done: 'Parser written',
      next: 'Wire the CLI',
      artifacts: [],
      blocker: null,
      ...patch,
    });
    let roomId = '';
    let lead = '';
    await updateMap(project, workId, (map, letters) => {
      lead = addSession(map, { provider: 'claude', label: `lead-${LONG_LABEL}`, task: '' }).id;
      const owner = addSession(map, { provider: 'claude', label: `owner-${LONG_LABEL}`, task: '' }).id;
      const checker = addSession(map, { provider: 'claude', label: `checker-${LONG_LABEL}`, task: '' }).id;
      const room = addRoom(map, { title: `Delivery-${'D'.repeat(80)}`, creator: HUMAN, members: [lead, owner, checker], lead, mode: 'verified' });
      roomId = room.id;
      const item = (id: number, title: string, status: PlanItem['status'], patch: Partial<PlanItem> = {}): PlanItem => ({
        id,
        title,
        owner,
        scope: `src/${id}/${'deep/'.repeat(12)}index.ts`,
        after: [],
        criteria: ['Works'],
        verifier: checker,
        status,
        evidence: null,
        note: null,
        log: [],
        ...patch,
      });
      const evidence = { text: 'Measured on the whole suite', artifacts: ['src/report.txt'] };
      const items: PlanItem[] = [
        item(1, 'Schema', 'verified', { evidence, log: [row(owner, 'in_progress', 90), row(owner, 'done', 80), row(checker, 'verified', 70)] }),
        item(2, 'Api', 'verified', { after: [1], evidence, log: [row(owner, 'in_progress', 65), row(owner, 'done', 60), row(checker, 'verified', 55)] }),
        // Сдан дважды: позиция проверяющего записана для первой сдачи (журнал: сдача на 2-й записи, текущая — на 4-й).
        item(3, `${LONG_WORDS} ${UNBROKEN}`, 'done', {
          after: [1],
          evidence,
          log: [row(owner, 'in_progress', 50), row(owner, 'done', 45), row(checker, 'returned', 40), row(owner, 'done', 20)],
          progress: { verifier: checkpoint(checker, { submission: 2, done: 'Read the first diff', next: 'Run the suite', blocker: 'The suite is slow' }) },
        }),
        item(4, `Wire ${UNBROKEN}`, 'in_progress', {
          after: [2],
          log: [row(owner, 'in_progress', 30)],
          progress: {
            owner: checkpoint(owner, {
              done: `Parser written and wired through ${'segment/'.repeat(30)}index.ts`,
              next: `Cover ${UNBROKEN.slice(0, 150)}`,
              artifacts: ['src/parser.ts', 'src/cli.ts'],
              blocker: `Waiting for a fixture ${'fixture-'.repeat(20)}`,
            }),
          },
        }),
        item(5, `Docs ${LONG_WORDS}`, 'waiting', { after: [3, 4] }),
        item(6, 'Release', 'ready'),
        item(7, 'Review', 'done', { after: [2], evidence, log: [row(owner, 'in_progress', 15), row(owner, 'done', 10)] }),
      ];
      map.work.planSeq = 1;
      map.plans = [
        {
          id: 'pl-01',
          roomId: room.id,
          mode: 'verified',
          status: 'active',
          rev: 3,
          goal: `Ship the assignments ${UNBROKEN}`,
          items,
          backlog: [],
          acceptedAt: minutesAgo(120),
          completedAt: null,
          cancelledAt: null,
          completionSummary: null,
        },
      ];
      // Поручения резервирует настоящий `reservePlanEffects`, как после принятия плана.
      reservePlanEffects(map, letters, DEFAULT_CONFIG.messageRate);
    });
    await expect(window.locator('[data-room-row]')).toHaveCount(1, { timeout: 20_000 });

    // Строка комнаты: сданное, но не проверенное — отдельным счётчиком (два пункта: 3 и 7), `verified` не растёт.
    await expect(window.locator('[data-room-plan-awaiting]')).toHaveText('2 awaiting verification', { timeout: 20_000 });
    await expect(window.locator('[data-room-plan-awaiting]')).toBeVisible();

    await sendFocusTarget(electronApp, { kind: 'room', projectPath: project, workId, roomId });
    const panel = window.locator('[data-plan-panel]');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    const item = (id: number): Locator => panel.locator(`[data-plan-item="${id}"]`);
    await expect(panel.locator('[data-plan-summary] > div').first()).toContainText('2/7 verified');
    await expect(panel.locator('[data-plan-awaiting]')).toHaveText('2 awaiting verification');

    // Кто действует и почему ждёт — те же обязанности, что видит агент в `plan_tasks` (`planItemDuties`).
    await expect(item(1).locator('[data-plan-duty]')).toHaveCount(0);
    await expect(item(3).locator('[data-plan-duty="owner"]')).toContainText('Awaiting verification by');
    await expect(item(3).locator('[data-plan-duty="verifier"]')).toContainText('must verify');
    await expect(item(4).locator('[data-plan-duty="owner"]')).toContainText('must continue');
    await expect(item(4).locator('[data-plan-duty="verifier"]')).toContainText('to submit');
    await expect(item(5).locator('[data-plan-duty="owner"]')).toContainText('Waiting for #3, #4');
    await expect(item(6).locator('[data-plan-duty="owner"]')).toContainText('must start');
    await expect(item(7).locator('[data-plan-duty="verifier"]')).toContainText('must verify');

    // Последние позиции: у проверяющего с более ранней сдачей — «Stale», у владельца — сделано, дальше, препятствие.
    const verifierCheckpoint = item(3).locator('[data-plan-checkpoint="verifier"]');
    await expect(verifierCheckpoint.locator('[data-checkpoint-stale]')).toHaveText('Stale · saved before the latest submission');
    await expect(verifierCheckpoint.locator('[data-checkpoint-next]')).toHaveText('Run the suite');
    const ownerCheckpoint = item(4).locator('[data-plan-checkpoint="owner"]');
    await expect(ownerCheckpoint.locator('[data-checkpoint-stale]')).toHaveCount(0);
    await expect(ownerCheckpoint.locator('[data-checkpoint-done]')).toContainText('Parser written and wired');
    await expect(ownerCheckpoint.locator('[data-checkpoint-blocker]')).toContainText('Waiting for a fixture');
    await expect(ownerCheckpoint.locator('[data-checkpoint-artifacts]')).toHaveText('2 artifacts');
    await expect(panel.locator('[data-plan-checkpoint]')).toHaveCount(2);

    // 800×500, длинные названия и путь проекта: ничто не выходит за правый край блока и окна, лента вбок не едет.
    expect(await overflowOf(panel, '*')).toEqual({ scroll: 0, outside: [], feedScroll: 0, windowFit: true });
    expect((await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0).toBe(true);

    // Поправка: пункт 2 (проверенный) меняется — он «будет переделан», зависящие от него 4, 5 и 7 сбрасываются; пункт 6
    // убирается; пункт 8 добавляется. Пункт 3 (сдан, от изменённых не зависит) остаётся как есть; пункт 1 скрыт одной строкой.
    await updateMap(project, workId, (map) => {
      const plan = map.plans![0]!;
      const draftItem = (source: PlanItem): PlanItemInput => ({
        id: source.id,
        title: source.title,
        owner: source.owner,
        scope: source.scope,
        after: source.after,
        criteria: source.criteria,
        verifier: source.verifier,
      });
      const items = plan.items.filter((source) => source.id !== 6).map(draftItem);
      items.find((source) => source.id === 2)!.scope = 'src/2/changed.ts';
      items.push({ id: 8, title: `Announce ${UNBROKEN}`, owner: plan.items[0]!.owner, scope: 'docs/announce.md', after: [5], criteria: ['Published'], verifier: plan.items[0]!.verifier });
      setProposal(map, roomId, lead, 'Only the remaining work changes: the export contract and the announcement.', new Date().toISOString(), {
        plan: { id: plan.id, rev: plan.rev, mode: 'verified', goal: plan.goal, items },
      });
    });
    const card = window.locator('[data-decision-card]');
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    const remaining = card.locator('[data-plan-remaining]');
    await expect(remaining).toBeVisible();

    // Только несделанное: проверенный пункт 1 не перечислен, убранный 6 — одной строкой, сделанные пункты не пересказаны.
    await expect(remaining.locator('[data-remaining-item]')).toHaveCount(6);
    await expect(remaining.locator('[data-remaining-item="1"]')).toHaveCount(0);
    await expect(remaining.locator('[data-remaining-item="6"]')).toHaveCount(0);
    await expect(remaining.locator('[data-remaining-item="2"]')).toContainText('Will be redone');
    await expect(remaining.locator('[data-remaining-item="2"]')).toContainText('Ready');
    await expect(remaining.locator('[data-remaining-item="3"]')).toContainText('Done');
    await expect(remaining.locator('[data-remaining-item="3"] [data-plan-mark]')).toHaveCount(0);
    await expect(remaining.locator('[data-remaining-item="4"] [data-plan-mark="changed"]')).toHaveCount(1);
    await expect(remaining.locator('[data-remaining-item="5"] [data-plan-mark="changed"]')).toHaveCount(1);
    await expect(remaining.locator('[data-remaining-item="7"] [data-plan-mark="changed"]')).toHaveCount(1);
    await expect(remaining.locator('[data-remaining-item="8"] [data-plan-mark="new"]')).toHaveCount(1);
    await expect(remaining.locator('[data-plan-done-hidden]')).toHaveText('1 done item hidden');
    await expect(remaining.locator('[data-plan-removed]')).toContainText('Removed: #6 Release');
    await expect(remaining.locator('details[data-plan-full]')).not.toHaveAttribute('open', '');

    // Карточка в окне 800×500 при длинных названиях: ни выход за край, ни прокрутка вбок.
    expect(await overflowOf(card, '[data-plan-remaining] *')).toEqual({ scroll: 0, outside: [], feedScroll: 0, windowFit: true });
    expect((await window.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0).toBe(true);
  });
});
