import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';
import { makeTempProject } from './tmp.js';

/**
 * Раскладка на работу переживает перезапуск окна (кусок 2.7 плана каркаса,
 * спека 5.8, 14.3): у двух работ разные раскладки, после нового запуска каждая
 * на месте по своей работе.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { harnas: { call: (m: string, p: unknown) => Promise<unknown> } }).harnas.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
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

// `data-session-id` уникален только внутри работы — строка ищется внутри обёртки своей работы.
const rowSel = (workKey: string, sessionId: string): string => `[data-work-key="${workKey}"] [data-session-id="${sessionId}"]`;
const containerSel = (workKey: string): string => `[data-work-container="${workKey}"]`;

/** Вкладки-терминалы по группам видимой раскладки работы; `null` — её контейнер не в центре. */
async function shownLayout(window: Page, workKey: string): Promise<string[][] | null> {
  return window.evaluate((s) => {
    const container = document.querySelector<HTMLElement>(s);
    if (container === null || container.style.visibility === 'hidden') return null;
    const groupsEls = [...container.querySelectorAll('[data-group-id]')];
    // Одна группа — её строка вкладок в заголовке окна (спека 5.3).
    if (groupsEls.length === 1) {
      return [[...document.querySelectorAll('#titlebar-tabs [role="tab"]')].map((tab) => tab.getAttribute('data-tab-id') ?? '')];
    }
    return groupsEls.map((group) => [...group.querySelectorAll('[role="tab"]')].map((tab) => tab.getAttribute('data-tab-id') ?? ''));
  }, containerSel(workKey));
}

interface SavedNode {
  type: 'group' | 'split';
  tabs?: Array<{ id: string }>;
  children?: [SavedNode, SavedNode];
}

function savedTabs(node: SavedNode | undefined): string[][] {
  if (node === undefined) return [];
  if (node.type === 'group') return [(node.tabs ?? []).map((tab) => tab.id)];
  return [...savedTabs(node.children?.[0]), ...savedTabs(node.children?.[1])];
}

test.describe('раскладка на работу переживает перезапуск окна (кусок 2.7)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-layout-'));
    project = await makeTempProject('layout');
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
    return { electronApp, window };
  }

  test('у двух работ разные раскладки; после перезапуска обе на месте по своим работам', async () => {
    let { electronApp, window } = await launch();
    await expect(window.getByTestId('landing')).toBeVisible();

    const workA = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-layout-a', goal: '' });
    const keyA = `${project} ${workA.workId}`;
    const a1 = await createSession(window, workA.workId, 'раз');
    const a2 = await createSession(window, workA.workId, 'два');
    const workB = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-layout-b', goal: '' });
    const keyB = `${project} ${workB.workId}`;
    const b1 = await createSession(window, workB.workId, 'три');
    await expect(window.getByTestId('app-shell')).toBeVisible();

    // Работа A: две группы рядом (⌘D с выбором). Акселератор живёт в нативном
    // меню — действие шлётся тем же IPC, что и из меню.
    await window.locator(rowSel(keyA, a1)).click();
    await electronApp.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('menu:action', 'group.splitRight');
    });
    await window.getByRole('dialog').getByText('S02 два').click();
    const layoutA = [[`terminal:${a1}`], [`terminal:${a2}`]];
    await expect.poll(() => shownLayout(window, keyA)).toEqual(layoutA);

    // Работа B: одна группа с одной вкладкой.
    await window.locator(rowSel(keyB, b1)).click();
    const layoutB = [[`terminal:${b1}`]];
    await expect.poll(() => shownLayout(window, keyB)).toEqual(layoutB);

    // Тишина сохранения — 500 мс на раскладку и 300 мс на активную работу
    // (спека 5.8, план 2.2): закрыть окно только когда обе раскладки и
    // активная работа уже на диске.
    const layoutsFile = path.join(home, 'desktop', 'layouts.json');
    const uiFile = path.join(home, 'desktop', 'ui.json');
    await expect
      .poll(
        async () => {
          try {
            const file = JSON.parse(await readFile(layoutsFile, 'utf8')) as { works: Record<string, { root: SavedNode }> };
            const ui = JSON.parse(await readFile(uiFile, 'utf8')) as { activeWorkKey: string | null };
            return {
              a: savedTabs(file.works[keyA]?.root),
              b: savedTabs(file.works[keyB]?.root),
              active: ui.activeWorkKey,
            };
          } catch {
            return null;
          }
        },
        { timeout: 10_000 },
      )
      .toEqual({ a: layoutA, b: layoutB, active: keyB });

    await electronApp.close();
    app = null;

    ({ electronApp, window } = await launch());
    await expect(window.getByTestId('app-shell')).toBeVisible();

    // Активна последняя активная работа — её раскладка сразу на месте, без клика.
    await expect.poll(() => shownLayout(window, keyB)).toEqual(layoutB);

    // Клик по уже открытой сессии A только делает A активной — вкладка та же,
    // раскладка A восстановлена с диска, а не собрана заново.
    await window.locator(rowSel(keyA, a1)).click();
    await expect.poll(() => shownLayout(window, keyA)).toEqual(layoutA);
  });
});
