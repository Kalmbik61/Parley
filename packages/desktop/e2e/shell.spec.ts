import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';
import { makeTempProject } from './tmp.js';

/**
 * Каркас окна (кусок 2.7 плана каркаса, спека 14.3, строка этапа 2): сплит с
 * выбором, перенос вкладки к краю группы, схлопывание сплита, перенос
 * терминала без пересоздания поверхности и смена работы в центре.
 *
 * Вкладки тащатся настоящей мышью Playwright (move → down → сдвиг больше
 * порога 4 px → move → up): `PointerSensor` @dnd-kit слушает pointer-события,
 * синтетический `dispatchEvent` его порог не проходит.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const term = (sessionId: string): string => `terminal:${sessionId}`;
const tabSel = (tabId: string): string => `[role="tab"][data-tab-id="${tabId}"]`;
const surfaceSel = (tabId: string): string => `[data-tab-id="${tabId}"][data-mount-id]`;
// `data-session-id` уникален только внутри работы (хост нумерует s-01… в каждой),
// поэтому строка сессии ищется внутри карточки своей работы (`sidebar/WorkCard.tsx`).
const rowSel = (workKey: string, sessionId: string): string => `[data-work-key="${workKey}"] [data-session-id="${sessionId}"]`;
const containerSel = (workKey: string): string => `[data-work-container="${workKey}"]`;

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Акселераторы живут в нативном меню, `keyboard.press` до него не доходит — действие шлётся тем же IPC, что и из меню. */
async function sendMenu(app: ElectronApplication, action: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, a) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', a);
  }, action);
}

async function createWork(window: Page, title: string): Promise<{ workId: string; key: string }> {
  const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title, goal: '' });
  return { workId, key: `${project} ${workId}` };
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

