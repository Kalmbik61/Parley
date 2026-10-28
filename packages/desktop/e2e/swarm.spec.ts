import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import type { WindowWorkMap, WorkSwarm } from '@parley/core';
import { quitApp, stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { readStoredMapE2E, replaceStoredMapE2E, withoutLettersE2E } from './stored-map.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Рой работы (спека роя v1, раздел 9, живая проверка): настоящий хост, настоящее окно и остров, настоящий `parley-mcp`;
 * агент — стаб `stub-echo-agent.mjs` (строка `STUB_MCP <инструмент> <json>` в терминал вызывает инструмент так, как это
 * делает Claude Code), настоящих claude и codex нет. Каркас — `browser-agent-control.spec.ts`, остров — `island.spec.ts`.
 *
 * 1) рой, записанный в карту (как «чужая запись»): четыре места показа — строка в сайдбаре под сессией, под комнатой и
 *    на верхнем уровне, чип шапки королевы и трутня, значки карточки и свёрнутой группы, ряд острова и счётчик капсулы;
 * 2) живой рой от `create_swarm` до итога создателю: королева, `swarm_add`, сдача трутня закрывает его сессию, счётчик и
 *    точки, collecting и письмо королеве, done и письмо создателю, «Mark as seen»;
 * 3) лимиты: обычный new-sessions (при заполненном рой создаётся, `spawned` не растёт), swarm-concurrent, общие
 *    workConcurrent и workLaunches — отказ агенту без записи в карту;
 * 4) отмена человеком из меню строки: живые участники закрыты, королева жива;
 * 5) срок жизни `PARLEY_SWARM_MINUTES=1`: failed по таймеру хоста, письмо королеве, итог с частичной сводкой;
 * 6) перезапуск хоста: недоставленный итог уходит создателю один раз, сдавший трутень дозакрыт.
 *
 * Скриншоты — в каталог `SWARM_SHOTS`, если он задан (в коммит они не идут).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shotsDir = process.env['SWARM_SHOTS'];

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => void } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body), { method, params })) as T;
}

interface McpResult {
  session: string;
  tool: string;
  isError: boolean;
  text: string;
}

const readLines = async <T>(file: string): Promise<T[]> =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);

function islandPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().endsWith('/island.html'));
}

async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  const found = (): Page | undefined => app.windows().find((page) => page.url() !== '' && page.url() !== 'about:blank' && !page.url().endsWith('/island.html'));
  await expect.poll(() => found() !== undefined, { message: 'главное окно загрузилось', timeout: 30_000 }).toBe(true);
  return found()!;
}

