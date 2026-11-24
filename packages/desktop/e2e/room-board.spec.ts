import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import {
  addBacklogItem,
  addRoom,
  addSession,
  HUMAN,
  setProposal,
  takeBacklogItem,
  updateMap,
  type PlanItem,
} from '@parley/core';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Доска комнаты глазами человека (сквозная приёмка, план 2026-11-17, задача 9) в окне 800×500 с длинными названиями.
 *
 * Карту кладёт тест ядром, как положил бы хост: комната с Verified-планом из шести пунктов в разных состояниях и три
 * сессии с номерами подряд. Агентов нет, будильник хоста на паузе. Сценарий идёт сквозь шаги плана: переключатель и
 * колонки, геометрия, цвет агента, движение карточки, панель пункта (Esc, Enter, нажатие мимо), решение человека,
 * запоминание вида, доска проекта, лента под доской, карточка участника с метками. Снимки — в `test-results/room-board/`
 * (не коммитятся), по две темы.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/room-board');
let project = '';

const LONG_TITLE = `Rebuild the whole export pipeline so that every stage reports progress ${'PlanRemainingView-'.repeat(6)}`;
const LONG_LABEL = 'a-session-label-without-any-spaces-that-keeps-going-on-and-on';
const LONG_ROLE = 'payments-database-migration-reviewer-for-ledger';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Тема меняется в main; снимок делается, когда окно действительно её применило (класс `.dark` на `<html>`) и всё осело. */
async function setTheme(app: ElectronApplication, window: Page, theme: 'light' | 'dark'): Promise<void> {
  await app.evaluate(({ nativeTheme }, source) => {
    nativeTheme.themeSource = source;
  }, theme);
  await expect.poll(() => window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark');
  await window.waitForTimeout(300);
}

/** Панель выезжает справа: снимок — когда она встала на место (её левый край перестал двигаться) и целиком в окне. */
async function expectSheetSettled(window: Page): Promise<void> {
  const sheet = window.locator('[data-room-item-sheet]');
  let last = -1;
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      const settled = box !== null && box.x === last && box.x + box.width <= (await window.evaluate(() => globalThis.innerWidth)) + 1;
      last = box?.x ?? -1;
      return settled;
    }, { intervals: [150] })
    .toBe(true);
}

/** Снимок без всплывашек: тост «Parley added PARLEY.md» от настоящей сессии закрывал бы низ окна. */
async function snap(window: Page, file: string): Promise<void> {
  await expect(window.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 20_000 });
  await window.screenshot({ path: file });
}

async function setWindow(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
}

const column = (window: Page, id: string): Locator => window.locator(`[data-room-board-layer] [data-board-column="${id}"]`);
const card = (window: Page, id: number): Locator => window.locator(`[data-room-board-layer] [data-board-item="${id}"]`);
const feed = (window: Page): Locator => window.locator('[data-room-feed]');

/** Номер цвета у значка агента с подписью `label` в `scope`. */
async function colourOf(scope: Locator): Promise<string | null> {
  return scope.locator('[data-agent-colour]').first().getAttribute('data-agent-colour');
}

