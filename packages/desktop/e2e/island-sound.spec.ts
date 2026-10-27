import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Звуки острова (#9 §3, §6.4; план 3b B25): S6 — `AudioContext` острова в состоянии `running` без жеста человека;
 * S1–S3 — по счётчику решений политики `__parleyIslandCues` (`renderer/island/sound/cues.ts`); V1–V3 — голос помощника
 * (`PARLEY_TTS=fake`) и сигналы в одном графе окна.
 *
 * Каркас — как у `island.spec.ts`: остров включается пустым `PARLEY_ISLAND`, главное окно берётся по адресу страницы,
 * остров — по `island.html`. Запросы разрешения и вопросы — живые HTTP-хуки стаба (`STUB_HOOK <json>` в его терминале),
 * начало и конец хода остальных сессий — строки файлового журнала событий, как в `attention.spec.ts`: стаб для них не
 * нужен, а пачку из пяти Done так можно записать разом.
 *
 * Аудио окна острова видно через пробу `AUDIO_PROBE`: скрипт до загрузки страницы оборачивает `AudioContext` и пишет в
 * `globalThis.__e2eAudio` каждый контекст (его состояния и признак жеста на каждой смене), число источников буфера
 * (голос) и осцилляторов (сигналы), а также вызовы `setTargetAtTime` к 0,3 и 1 — так видно приглушение голоса (V2).
 * Остров создаётся при старте, поэтому проба ставится в контекст Playwright, а страница острова перезагружается из main.
 * Любой `evaluate` Playwright идёт с жестом пользователя: до проверки S6 страницу острова читает только main
 * (`executeJavaScript` без жеста).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubEcho = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubAssistant = path.resolve(dirname, 'stub-assistant-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');

const MODEL = 'claude-sonnet-4-5';

const AUDIO_PROBE = `(() => {
  const Native = globalThis.AudioContext;
  if (typeof Native !== 'function' || globalThis.__e2eAudio !== undefined) return;
  const probe = { contexts: [], ducks: [] };
  globalThis.__e2eAudio = probe;
  const entries = new WeakMap();
  globalThis.AudioContext = class extends Native {
    constructor(...args) {
      super(...args);
      const entry = { states: [this.state], activated: [navigator.userActivation.hasBeenActive], sources: 0, oscillators: 0 };
      probe.contexts.push(entry);
      entries.set(this, entry);
      this.addEventListener('statechange', () => {
        entry.states.push(this.state);
        entry.activated.push(navigator.userActivation.hasBeenActive);
      });
    }
    createBufferSource() {
      entries.get(this).sources += 1;
      return super.createBufferSource();
    }
    createOscillator() {
      entries.get(this).oscillators += 1;
      return super.createOscillator();
    }
  };
  const params = new WeakMap();
  let next = 0;
  const setTarget = AudioParam.prototype.setTargetAtTime;
  AudioParam.prototype.setTargetAtTime = function (value, start, constant) {
    if (value === 0.3 || value === 1) {
      if (!params.has(this)) params.set(this, (next += 1));
      probe.ducks.push({ param: params.get(this), value, start });
    }
    return setTarget.call(this, value, start, constant);
  };
})();`;

interface AudioProbe {
  contexts: Array<{ states: string[]; activated: boolean[]; sources: number; oscillators: number }>;
  ducks: Array<{ param: number; value: number; start: number }>;
}

type Verdicts = { play: number; merge: number; skip: number };
type CueCounter = Partial<Record<string, Verdicts>>;

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
    app: { saveUi: (patch: unknown) => Promise<unknown> };
  };
};

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

function islandPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().endsWith('/island.html'));
}

async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  const found = (): Page | undefined =>
    app.windows().find((page) => page.url() !== '' && page.url() !== 'about:blank' && !page.url().endsWith('/island.html'));
  await expect.poll(() => found() !== undefined, { message: 'главное окно загрузилось', timeout: 30_000 }).toBe(true);
  return found()!;
}

async function resizeMain(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().endsWith('/island.html'))
        ?.setBounds({ x: 0, y: 0, ...size }),
    { width, height },
  );
}

/** Выражение в окне острова без жеста пользователя (`executeJavaScript(…, false)` в main); окна нет — `null`. */
async function islandEval<T>(app: ElectronApplication, source: string): Promise<T | null> {
  return (await app.evaluate(async ({ BrowserWindow }, code) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/island.html'));
    return window === undefined ? null : ((await window.webContents.executeJavaScript(code, false)) as unknown);
  }, source)) as T | null;
}