test.describe('рой работы (спека роя v1, раздел 9)', () => {
  test.setTimeout(240_000);
  let home: string;
  let project: string;
  let mcpLog: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('swarm');
    project = await makeTempProject('swarm');
    mcpLog = path.join(home, 'mcp.jsonl');
    if (shotsDir !== undefined) await mkdir(shotsDir, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function openApp(extraEnv: Record<string, string> = {}, existingHome = false) {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: path.join(home, 'no-codex'),
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_MCP_LOG: mcpLog,
      // Остров с подменным вырезом: капсула с правым статусом (island.spec.ts, N4a).
      PARLEY_ISLAND: '',
      PARLEY_NOTCH: '185x32',
      ...extraEnv,
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    electronApp.on('window', (page) => page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {})));
    const window = await mainWindowOf(electronApp);
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((candidate) => !candidate.webContents.getURL().endsWith('/island.html'))?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }),
    );
    // Дом с работой открывается сразу в оболочке, пустой — на заставке.
    await expect(window.getByTestId(existingHome ? 'app-shell' : 'landing')).toBeVisible();
    // Будильник печатал бы в терминал стаба указатели на письма и портил бы строки вызовов.
    await call(window, 'wake.pause', {});
    if (existingHome) {
      const { entries } = await call<{ entries: Array<{ projectPath: string; map: { work: { id: string } } }> }>(window, 'works.list', {});
      const workId = entries.find((entry) => entry.projectPath === project)!.map.work.id;
      return { electronApp, window, workId, workKey: `${project} ${workId}` };
    }
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-swarm', goal: '' });
    return { electronApp, window, workId, workKey: `${project} ${workId}` };
  }
  type Opened = Awaited<ReturnType<typeof openApp>>;

  const sessionCreate = async ({ window, workId }: Opened, label: string): Promise<string> =>
    (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null })).ref.sessionId;

  const shot = async (window: Page, name: string): Promise<void> => {
    if (shotsDir !== undefined) await window.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  };

  /** Журнал событий сессии — то, что дописал бы хук Claude Code (`attention.spec.ts`): делает сессию «работающей». */
  async function hookEvent({ workId }: Opened, sessionId: string, event: Record<string, string>): Promise<void> {
    const dir = path.join(project, '.parley', 'works', workId, 'events');
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
  }

  /** Инструмент агента `session`: строка `STUB_MCP` в его терминал, результат — из журнала стаба. */
  async function agentTool({ window, workId }: Opened, session: string, tool: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId: session }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 40_000, message: `${tool} от ${session}` }).toBeGreaterThan(before);
    const entry = (await readLines<McpResult>(mcpLog))[before] as McpResult;
    expect(entry.session).toBe(session);
    expect(entry.tool).toBe(tool);
    return entry;
  }

  /** Сессия запущена: строка вне «not started». Терминал стаба принимает ввод только у запущенной. */
  async function startSession({ window, workKey }: Opened, sessionId: string): Promise<void> {
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${sessionId}"]`);
    await row.click();
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    await window.waitForTimeout(500);
  }

  /** Процесс сессии поднят: её терминал принимает `STUB_MCP`. */
  async function waitRunning(opened: Opened, sessionId: string): Promise<void> {
    await expect
      .poll(() => mapOf(opened).sessions.find((session) => session.id === sessionId)?.pid ?? null, { message: `процесс ${sessionId} запущен`, timeout: 30_000 })
      .not.toBeNull();
    await opened.window.waitForTimeout(700);
  }

  /** Письма карты, адресованные `to`, с текстом, где есть `part`. */
  const lettersTo = (opened: Opened, to: string, part: string) =>
    mapOf(opened).messages.filter((message) => message.to.includes(to) && message.text.includes(part));

  /** Создатель, `create_swarm`, королева запущена: общий разгон сценариев 3–6. */
  async function startSwarm(opened: Opened, tag = 'Research') {
    const creator = await sessionCreate(opened, 'creator');
    await startSession(opened, creator);
    const created = await agentTool(opened, creator, 'create_swarm', { tag, objective: 'Compare how crawlers retry', provider: 'claude' });
    expect(created.isError, created.text).toBe(false);
    const { swarmId, queenSessionId: queen } = JSON.parse(created.text) as { swarmId: string; queenSessionId: string };
    await expect(swarmRow(opened, swarmId)).toBeVisible({ timeout: 20_000 });
    await waitRunning(opened, queen);
    return { creator, swarmId, queen };
  }

  /** `swarm_add` королевы; возвращает результат инструмента, отказ тоже. */
  const addMember = (opened: Opened, queen: string, role: 'drone' | 'verifier', task: string): Promise<McpResult> =>
    agentTool(opened, queen, 'swarm_add', { role, task, provider: 'claude' });

  /** Что отказ не должен менять: сессии, участники роя и счётчики ресурсов. */
  const footprint = (opened: Opened): string => {
    const map = mapOf(opened);
    return JSON.stringify({
      sessions: map.sessions.map((session) => session.id),
      swarms: (map.swarms ?? []).map((swarm) => swarm.members.map((member) => member.sessionId)),
      spawned: map.resources?.spawned ?? 0,
      swarmSpawned: map.resources?.swarmSpawned ?? 0,
      swarmsCreated: map.resources?.swarmsCreated ?? 0,
    });
  };

  const swarmsOf = (opened: Opened): WorkSwarm[] => readStoredMapE2E(home, project, opened.workId).swarms ?? [];
  const mapOf = (opened: Opened): WindowWorkMap => readStoredMapE2E(home, project, opened.workId);
  const swarmRow = ({ window, workKey }: Opened, swarmId: string): Locator => window.locator(`[data-work-key="${workKey}"] [data-swarm-row="${swarmId}"]`);

  test('1) рой, записанный в карту: четыре места показа', async () => {
    const opened = await openApp();
    const { window, workId, workKey } = opened;
    const creator = await sessionCreate(opened, 'creator');
    const other = await sessionCreate(opened, 'other');
    const queenA = await sessionCreate(opened, 'queen-a');
    const droneA1 = await sessionCreate(opened, 'drone-a1');
    const droneA2 = await sessionCreate(opened, 'drone-a2');
    const queenB = await sessionCreate(opened, 'queen-b');
    const droneB1 = await sessionCreate(opened, 'drone-b1');
    const queenC = await sessionCreate(opened, 'queen-c');
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title: 'Review', members: [other], lead: other, quiet: true });
    await expect(window.locator(`[data-work-key="${workKey}"] [data-room-row="${roomId}"]`).first()).toBeVisible();

    const member = (sessionId: string, role: 'queen' | 'drone' | 'verifier', n: number, handed: boolean) => ({
      sessionId,
      role,
      n,
      addedAt: '2026-10-28T12:00:00.000Z',
      handedAt: handed ? '2026-10-28T12:01:00.000Z' : null,
    });
    const base = { objective: 'Study', createdAt: new Date(Date.now() - 4 * 60_000).toISOString(), endedAt: null, result: null, failure: null, seenAt: null, expiredAt: null, status: 'running' as const };
    const swarms: WorkSwarm[] = [
      { ...base, id: 'sw-01', tag: 'Research', creator: { kind: 'session', sessionId: creator }, queen: queenA, members: [member(queenA, 'queen', 1, false), member(droneA1, 'drone', 1, true), member(droneA2, 'drone', 2, false)] },
      { ...base, id: 'sw-02', tag: 'Audit', creator: { kind: 'room', roomId }, queen: queenB, members: [member(queenB, 'queen', 1, false), member(droneB1, 'drone', 1, false)] },
      { ...base, id: 'sw-03', tag: 'Prices', creator: { kind: 'human' }, queen: queenC, members: [member(queenC, 'queen', 1, false)] },
    ];
    const current = mapOf(opened);
    replaceStoredMapE2E(home, project, workId, { ...withoutLettersE2E(current), swarms, swarmSeq: 3 });

    const card = window.locator(`[data-work-key="${workKey}"]`);
    // Сессии роя обычными строками не стоят: видны только creator и other.
    await expect(swarmRow(opened, 'sw-01')).toBeVisible({ timeout: 20_000 });
    await expect(swarmRow(opened, 'sw-02')).toBeVisible();
    await expect(swarmRow(opened, 'sw-03')).toBeVisible();
    for (const hidden of [queenA, droneA1, droneA2, queenB, droneB1, queenC]) await expect(card.locator(`[data-session-id="${hidden}"]`)).toHaveCount(0);
    await expect(card.locator(`[data-session-id="${creator}"]`)).toBeVisible();

    // 1. Сайдбар: свёрнута, счётчик, точки, таймер; порядок — под создателем, под комнатой, наверху.
    await expect(swarmRow(opened, 'sw-01').locator('[data-swarm-counter]')).toHaveText('1/2');
    await expect(swarmRow(opened, 'sw-01')).toHaveAttribute('aria-expanded', 'false');
    await expect(swarmRow(opened, 'sw-03').locator('[data-swarm-counter]')).toHaveText('…');
    const order = await card.locator('[data-session-id], [data-room-row], [data-swarm-row]').evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset['swarmRow'] ?? (node as HTMLElement).dataset['roomRow'] ?? (node as HTMLElement).dataset['sessionId'] ?? ''),
    );
    expect(order.indexOf('sw-01')).toBe(order.indexOf(creator) + 1);
    expect(order.indexOf('sw-02')).toBe(order.indexOf(roomId) + 1);
    expect(order.at(-1)).toBe('sw-03');
    await expect(swarmRow(opened, 'sw-01').locator('[data-swarm-timer]')).toHaveText(/^[34]:\d\d$/);

    // 3. Значок карточки (три идущих роя) виден и при свёрнутых строках.
    const badge = card.locator('[data-swarm-badge]').first();
    await expect(badge.locator('[data-swarm-count]')).toHaveText('3');

    // Раскрытие: королева, трутни; клик по трутню открывает его чат, в шапке — «in swarm Research» (место 2).
    await swarmRow(opened, 'sw-01').click();
    await expect(swarmRow(opened, 'sw-01').locator('[data-swarm-member]')).toHaveCount(3);
    await swarmRow(opened, 'sw-01').locator(`[data-swarm-member="${droneA2}"]`).click();
    const droneTab = window.locator(`[role="tab"][data-tab-id="terminal:${droneA2}"]`);
    await expect(droneTab).toHaveAttribute('data-active', 'true', { timeout: 20_000 });
    await expect(window.getByTestId('chat-swarm-chip')).toHaveText(/in swarm Research/);
    // Чип трутня ведёт к королеве.
    await window.getByTestId('chat-swarm-chip').click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${queenA}"]`)).toHaveAttribute('data-active', 'true', { timeout: 20_000 });
    // У королевы — `Research · 1/2`.
    await expect(window.getByTestId('chat-swarm-chip')).toHaveText(/Research · 1\/2/);
    await shot(window, '1-sidebar-chip-badge');

    // 4. Остров: капсула со счётчиком роёв, по клику — список с рядами роёв; сессии роя рядами не стоят.
    await expect.poll(() => islandPage(app!) !== undefined, { message: 'остров создан' }).toBe(true);
    const island = islandPage(app!)!;
    const shape = island.getByTestId('island');
    await expect(shape.getByTestId('island-capsule-swarm')).toBeVisible({ timeout: 20_000 });
    await expect(shape.getByTestId('island-capsule-swarm')).toContainText('1/3');
    await shot(window, '1-island-capsule');
    await shape.getByTestId('island-capsule').click();
    await expect(shape.getByTestId('island-work-swarm')).toHaveCount(3);
    await expect(shape.getByTestId('island-session')).toHaveCount(0);
    await window.waitForTimeout(800);
    if (shotsDir !== undefined) await island.screenshot({ path: path.join(shotsDir, '1-island-list.png') });
    // Клик по ряду роя ведёт к королеве.
    await shape.getByTestId('island-work-swarm').first().click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${queenA}"]`)).toHaveAttribute('data-active', 'true');

    // Свёрнутая группа проекта: значок суммы, статичный.
    await window.locator('[data-section-key]').filter({ hasText: path.basename(project) }).first().click();
    await expect(window.locator(`[role="treeitem"][data-work-key="${workKey}"]`)).toHaveCount(0);
    await expect(window.locator('[data-section-key] [data-swarm-badge] [data-swarm-count]').first()).toHaveText('3');
    await expect(window.locator('[data-section-key] [data-swarm-badge] [data-swarm-icon]').first()).not.toHaveAttribute('data-live', '');
    await shot(window, '1-group-collapsed');
  });

  test('2) живой рой: create_swarm, swarm_add, сдача, collecting, итог создателю, Mark as seen', async () => {
    const opened = await openApp();
    const { window, workKey } = opened;
    const card = window.locator(`[data-work-key="${workKey}"]`);
    const creator = await sessionCreate(opened, 'creator');
    await startSession(opened, creator);

    // create_swarm от сессии-создателя: королева заводится хостом, строка роя встаёт под создателем.
    const created = await agentTool(opened, creator, 'create_swarm', { tag: 'Research', objective: 'Compare how crawlers retry', provider: 'claude' });
    expect(created.isError, created.text).toBe(false);
    const { swarmId, queenSessionId: queen } = JSON.parse(created.text) as { swarmId: string; queenSessionId: string };
    const row = swarmRow(opened, swarmId);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('[data-swarm-counter]')).toHaveText('…');
    await expect(card.locator(`[data-session-id="${queen}"]`)).toHaveCount(0);
    await waitRunning(opened, queen);

    // swarm_add королевы: два трутня; сессии роя обычными строками не стоят.
    const drones: string[] = [];
    for (const slice of ['slice one', 'slice two']) {
      const added = await agentTool(opened, queen, 'swarm_add', { role: 'drone', task: slice, provider: 'claude' });
      expect(added.isError, added.text).toBe(false);
      drones.push((JSON.parse(added.text) as { sessionId: string }).sessionId);
    }
    await expect(row.locator('[data-swarm-counter]')).toHaveText('0/2');
    for (const id of drones) await expect(card.locator(`[data-session-id="${id}"]`)).toHaveCount(0);
    for (const id of [queen, ...drones]) await waitRunning(opened, id);
    // Работающие сессии роя — события хука: остров их рядами и «working» не считает, только ряд роя.
    for (const id of [queen, ...drones]) await hookEvent(opened, id, { hook_event_name: 'UserPromptSubmit' });
    await row.click();
    await expect(row.locator(`[data-swarm-member="${drones[0]}"]`)).toHaveAttribute('data-member-state', 'working', { timeout: 20_000 });
    await expect(row.locator(`[data-swarm-member="${queen}"]`)).toContainText('waiting for hand-ins');
    await shot(window, '2-running');

    const island = islandPage(app!)!;
    const shape = island.getByTestId('island');
    await expect(shape.getByTestId('island-capsule-swarm')).toContainText('0/2', { timeout: 20_000 });
    await shape.getByTestId('island-capsule').click();
    await expect(shape.getByTestId('island-work-swarm')).toHaveCount(1);
    await expect(shape.getByTestId('island-session')).toHaveCount(0);
    await window.waitForTimeout(800);
    if (shotsDir !== undefined) await island.screenshot({ path: path.join(shotsDir, '2-island-running.png') });
    await shape.getByTestId('island-work-swarm').click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${queen}"]`)).toHaveAttribute('data-active', 'true', { timeout: 20_000 });

    // Чип трутня ведёт к королеве.
    await row.locator(`[data-swarm-member="${drones[1]}"]`).click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${drones[1]}"]`)).toHaveAttribute('data-active', 'true', { timeout: 20_000 });
    await window.getByTestId('chat-swarm-chip').click();
    await expect(window.locator(`[role="tab"][data-tab-id="terminal:${queen}"]`)).toHaveAttribute('data-active', 'true', { timeout: 20_000 });

    // Трутень сдаёт работу: хост записывает handedAt и закрывает его сессию; счётчик и точки меняются.
    const handed = await agentTool(opened, drones[0] as string, 'report', { status: 'done', summary: 'slice one: three findings' });
    expect(handed.isError, handed.text).toBe(false);
    await expect(row.locator('[data-swarm-counter]')).toHaveText('1/2', { timeout: 20_000 });
    await expect(row.locator(`[data-swarm-member="${drones[0]}"]`)).toHaveAttribute('data-member-state', 'handed');
    await expect(row.locator('[data-dot="handed"]')).toHaveCount(1);
    await expect.poll(() => mapOf(opened).sessions.find((session) => session.id === drones[0])?.lifecycle, { timeout: 20_000 }).toBe('closed');
    await expect(shape.getByTestId('island-capsule-swarm')).toContainText('1/2', { timeout: 20_000 }).catch(async () => {
      // Остров мог уйти в капсулу: счётчик читается в любом виде формы.
      await expect(shape).toContainText('1/2');
    });
    await shot(window, '2-drone-handed');

    // Второй трутень сдал — все сдали: collecting и письмо королеве «пиши сводку».
    await agentTool(opened, drones[1] as string, 'report', { status: 'done', summary: 'slice two: two findings' });
    await expect(row).toHaveAttribute('data-swarm-status', 'collecting', { timeout: 20_000 });
    await expect(row.locator(`[data-swarm-member="${queen}"]`)).toContainText('collecting');
    await expect.poll(() => lettersTo(opened, queen, swarmId).length, { message: 'письмо королеве о collecting', timeout: 20_000 }).toBeGreaterThan(0);
    expect(lettersTo(opened, queen, swarmId)[0]?.from).toBe('parley');
    await shot(window, '2-collecting');

    // Вторая волна: проверяющий возвращает рой в running, его сдача — снова в collecting.
    const verifier = await agentTool(opened, queen, 'swarm_add', { role: 'verifier', task: 'recheck the claims', provider: 'claude' });
    expect(verifier.isError, verifier.text).toBe(false);
    const verifierId = (JSON.parse(verifier.text) as { sessionId: string }).sessionId;
    await expect(row).toHaveAttribute('data-swarm-status', 'running', { timeout: 20_000 });
    await expect(row.locator('[data-swarm-counter]')).toHaveText('2/3');
    await waitRunning(opened, verifierId);
    await agentTool(opened, verifierId, 'report', { status: 'done', summary: 'claims verified' });
    await expect(row).toHaveAttribute('data-swarm-status', 'collecting', { timeout: 20_000 });
    await expect(row.locator('[data-swarm-counter]')).toHaveText('3/3');

    // Королева сдаёт итог: done, письмо создателю с итогом, ✓ в строке и значке карточки.
    await agentTool(opened, queen, 'report', { status: 'done', summary: 'Use jittered exponential backoff.' });
    await expect(row).toHaveAttribute('data-swarm-status', 'done', { timeout: 20_000 });
    await expect(row.locator('[data-swarm-end="done"]')).toBeVisible();
    await expect.poll(() => lettersTo(opened, creator, 'Use jittered exponential backoff.').length, { message: 'итог создателю', timeout: 30_000 }).toBeGreaterThan(0);
    await expect(card.locator('[data-swarm-badge="done"] [data-swarm-count]')).toHaveText('✓');
    await expect(row.locator('[data-swarm-outcome]')).toContainText('Use jittered exponential backoff.');
    await shot(window, '2-done');

    // «Mark as seen» убирает законченный рой с карточки и ставит seenAt.
    await row.locator('[data-swarm-outcome] [data-swarm-action="seen"]').click();
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    expect(swarmsOf(opened)[0]?.seenAt).not.toBeNull();
    await expect(card.locator('[data-swarm-badge]')).toHaveCount(0);
    await shot(window, '2-seen');
  });

  test('3a) лимит обычных new-sessions рой не тратит; swarm-concurrent отказывает без записи', async () => {
    const opened = await openApp({ PARLEY_WORK_NEW_SESSIONS: '1', PARLEY_SWARM_CONCURRENT: '3' });
    const creator = await sessionCreate(opened, 'creator');
    await startSession(opened, creator);
    // Обычная сессия агента заполняет лимит new-sessions (1 из 1); вторая отказывает.
    const first = await agentTool(opened, creator, 'create_session', { provider: 'claude', label: 'helper', task: 'help' });
    expect(first.isError, first.text).toBe(false);
    const second = await agentTool(opened, creator, 'create_session', { provider: 'claude', label: 'helper2', task: 'help' });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('new-session limit reached');
    expect(mapOf(opened).resources?.spawned).toBe(1);

    // Рой при заполненном лимите создаётся; `spawned` не растёт, растёт `swarmSpawned`.
    const created = await agentTool(opened, creator, 'create_swarm', { tag: 'Research', objective: 'Study crawlers', provider: 'claude' });
    expect(created.isError, created.text).toBe(false);
    const { swarmId, queenSessionId: queen } = JSON.parse(created.text) as { swarmId: string; queenSessionId: string };
    await waitRunning(opened, queen);
    for (const task of ['slice one', 'slice two']) {
      const added = await addMember(opened, queen, 'drone', task);
      expect(added.isError, added.text).toBe(false);
    }
    expect(mapOf(opened).resources).toMatchObject({ spawned: 1, swarmSpawned: 3, swarmsCreated: 1 });

    // Живых в рое три (королева и два трутня): четвёртый отказывает по swarm-concurrent, карта и счётчики не меняются.
    const before = footprint(opened);
    const denied = await addMember(opened, queen, 'drone', 'slice three');
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('swarm concurrency limit reached');
    expect(footprint(opened)).toBe(before);
    await expect(swarmRow(opened, swarmId).locator('[data-swarm-counter]')).toHaveText('0/2');
  });

  test('3b) общий лимит одновременных сессий работы действует и для роя: отказ без записи', async () => {
    const opened = await openApp({ PARLEY_WORK_CONCURRENT: '3' });
    const { swarmId, queen } = await startSwarm(opened);
    const ok = await addMember(opened, queen, 'drone', 'slice one');
    expect(ok.isError, ok.text).toBe(false);
    // Создатель, королева и трутень заняли три места из трёх.
    const before = footprint(opened);
    const denied = await addMember(opened, queen, 'drone', 'slice two');
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('session limit reached');
    expect(footprint(opened)).toBe(before);
    await expect(swarmRow(opened, swarmId).locator('[data-swarm-counter]')).toHaveText('0/1');
  });

  test('3c) лимит запусков в час (workLaunches) действует для роя: resource-budget без записи', async () => {
    const opened = await openApp({ PARLEY_WORK_LAUNCHES: '3' });
    const { swarmId, queen } = await startSwarm(opened);
    // В счёте запусков за час и запуск сессии создателя: создатель — первый, королева — второй, трутень — третий; четвёртый отказывает.
    const ok = await addMember(opened, queen, 'drone', 'slice one');
    expect(ok.isError, ok.text).toBe(false);
    const before = footprint(opened);
    const denied = await addMember(opened, queen, 'drone', 'slice two');
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/launch limit reached|resource-budget/);
    expect(footprint(opened)).toBe(before);
    await expect(swarmRow(opened, swarmId).locator('[data-swarm-counter]')).toHaveText('0/1');
  });

  test('4) отмена человеком из меню строки: живые участники закрыты, королева жива, рой cancelled', async () => {
    const opened = await openApp();
    const { window, workKey } = opened;
    const { swarmId, queen } = await startSwarm(opened);
    const drones: string[] = [];
    for (const task of ['slice one', 'slice two']) drones.push((JSON.parse((await addMember(opened, queen, 'drone', task)).text) as { sessionId: string }).sessionId);
    for (const id of drones) await waitRunning(opened, id);
    const row = swarmRow(opened, swarmId);
    await row.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Cancel swarm' }).click();
    await expect(window.getByText('Cancel swarm Research?')).toBeVisible();
    await shot(window, '4-cancel-confirm');
    // Первая по DOM «Cancel swarm» — кнопка подтверждения диалога.
    await window.getByRole('button', { name: 'Cancel swarm' }).first().click();
    await expect.poll(() => swarmsOf(opened)[0]?.status, { timeout: 20_000 }).toBe('cancelled');
    for (const id of drones) await expect.poll(() => mapOf(opened).sessions.find((session) => session.id === id)?.lifecycle, { timeout: 20_000 }).toBe('closed');
    // Королева остаётся обычной сессией: с ней можно продолжить разговор.
    expect(mapOf(opened).sessions.find((session) => session.id === queen)?.lifecycle).not.toBe('closed');
    // Отменённый рой с карточки уходит (виден только при «N more closed»), значка нет.
    await expect(row).toHaveCount(0, { timeout: 20_000 });
    await expect(window.locator(`[data-work-key="${workKey}"] [data-swarm-badge]`)).toHaveCount(0);
    await shot(window, '4-cancelled');
  });

  test('5) срок жизни: рой закрывается по swarmMinutes, королеве письмо, итог создателю с частичной сводкой', async () => {
    test.setTimeout(300_000);
    const opened = await openApp({ PARLEY_SWARM_MINUTES: '1' });
    const { window } = opened;
    const { creator, swarmId, queen } = await startSwarm(opened);
    const drone = (JSON.parse((await addMember(opened, queen, 'drone', 'slice one')).text) as { sessionId: string }).sessionId;
    await waitRunning(opened, drone);
    // Минута срока, таймер хоста раз в 30 с: ждём до двух минут.
    await expect.poll(() => swarmsOf(opened)[0]?.status, { message: 'рой просрочен', timeout: 150_000, intervals: [2_000] }).toBe('failed');
    const swarm = swarmsOf(opened)[0]!;
    expect(swarm.failure).toBe('time limit: 1 min');
    expect(swarm.expiredAt).not.toBeNull();
    expect(swarm.endedAt).toBe(swarm.expiredAt);
    await expect.poll(() => mapOf(opened).sessions.find((session) => session.id === drone)?.lifecycle, { timeout: 20_000 }).toBe('closed');
    expect(mapOf(opened).sessions.find((session) => session.id === queen)?.lifecycle).not.toBe('closed');
    await expect.poll(() => lettersTo(opened, queen, 'time limit').length, { message: 'письмо королеве «сдай что есть»', timeout: 20_000 }).toBeGreaterThan(0);
    expect(lettersTo(opened, queen, 'time limit')[0]?.text).toContain('Hand in what you have');
    // Итог создателю ждёт report королевы: пока не сдала, письма с итогом нет.
    expect(lettersTo(opened, creator, 'Partial result: covered one slice of two').length).toBe(0);
    const row = swarmRow(opened, swarmId);
    await expect(row).toHaveAttribute('data-swarm-status', 'failed');
    await expect(row.locator('[data-swarm-end="failed"]')).toBeVisible();
    await shot(window, '5-expired');
    // Королева сдаёт что есть: статус остаётся failed, создателю уходит итог с частичной сводкой.
    await agentTool(opened, queen, 'report', { status: 'done', summary: 'Partial result: covered one slice of two' });
    await expect.poll(() => lettersTo(opened, creator, 'Partial result: covered one slice of two').length, { message: 'итог создателю', timeout: 30_000 }).toBeGreaterThan(0);
    expect(swarmsOf(opened)[0]?.status).toBe('failed');
    await shot(window, '5-expired-result');
  });

  test('6) перезапуск хоста посреди роя: рой на месте, сверка дозакрывает сдавшего и отправляет недоставленный итог', async () => {
    test.setTimeout(240_000);
    const first = await openApp();
    const { creator, swarmId, queen } = await startSwarm(first);
    const drones: string[] = [];
    for (const task of ['slice one', 'slice two']) drones.push((JSON.parse((await addMember(first, queen, 'drone', task)).text) as { sessionId: string }).sessionId);
    for (const id of drones) await waitRunning(first, id);
    await agentTool(first, drones[0] as string, 'report', { status: 'done', summary: 'slice one: findings' });
    await expect.poll(() => swarmsOf(first)[0]?.members.find((member) => member.sessionId === drones[0])?.handedAt ?? null, { timeout: 20_000 }).not.toBeNull();
    // Окно и хост выключаются; дом остаётся.
    await quitApp(first.electronApp);
    app = null;
    await stopHost(home);
    // Пока хоста нет, рой «дошёл до конца» чужой записью: сдача второго трутня записана, закрытие не успело, итог не доставлен.
    const stored = readStoredMapE2E(home, project, first.workId);
    const at = new Date().toISOString();
    const swarms = (stored.swarms ?? []).map((swarm) => ({
      ...swarm,
      status: 'done' as const,
      endedAt: at,
      result: { summary: 'Result written before the restart', at, deliveredAt: null },
      members: swarm.members.map((member) => (member.sessionId === drones[1] ? { ...member, handedAt: at } : member)),
    }));
    replaceStoredMapE2E(home, project, first.workId, { ...withoutLettersE2E(stored), swarms });

    // Новый boot хоста: сверка отправляет итог создателю и закрывает сдавшего трутня.
    const second = await openApp({}, true);
    const row = swarmRow(second, swarmId);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-swarm-status', 'done');
    await expect(row.locator('[data-swarm-counter]')).toHaveText('2/2');
    await expect.poll(() => lettersTo(second, creator, 'Result written before the restart').length, { message: 'недоставленный итог отправлен после рестарта', timeout: 30_000 }).toBe(1);
    await expect.poll(() => swarmsOf(second)[0]?.result?.deliveredAt ?? null, { timeout: 30_000 }).not.toBeNull();
    await expect.poll(() => mapOf(second).sessions.find((session) => session.id === drones[1])?.lifecycle, { message: 'сдавший дозакрыт', timeout: 30_000 }).toBe('closed');
    // Повторная сверка итог не дублирует.
    await second.window.waitForTimeout(3_000);
    expect(lettersTo(second, creator, 'Result written before the restart').length).toBe(1);
    await shot(second.window, '6-after-restart');
  });
});
