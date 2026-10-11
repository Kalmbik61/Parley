import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Архив комнат и проектов в живом окне 800×500 (спека `2026-10-08-archive-rooms-projects-design.md`, часть 1, раздел 8,
 * последний пункт; часть 2, 15: Rename сессии). Значения длинные нарочно: проект лежит под `/private/var/folders/…` в папке
 * с именем в 85 символов, название работы и комнаты — по 120 символов без пробелов, имя сессии — 80. Рядом с каждым шагом
 * проверяется геометрия: ни одна рамка внутри сайдбара (строки, ссылки «N archived», кнопки меню, поле переименования) и
 * внутри диалога подтверждения не выходит за его край, а у сайдбара и диалога нет горизонтальной прокрутки.
 *
 * Комнату и сессии создаёт хост (`rooms.create`, `sessions.create`, тихий старт), вместо `claude` — заглушка агента.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

const LONG_FOLDER = `archive-check-${'P'.repeat(70)}`;
const LONG_WORK = `archive-work-${'W'.repeat(107)}`;
const LONG_ROOM = `archive-room-${'R'.repeat(107)}`;
const LONG_SESSION = `session-name-${'S'.repeat(66)}`;

interface MapShape {
  work: { status: string };
  rooms: { id: string; title: string; archivedAt?: string | null }[];
  sessions: { id: string; label: string; lifecycle: string }[];
  messages: { from: string; to: string[]; roomId: string | null; text: string }[];
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

/**
 * Что вылезло из сайдбара: у него и у списка нет горизонтальной прокрутки, рамка ни одного потомка не выходит за рамку
 * сайдбара, а у строк (секция, карточка, комната, сессия, ссылки «N archived») — за рамку самой строки.
 */
async function sidebarProblems(window: Page, step: string): Promise<string[]> {
  return window.evaluate((name) => {
    const problems: string[] = [];
    const sidebar = document.querySelector<HTMLElement>('[data-work-sidebar]');
    if (sidebar === null) return [`${name}: no sidebar`];
    const describe = (el: Element): string => {
      const own = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24);
      return `${el.tagName.toLowerCase()} «${own}»`;
    };
    const box = sidebar.getBoundingClientRect();
    for (const el of [sidebar, sidebar.querySelector<HTMLElement>('[data-sidebar-list]')]) {
      if (el !== null && el.scrollWidth > el.clientWidth) problems.push(`${name}: ${describe(el)} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    }
    for (const el of sidebar.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > box.right + 0.5 || rect.left < box.left - 0.5) {
        problems.push(`${name}: ${describe(el)} x ${Math.round(rect.left)}..${Math.round(rect.right)} outside sidebar ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
    }
    const rows = sidebar.querySelectorAll('[data-section-key], [data-work-key], [data-room-row], [data-session-id], [data-archived-works], [data-archived-rooms]');
    for (const row of rows) {
      const rowBox = row.getBoundingClientRect();
      for (const el of row.querySelectorAll('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > rowBox.right + 0.5 || rect.left < rowBox.left - 0.5) {
          problems.push(`${name}: ${describe(el)} outside its row ${describe(row)} (${Math.round(rect.right)} > ${Math.round(rowBox.right)})`);
        }
      }
    }
    return problems.slice(0, 8);
  }, step);
}

/**
 * Что вылезло из открытого диалога: нет горизонтальной прокрутки, диалог целиком в окне, заголовок, описание, флажок и
 * кнопки не выходят за его рамку, а каждая кнопка достижима (в её центре не чужой элемент).
 */
async function dialogProblems(window: Page, step: string): Promise<string[]> {
  const dialog = window.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Диалог появляется с zoom-in: до конца анимации его рамка ещё меньше итоговой.
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))));
  return dialog.evaluate((el, name) => {
    const problems: string[] = [];
    const box = el.getBoundingClientRect();
    if (el.scrollWidth > el.clientWidth) problems.push(`${name}: dialog scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    if (box.left < -0.5 || box.right > globalThis.innerWidth + 0.5 || box.top < -0.5 || box.bottom > globalThis.innerHeight + 0.5) {
      problems.push(`${name}: dialog ${Math.round(box.left)}..${Math.round(box.right)} x ${Math.round(box.top)}..${Math.round(box.bottom)} outside window`);
    }
    for (const node of el.querySelectorAll('h2, p, label, button, [role="checkbox"]')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      const what = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 24);
      if (rect.right > box.right + 0.5 || rect.left < box.left - 0.5) {
        problems.push(`${name}: ${node.tagName.toLowerCase()} «${what}» x ${Math.round(rect.left)}..${Math.round(rect.right)} outside dialog ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
      if (node.tagName === 'BUTTON') {
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        // Тост «Parley added PARLEY.md…» после создания первой сессии висит несколько секунд поверх чего угодно, диалог
        // не исключение: он уходит сам, и Playwright дожидается его при клике, поэтому кнопкой под ним проверка не падает.
        if (hit?.closest('[data-sonner-toast]') != null) continue;
        if (hit === null || !node.contains(hit)) problems.push(`${name}: button «${what}» covered or not clickable`);
      }
    }
    return problems;
  }, step);
}

