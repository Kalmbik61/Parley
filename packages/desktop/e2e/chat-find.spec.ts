import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Поиск ⌘F по ленте вида «Chat» (план 2026-11-01, задача 9). Лента сеется из журнала, как в `chat-view.spec.ts`
 * (настоящий журнал пробы p5b, `providerSessionId` сессии подставляется), но в `toolUseResult.filePath` двух вызовов
 * (`Write` и `Edit`) вписано слово `zebrafish`: оно лежит только внутри вывода вызовов, который в DOM есть лишь у
 * раскрытого вызова, — обычный поиск по странице его бы не нашёл. ⌘F с фокусом в поле сообщения открывает полосу,
 * набранное слово даёт `1/2`, Enter — `2/2`, вызов с совпадением раскрывается и виден на экране, Shift+Enter и Esc
 * возвращают назад и закрывают полосу.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const transcript = path.resolve(dirname, '../../core/src/feed/fixtures/transcript-p5b-write.jsonl');
/** `sessionId` записей журнала пробы p5b. */
const TRANSCRIPT_SESSION_ID = 'a879774d-1db9-4645-af69-cab9e03df081';
const WORD = 'zebrafish';

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

async function providerSessionIdOf(window: Page, ref: Ref): Promise<string | null> {
  const list = await call<{ entries: Array<{ map: { sessions: Array<{ id: string; providerSessionId: string | null }> } }> }>(
    window,
    'works.list',
    {},
  );
  return list.entries.flatMap((entry) => entry.map.sessions).find((candidate) => candidate.id === ref.sessionId)?.providerSessionId ?? null;
}

/** Вхождений в текущей (активной) подсветке поиска; `null` — API подсветки нет. */
async function activeHighlights(window: Page): Promise<number | null> {
  return window.evaluate(() => {
    const registry = (globalThis as unknown as { CSS?: { highlights?: Map<string, Set<unknown>> } }).CSS?.highlights;
    return registry === undefined ? null : (registry.get('chat-find-active')?.size ?? 0);
  });
}

test.describe('поиск ⌘F по ленте Chat (план 2026-11-01, задача 9)', () => {
  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('chat-find');
    project = await makeTempProject('chat-find');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('слово из вывода вызова находится, вызов раскрывается и виден; Enter переходит ко второму', async () => {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_BRACKETED: '1',
    };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
    await expect(window.getByTestId('landing')).toBeVisible();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    const work = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-chat-find', goal: '' });
    const session = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId: work.workId,
      provider: 'claude',
      label: 'chat',
      task: '',
      parent: null,
    });
    const ref = session.ref;

    await expect.poll(() => providerSessionIdOf(window, ref)).not.toBeNull();
    const providerSessionId = (await providerSessionIdOf(window, ref))!;
    const historyRoot = process.env.PARLEY_CLAUDE_PROJECTS_DIR;
    if (historyRoot === undefined) throw new Error('нет PARLEY_CLAUDE_PROJECTS_DIR — global-setup не отработал');
    const dir = path.join(historyRoot, `-e2e-chat-find-${ref.sessionId}-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    // Слово — в `toolUseResult.filePath` двух вызовов (`Write`, `Edit`). Лента берёт вывод вызова из `toolUseResult`, а не из
    // текста `content` для модели («File created successfully…»): он в ленту не попадает, слово там искать нельзя.
    const records = (await readFile(transcript, 'utf8'))
      .replaceAll(TRANSCRIPT_SESSION_ID, providerSessionId)
      .replaceAll('"filePath":"<proj>/notes.txt"', `"filePath":"<proj>/${WORD}-notes.txt"`);
    expect(records.split(WORD)).toHaveLength(3);
    await writeFile(path.join(dir, `${providerSessionId}.jsonl`), records);
    await expect
      .poll(async () => (await call<{ items: unknown[] }>(window, 'feed.snapshot', { ref })).items.length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await expect(chat.getByTestId('chat-prompt').first()).toContainText('notes.txt');
    // Вывод вызовов в DOM нет: ни ход свёрнут, ни вызов не раскрыт.
    await expect(chat.getByTestId('chat-tool-result')).toHaveCount(0);

    // ⌘F с фокусом в поле сообщения (оно же в фокусе после открытия) открывает полосу над лентой.
    const field = chat.getByRole('textbox', { name: 'Message to Claude' });
    await field.focus();
    await window.keyboard.press('Meta+F');
    const bar = chat.getByTestId('chat-find');
    await expect(bar).toBeVisible();
    const input = bar.getByRole('textbox');
    await expect(input).toBeFocused();
    await expect(bar.getByTestId('chat-find-count')).toHaveText('0/0');

    await window.keyboard.type(WORD);
    await expect(bar.getByTestId('chat-find-count')).toHaveText('1/2');
    // Первое совпадение — сверху: вывод `Write`, вызов раскрыт и на экране.
    const results = chat.getByTestId('chat-tool-result');
    const first = results.filter({ hasText: '"type": "create"' });
    await expect(first).toHaveCount(1);
    await expect(first).toContainText(WORD);
    await expect(first).toBeInViewport();
    expect(await activeHighlights(window)).not.toBe(0);

    await window.keyboard.press('Enter');
    await expect(bar.getByTestId('chat-find-count')).toHaveText('2/2');
    const second = results.filter({ hasText: 'newString' });
    await expect(second).toHaveCount(1);
    await expect(second).toContainText(WORD);
    await expect(second).toBeInViewport();

    await window.keyboard.press('Shift+Enter');
    await expect(bar.getByTestId('chat-find-count')).toHaveText('1/2');
    await expect(first).toBeInViewport();

    await window.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect(field).toBeFocused();
    expect(await activeHighlights(window)).not.toBe(1);

    expect(errors).toEqual([]);
  });
});