async function audioProbe(app: ElectronApplication): Promise<AudioProbe | null> {
  return islandEval<AudioProbe>(app, 'globalThis.__e2eAudio ?? null');
}

async function cueCounter(app: ElectronApplication): Promise<CueCounter> {
  return (await islandEval<CueCounter>(app, 'globalThis.__parleyIslandCues ?? {}')) ?? {};
}

function verdicts(counter: CueCounter, signal: string): Verdicts {
  return counter[signal] ?? { play: 0, merge: 0, skip: 0 };
}

const total = (row: Verdicts): number => row.play + row.merge + row.skip;

/**
 * Проба аудио в окне острова: скрипт до загрузки любой страницы, затем перезагрузка острова из main — его страница
 * загрузилась раньше, чем тест получил контекст. Ждёт пробу и смонтированный остров.
 */
async function installAudioProbe(app: ElectronApplication): Promise<void> {
  await app.context().addInitScript(AUDIO_PROBE);
  await expect.poll(() => islandPage(app) !== undefined, { message: 'остров создан', timeout: 30_000 }).toBe(true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('/island.html'))
      ?.webContents.reload(),
  );
  await expect
    .poll(() => islandEval<boolean>(app, `typeof globalThis.__e2eAudio === 'object' && document.getElementById('root')?.childElementCount > 0`), {
      message: 'проба аудио в острове',
      timeout: 15_000,
    })
    .toBe(true);
}

/** Наведение на остров: main шлёт то же, что по своему опросу курсора (`island:hover`). */
async function hoverIsland(app: ElectronApplication, hovered: boolean): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, over) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith('/island.html'))
        ?.webContents.send('island:hover', over),
    hovered,
  );
}