test.describe('доска комнаты в окне 800×500 (сквозная приёмка)', () => {
  let home: string;
  let app: ElectronApplication | null = null;
  let homeBefore: string | undefined;

  test.beforeEach(async () => {
    home = await makeTempHome('room-board');
    project = await makeTempProject(`room-board-${'very-long-project-directory-name-'.repeat(3)}`);
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

  test('переключатель, колонки, цвет агента, панель пункта, решение, запоминание вида, лента под доской', async () => {
    test.setTimeout(240_000);
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const launch = async (): Promise<{ electronApp: ElectronApplication; window: Page }> => {
      const electronApp = await electron.launch({ args: [mainEntry], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await setWindow(electronApp, 800, 500);
      await expect(window.getByTestId('landing').or(window.getByTestId('app-shell'))).toBeVisible();
      return { electronApp, window };
    };
    let { electronApp, window } = await launch();
    await call(window, 'wake.pause', {});

    // ── 1. Карта: Verified-план из шести пунктов, три сессии подряд, длинные названия ─────────────────────────────
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-board', goal: '' });
    const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    const row = (by: string, status: PlanItem['status'], minutes: number): PlanItem['log'][number] => ({ at: minutesAgo(minutes), by, status, note: null });
    let roomId = '';
    let lead = '';
    let worker = '';
    let checker = '';
    // Ведущая сессия — настоящая (заглушка агента): её слово состояния ведут хуки в журнале событий, как в
    // `room-participants-layout.spec.ts`. Остальные лежат в карте без процесса.
    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(project, '.claude', 'agents', 'migration-reviewer.md'),
      `---\nname: ${LONG_ROLE}\ndescription: Reviews ledger migrations for locks and rollbacks.\n---\nReview the migration.\n`,
    );
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: `lead-${LONG_LABEL}`,
      task: '',
      parent: null,
      role: { source: 'claude', name: LONG_ROLE },
    });
    lead = created.ref.sessionId;
    await updateMap(project, workId, (map) => {
      worker = addSession(map, { provider: 'claude', label: `worker-${LONG_LABEL}`, task: '' }).id;
      checker = addSession(map, { provider: 'claude', label: `checker-${LONG_LABEL}`, task: '', role: { source: 'claude', name: LONG_ROLE } }).id;
      const room = addRoom(map, { title: `Delivery-${'D'.repeat(60)}`, creator: HUMAN, members: [lead, worker, checker], lead, mode: 'verified' });
      roomId = room.id;
      const item = (id: number, title: string, status: PlanItem['status'], patch: Partial<PlanItem> = {}): PlanItem => ({
        id,
        title,
        owner: worker,
        scope: `src/${id}/index.ts`,
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
        item(1, `Docs ${LONG_TITLE}`, 'waiting', { after: [3] }),
        item(2, 'Release', 'ready'),
        item(3, LONG_TITLE, 'in_progress', {
          log: [row(worker, 'in_progress', 30)],
          progress: { owner: { by: worker, at: minutesAgo(5), submission: null, done: 'Parser written', next: 'Cover the export stages', artifacts: [], blocker: null } },
        }),
        item(4, 'Api', 'done', { evidence, log: [row(worker, 'in_progress', 50), row(worker, 'done', 20)] }),
        item(5, 'Schema', 'returned', { note: 'Add the missing migration', log: [row(worker, 'in_progress', 70), row(worker, 'done', 60), row(checker, 'returned', 55)] }),
        item(6, 'Setup', 'verified', { evidence, log: [row(worker, 'in_progress', 90), row(worker, 'done', 80), row(checker, 'verified', 70)] }),
      ];
      map.work.planSeq = 1;
      map.plans = [
        {
          id: 'pl-01',
          roomId: room.id,
          mode: 'verified',
          status: 'active',
          rev: 1,
          goal: 'Ship the export',
          items,
          backlog: [],
          acceptedAt: minutesAgo(120),
          completedAt: null,
          cancelledAt: null,
          completionSummary: null,
        },
      ];
    });

    // ── 2. Карточка бэклога проекта, взятая этой комнатой ────────────────────────────────────────────────────────
    const added = await addBacklogItem(project, { title: 'Ship the export' });
    await takeBacklogItem(project, added.id, `${workId}/${roomId}`);

    // Длинное письмо в ленту, чтобы лента прокручивалась и в виде Feed есть что считать.
    for (let index = 0; index < 8; index += 1) {
      await call(window, 'rooms.send', { projectPath: project, workId, roomId, to: [], text: `Note ${index}: ${'the export keeps going '.repeat(12)}`, kind: 'note' });
    }

    const roomRow = window.locator(`[data-room-row="${roomId}"]`);
    await expect(roomRow).toHaveCount(1, { timeout: 20_000 });
    await roomRow.locator('> div').first().click();
    await expect(window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`)).toHaveAttribute('data-active', 'true');

    // ── 3. Переключатель виден; Board: четыре колонки с числами, пункты по таблице спеки 5.2 ────────────────────
    const switcher = window.getByRole('group', { name: 'Room view' }).or(window.locator('[aria-label="Room view"]')).first();
    await expect(switcher).toBeVisible({ timeout: 20_000 });
    await expect(window.locator('[data-room-board-layer]')).toHaveCount(0);
    await window.getByRole('radio', { name: 'Board' }).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();
    await expect(window.locator('[data-room-board-layer] [data-board-column]')).toHaveCount(4);
    const counts = async (): Promise<string[]> =>
      Promise.all(['waiting', 'progress', 'review', 'done'].map(async (id) => (await column(window, id).locator('[data-board-count]').textContent()) ?? ''));
    expect(await counts()).toEqual(['2', '2', '1', '1']);
    await expect(column(window, 'waiting').locator('[data-board-item]')).toHaveCount(2);
    await expect(column(window, 'waiting').locator('[data-board-item="1"]')).toHaveCount(1);
    await expect(column(window, 'waiting').locator('[data-board-item="2"]')).toHaveCount(1);
    await expect(column(window, 'progress').locator('[data-board-item="3"]')).toHaveCount(1);
    await expect(column(window, 'progress').locator('[data-board-item="5"]')).toHaveCount(1);
    await expect(column(window, 'review').locator('[data-board-item="4"]')).toHaveCount(1);
    await expect(column(window, 'done').locator('[data-board-item="6"]')).toHaveCount(1);
    await expect(card(window, 4)).toContainText('Submitted · waiting for');

    // ── 4. Окно 800×500: ничего не выходит за окно, колонки прокручиваются вбок, название обрезано ───────────────
    const layer = window.locator('[data-room-board-layer]');
    const geometry = await layer.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const scroller = node.querySelector<HTMLElement>('[data-board-column]')?.parentElement as HTMLElement;
      const title = node.querySelector<HTMLElement>('[data-board-item="3"] .line-clamp-2') as HTMLElement;
      return {
        layerRight: box.right,
        layerBottom: box.bottom,
        innerWidth: globalThis.innerWidth,
        innerHeight: globalThis.innerHeight,
        columnsScroll: scroller.scrollWidth - scroller.clientWidth,
        titleClamped: title.scrollHeight > title.clientHeight,
        pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geometry.layerRight).toBeLessThanOrEqual(geometry.innerWidth);
    expect(geometry.layerBottom).toBeLessThanOrEqual(geometry.innerHeight);
    expect(geometry.columnsScroll).toBeGreaterThan(0);
    expect(geometry.titleClamped).toBe(true);
    expect(geometry.pageScroll).toBeLessThanOrEqual(0);

    // Низкая панель (< 560 px): в виде Board нет строки режима и ленты участников (их нет в дереве, а не спрятаны стилем),
    // первая карточка каждой непустой колонки видна целиком и под ней нет чужого элемента, лента событий — одна строка.
    await expect(window.getByRole('combobox', { name: 'Room mode' })).toHaveCount(0);
    await expect(window.locator('[data-participant]')).toHaveCount(0);
    for (const id of ['waiting', 'progress', 'review', 'done']) {
      const first = column(window, id).locator('[data-board-item]').first();
      // Колонки прокручиваются вбок: дальняя сначала приезжает в окно.
      await first.scrollIntoViewIfNeeded();
      const visible = await first.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const scope = node.closest<HTMLElement>('[data-room-board-layer]')!.getBoundingClientRect();
        const at = document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(box.height / 2, 12));
        return { inside: box.top >= scope.top - 1 && box.bottom <= scope.bottom + 1 && box.left >= scope.left - 1, hit: at !== null && node.contains(at) };
      });
      expect(visible, id).toEqual({ inside: true, hit: true });
    }
    const eventRows = await window.locator('[data-board-events] li').evaluateAll((nodes) =>
      nodes.filter((node) => node.getBoundingClientRect().height > 0).map((node) => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight) || 16 })),
    );
    expect(eventRows.length).toBeLessThanOrEqual(1);
    for (const eventRow of eventRows) expect(eventRow.height).toBeLessThanOrEqual(eventRow.line * 1.6);

    // ── 5. Цвет агента: три сессии подряд — три разных цвета; у одной сессии цвет один в сайдбаре и на карточке ───
    if ((await roomRow.getAttribute('aria-expanded')) !== 'true') await roomRow.getByRole('button', { name: 'Show agents' }).click();
    await expect(roomRow.locator('[data-session-id]')).toHaveCount(3);
    const sidebarColour = async (id: string): Promise<string | null> => colourOf(roomRow.locator(`[data-session-id="${id}"]`));
    const colours = [await sidebarColour(lead), await sidebarColour(worker), await sidebarColour(checker)];
    expect(colours.every((value) => value !== null)).toBe(true);
    expect(new Set(colours).size).toBe(3);
    expect(await colourOf(card(window, 3))).toBe(await sidebarColour(worker));
    expect(await colourOf(card(window, 4).locator('[data-board-stripe]').locator('xpath=..'))).toBe(await sidebarColour(worker));

    await mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(electronApp, window, theme);
      await window.waitForTimeout(300);
      await snap(window, path.join(shots, `board-800x500-${theme}.png`));
    }
    await setTheme(electronApp, window, 'light');

    // ── 6. Состояние пункта меняется в карте: карточка в другой колонке без перезагрузки ─────────────────────────
    await updateMap(project, workId, (map) => {
      map.plans![0]!.items.find((item) => item.id === 2)!.status = 'in_progress';
    });
    await expect(column(window, 'progress').locator('[data-board-item="2"]')).toHaveCount(1, { timeout: 20_000 });
    expect(await counts()).toEqual(['1', '3', '1', '1']);

    // ── 7. Панель пункта: нажатие, Esc, Enter, нажатие мимо ────────────────────────────────────────────────────
    const sheet = window.locator('[data-room-item-sheet]');
    await card(window, 3).click();
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Plan item 3');
    await expectSheetSettled(window);
    await snap(window, path.join(shots, 'item-sheet-800x500-light.png'));
    await window.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(card(window, 3)).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(sheet).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await card(window, 3).click();
    await expect(sheet).toBeVisible();
    // Мимо панели: левый край окна, где доска (панель прижата вправо).
    await window.mouse.click(4, 250);
    await expect(sheet).toHaveCount(0);
    await expect(card(window, 3)).toBeFocused();
    await setTheme(electronApp, window, 'dark');
    await card(window, 3).click();
    await expect(sheet).toBeVisible();
    await window.waitForTimeout(300);
    await expectSheetSettled(window);
    await snap(window, path.join(shots, 'item-sheet-800x500-dark.png'));
    await window.keyboard.press('Escape');
    await setTheme(electronApp, window, 'light');

    // ── 8. Решение человека: уведомление над колонками; Open feed показывает ленту; Board снова ───────────────
    await updateMap(project, workId, (map) => {
      // В комнате с режимом решение — поправка плана (`decision must match room mode`): как в `room-assignments.spec.ts`.
      const plan = map.plans![0]!;
      const items = plan.items.map((source) => ({
        id: source.id,
        title: source.title,
        owner: source.owner,
        scope: source.scope,
        after: source.after,
        criteria: source.criteria,
        verifier: source.verifier,
      }));
      items.push({ id: 7, title: 'Announce', owner: worker, scope: 'docs/announce.md', after: [3], criteria: ['Published'], verifier: checker });
      setProposal(map, roomId, lead, 'Add the announcement to the plan?', new Date().toISOString(), {
        plan: { id: plan.id, rev: plan.rev, mode: 'verified', goal: plan.goal, items },
      });
    });
    const notice = window.locator('[data-board-notice]');
    await expect(notice).toContainText('A decision is waiting for you in the feed', { timeout: 20_000 });
    await notice.getByRole('button', { name: 'Open feed' }).click();
    await expect(window.locator('[data-room-board-layer]')).toHaveCount(0);
    await expect(feed(window)).toBeVisible();
    await window.getByRole('radio', { name: 'Board' }).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();
    await updateMap(project, workId, (map) => {
      map.rooms.find((candidate) => candidate.id === roomId)!.proposal = null;
    });
    await expect(notice).toHaveCount(0, { timeout: 20_000 });

    // ── 9. Выход через quitApp и новый запуск: комната открыта в виде Board ───────────────────────────────────
    await window.waitForTimeout(1500);
    await quitApp(electronApp);
    ({ electronApp, window } = await launch());
    // Наблюдение, не проверка: пока комната открывается сразу в виде Board, полная шапка может мелькнуть до сжатия
    // (высоту панели даёт ResizeObserver). Считаем изменения дерева, в которых слой доски уже есть, а лента участников ещё стоит.
    await window.evaluate(() => {
      const state = { frames: 0, seen: false };
      (globalThis as unknown as { __flash: typeof state }).__flash = state;
      new MutationObserver(() => {
        if (document.querySelector('[data-room-board-layer]') !== null) state.seen = true;
        if (document.querySelector('[data-room-board-layer]') !== null && document.querySelector('[data-participant]') !== null) state.frames += 1;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await call(window, 'wake.pause', {});
    await expect(window.locator('[data-room-board-layer]')).toBeVisible({ timeout: 30_000 });
    const flash = await window.evaluate(() => (globalThis as unknown as { __flash: { frames: number; seen: boolean } }).__flash);
    test.info().annotations.push({ type: 'board-first-frame', description: `layer seen: ${flash.seen}; mutations with full header under the board: ${flash.frames}` });
    console.log(`[room-board] first frame: layer seen ${flash.seen}, mutations with participant strip under the board ${flash.frames}`);
    await expect(window.getByRole('radio', { name: 'Board' })).toHaveAttribute('data-state', 'on');

    // ── 10. Доска проекта: карточка комнаты показывает ход плана ──────────────────────────────────────────────
    await window.getByRole('button', { name: /^Board/ }).first().click();
    const planLine = window.locator('[data-board-plan]');
    await expect(planLine).toBeVisible({ timeout: 20_000 });
    await expect(planLine).toContainText('verified');
    await setTheme(electronApp, window, 'light');
    await snap(window, path.join(shots, 'project-board-800x500-light.png'));
    await setTheme(electronApp, window, 'dark');
    await window.waitForTimeout(300);
    await snap(window, path.join(shots, 'project-board-800x500-dark.png'));
    await setTheme(electronApp, window, 'light');
    await window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();

    // ── 11. Лента под доской ──────────────────────────────────────────────────────────────────────────────────
    await window.getByRole('radio', { name: 'Feed' }).click();
    await expect(window.locator('[data-room-board-layer]')).toHaveCount(0);
    // а) лента прокручена вверх: Board и обратно — то же место.
    await feed(window).evaluate((node) => {
      node.scrollTop = 120;
    });
    await window.waitForTimeout(200);
    const before = await feed(window).evaluate((node) => node.scrollTop);
    expect(before).toBeGreaterThan(0);
    await window.getByRole('radio', { name: 'Board' }).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();
    await window.getByRole('radio', { name: 'Feed' }).click();
    await expect(window.locator('[data-room-board-layer]')).toHaveCount(0);
    expect(await feed(window).evaluate((node) => node.scrollTop)).toBe(before);
    // б) лента у низа: Board, новое письмо, Feed — лента у низа, письмо видно.
    await feed(window).evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await window.waitForTimeout(200);
    await window.getByRole('radio', { name: 'Board' }).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();
    await call(window, 'rooms.send', { projectPath: project, workId, roomId, to: [], text: 'Fresh letter while the board is open', kind: 'note' });
    await window.waitForTimeout(800);
    await window.getByRole('radio', { name: 'Feed' }).click();
    await expect(window.locator('[data-room-board-layer]')).toHaveCount(0);
    const fresh = feed(window).getByText('Fresh letter while the board is open');
    await expect(fresh).toBeVisible();
    const gap = await feed(window).evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
    expect(gap).toBeLessThanOrEqual(48);
    // в) в виде Board Tab не доходит до элементов ленты и поля ввода.
    await window.getByRole('radio', { name: 'Board' }).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();
    await card(window, 1).focus();
    for (let step = 0; step < 40; step += 1) {
      await window.keyboard.press('Tab');
      const inFeed = await window.evaluate(() => {
        const active = document.activeElement;
        return active !== null && active.closest('[data-room-feed-area]') !== null;
      });
      expect(inFeed).toBe(false);
    }
    await window.getByRole('radio', { name: 'Feed' }).click();

    // ── 12. Карточка участника в окне 800×500: одна карточка сразу с двумя метками пунктов и «+N», длинным именем, длинной
    // ролью, звездой ведущего и длинным словом состояния; имя не уже 5ch, вторая строка не выходит за карточку ─────────
    await updateMap(project, workId, (map) => {
      const plan = map.plans![0]!;
      for (const id of [1, 2, 3, 5]) plan.items.find((item) => item.id === id)!.owner = lead;
    });
    // Ход начат и закончен, вкладку сессии никто не открывал: слово состояния `done · unseen`, самое длинное из обычных.
    const eventsDir = path.join(project, '.parley', 'works', workId, 'events');
    await mkdir(eventsDir, { recursive: true });
    await appendFile(path.join(eventsDir, `${lead}.jsonl`), `${JSON.stringify({ hook_event_name: 'UserPromptSubmit' })}\n${JSON.stringify({ hook_event_name: 'Stop' })}\n`);
    const participant = window.locator(`[data-participant="${lead}"]`);
    await participant.scrollIntoViewIfNeeded();
    // Предпосылки измерения — до геометрии: имя длинное (обрезано), роль длинная, звезда ведущего, длинное слово состояния,
    // две метки пунктов и «+N».
    await expect(participant).toContainText('done · unseen', { timeout: 20_000 });
    await expect(participant.locator('[data-role-chip]')).toContainText(LONG_ROLE.slice(0, 8));
    await expect(participant.locator('[title="Lead"]')).toHaveCount(1);
    const tags = participant.locator('[data-participant-items]');
    await expect(tags).toHaveText(/^#\d+ #\d+ \+\d+$/, { timeout: 20_000 });
    const named = await participant.evaluate((element) => {
      const name = element.querySelector<HTMLElement>('.font-semibold') as HTMLElement;
      return { text: name.textContent ?? '', truncated: name.scrollWidth > name.clientWidth };
    });
    expect(named.text.length).toBeGreaterThan(8);
    const fit = await participant.evaluate((element) => {
      const header = element.querySelector<HTMLElement>('button > span') as HTMLElement;
      const name = header.querySelector<HTMLElement>('.font-semibold') as HTMLElement;
      const second = element.querySelector<HTMLElement>('[data-participant-items]')?.parentElement as HTMLElement;
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;width:5ch';
      probe.className = getComputedStyle(name).fontWeight === '600' ? 'font-semibold' : '';
      name.appendChild(probe);
      const fiveCh = probe.getBoundingClientRect().width;
      probe.remove();
      const cardRight = element.getBoundingClientRect().right;
      return {
        nameWidth: name.getBoundingClientRect().width,
        fiveCh,
        secondRight: Math.max(...Array.from(second.children).map((child) => child.getBoundingClientRect().right)),
        cardRight,
        headerRight: Math.max(...Array.from(header.children).map((child) => child.getBoundingClientRect().right)),
      };
    });
    expect(fit.nameWidth).toBeGreaterThanOrEqual(fit.fiveCh - 1);
    expect(fit.secondRight).toBeLessThanOrEqual(fit.cardRight + 1);
    expect(fit.headerRight).toBeLessThanOrEqual(fit.cardRight + 1);
    await snap(window, path.join(shots, 'room-header-800x500-light.png'));
    await setTheme(electronApp, window, 'dark');
    await window.waitForTimeout(300);
    await snap(window, path.join(shots, 'room-header-800x500-dark.png'));
    await setTheme(electronApp, window, 'light');

    // В высокой панели (1280×800) лента участников видна и в виде Board.
    await setWindow(electronApp, 1280, 800);
    await expect.poll(() => window.evaluate(() => globalThis.innerHeight)).toBe(800);
    await window.getByRole('radio', { name: 'Board' }).click();
    await expect(window.locator('[data-room-board-layer]')).toBeVisible();
    await expect(window.locator('[data-participant]')).toHaveCount(3);
    await expect(window.getByRole('combobox', { name: 'Room mode' })).toBeVisible();
    await snap(window, path.join(shots, 'board-1280x800-light.png'));
    const sidebarRoom = window.locator(`[data-room-row="${roomId}"]`);
    await sidebarRoom.screenshot({ path: path.join(shots, 'sidebar-rings-light.png') });
    await setTheme(electronApp, window, 'dark');
    await window.waitForTimeout(300);
    await snap(window, path.join(shots, 'board-1280x800-dark.png'));
    await sidebarRoom.screenshot({ path: path.join(shots, 'sidebar-rings-dark.png') });
    await setTheme(electronApp, window, 'light');
  });
});
