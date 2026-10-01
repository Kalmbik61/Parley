import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Вёрстка диалогов с длинными значениями (раунд исправлений 2 куска 3.5; диалоги 1.5–1.7 — кусок 7 плана «Organic»):
 * длинный путь проекта (`mkdtemp` на macOS — `/private/var/folders/…`), название работы в 120 символов и ярлык в 40,
 * пять агентов в диалоге «New session or room», две сессии с длинными ярлыками и задачами в диалоге «New room» из двух
 * сессий (1.6; правка по ревью куска 7). Прежде путь в Select задавал минимальную ширину формы, и поля с
 * кнопкой Create выходили за правый край диалога New workspace. Проверка — геометрия: правый край каждого поля и
 * кнопки не правее правого края диалога, у самого диалога нет горизонтальной прокрутки, а содержимое пилюль выбора
 * (провайдер 1.5, ведущий 1.6) не торчит за их рамку.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/** 120 символов без пробелов — худший случай: переносить нечему. */
const LONG_TITLE = `layout-check-${'W'.repeat(107)}`;
const LONG_LABEL = `label-${'L'.repeat(34)}`;
/** Ярлыки и задача сессий для диалога 1.6: в его пилюлях ведущего задача идёт вторым, приглушённым текстом. */
const LONG_LABEL_DRAGGED = `label-${'M'.repeat(34)}`;
const LONG_LABEL_TARGET = `label-${'N'.repeat(34)}`;
const LONG_TASK = `task-${'T'.repeat(200)}`;

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/** Что вылезло за правый край открытого диалога — пустой список, если ничего. */
async function overflowOf(window: Page, name: string): Promise<string[]> {
  const dialog = window.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Диалог появляется с zoom-in: до конца анимации его рамка ещё меньше итоговой.
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  return dialog.evaluate((el, dialogName) => {
    const box = el.getBoundingClientRect();
    const problems: string[] = [];
    if (el.scrollWidth > el.clientWidth) problems.push(`${dialogName}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    for (const node of el.querySelectorAll('input, textarea, button, [role="combobox"], [role="option"], [role="radio"], h2')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > box.right + 0.5) {
        const what = (node.getAttribute('aria-label') ?? node.textContent ?? '').slice(0, 30);
        problems.push(`${dialogName}: ${node.tagName.toLowerCase()} «${what}» right ${Math.round(rect.right)} > ${Math.round(box.right)}`);
      }
      // Пилюля выбора (провайдер 1.5, ведущий 1.6) с длинным ярлыком: рамка в диалоге, а текст не вылезает из неё —
      // `scrollWidth` шире `clientWidth`, когда содержимое кнопки торчит за её край (рамка при этом не растёт).
      if (node.getAttribute('role') === 'radio' && node.scrollWidth > node.clientWidth + 1) {
        problems.push(`${dialogName}: radio «${(node.textContent ?? '').slice(0, 30)}» content ${node.scrollWidth} > box ${node.clientWidth}`);
      }
    }
    return problems;
  }, name);
}

/** Кнопки подвала диалогов окна (и крестик заголовка): они обязаны быть видны при любой высоте окна. */
const FOOTER_BUTTON = /^(Cancel|Create|Create workspace|Create room|Start session|Retry|Done|Close|Delete.*)$/;

/**
 * Высота диалогов (находка живой проверки review-3.5-rr2): диалог целиком в окне, а каждая
 * кнопка подвала — внутри окна по вертикали и сверху её центра нет чужого элемента (клик дойдёт).
 */
async function footerProblemsOf(window: Page, name: string): Promise<string[]> {
  const dialog = window.getByRole('dialog');
  const problems = await dialog.evaluate(
    (el, [dialogName, pattern]) => {
      const out: string[] = [];
      const height = window.innerHeight;
      const box = el.getBoundingClientRect();
      if (box.top < -0.5 || box.bottom > height + 0.5) {
        out.push(`${dialogName}: dialog ${Math.round(box.top)}..${Math.round(box.bottom)} outside 0..${height}`);
      }
      const re = new RegExp(pattern);
      const buttons = [...el.querySelectorAll('button')].filter((b) => re.test((b.textContent ?? '').trim()));
      if (buttons.length === 0) out.push(`${dialogName}: no footer buttons found`);
      for (const button of buttons) {
        const label = (button.textContent ?? '').trim();
        const rect = button.getBoundingClientRect();
        if (rect.bottom > height + 0.5) {
          out.push(`${dialogName}: «${label}» bottom ${Math.round(rect.bottom)} > ${height}`);
          continue;
        }
        // Выключенная кнопка пропускает указатель — проверять нечего.
        if (button.disabled) continue;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        if (hit === null || !button.contains(hit)) out.push(`${dialogName}: «${label}» covered or not clickable`);
      }
      return out;
    },
    [name, FOOTER_BUTTON.source] as const,
  );
  return problems;
}

/** Тащит строку `from` к строке `to` и держит указатель там; отпустить — `mouse.up()` из вызывающего кода. */
async function dragOver(window: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (a === null || b === null) throw new Error('строки для броска не найдены');
  await window.mouse.move(a.x + 40, a.y + a.height / 2);
  await window.mouse.down();
  // Порог перетаскивания — 4 px; затем указатель идёт к цели и стоит на ней (droppable включается после старта).
  await window.mouse.move(a.x + 60, a.y + a.height / 2 + 6, { steps: 3 });
  await window.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 10 });
  await window.mouse.move(b.x + 62, b.y + b.height / 2, { steps: 2 });
}

async function closeDialog(window: Page): Promise<void> {
  await window.keyboard.press('Escape');
  await expect(window.getByRole('dialog')).toBeHidden();
}

for (const size of [
  { width: 800, height: 500 },
  { width: 1400, height: 900 },
]) {
  test.describe(`диалоги с длинными значениями, окно ${size.width}x${size.height}`, () => {
    let home: string;
    let base: string;
    let project: string;
    let app: ElectronApplication | null = null;

    test.beforeEach(async () => {
      home = await makeTempHome('dialogs');
      base = await makeTempProject('dialogs');
      // Путь из mkdtemp и ещё длинное имя папки — заведомо шире любого диалога.
      project = path.join(base, 'a-rather-long-project-folder-name-for-dialog-layout');
      await mkdir(project);
    });

    test.afterEach(async () => {
      await stopApp(app);
      app = null;
      await stopHost(home);
      await rm(home, { recursive: true, force: true });
      await rm(base, { recursive: true, force: true });
    });

    test('ничего не выходит за правый край, подвал в окне: New workspace, New session, New room (пять агентов), New room из двух сессий, Delete, палитра, Settings', async () => {
      test.setTimeout(120_000);
      const env = { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' };
      const electronApp = await electron.launch({ args: [mainEntry], env });
      app = electronApp;
      const window = await electronApp.firstWindow();
      await electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds }), size);
      await expect(window.getByTestId('landing')).toBeVisible();

      const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: LONG_TITLE, goal: '' });
      await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: LONG_LABEL, task: '', parent: null });
      await expect(window.getByTestId('app-shell')).toBeVisible();
      const card = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`);
      await expect(card).toContainText(LONG_LABEL);

      const problems: string[] = [];

      // New workspace от «+» заголовка проекта: проект выбран, поля заполнены длинными значениями.
      await window.getByRole('button', { name: /^New workspace in / }).click();
      const composer = window.getByRole('dialog');
      await expect(composer.getByRole('radiogroup', { name: 'Project' }).getByRole('radio', { checked: true })).toHaveAttribute('title', project);
      await composer.getByLabel(/^Title/).fill(LONG_TITLE);
      await composer.getByLabel(/^First prompt/).fill(`${LONG_LABEL} ${'long prompt '.repeat(80)}`);
      problems.push(...(await overflowOf(window, 'New workspace')));
      problems.push(...(await footerProblemsOf(window, 'New workspace')));
      // Кнопка подвала нажимается мышью и при окне 800×500.
      await composer.getByRole('button', { name: 'Cancel', exact: true }).click({ timeout: 5_000 });
      await expect(window.getByRole('dialog')).toBeHidden();

      const cardAction = async (action: string): Promise<void> => {
        await card.getByText(LONG_TITLE).click({ button: 'right' });
        await window.locator(`[data-card-action="${action}"]`).click();
      };

      await cardAction('new-session');
      await expect(window.getByRole('dialog').getByRole('heading', { name: 'New session' })).toBeVisible();
      await window.getByRole('dialog').getByPlaceholder('Optional').fill(LONG_LABEL);
      problems.push(...(await overflowOf(window, 'New session')));
      problems.push(...(await footerProblemsOf(window, 'New session')));
      await closeDialog(window);

      // «New room» — тот же диалог, открытый комнатой; пять агентов и название комнаты в 120 символов.
      await cardAction('new-room');
      const room = window.getByRole('dialog');
      await expect(room.getByRole('heading', { name: 'New room' })).toBeVisible();
      for (let i = 0; i < 3; i += 1) await room.getByRole('button', { name: 'Add agent' }).click();
      await expect(room.locator('[data-agent-row]')).toHaveCount(5);
      await room.getByPlaceholder('What the agents will discuss').fill(LONG_TITLE);
      problems.push(...(await overflowOf(window, 'New room')));
      problems.push(...(await footerProblemsOf(window, 'New room')));
      await closeDialog(window);

      // «New room» из двух сессий (1.6): бросок сессии на сессию той же работы; ярлыки в 40 знаков и задачи в 200+.
      const create = (label: string): Promise<{ ref: { sessionId: string } }> =>
        call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: LONG_TASK, parent: null });
      const dragged = (await create(LONG_LABEL_DRAGGED)).ref.sessionId;
      const target = (await create(LONG_LABEL_TARGET)).ref.sessionId;
      const draggedRow = card.locator(`[data-session-id="${dragged}"]`);
      const targetRow = card.locator(`[data-session-id="${target}"]`);
      await expect(draggedRow).toBeVisible();
      await expect(targetRow).toBeVisible();
      await dragOver(window, draggedRow, targetRow);
      await expect(targetRow).toHaveAttribute('data-drop-over', '');
      await window.mouse.up();
      const merge = window.getByRole('dialog');
      await expect(merge.getByRole('heading', { name: 'New room' })).toBeVisible();
      await expect(merge.getByRole('radio')).toHaveCount(2);
      problems.push(...(await overflowOf(window, 'New room from two')));
      problems.push(...(await footerProblemsOf(window, 'New room from two')));
      await closeDialog(window);

      await cardAction('delete');
      await expect(window.getByRole('dialog')).toContainText(LONG_TITLE);
      problems.push(...(await overflowOf(window, 'Delete')));
      problems.push(...(await footerProblemsOf(window, 'Delete')));
      await closeDialog(window);

      await window.getByRole('button', { name: 'Search ⌘J' }).first().click();
      await expect(window.getByRole('dialog')).toContainText(LONG_TITLE);
      problems.push(...(await overflowOf(window, 'Palette')));
      await window.getByRole('dialog').getByRole('combobox').fill('Settings');
      await window.keyboard.press('Enter');
      await expect(window.getByRole('dialog')).toContainText('Settings');
      problems.push(...(await overflowOf(window, 'Settings')));
      problems.push(...(await footerProblemsOf(window, 'Settings')));
      await closeDialog(window);

      expect(problems).toEqual([]);
    });
  });
}
