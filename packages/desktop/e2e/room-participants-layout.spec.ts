import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Первая строка карточки участника комнаты в окне 800×500 (жалоба со скриншотом 2026-10-07): у участников с ролью,
 * ведущим `★` и словом `done · unseen` имя схлопывалось в ноль, а слово состояния уезжало за правый край карточки.
 * Договорённость «роль сжимается первой»: имя видно хотя бы коротким номером сессии (`S01…`), `★` и слово состояния
 * целиком, а сжимается чип роли — многоточие в его тексте, 🔒 на месте, полная роль в тултипе чипа. Та же строка
 * участника в развёрнутой комнате сайдбара (`SessionRow`) — с теми же проверками; времени у участника комнаты в сайдбаре нет.
 *
 * Значения нарочно длинные: название сессии в полсотни знаков, нативная роль Claude проекта с длинным именем
 * (`.claude/agents/*.md`, без 🔒) и встроенные роли «только чтение» (🔒 Architect, 🔒 Researcher). Состояние
 * `done · unseen` — строки хука в журнале событий сессии (как в `attention.spec.ts`): ход начат и закончен, а
 * вкладку сессии никто не открывал. Раскладку jsdom не меряет — поэтому окно Electron и прямоугольники элементов.
 * Снимок — в `test-results/room-participants-layout/` (не коммитится).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const shots = path.resolve(dirname, '../test-results/room-participants-layout');