test.describe('архив комнат и проектов, 800×500 с длинными значениями', () => {
  let home: string;
  /** Корень временного каталога; сам проект — длинная папка внутри него. */
  let base: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('archive');
    base = await makeTempProject('archive');
    project = path.join(base, LONG_FOLDER);
    await mkdir(project, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });

  async function launch(): Promise<Page> {
    app = await electron.launch({ args: [mainEntry], env: { ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom' } });
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 800, height: 500 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    return window;
  }

  async function createSession(window: Page, workId: string, label: string): Promise<string> {
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null });
    return ref.sessionId;
  }

  const mapOf = async (workId: string): Promise<MapShape> =>
    JSON.parse(await readFile(path.join(project, '.parley', 'works', workId, 'map.json'), 'utf8')) as MapShape;

  const hiddenProjects = async (): Promise<string[]> => {
    try {
      const ui = JSON.parse(await readFile(path.join(home, 'desktop', 'ui.json'), 'utf8')) as { hiddenProjects?: string[] };
      return ui.hiddenProjects ?? [];
    } catch {
      return [];
    }
  };

  test('(а) комната: Archive… с флажком → ссылка «1 archived room» → архивная строка и вкладка только для чтения → Reopen', async () => {
    test.setTimeout(120_000);
    const window = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: LONG_WORK, goal: '' });
    const ids: string[] = [];
    for (const label of ['planner', 'critic', 'executor']) ids.push(await createSession(window, workId, label));
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', { projectPath: project, workId, title: LONG_ROOM, members: ids, lead: ids[0], quiet: true });

    const card = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`);
    const openRow = card.locator(`[data-room-row="${roomId}"]`);
    const archivedLink = card.locator('[data-archived-rooms]');
    const archivedList = card.locator('[data-archived-rooms-list]');
    await expect(openRow).toHaveCount(1);
    expect(await sidebarProblems(window, 'a0 открытая комната')).toEqual([]);

    // Меню открытой комнаты: Archive… есть, Reopen нет.
    await openRow.locator('> div').first().click({ button: 'right' });
    await expect(window.locator('[data-room-action="archive"]')).toBeVisible();
    await expect(window.locator('[data-room-action="reopen"]')).toHaveCount(0);
    await window.locator('[data-room-action="archive"]').click();

    // Подтверждение: флажок включён по умолчанию, геометрия диалога в порядке.
    const dialog = window.getByRole('dialog', { name: `Archive room "${LONG_ROOM}"?` });
    const stopFlag = dialog.getByRole('checkbox', { name: 'Also stop its 3 agents that are in no other room' });
    await expect(stopFlag).toBeChecked();
    expect(await dialogProblems(window, 'a1 подтверждение архивации')).toEqual([]);
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Хост: комната в архиве, строка в ленте, агенты остановлены флажком.
    await expect.poll(async () => (await mapOf(workId)).rooms[0]?.archivedAt ?? null).not.toBeNull();
    const archivedMap = await mapOf(workId);
    expect(archivedMap.messages.some((message) => message.roomId === roomId && message.text === 'Room archived by the human.')).toBe(true);
    await expect.poll(async () => (await mapOf(workId)).sessions.map((session) => session.lifecycle)).toEqual(['sleeping', 'sleeping', 'sleeping']);

    // Комната ушла из строк, внизу карточки — ссылка.
    await expect(openRow).toHaveCount(0);
    await expect(archivedLink).toHaveText('1 archived room');
    await expect(archivedList).toHaveCount(0);
    expect(await sidebarProblems(window, 'a2 ссылка «1 archived room»')).toEqual([]);

    // Раскрытие: приглушённая строка архивной комнаты; подпись ссылки меняется.
    await archivedLink.click();
    await expect(archivedLink).toHaveText('Hide archived rooms');
    const archivedRow = archivedList.locator(`[data-room-row="${roomId}"]`);
    await expect(archivedRow).toHaveCount(1);
    await expect(archivedRow).toHaveAttribute('data-dimmed', '');
    expect(await sidebarProblems(window, 'a3 раскрытая архивная строка')).toEqual([]);

    // Меню архивной строки: Reopen первым, Rename, Delete…; Archive… нет.
    await archivedRow.locator('> div').first().click({ button: 'right' });
    await expect(window.locator('[data-room-action="reopen"]')).toBeVisible();
    await expect(window.locator('[data-room-action="rename"]')).toBeVisible();
    await expect(window.locator('[data-room-action="delete"]')).toBeVisible();
    await expect(window.locator('[data-room-action="archive"]')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(window.locator('[data-room-action="reopen"]')).toHaveCount(0);

    // Вкладка архивной комнаты: метка Archived и кнопка Reopen вместо поля ввода.
    await archivedRow.locator('> div').first().click();
    const tab = window.locator(`[role="tab"][data-tab-id="room:${roomId}"]`);
    await expect(tab).toHaveAttribute('data-active', 'true');
    const panel = window.locator('[data-room-panel]:visible');
    await expect(panel.locator('[data-room-archived]')).toHaveText('Archived');
    await expect(panel.locator('[data-room-header] h3')).toHaveAttribute('title', LONG_ROOM);
    await expect(panel.locator('[data-room-archived-note]')).toContainText('This room is archived.');
    await expect(panel.locator('[data-room-reopen]')).toHaveText('Reopen');
    await expect(panel.locator('[data-room-editor]')).toHaveCount(0);
    const panelProblems = await panel.evaluate((el) => {
      const problems: string[] = [];
      const box = el.getBoundingClientRect();
      if (el.scrollWidth > el.clientWidth) problems.push(`panel scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      for (const selector of ['[data-room-archived]', '[data-room-archived-note]', '[data-room-reopen]', '[data-room-header] h3']) {
        const node = el.querySelector(selector);
        if (node === null) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.right > box.right + 0.5 || rect.left < box.left - 0.5) {
          problems.push(`${selector} x ${Math.round(rect.left)}..${Math.round(rect.right)} width ${Math.round(rect.width)} vs panel ${Math.round(box.left)}..${Math.round(box.right)}`);
        }
      }
      return problems;
    });
    expect(panelProblems).toEqual([]);

    // Reopen из вкладки возвращает комнату: строка в карточке, ссылки нет, поле ввода вернулось.
    await panel.locator('[data-room-reopen]').click();
    await expect.poll(async () => (await mapOf(workId)).rooms[0]?.archivedAt ?? null).toBeNull();
    await expect(openRow).toHaveCount(1);
    await expect(archivedLink).toHaveCount(0);
    await expect(panel.locator('[data-room-archived]')).toHaveCount(0);
    await expect(panel.locator('[data-room-editor]')).toHaveCount(1);
    expect(await sidebarProblems(window, 'a4 после Reopen')).toEqual([]);

    // Второй круг и Reopen из меню строки. Агенты спят с первого круга: останавливать некого — флажка нет.
    await openRow.locator('> div').first().click({ button: 'right' });
    await window.locator('[data-room-action="archive"]').click();
    const again = window.getByRole('dialog', { name: `Archive room "${LONG_ROOM}"?` });
    await expect(again.getByRole('checkbox')).toHaveCount(0);
    await again.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(again).toBeHidden();
    await expect.poll(async () => (await mapOf(workId)).rooms[0]?.archivedAt ?? null).not.toBeNull();
    await expect(archivedLink).toBeVisible();
    // Раскрытие помнится по работе: строка уже под ссылкой или ссылка предлагает её раскрыть.
    if ((await archivedLink.textContent()) !== 'Hide archived rooms') await archivedLink.click();
    await expect(archivedRow).toHaveCount(1);
    await archivedRow.locator('> div').first().click({ button: 'right' });
    await window.locator('[data-room-action="reopen"]').click();
    await expect.poll(async () => (await mapOf(workId)).rooms[0]?.archivedAt ?? null).toBeNull();
    await expect(archivedLink).toHaveCount(0);
    await expect(openRow).toHaveCount(1);
    expect(await sidebarProblems(window, 'a5 после Reopen из меню')).toEqual([]);
  });

  test('(б) единственная работа в архиве: проект остаётся с «+» и «1 archived»; Remove from list… убирает его, палитра возвращает', async () => {
    test.setTimeout(120_000);
    const window = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: LONG_WORK, goal: '' });
    await createSession(window, workId, 'solo');
    const key = `${project} ${workId}`;
    const card = window.locator(`[data-work-key="${key}"]:not([role="tab"])`);
    const section = window.locator(`[data-section-key="${project}"]`);
    const archivedLink = window.locator('[data-archived-works]');
    const sectionMenu = section.getByRole('button', { name: 'Section options' });
    const removeItem = window.locator('[data-section-action="remove-from-list"]');
    await expect(card).toHaveCount(1);
    expect(await sidebarProblems(window, 'b0 проект с живой работой')).toEqual([]);

    // Пока есть неархивная работа, «Remove from list…» выключен с подсказкой.
    await section.hover();
    await sectionMenu.click();
    await expect(removeItem).toHaveAttribute('aria-disabled', 'true');
    await expect(removeItem).toHaveAttribute('title', 'Archive its workspaces first');
    await window.keyboard.press('Escape');
    await expect(removeItem).toHaveCount(0);

    // Архивирую работу из меню карточки.
    await card.locator('[data-work-title]').first().click({ button: 'right' });
    await window.locator('[data-card-action="archive"]').click();
    const archiveDialog = window.getByRole('dialog', { name: `Archive "${LONG_WORK}"?` });
    expect(await dialogProblems(window, 'b1 подтверждение архивации работы')).toEqual([]);
    await archiveDialog.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(archiveDialog).toBeHidden();
    await expect.poll(async () => (await mapOf(workId)).work.status).toBe('archived');

    // Проект остался: заголовок, «+», ссылка; работы не видно.
    await expect(card).toHaveCount(0);
    await expect(section).toHaveCount(1);
    // Имя папки в заголовке обрезано многоточием, полный путь — в тултипе.
    await expect(section).toHaveAttribute('title', project);
    await expect(section.getByRole('button', { name: /^New workspace in / })).toBeVisible();
    await expect(archivedLink).toHaveText('1 archived');
    await expect(window.getByTestId('landing')).toHaveCount(0);
    expect(await sidebarProblems(window, 'b2 проект без показанных работ')).toEqual([]);

    // Клик раскрывает архивную работу (приглушённую), подпись «Hide archived»; повторный клик прячет.
    await archivedLink.click();
    await expect(archivedLink).toHaveText('Hide archived');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-dimmed', '');
    expect(await sidebarProblems(window, 'b3 раскрытая архивная работа')).toEqual([]);
    await archivedLink.click();
    await expect(card).toHaveCount(0);
    await expect(archivedLink).toHaveText('1 archived');

    // «Remove from list…» теперь доступен: подтверждение, проект пропал.
    await section.hover();
    await sectionMenu.click();
    await expect(removeItem).not.toHaveAttribute('aria-disabled', 'true');
    await removeItem.click();
    const removeDialog = window.getByRole('dialog', { name: `Remove "${LONG_FOLDER}" from the list?` });
    expect(await dialogProblems(window, 'b4 подтверждение Remove from list')).toEqual([]);
    await removeDialog.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(removeDialog).toBeHidden();
    await expect(section).toHaveCount(0);
    await expect(archivedLink).toHaveCount(0);
    await expect.poll(hiddenProjects).toEqual([project]);
    // Ничего не удалено: работа на диске.
    expect((await mapOf(workId)).work.status).toBe('archived');

    // Палитра «Show archived workspaces» показывает скрытый проект с архивной работой.
    await window.keyboard.press('Meta+J');
    const input = window.locator('[data-palette] [cmdk-input]');
    await expect(input).toBeFocused();
    await window.keyboard.type('archived');
    await window.locator('[data-palette] [role="option"]', { hasText: 'Show archived workspaces' }).click();
    await expect(window.locator('[data-palette]')).toHaveCount(0);
    await expect(section).toHaveCount(1);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-dimmed', '');
    expect(await sidebarProblems(window, 'b5 «Show archived workspaces»')).toEqual([]);
  });

  test('(в) Rename сессии из меню строки: длинное имя не вылезает за строку, Enter сохраняет', async () => {
    test.setTimeout(90_000);
    const window = await launch();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: LONG_WORK, goal: '' });
    const first = await createSession(window, workId, 'planner');
    await createSession(window, workId, 'critic');
    const card = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`);
    const row = card.locator(`[data-session-id="${first}"]`);
    await expect(row).toHaveCount(1);

    await row.click({ button: 'right' });
    await window.locator('[data-session-action="rename"]').click();
    const field = window.getByRole('textbox', { name: 'Session name' });
    await expect(field).toBeFocused();
    await field.fill(LONG_SESSION);
    expect(await sidebarProblems(window, 'c1 поле переименования')).toEqual([]);
    const inside = await field.evaluate((el) => {
      const rowBox = el.closest('[data-session-id]')?.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rowBox !== undefined && rect.width > 0 && rect.left >= rowBox.left - 0.5 && rect.right <= rowBox.right + 0.5;
    });
    expect(inside).toBe(true);

    await field.press('Enter');
    await expect(field).toHaveCount(0);
    await expect(row).toContainText(LONG_SESSION);
    await expect.poll(async () => (await mapOf(workId)).sessions.find((session) => session.id === first)?.label).toBe(LONG_SESSION);
    expect(await sidebarProblems(window, 'c2 после Enter')).toEqual([]);
  });
});
