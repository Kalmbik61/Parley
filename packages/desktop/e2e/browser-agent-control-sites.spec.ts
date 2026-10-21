import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Агент и внешние сайты, скрипты, куки, хранилище, файлы (этап D, план 2026-10-20-browser-agent-control-plan.md, задача 22b):
 * `browser_evaluate`, `browser_cookies`, `browser_storage`, `browser_downloads`, `browser_action upload` настоящего
 * `parley-mcp` через настоящий эндпоинт хоста и настоящее окно (каркас — `browser-agent-control.spec.ts`).
 * - внешний сайт (не loopback, `--host-resolver-rules`): чтения работают, секреты замаскированы (Фокус ревью 6);
 * - скрипт: значение, исключение, `timeout`, пауза и выключатель посреди скрипта (Фокус ревью 3);
 * - куки и хранилище только текущей страницы; значения httpOnly-кук не отдаются никогда (Фокус ревью 4);
 * - выбор файла перехвачен, загрузка файла, скачивание агента — в папку сессии, скачивание человека — диалог (Фокус ревью 5, 7).
 * Секретные места загрузки (`~/.ssh` и прочее) проверяют модульные тесты задачи 17: настоящий `~/.ssh` E2E не трогает.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

/** Внешнее имя сайта: `--host-resolver-rules` отправляет его на локальный сервер (спайк В13). */
const EXTERNAL_HOST = 'example.test';
const HOST_RULES = `--host-resolver-rules=MAP ${EXTERNAL_HOST} 127.0.0.1`;

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
    app: { saveUi: (patch: unknown) => Promise<unknown> };
  };
};

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

/** JS в мире страницы гостя — только у теста: окну и агенту этого не дано. Адрес гостя — точный. */
async function guestEval<T>(app: ElectronApplication, url: string, code: string): Promise<T | null> {
  return app.evaluate(
    async ({ webContents }, [u, c]) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === 'webview' && item.getURL() === u);
      return guest === undefined ? null : ((await guest.executeJavaScript(c)) as unknown);
    },
    [url, code] as const,
  ) as Promise<T | null>;
}

const FORM_HTML = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Form page</title><h1>Form page</h1>
<label>Name <input id="name" aria-label="Name" autocomplete="off"></label>
<label>API key <input id="key" aria-label="API key" value="SECRET8"></label>
<button id="save">Save</button>
<script>
console.error('token=SECRET5');
fetch('/api/me?access_token=SECRET6').catch(() => {});
</script>`;

const STATE_HTML = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>State page</title><h1>State page</h1>
<button id="ok">Ok</button>
<script>
window.__state = { user: 'ann' };
document.cookie = 'theme=dark; path=/';
localStorage.setItem('k', 'v');
</script>`;