const LONG_LABEL = 'backend-refactor-of-the-payments-ledger-and-invoices';
const LONG_ROLE = 'payments-database-migration-reviewer-for-ledger';
let project = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function hookEvent(workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.parley', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

/** Замер одной строки: прямоугольники детей против строки и карточки, ширина имени против `S01…` тем же шрифтом. */
interface RowMeasure {
  tag: string;
  rowRight: number;
  cardRight: number;
  rowScroll: number;
  rowClient: number;
  childrenRight: number[];
  nameWidth: number;
  nameRight: number;
  tagWidth: number;
  chipTitle: string | null;
  chipRight: number;
  lockRight: number | null;
  textScroll: number;
  textClient: number;
  textOverflow: string;
  starRight: number | null;
  word: string;
  wordScroll: number;
  wordClient: number;
  wordRight: number;
}

/**
 * `row` — строка (первая строка карточки участника или строка сессии сайдбара), `card` — её граница, `name` — имя.
 * Слово состояния ищется по тексту: в строке сайдбара за ним идёт ещё время. Исполняется в окне: `evaluate` берёт одну
 * функцию, поэтому общий замер уходит туда текстом (`measure.toString()`) и собирается обратно `new Function`.
 */
function measure(row: HTMLElement, card: HTMLElement, name: HTMLElement, word: string): RowMeasure {
  const right = (element: Element): number => element.getBoundingClientRect().right;
  const chip = row.querySelector<HTMLElement>('[data-role-chip]');
  if (chip === null) throw new Error('у строки нет чипа роли');
  const text = (chip.lastElementChild as HTMLElement | null) ?? chip;
  const lock = chip.querySelector('[aria-label="Read only"]');
  const star = row.querySelector('[title="Lead"]');
  const wordElement = Array.from(row.children).find((child) => child.textContent === word) as HTMLElement | undefined;
  if (wordElement === undefined) throw new Error(`в строке нет слова «${word}»: ${row.textContent ?? ''}`);
  // Проба тем же шрифтом: имя должно вмещать хотя бы номер сессии с многоточием.
  const tag = (name.textContent ?? '').split(' ')[0] ?? '';
  const probe = name.cloneNode() as HTMLElement;
  probe.textContent = `${tag}…`;
  probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;min-width:0;flex:none';
  row.appendChild(probe);
  const tagWidth = probe.getBoundingClientRect().width;
  probe.remove();
  return {
    tag,
    rowRight: right(row),
    cardRight: right(card),
    rowScroll: row.scrollWidth,
    rowClient: row.clientWidth,
    childrenRight: Array.from(row.children, right),
    nameWidth: name.getBoundingClientRect().width,
    nameRight: right(name),
    tagWidth,
    chipTitle: chip.getAttribute('title'),
    chipRight: right(chip),
    lockRight: lock === null ? null : right(lock),
    textScroll: text.scrollWidth,
    textClient: text.clientWidth,
    textOverflow: getComputedStyle(text).textOverflow,
    starRight: star === null ? null : right(star),
    word: wordElement.textContent ?? '',
    wordScroll: wordElement.scrollWidth,
    wordClient: wordElement.clientWidth,
    wordRight: right(wordElement),
  };
}

/**
 * Проверки строки: ничего в ней не вылезает за её правый край, имя не тоньше `S01…`, `★` и слово целиком, чип обрезан
 * многоточием, 🔒 внутри чипа.
 */
function expectRowFits(m: RowMeasure, expected: { lock: boolean; star: boolean; role: string }): void {
  expect(m.rowRight).toBeLessThanOrEqual(m.cardRight + 0.5);
  expect(m.rowScroll).toBeLessThanOrEqual(m.rowClient);
  for (const childRight of m.childrenRight) expect(childRight).toBeLessThanOrEqual(m.rowRight + 0.5);
  expect(m.tag).toMatch(/^S\d+$/);
  expect(m.nameWidth).toBeGreaterThan(0);
  expect(m.nameWidth + 0.5).toBeGreaterThanOrEqual(m.tagWidth);
  expect(m.nameRight).toBeLessThanOrEqual(m.rowRight + 0.5);
  expect(m.word).toBe('done · unseen');
  expect(m.wordScroll).toBeLessThanOrEqual(m.wordClient);
  expect(m.wordRight).toBeLessThanOrEqual(m.rowRight + 0.5);
  // Чип сжат: его текст обрезан многоточием, а полная роль — в тултипе чипа.
  expect(m.chipRight).toBeLessThanOrEqual(m.rowRight + 0.5);
  expect(m.textOverflow).toBe('ellipsis');
  expect(m.textScroll).toBeGreaterThan(m.textClient);
  expect(m.chipTitle ?? '').toContain(expected.role);
  if (expected.lock) {
    expect(m.lockRight).not.toBeNull();
    expect(m.lockRight as number).toBeLessThanOrEqual(m.chipRight + 0.5);
  } else expect(m.lockRight).toBeNull();
  if (expected.star) {
    expect(m.starRight).not.toBeNull();
    expect(m.starRight as number).toBeLessThanOrEqual(m.rowRight + 0.5);
  } else expect(m.starRight).toBeNull();
}

test.describe('карточки участников комнаты с ролями в окне 800×500', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('room-participants');
    project = await makeTempProject('room-participants');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('роль сжимается первой: имя не тоньше номера сессии, ★ и «done · unseen» целиком, 🔒 на месте — и в сайдбаре', async () => {
    test.setTimeout(90_000);
    // Нативная роль Claude проекта с длинным именем: её чип без 🔒.
    await mkdir(path.join(project, '.claude', 'agents'), { recursive: true });
    await writeFile(
      path.join(project, '.claude', 'agents', 'migration-reviewer.md'),
      `---\nname: ${LONG_ROLE}\ndescription: Reviews ledger migrations for locks and rollbacks.\n---\nReview the migration.\n`,
    );
    const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
    const electronApp = await electron.launch({ args: [mainEntry], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-room-participants', goal: '' });
    const roles = [
      { source: 'builtin', name: 'architect', label: 'Architect · Builtin', lock: true },
      { source: 'builtin', name: 'researcher', label: 'Researcher · Builtin', lock: true },
      { source: 'claude', name: LONG_ROLE, label: `${LONG_ROLE} · Claude`, lock: false },
    ] as const;
    const members: string[] = [];
    for (const role of roles) {
      const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
        projectPath: project,
        workId,
        provider: 'claude',
        label: LONG_LABEL,
        task: '',
        parent: null,
        role: { source: role.source, name: role.name },
      });
      members.push(ref.sessionId);
    }
    const lead = members[0] as string;
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: 'e2e-room',
      members,
      lead,
      quiet: true,
    });
    // Ход начат и закончен, вкладку сессии никто не открывал — `done · unseen`.
    for (const sessionId of members) {
      await hookEvent(workId, sessionId, { hook_event_name: 'UserPromptSubmit' });
      await hookEvent(workId, sessionId, { hook_event_name: 'Stop' });
    }
    await expect(window.getByTestId('app-shell')).toBeVisible();

    const roomRow = window.locator(`[data-room-row="${roomId}"]`);
    await roomRow.locator('> div').first().click();
    await expect(window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`)).toHaveAttribute('data-active', 'true');
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect.poll(() => window.evaluate(() => globalThis.innerWidth)).toBe(800);

    // Лента участников: состояние, роли и 🔒 приехали (🔒 — ответ `roles.list` хоста).
    const cards = window.locator('[data-participant]');
    await expect(cards).toHaveCount(3);
    for (const [index, sessionId] of members.entries()) {
      const card = window.locator(`[data-participant="${sessionId}"]`);
      await expect(card).toContainText('done · unseen', { timeout: 10_000 });
      await expect(card.locator('[data-role-chip]')).toContainText(roles[index]?.name === LONG_ROLE ? LONG_ROLE : (roles[index]?.label as string));
      await expect(card.locator('[data-role-chip] [aria-label="Read only"]')).toHaveCount(roles[index]?.lock ? 1 : 0, { timeout: 10_000 });
    }

    for (const [index, sessionId] of members.entries()) {
      const card = window.locator(`[data-participant="${sessionId}"]`);
      const m = await card.evaluate((element, fn) => {
        const header = element.querySelector<HTMLElement>('button > span');
        const name = header?.querySelector<HTMLElement>('.font-semibold');
        if (!header || !name) throw new Error('у карточки нет первой строки');
        return (new Function(`return (${fn})`)() as typeof measure)(header, element as HTMLElement, name, 'done · unseen');
      }, measure.toString());
      const role = roles[index] as (typeof roles)[number];
      expectRowFits(m, { lock: role.lock, star: sessionId === lead, role: role.label });
    }
    await mkdir(shots, { recursive: true });
    await window.waitForTimeout(300);
    await window.screenshot({ path: path.join(shots, 'participants-800x500.png') });

    // Та же строка в развёрнутой комнате сайдбара (ширина по умолчанию 288): имя, чип с 🔒, `★` и слово — как в карточке.
    // Времени у участника комнаты нет (у ведущего с 🔒 и `done · unseen` оно выходило за рамку на ~12px) — вся строка
    // влезает у каждого, ведущего тоже.
    if ((await roomRow.getAttribute('aria-expanded')) !== 'true') await roomRow.getByRole('button', { name: 'Show agents' }).click();
    await expect(roomRow.locator('[data-session-id]')).toHaveCount(3);
    for (const [index, sessionId] of members.entries()) {
      const row = roomRow.locator(`[data-session-id="${sessionId}"]`);
      await expect(row).toContainText('done · unseen');
      await expect(row.locator('[data-role-chip] [aria-label="Read only"]')).toHaveCount(roles[index]?.lock ? 1 : 0, { timeout: 10_000 });
      const m = await row.evaluate((element, fn) => {
        const line = element.querySelector<HTMLElement>('[data-role-chip]')?.parentElement;
        const card = element.closest<HTMLElement>('[data-work-key]');
        const name = line?.querySelector<HTMLElement>('[data-role-chip]')?.previousElementSibling as HTMLElement | null;
        if (!line || !card || !name) throw new Error('у строки сайдбара нет чипа, карточки или имени');
        return (new Function(`return (${fn})`)() as typeof measure)(line, card, name, 'done · unseen');
      }, measure.toString());
      const role = roles[index] as (typeof roles)[number];
      expectRowFits(m, { lock: role.lock, star: sessionId === lead, role: role.label });
    }
    await window.screenshot({ path: path.join(shots, 'sidebar-800x500.png') });
  });
});