async function rectOf(window: Page, selector: string): Promise<Rect> {
  const rect = await window.evaluate((s) => {
    const el = document.querySelector(s);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
  if (rect === null) throw new Error(`нет элемента ${selector}`);
  return rect;
}

const center = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Настоящее перетаскивание мышью: сдвиг на 8 px переходит порог 4 px `PointerSensor`. */
async function dragTo(window: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(from.x + (to.x >= from.x ? 8 : -8), from.y, { steps: 3 });
  await window.mouse.move(to.x, to.y, { steps: 12 });
  // Зона броска пересчитывается на `dragMove` — дать ей кадр под указателем.
  await window.waitForTimeout(150);
  await window.mouse.up();
  // После броска @dnd-kit ещё 50 мс глушит `click` на документе (так он не даёт
  // отпусканию кнопки сработать кликом); человек так быстро не кликает, а
  // Playwright — успевает, и следующий клик тест потерял бы.
  await window.waitForTimeout(300);
}

async function dragTab(window: Page, tabId: string, to: { x: number; y: number }): Promise<void> {
  await dragTo(window, center(await rectOf(window, tabSel(tabId))), to);
}

const groupCount = (window: Page, scope = ''): Promise<number> =>
  window.evaluate((s) => document.querySelectorAll(`${s} [data-group-id]`.trim()).length, scope);

/**
 * Группа вкладки. Пока группа в работе одна, её строка вкладок стоит в
 * заголовке окна (`#titlebar-tabs`, спека 5.3), а не внутри группы, — тогда это
 * единственная группа видимой работы.
 */
const groupIdOfTab = (window: Page, tabId: string): Promise<string | null> =>
  window.evaluate((s) => {
    const tab = document.querySelector(s);
    if (tab === null) return null;
    const own = tab.closest('[data-group-id]');
    if (own !== null) return own.getAttribute('data-group-id');
    if (tab.closest('#titlebar-tabs') === null) return null;
    const shown = [...document.querySelectorAll<HTMLElement>('[data-work-container]')].find((el) => el.style.visibility !== 'hidden');
    const all = shown?.querySelectorAll('[data-group-id]') ?? [];
    return all.length === 1 ? (all[0]?.getAttribute('data-group-id') ?? null) : null;
  }, tabSel(tabId));

const mountIdOf = (window: Page, tabId: string): Promise<string | null> =>
  window.evaluate((s) => document.querySelector(s)?.getAttribute('data-mount-id') ?? null, surfaceSel(tabId));

/** Контейнер работы виден — значит, её раскладка сейчас в центре (`AppShell.tsx`, скрытые — `visibility: hidden`). */
const isContainerShown = (window: Page, workKey: string): Promise<boolean> =>
  window.evaluate((s) => {
    const el = document.querySelector<HTMLElement>(s);
    return el !== null && el.style.visibility !== 'hidden';
  }, containerSel(workKey));

async function typeInto(window: Page, sessionId: string, text: string): Promise<void> {
  await window.locator(`${surfaceSel(term(sessionId))} .xterm-helper-textarea`).focus();
  await window.keyboard.type(text);
  await window.keyboard.press('Enter');
}

test.describe('каркас окна: сплиты, перенос вкладок, смена работ (кусок 2.7)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-shell-'));
    project = await makeTempProject('shell');
  });

  test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(): Promise<{ electronApp: ElectronApplication; window: Page }> {
    const env = { ...process.env, HARNAS_HOME: home, HARNAS_CLAUDE_BIN: stubAgent, HARNAS_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    // Сплит отказывает, если группе не хватает 240×160 — окно побольше минимального.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    return { electronApp, window };
  }

  test('⌘D и выбор — две группы; вкладка к нижнему краю — по-прежнему две; закрытие последней вкладки схлопывает сплит', async () => {
    const { electronApp, window } = await launch();
    const work = await createWork(window, 'e2e-shell');
    const s1 = await createSession(window, work.workId, 'раз');
    const s2 = await createSession(window, work.workId, 'два');
    await createSession(window, work.workId, 'три');
    await expect(window.getByTestId('app-shell')).toBeVisible();

    await window.locator(rowSel(work.key, s1)).click();
    await expect.poll(() => groupCount(window)).toBe(1);

    await sendMenu(electronApp, 'group.splitRight');
    await window.getByRole('dialog').getByText('S02 два').click();
    await expect.poll(() => groupCount(window)).toBe(2);
    const sourceGroup = await groupIdOfTab(window, term(s2));
    const group1 = await groupIdOfTab(window, term(s1));
    expect(sourceGroup).not.toBeNull();
    expect(group1).not.toBeNull();

    // Вкладку S02 — к нижнему краю тела группы S01.
    const body1 = await rectOf(window, `[data-group-body="${group1}"]`);
    await dragTab(window, term(s2), { x: body1.x + body1.w / 2, y: body1.y + body1.h * 0.92 });

    // Исходная группа S02 опустела и удалена (2.1), S02 — в новой группе под S01.
    await expect.poll(() => groupCount(window)).toBe(2);
    await expect.poll(() => window.locator(`[data-group-id="${sourceGroup}"]`).count()).toBe(0);
    const newGroup = await groupIdOfTab(window, term(s2));
    expect(newGroup).not.toBe(sourceGroup);
    const r1 = await rectOf(window, `[data-group-id="${group1}"]`);
    const r2 = await rectOf(window, `[data-group-id="${newGroup}"]`);
    expect(r2.y).toBeGreaterThanOrEqual(r1.y + r1.h - 2);
    expect(Math.abs(r2.x - r1.x)).toBeLessThan(2);

    // Закрыть последнюю вкладку группы — сплит схлопывается.
    await window.locator(`${tabSel(term(s2))} button[aria-label="Close"]`).click();
    await expect.poll(() => groupCount(window)).toBe(1);
    await expect(window.locator(tabSel(term(s2)))).toHaveCount(0);
  });

  test('перенос вкладки терминала в другую группу: data-mount-id тот же, текст экрана на месте', async () => {
    const { electronApp, window } = await launch();
    const work = await createWork(window, 'e2e-shell-mount');
    const s1 = await createSession(window, work.workId, 'раз');
    const s2 = await createSession(window, work.workId, 'два');
    await expect(window.getByTestId('app-shell')).toBeVisible();

    await window.locator(rowSel(work.key, s1)).click();
    await sendMenu(electronApp, 'group.splitRight');
    await window.getByRole('dialog').getByText('S02 два').click();
    await expect.poll(() => groupCount(window)).toBe(2);

    await typeInto(window, s1, 'hello-mount');
    await expect(window.locator(surfaceSel(term(s1))).getByText('echo: hello-mount', { exact: true })).toBeVisible();
    const mountBefore = await mountIdOf(window, term(s1));
    expect(mountBefore).not.toBeNull();

    // В тело группы S02 — вкладка S01 уходит туда, её группа опустела и удалена.
    const group2 = await groupIdOfTab(window, term(s2));
    await dragTab(window, term(s1), center(await rectOf(window, `[data-group-body="${group2}"]`)));
    await expect.poll(() => groupCount(window)).toBe(1);
    await expect.poll(() => groupIdOfTab(window, term(s1))).toBe(group2);

    // Тот же `data-mount-id` — поверхность не пересоздавалась, второго `pty.attach` не было (спека 14.3).
    expect(await mountIdOf(window, term(s1))).toBe(mountBefore);
    await expect(window.locator(surfaceSel(term(s1))).getByText('echo: hello-mount', { exact: true })).toBeVisible();
  });

  test('две работы: клик по сессии второй меняет центр, назад — снова первая; бросок не уходит в скрытую работу', async () => {
    const { electronApp, window } = await launch();
    const workA = await createWork(window, 'e2e-shell-a');
    const a1 = await createSession(window, workA.workId, 'альфа');
    const a2 = await createSession(window, workA.workId, 'бета');
    const workB = await createWork(window, 'e2e-shell-b');
    const b1 = await createSession(window, workB.workId, 'гамма');
    await expect(window.getByTestId('app-shell')).toBeVisible();

    await window.locator(rowSel(workA.key, a1)).click();
    await expect.poll(() => isContainerShown(window, workA.key)).toBe(true);
    await expect(window.locator(`${containerSel(workA.key)} ${surfaceSel(term(a1))}`)).toHaveCount(1);

    // Клик по строке сессии второй работы — в центре её раскладка.
    await window.locator(rowSel(workB.key, b1)).click();
    await expect.poll(() => isContainerShown(window, workB.key)).toBe(true);
    await expect.poll(() => isContainerShown(window, workA.key)).toBe(false);
    await expect(window.locator(`${containerSel(workB.key)} ${surfaceSel(term(b1))}`)).toHaveCount(1);

    await sendMenu(electronApp, 'history.back');
    await expect.poll(() => isContainerShown(window, workA.key)).toBe(true);
    await expect.poll(() => isContainerShown(window, workB.key)).toBe(false);

    // Вторая работа скрыта в LRU, её тела — на том же месте под первой.
    // Вторая сессия первой работы — вторая вкладка-терминал той же группы.
    await window.locator(rowSel(workA.key, a2)).click();
    await expect.poll(() => groupCount(window, containerSel(workA.key))).toBe(1);
    await expect(window.locator('#titlebar-tabs [role="tab"]')).toHaveCount(2);

    // Вкладку — к правому краю группы: две группы в первой работе.
    const groupA = await groupIdOfTab(window, term(a2));
    const bodyA = await rectOf(window, `[data-group-body="${groupA}"]`);
    await dragTab(window, term(a2), { x: bodyA.x + bodyA.w * 0.92, y: bodyA.y + bodyA.h / 2 });
    await expect.poll(() => groupCount(window, containerSel(workA.key))).toBe(2);

    // Вторая работа — по-прежнему одна группа: бросок не ушёл в скрытую раскладку.
    await window.locator(rowSel(workB.key, b1)).click();
    await expect.poll(() => isContainerShown(window, workB.key)).toBe(true);
    expect(await groupCount(window, containerSel(workB.key))).toBe(1);
    expect(await groupCount(window, containerSel(workA.key))).toBe(2);
  });
});