/** Строки ответов хоста, записанные стабом в `STUB_HOOK_LOG`. */
async function hookLines(logFile: string, event: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(logFile, 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter((line) => line.includes(`"event":"${event}"`)).length;
}

/** Хук сессии строкой `STUB_HOOK` в терминал стаба; ответа не ждёт. */
async function holdHook(window: Page, ref: Ref, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const body = JSON.stringify({ hook_event_name: event, ...fields });
  await window.evaluate(
    ({ target, data }) => (globalThis as unknown as Parley).parley.notify('pty.input', { ref: target, data }),
    { target: ref, data: `STUB_HOOK ${body}\r` },
  );
}

/** Хук, на который хост отвечает сразу: ждёт его строку в журнале ответов. */
async function fireHook(window: Page, ref: Ref, logFile: string, event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const before = await hookLines(logFile, event);
  await holdHook(window, ref, event, fields);
  await expect.poll(() => hookLines(logFile, event), { message: `ответ хоста на ${event}`, timeout: 15_000 }).toBeGreaterThan(before);
}

/** Событие в файловый журнал сессии: по нему хост считает активность (как `attention.spec.ts`). */
async function journal(ref: Ref, ...events: string[]): Promise<void> {
  const dir = path.join(ref.projectPath, '.parley', 'works', ref.workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${ref.sessionId}.jsonl`), events.map((event) => `${JSON.stringify({ hook_event_name: event })}\n`).join(''));
}

interface LoggedNote {
  title: string;
  silent: boolean;
}

async function loggedNotes(app: ElectronApplication): Promise<LoggedNote[]> {
  return app.evaluate(() =>
    ((globalThis as { __parleyNotifications?: LoggedNote[] }).__parleyNotifications ?? []).map(({ title, silent }) => ({ title, silent })),
  );
}

test.describe('звуки острова', () => {
  test.setTimeout(120_000);

  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('island-sound');
    project = await makeTempProject('island-sound');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(claudeBin: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page; logFile: string }> {
    const logFile = path.join(home, 'hook-log.jsonl');
    const app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_CLAUDE_BIN: claudeBin,
        PARLEY_CODEX_BIN: stubCodex,
        PARLEY_GLM_BIN: path.join(home, 'no-glm'),
        PARLEY_SKIP_VERSION_PROBE: '',
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_ISLAND: '',
        STUB_BRACKETED: '1',
        STUB_HOOK_LOG: logFile,
        ...extraEnv,
      },
    });
    running = app;
    const window = await mainWindowOf(app);
    await resizeMain(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    return { app, window, logFile };
  }

  /** Сессия, открытая во вкладке: её стаб принимает строки STUB_HOOK (чат виден — стаб прошёл старт). */
  async function hookSession(window: Page, workId: string, logFile: string): Promise<Ref> {
    const { ref } = await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'hooks', task: '', parent: null });
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    await expect(window.getByTestId('chat-view')).toBeVisible();
    await fireHook(window, ref, logFile, 'SessionStart', { source: 'startup', model: MODEL, permission_mode: 'default', cwd: project });
    return ref;
  }

  test('S6 и S1–S3: контекст без жеста, сигнал запроса один раз на ключ, Done с беззвучным баннером, пачка Done и бюджет', async () => {
    const { app, window, logFile } = await launch(stubEcho);
    // `shell.beep` main больше не зовёт никто (S1): подмена считает вызовы.
    await app.evaluate(({ shell }) => {
      const target = globalThis as { __e2eBeeps?: number };
      target.__e2eBeeps = 0;
      shell.beep = () => {
        target.__e2eBeeps = (target.__e2eBeeps ?? 0) + 1;
      };
    });
    await window.evaluate(() => (globalThis as unknown as Parley).parley.app.saveUi({ notifications: { finishedSound: true } }));
    await installAudioProbe(app);

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-island-sound', goal: '' });
    const hooks = await hookSession(window, workId, logFile);
    // Пять сессий без вкладок: их Done острову не видно в окне — он выдвигает остров и звучит.
    const quiet: Ref[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { ref } = await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: `done-${i + 1}`, task: '', parent: null });
      quiet.push(ref);
    }

    // S6: первый сигнал острова (разрешение) создаёт контекст — он `running`, и жеста в окне острова не было.
    await holdHook(window, hooks, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'touch /tmp/island-sound-e2e' }, permission_mode: 'default', permission_suggestions: [] });
    await expect
      .poll(async () => (await audioProbe(app))?.contexts[0]?.states.includes('running') ?? false, { message: 'AudioContext острова running', timeout: 15_000 })
      .toBe(true);
    const probe = (await audioProbe(app))!;
    expect(probe.contexts).toHaveLength(1);
    expect(probe.contexts[0]!.activated.every((active) => !active)).toBe(true);
    expect(await islandEval<boolean>(app, 'navigator.userActivation.hasBeenActive')).toBe(false);

    // S1: разрешение прозвучало ровно раз, повтора по тому же ключу нет; `shell.beep` не звал никто.
    const island = islandPage(app)!;
    await expect(island.getByTestId('island-card')).toContainText('Run: touch /tmp/island-sound-e2e');
    await expect.poll(async () => verdicts(await cueCounter(app), 'permission')).toEqual({ play: 1, merge: 0, skip: 0 });
    await island.waitForTimeout(1500);
    expect(verdicts(await cueCounter(app), 'permission')).toEqual({ play: 1, merge: 0, skip: 0 });
    // Вопрос агента — свой сигнал, тоже один раз.
    const questions = [
      {
        question: 'Which database should we use?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'Relational, the default choice' },
          { label: 'SQLite', description: 'Embedded, a single file' },
        ],
        multiSelect: false,
      },
    ];
    await holdHook(window, hooks, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions }, tool_use_id: 'toolu_sound_ask', permission_mode: 'default' });
    await expect.poll(async () => verdicts(await cueCounter(app), 'question'), { timeout: 15_000 }).toEqual({ play: 1, merge: 0, skip: 0 });

    // S3: пять сессий работают, затем пять Done разом — один звук, четыре слиты.
    for (const ref of quiet) await journal(ref, 'UserPromptSubmit');
    for (const ref of quiet) {
      await expect(window.locator(`[data-session-id="${ref.sessionId}"] [data-state="working"]`).first()).toBeVisible({ timeout: 15_000 });
    }
    const start = Date.now();
    await Promise.all(quiet.map((ref) => journal(ref, 'Stop')));
    await expect.poll(async () => total(verdicts(await cueCounter(app), 'done')), { message: 'пять решений Done', timeout: 10_000 }).toBe(5);
    expect(verdicts(await cueCounter(app), 'done')).toEqual({ play: 1, merge: 4, skip: 0 });
    // Разрешение сразу после пачки звучит: остывание Done его не держит.
    await holdHook(window, hooks, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'pwd' }, permission_mode: 'default', permission_suggestions: [] });
    await expect.poll(async () => verdicts(await cueCounter(app), 'permission'), { timeout: 15_000 }).toEqual({ play: 2, merge: 0, skip: 0 });

    // S2: остров сыграл Done — баннеры этих Done беззвучны.
    await expect.poll(async () => (await loggedNotes(app)).filter((note) => note.title.endsWith('finished')).length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect((await loggedNotes(app)).filter((note) => note.title.endsWith('finished') && !note.silent)).toEqual([]);

    // S3, бюджет: Done через 2,4 и 4,8 с звучат (остывание 2 с прошло), четвёртый звук Done за 10 с — нет.
    for (const [index, at] of [2400, 4800, 7200].entries()) {
      const wait = start + at - Date.now();
      if (wait > 0) await island.waitForTimeout(wait);
      await journal(quiet[index]!, 'UserPromptSubmit', 'Stop');
      await expect.poll(async () => total(verdicts(await cueCounter(app), 'done')), { message: `Done №${index + 2}`, timeout: 5_000 }).toBe(6 + index);
    }
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(verdicts(await cueCounter(app), 'done')).toEqual({ play: 3, merge: 4, skip: 1 });
    expect(await app.evaluate(() => (globalThis as { __e2eBeeps?: number }).__e2eBeeps)).toBe(0);
  });

  test('V1–V3: голос и сигналы в одном AudioContext; разрешение под речью звучит и опускает голос; наведение под речью молчит; лицо остаётся лицом', async () => {
    const { app, window, logFile } = await launch(stubAssistant, { PARLEY_TTS: 'fake', PARLEY_VOICE: 'fake' });
    await window.evaluate(() =>
      (globalThis as unknown as Parley).parley.app.saveUi({
        assistant: { enabled: true, provider: 'claude', speak: true, language: 'en' },
        // Звуки интерфейса включены: наведение молчит только из-за речи (#9 §6.4).
        island: { sound: { palette: 'soft', volume: 0.6, ui: true } },
      }),
    );
    await installAudioProbe(app);
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-island-voice', goal: '' });
    const hooks = await hookSession(window, workId, logFile);

    // Помощник: палитра ⌘J → «Ask the assistant»; долгий ответ из 24 предложений — лицо говорит около 10 с.
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type('Ask the assistant');
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText('Ask the assistant');
    await window.keyboard.press('Enter');
    const island = islandPage(app)!;
    await expect(island.getByTestId('assistant-view')).toBeVisible();
    await island.getByTestId('assistant-input').fill('speak long');
    await island.getByTestId('assistant-input').press('Enter');
    const face = island.getByTestId('assistant-view').getByTestId('swarm');
    await expect(face).toHaveAttribute('data-shape', 'face', { timeout: 30_000 });
    await expect.poll(async () => verdicts(await cueCounter(app), 'speak').play, { message: 'сигнал начала речи' }).toBe(1);

    // Микро под речью молчит: наведение решено политикой как «пропуск».
    await hoverIsland(app, true);
    await expect.poll(async () => verdicts(await cueCounter(app), 'hover'), { message: 'наведение под речью' }).toEqual({ play: 0, merge: 0, skip: 1 });
    await hoverIsland(app, false);

    // V2: разрешение во время речи звучит в полную силу и опускает голос до 30 % на 0,7 с.
    await holdHook(window, hooks, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default', permission_suggestions: [] });
    await expect.poll(async () => verdicts(await cueCounter(app), 'permission'), { timeout: 15_000 }).toEqual({ play: 1, merge: 0, skip: 0 });
    await expect(island.getByTestId('assistant-status')).toHaveText('Speaking');
    await expect
      .poll(async () => {
        const ducks = (await audioProbe(app))?.ducks ?? [];
        return ducks.some((down) => down.value === 0.3 && ducks.some((up) => up.param === down.param && up.value === 1 && Math.abs(up.start - down.start - 0.7) < 0.01));
      }, { message: 'голос опущен до 0,3 и возвращён через 0,7 с' })
      .toBe(true);

    // V3: реакция на запрос лицо не сдвигает — рой остаётся лицом.
    await expect(face).toHaveAttribute('data-shape', 'face');
    await island.waitForTimeout(300);
    await expect(face).toHaveAttribute('data-shape', 'face');

    // V1: один контекст на окно — в нём и голос (источники буфера), и сигналы (осцилляторы).
    const probe = (await audioProbe(app))!;
    expect(probe.contexts).toHaveLength(1);
    expect(probe.contexts[0]!.sources).toBeGreaterThan(0);
    expect(probe.contexts[0]!.oscillators).toBeGreaterThan(0);
  });
});