const FILES_HTML = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Files page</title><h1>Files page</h1>
<input type="file" id="files" aria-label="Files" multiple><div id="names"></div>
<a id="dl" href="/report.csv">Report</a>
<script>
document.getElementById('files').addEventListener('change', (e) => {
  document.getElementById('names').textContent = Array.from(e.target.files).map((f) => f.name).join(',');
});
</script>`;

test.describe('агент: внешний сайт, скрипт, куки, хранилище, файлы (этап D, 22b)', () => {
  test.setTimeout(180_000);
  let home: string;
  let project: string;
  let server: Server;
  let port: number;
  let origin: string;
  let mcpLog: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('browser-agent-sites');
    project = await makeTempProject('browser-agent-sites');
    mcpLog = path.join(home, 'mcp.jsonl');
    await writeFile(path.join(project, 'PARLEY.md'), 'E2E project rules.\n');
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      const html = (body: string, headers: Record<string, string | string[]> = {}): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body);
      };
      if (url.startsWith('/api/me')) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"no session"}');
      } else if (url.startsWith('/state')) {
        html(STATE_HTML, { 'set-cookie': 'sid=S3SS; HttpOnly; Path=/' });
      } else if (url.startsWith('/human')) {
        html('<!doctype html><title>Human page</title><h1>Human page</h1>', { 'set-cookie': 'human=1; Path=/' });
      } else if (url.startsWith('/files')) {
        html(FILES_HTML);
      } else if (url.startsWith('/report.csv')) {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' }).end('a,b\n1,2\n');
      } else {
        html(FORM_HTML);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Окно и ведущая сессия на экране (как в `browser-agent-control.spec.ts`); `PARLEY_DOWNLOADS=log` — диалог скачивания человека подменён журналом. */
  async function openApp(launchArgs: string[] = []) {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: path.join(home, 'no-codex'),
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_DOWNLOADS: 'log',
      STUB_BRACKETED: '1',
      STUB_MCP_LOG: mcpLog,
      PARLEY_SKIP_VERSION_PROBE: '',
    };
    const electronApp = await electron.launch({ args: [mainEntry, ...launchArgs], env });
    app = electronApp;
    electronApp.on('window', (page) => page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {})));
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    await call(window, 'wake.pause', {});

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-agent-sites', goal: '' });
    const lead = (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'lead', task: '', parent: null })).ref.sessionId;
    const workKey = `${project} ${workId}`;
    const row = window.locator(`[data-work-key="${workKey}"] [data-session-id="${lead}"]`);
    await row.click();
    await expect(row).not.toContainText('not started', { timeout: 20_000 });
    await window.waitForTimeout(800);
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { electronApp, window, lead, workId };
  }

  type Opened = Awaited<ReturnType<typeof openApp>>;

  /** Инструмент агента `session`: строка `STUB_MCP` в его терминал, результат — из журнала заглушки. */
  async function agentTool({ window, workId }: Opened, session: string, tool: string, args: Record<string, unknown> = {}): Promise<McpResult> {
    const before = (await readLines<McpResult>(mcpLog)).length;
    await window.evaluate(
      ([ref, line]) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data: line }),
      [{ projectPath: project, workId, sessionId: session }, `STUB_MCP ${tool} ${JSON.stringify(args)}\r`] as const,
    );
    await expect.poll(async () => (await readLines<McpResult>(mcpLog)).length, { timeout: 60_000 }).toBeGreaterThan(before);
    const entry = (await readLines<McpResult>(mcpLog))[before] as McpResult;
    expect(entry.session).toBe(session);
    expect(entry.tool).toBe(tool);
    return entry;
  }

  /** `browser_open` и id открытой страницы из ответа (инструмент ждёт загрузку). */
  async function openPage(opened: Opened, session: string, args: Record<string, unknown>): Promise<string> {
    const result = await agentTool(opened, session, 'browser_open', args);
    expect(result.isError, result.text).toBe(false);
    const id = /Opened (t\d+):/.exec(result.text)?.[1];
    expect(id, result.text).toBeDefined();
    return id as string;
  }

  const panelOf = (window: Page, owner: string) => window.locator(`[data-testid="browser-panel"][data-panel-owner="${owner}"]`);

  /** Панель чата открыта и показывает активную страницу: человек её видел (`seen`). */
  async function showPanel(window: Page, lead: string) {
    const panel = panelOf(window, `session:${lead}`);
    if (!(await panel.isVisible())) await window.getByRole('button', { name: 'Browser', exact: true }).first().click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-testid="browser-field"]:visible')).toHaveCount(1);
    return panel;
  }

  /** Ссылка `eN` из `browser_snapshot` по роли и имени. */
  async function refOf(opened: Opened, session: string, tab: string, role: string, name: string): Promise<string> {
    const snapshot = await agentTool(opened, session, 'browser_snapshot', { tab, interactiveOnly: true });
    expect(snapshot.isError, snapshot.text).toBe(false);
    const ref = new RegExp(`\\[ref=(e\\d+)\\] ${role} "${name}"`).exec(snapshot.text)?.[1];
    expect(ref, snapshot.text).toBeDefined();
    return ref as string;
  }

  const sessionDirs = async (): Promise<string[]> => {
    const root = path.join(home, 'desktop', 'agent-downloads');
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory()) await walk(path.join(dir, entry.name));
        else files.push(path.join(dir, entry.name));
      }
    };
    await walk(root);
    return files;
  };

  test('внешний сайт (не loopback): snapshot, console, network, screenshot работают, секреты — маской (Фокус ревью 6)', async () => {
    const opened = await openApp([HOST_RULES]);
    const { window, lead } = opened;
    const tab = await openPage(opened, lead, { url: `http://${EXTERNAL_HOST}:${port}/form?token=SECRET7`, own: true });
    await showPanel(window, lead);

    const snapshot = await agentTool(opened, lead, 'browser_snapshot', { tab });
    expect(snapshot.isError, snapshot.text).toBe(false);
    expect(snapshot.text).toContain('Form page');
    expect(snapshot.text).not.toContain('SECRET7');

    let consoleText = '';
    await expect
      .poll(async () => (consoleText = (await agentTool(opened, lead, 'browser_console', { tab })).text), { timeout: 20_000 })
      .toContain('<redacted>');
    expect(consoleText).not.toContain('SECRET5');
    let network = '';
    await expect
      .poll(async () => (network = (await agentTool(opened, lead, 'browser_network', { tab })).text), { timeout: 20_000 })
      .toContain('/api/me');
    expect(network).not.toContain('SECRET6');
    expect(network).toContain('<redacted>');

    const tabs = await agentTool(opened, lead, 'browser_tabs');
    expect(tabs.isError, tabs.text).toBe(false);
    expect(tabs.text).not.toContain('SECRET7');
    const shot = await agentTool(opened, lead, 'browser_screenshot', { tab });
    expect(shot.isError, shot.text).toBe(false);
  });

  test('значение поля «API key» в дереве доступности маскируется и в дочернем тексте (Фокус ревью 6)', async () => {
    // Дочерний `StaticText` секретного поля повторял его значение — этот тест нашёл утечку; `ax-snapshot.ts` детей такого поля не обходит.
    const opened = await openApp([HOST_RULES]);
    const { window, lead } = opened;
    const tab = await openPage(opened, lead, { url: `http://${EXTERNAL_HOST}:${port}/form`, own: true });
    await showPanel(window, lead);
    const snapshot = await agentTool(opened, lead, 'browser_snapshot', { tab });
    expect(snapshot.isError, snapshot.text).toBe(false);
    expect(snapshot.text).toContain('API key');
    expect(snapshot.text).not.toContain('SECRET8');
  });

  test('скрипт: значение, исключение, timeout; пауза и выключатель посреди скрипта (Фокус ревью 3)', async () => {
    const opened = await openApp();
    const { window, lead } = opened;
    const tab = await openPage(opened, lead, { url: `${origin}/state`, own: true });
    const panel = await showPanel(window, lead);

    const value = await agentTool(opened, lead, 'browser_evaluate', { tab, expression: 'window.__state' });
    expect(value.isError, value.text).toBe(false);
    expect(value.text).toContain('{"user":"ann"}');
    const thrown = await agentTool(opened, lead, 'browser_evaluate', { tab, expression: 'foo' });
    expect(thrown.isError, thrown.text).toBe(false);
    expect(thrown.text).toContain('The script threw');

    // Бесконечный цикл обрывается по сроку; страница жива — клик по кнопке проходит.
    const looped = await agentTool(opened, lead, 'browser_evaluate', { tab, expression: 'while (true) {}' });
    expect(looped.isError, looped.text).toBe(true);
    expect(looped.text).toMatch(/^timeout:/);
    const ok = await refOf(opened, lead, tab, 'button', 'Ok');
    const clicked = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: ok });
    expect(clicked.isError, clicked.text).toBe(false);

    // Пауза панели: скрипт не уходит в страницу.
    const toggle = async (item: string): Promise<void> => {
      await panel.getByRole('button', { name: 'More browser actions' }).click();
      await window.getByRole('menuitem', { name: item }).click();
    };
    await toggle('Pause agents');
    await expect(panel).toHaveAttribute('data-agents-paused', 'true');
    const paused = await agentTool(opened, lead, 'browser_evaluate', { tab, expression: '1 + 1' });
    expect(paused.isError, paused.text).toBe(true);
    expect(paused.text).toMatch(/^access_denied:/);
    await toggle('Resume agents');
    await expect(panel).not.toHaveAttribute('data-agents-paused', 'true');

    // Выключатель «Let agents use the browser» посреди зависшего скрипта: результата нет, агенту access_denied.
    const hanging = agentTool(opened, lead, 'browser_evaluate', { tab, expression: 'new Promise(() => {})' });
    await expect(panel.getByTestId('agent-badge')).toBeVisible({ timeout: 15_000 });
    await window.evaluate(() => (globalThis as unknown as Parley).parley.app.saveUi({ browser: { devtoolsHeight: null, agentsAllowed: false } }));
    const denied = await hanging;
    expect(denied.isError, denied.text).toBe(true);
    expect(denied.text).toMatch(/^access_denied:/);
  });

  test('куки и хранилище: только страница агента, значения httpOnly не отдаются (Фокус ревью 4)', async () => {
    const opened = await openApp([HOST_RULES]);
    const { window, lead, electronApp } = opened;

    const url = `${origin}/state`;
    const tab = await openPage(opened, lead, { url, own: true });
    await showPanel(window, lead);

    // Вкладка человека на другом адресе со своей кукой `human=1`.
    const humanUrl = `http://${EXTERNAL_HOST}:${port}/human`;
    await window.getByRole('button', { name: 'Open…' }).first().click();
    await window.locator('[data-palette] [role="option"]', { hasText: 'New browser tab' }).click();
    const address = window.getByRole('textbox', { name: 'Address' });
    await expect(address).toBeFocused();
    await address.fill(humanUrl);
    await address.press('Enter');
    await expect.poll(() => guestEval<string>(electronApp, humanUrl, 'document.cookie')).toContain('human=1');

    const list = await agentTool(opened, lead, 'browser_cookies', { tab, action: 'list' });
    expect(list.isError, list.text).toBe(false);
    expect(list.text).toMatch(/(^|\n)theme /);
    expect(list.text).toMatch(/(^|\n)sid .*httpOnly/);
    expect(list.text).not.toContain('dark');
    expect(list.text).not.toContain('S3SS');
    expect(list.text).not.toMatch(/(^|\n)human/);

    const values = await agentTool(opened, lead, 'browser_cookies', { tab, action: 'list', values: true });
    expect(values.isError, values.text).toBe(false);
    expect(values.text).toContain('theme=dark');
    expect(values.text).toContain('sid=<httpOnly: hidden>');
    expect(values.text).not.toContain('S3SS');
    expect(values.text).not.toMatch(/(^|\n)human/);

    const set = await agentTool(opened, lead, 'browser_cookies', { tab, action: 'set', name: 'extra', value: '1' });
    expect(set.isError, set.text).toBe(false);
    expect(await guestEval<string>(electronApp, url, 'document.cookie')).toContain('extra=1');

    const removed = await agentTool(opened, lead, 'browser_cookies', { tab, action: 'delete', name: 'sid' });
    expect(removed.isError, removed.text).toBe(false);
    const after = await agentTool(opened, lead, 'browser_cookies', { tab, action: 'list' });
    expect(after.text).not.toMatch(/(^|\n)sid /);
    expect(after.text).toMatch(/(^|\n)theme /);

    // localStorage: видно и в госте.
    const stored = await agentTool(opened, lead, 'browser_storage', { tab, area: 'local', action: 'list' });
    expect(stored.isError, stored.text).toBe(false);
    expect(stored.text).toContain('k = v');
    const put = await agentTool(opened, lead, 'browser_storage', { tab, area: 'local', action: 'set', key: 'k2', value: 'v2' });
    expect(put.isError, put.text).toBe(false);
    expect(await guestEval<string>(electronApp, url, "localStorage.getItem('k2')")).toBe('v2');
    const got = await agentTool(opened, lead, 'browser_storage', { tab, area: 'local', action: 'get', key: 'k2' });
    expect(got.text).toContain('v2');
    const cleared = await agentTool(opened, lead, 'browser_storage', { tab, area: 'local', action: 'clear' });
    expect(cleared.isError, cleared.text).toBe(false);
    expect(await guestEval<number>(electronApp, url, 'localStorage.length')).toBe(0);
  });

  test('файлы: выбор файла перехвачен, upload кладёт файл, скачивание агента — в папку сессии, человека — диалог (Фокус ревью 5, 7)', async () => {
    const opened = await openApp();
    const { window, lead, electronApp } = opened;
    const url = `${origin}/files`;
    const tab = await openPage(opened, lead, { url, own: true });
    const panel = await showPanel(window, lead);
    const files = await refOf(opened, lead, tab, 'button', 'Files');

    // Клик по полю файла: системного окна нет, файлов нет, агенту заметка.
    const clicked = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: files });
    expect(clicked.isError, clicked.text).toBe(false);
    expect(clicked.text).toContain('file chooser');
    expect(clicked.text).toContain('upload');
    expect(await guestEval<number>(electronApp, url, "document.getElementById('files').files.length")).toBe(0);

    const payload = path.join(project, 'upload-me.txt');
    await writeFile(payload, 'hello');
    const uploaded = await agentTool(opened, lead, 'browser_action', { tab, action: 'upload', ref: files, files: [payload] });
    expect(uploaded.isError, uploaded.text).toBe(false);
    expect(await guestEval<string>(electronApp, url, "document.getElementById('names').textContent")).toBe('upload-me.txt');

    // Скачивание по клику агента — в папку сессии без диалога.
    const link = await refOf(opened, lead, tab, 'link', 'Report');
    const downloaded = await agentTool(opened, lead, 'browser_action', { tab, action: 'click', ref: link });
    expect(downloaded.isError, downloaded.text).toBe(false);
    expect(downloaded.text).toContain('agent-downloads');
    await expect.poll(sessionDirs).toHaveLength(1);
    const [saved] = await sessionDirs();
    expect(path.basename(saved as string)).toBe('report.csv');
    expect(await readFile(saved as string, 'utf8')).toBe('a,b\n1,2\n');
    let listed = '';
    await expect
      .poll(async () => (listed = (await agentTool(opened, lead, 'browser_downloads')).text), { timeout: 20_000 })
      .toContain('completed');
    expect(listed).toContain('report.csv');
    const log = (): Promise<unknown[]> => electronApp.evaluate(() => (globalThis as { __parleyDownloads?: unknown[] }).__parleyDownloads ?? []);
    expect(await log()).toEqual([]);

    // Хвост окна операции кончился (значок пропал): скачивание по клику человека — диалог, в папке агента нового файла нет.
    await expect(panel.getByTestId('agent-badge')).toHaveCount(0, { timeout: 15_000 });
    const at = (await guestEval<{ x: number; y: number }>(
      electronApp,
      url,
      "(() => { const r = document.getElementById('dl').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
    )) as { x: number; y: number };
    // Мышь Playwright до содержимого гостя не доходит (см. 22a): клик человека — событие мыши самого гостя.
    await electronApp.evaluate(({ webContents }, [u, x, y]) => {
      const guest = webContents.getAllWebContents().find((c) => c.getType() === 'webview' && c.getURL() === u);
      guest?.sendInputEvent({ type: 'mouseDown', x: x as number, y: y as number, button: 'left', clickCount: 1 });
      guest?.sendInputEvent({ type: 'mouseUp', x: x as number, y: y as number, button: 'left', clickCount: 1 });
    }, [url, at.x, at.y] as const);
    await expect.poll(log, { timeout: 15_000 }).toEqual([{ filename: 'report.csv', url: `${origin}/report.csv` }]);
    expect(await sessionDirs()).toHaveLength(1);
  });
});
