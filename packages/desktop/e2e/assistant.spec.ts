import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Помощник на острове (спека 2026-10-14): палитра «Ask the assistant» → вид помощника на острове → вопрос → карточка с письмом
 * в комнату → Send → в комнате письмо «You (via assistant)» со значком помощника → письмо агенту комнаты с упоминанием →
 * второй вопрос и ответ → вопрос виден сразу, пока ход думает, сообщения ждут «Queued» и уходят одним ходом → то же при
 * замороженном хосте → Esc.
 * Вместо `claude` — `stub-assistant-agent.mjs`: ход помощника он ведёт по-настоящему через маршруты хоста (обзор,
 * предложение письма), сессии работы и `--version` уходят в обычную заглушку. Каркас — как у `island.spec.ts`:
 * остров включается пустым `PARLEY_ISLAND` (конфиг Playwright гасит его для всех спеков), главное окно берётся по
 * адресу страницы, остров — по `island.html`. Работа и комната — шаги `room-actions.spec.ts`; названия длинные
 * (правило визуальных проверок), окно 800×500.
 *
 * Речь и лицо (план 3b B25; план 3, Task 10; #9 §6): `PARLEY_TTS=fake` — голос на подмене без движка и весов (каждое
 * предложение — два куска тишины по 0,2 с), `PARLEY_VOICE=fake` — голосовой ввод на подмене. Стаб ставит метку эмоции в
 * каждое предложение. Облик роя и подпись под ним пишет в журнал страницы `MutationObserver`: смены `data-shape` и
 * `data-emo` короче опроса Playwright. Хоткей помощника — то же событие main, что шлёт глобальное сочетание
 * (`island:assistant-open` с `listen: true`): настоящее сочетание ОС тест нажать не может. G3 (голос не скачан) идёт
 * без `PARLEY_TTS`: настоящая служба голоса с пустым домом теста, веса никто не качает.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-assistant-agent.mjs');

const WORK_TITLE = 'A very long workspace title for the assistant end-to-end check';
const ROOM_TITLE = 'A very long room title that should not break the island layout';
const LETTER = 'Skip the Safari tests.';

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    app: { saveUi: (patch: unknown) => Promise<unknown> };
  };
};

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

/** Страница острова, если его окно есть; нет окна — `undefined`. */
function islandPage(app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().endsWith('/island.html'));
}

/** Главное окно: страница загружена и это не остров (остров создаётся вместе с ним и мог оказаться первым). */
async function mainWindowOf(app: ElectronApplication): Promise<Page> {
  const found = (): Page | undefined =>
    app.windows().find((page) => page.url() !== '' && page.url() !== 'about:blank' && !page.url().endsWith('/island.html'));
  await expect.poll(() => found() !== undefined, { message: 'главное окно загрузилось', timeout: 30_000 }).toBe(true);
  return found()!;
}

/** Размер главного окна: `getAllWindows()[0]` мог бы оказаться островом, у которого размер ведёт его содержимое. */
async function resizeMain(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()
        .find((window) => !window.webContents.getURL().endsWith('/island.html'))
        ?.setBounds({ x: 0, y: 0, ...size }),
    { width, height },
  );
}

/** Голос и голосовой ввод на подменах (план 3b B25). */
const SPEECH_ENV = { PARLEY_TTS: 'fake', PARLEY_VOICE: 'fake' };
/** Строка, которой хост предваряет ход после смены рода голоса (#9 §6.8, Р3). */
const MALE_NOTE = '[system: voice changed — speak as male]';

/** Запись журнала облика: форма роя помощника, эмоция лица и подпись под роем. */
interface FaceEntry {
  shape: string;
  emo: string | null;
  status: string;
}

/**
 * Журнал облика роя помощника: `MutationObserver` на canvas роя и на подписи пишет каждую смену формы, эмоции и
 * подписи в `globalThis.__e2eFace`. Смена эмоции между предложениями длится доли секунды — опрос её пропустил бы.
 */
async function recordFace(island: Page): Promise<void> {
  await island.evaluate(() => {
    const view = document.querySelector('[data-testid="assistant-view"]');
    const canvas = view?.querySelector<HTMLElement>('[data-testid="swarm"]');
    const status = view?.querySelector('[data-testid="assistant-status"]');
    if (canvas === null || canvas === undefined || status === null || status === undefined) throw new Error('нет роя или подписи помощника');
    const log: FaceEntry[] = [];
    (globalThis as { __e2eFace?: FaceEntry[] }).__e2eFace = log;
    const push = (): void => {
      const entry = { shape: canvas.dataset.shape ?? '', emo: canvas.dataset.emo ?? null, status: status.textContent ?? '' };
      const last = log.at(-1);
      if (last?.shape !== entry.shape || last.emo !== entry.emo || last.status !== entry.status) log.push(entry);
    };
    push();
    new MutationObserver(push).observe(canvas, { attributes: true, attributeFilter: ['data-shape', 'data-emo'] });
    new MutationObserver(push).observe(status, { childList: true, subtree: true, characterData: true });
  });
}

async function faceLog(island: Page): Promise<FaceEntry[]> {
  return island.evaluate(() => (globalThis as { __e2eFace?: FaceEntry[] }).__e2eFace ?? []);
}

/** Подряд идущие повторы — одним значением. */
function runs<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => index === 0 || values[index - 1] !== value);
}

/** Хоткей помощника: main шлёт острову то же событие, что и на глобальное сочетание (`openAssistant({ listen: true })`). */
async function pressAssistantHotkey(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('/island.html'))
      ?.webContents.send('island:assistant-open', { listen: true }),
  );
}

async function ask(island: Page, text: string): Promise<void> {
  await island.getByTestId('assistant-input').fill(text);
  await island.getByTestId('assistant-input').press('Enter');
}

test.describe('помощник на острове', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('assistant');
    project = await makeTempProject('assistant');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('вопрос → карточка с письмом комнате → Send → «You (via assistant)» в комнате → ответ → Esc', async () => {
    test.setTimeout(120_000);
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_CLAUDE_BIN: stubAgent,
        PARLEY_GLM_BIN: path.join(home, 'no-glm'),
        // Проба версий включена: помощник требует claude 2.1.300, версию отдаёт стаб.
        PARLEY_SKIP_VERSION_PROBE: '',
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_ISLAND: '',
      },
    });
    const window = await mainWindowOf(app);
    await resizeMain(app, 800, 500);
    await expect(window.getByTestId('landing')).toBeVisible();

    // 1. Помощник выключен по умолчанию — включаем.
    await window.evaluate(() => (globalThis as unknown as Parley).parley.app.saveUi({ assistant: { enabled: true, provider: 'claude' } }));

    // 2. Работа и комната с одной сессией.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'planner',
      task: '',
      parent: null,
    });
    const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
      projectPath: project,
      workId,
      title: ROOM_TITLE,
      members: [ref.sessionId],
      lead: ref.sessionId,
      quiet: true,
    });

    // Снимок работ хоста обновляется из файлов с задержкой, а помощник смотрит именно его: ждём комнату в снимке,
    // иначе его обзор ещё не знает комнаты и ответ — «Nothing is open right now».
    type WorksList = { entries: Array<{ map: { work: { id: string }; rooms: unknown[] } }> };
    await expect
      .poll(
        async () => (await call<WorksList>(window, 'works.list', {})).entries.find((entry) => entry.map.work.id === workId)?.map.rooms.length ?? 0,
        { message: 'комната в снимке работ хоста', timeout: 30_000 },
      )
      .toBe(1);

    // 3. Палитра ⌘J → «Ask the assistant» → на острове вид помощника.
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type('Ask the assistant');
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText('Ask the assistant');
    await window.keyboard.press('Enter');
    await expect.poll(() => islandPage(app!) !== undefined, { message: 'остров создан' }).toBe(true);
    const island = islandPage(app)!;
    await expect(island.getByTestId('assistant-view')).toBeVisible();

    // 4. Просьба передать письмо → карточка → Send (кнопка взводится через 500 мс) → «Sent».
    await island.getByTestId('assistant-input').fill('tell the room to skip Safari tests');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-card')).toContainText(LETTER, { timeout: 30_000 });
    await island.waitForTimeout(600);
    await island.getByTestId('assistant-send').click();
    await expect(island.getByTestId('assistant-sent')).toBeVisible();

    // 5. В главном окне открыта комната: последнее письмо — от человека через помощника, со значком помощника.
    const row = window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"]) [data-room-row="${roomId}"]`);
    await expect(row).toHaveCount(1);
    await row.click();
    const letter = window.locator('[data-room-feed] [data-message-id]').filter({ hasText: LETTER }).last();
    await expect(letter).toBeVisible();
    await expect(letter.locator('[data-message-meta]')).toContainText('You (via assistant)');
    await expect(letter.locator('[data-assistant-mark]')).toHaveCount(1);

    // 5а. Письмо агенту через комнату: на карточке чип упомянутого, в ленте комнаты — чип упоминания у письма.
    await island.getByTestId('assistant-input').fill('mention tell the planner to skip Safari tests');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-mention')).toContainText('@', { timeout: 30_000 });
    await island.waitForTimeout(600);
    await island.getByTestId('assistant-send').click();
    await expect(island.getByTestId('assistant-sent')).toBeVisible();
    const mentioned = window.locator('[data-room-feed] [data-message-id]').filter({ hasText: LETTER }).last();
    await expect(mentioned.locator(`[data-mention="${ref.sessionId}"]`)).toHaveCount(1);

    // 6. Второй вопрос — ответ текстом.
    await island.getByTestId('assistant-input').fill('what is going on?');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-answer')).toContainText('The room is working.', { timeout: 30_000 });

    // 6а. Вопрос виден сразу; пока ход думает, следующие сообщения ждут серыми «Queued» и уходят вместе одним ходом.
    await island.getByTestId('assistant-input').fill('slow what is going on?');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-question')).toHaveText('slow what is going on?');
    await island.getByTestId('assistant-input').fill('echo first');
    await island.getByTestId('assistant-input').press('Enter');
    await island.getByTestId('assistant-input').fill('echo second');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-queued')).toHaveCount(2);
    await expect(island.getByTestId('assistant-answer')).toContainText('Got: echo first | echo second', { timeout: 30_000 });
    await expect(island.getByTestId('assistant-queued')).toHaveCount(0);
    // Ответ, который сменила очередь, не пропал: он выше, в истории.
    await expect(island.getByTestId('assistant-history').last()).toContainText('The room is working.');

    // 6б. Хост стоит (под нагрузкой его цикл событий занят секундами; здесь процесс заморожен): вопрос всё равно виден
    // сразу с «Sending…», следующее сообщение ждёт в очереди, а ответы приходят, когда хост оживает.
    const hostPid = Number((await readFile(path.join(home, 'host', 'host.pid'), 'utf8')).split('\n')[0]);
    process.kill(hostPid, 'SIGSTOP');
    try {
      await island.getByTestId('assistant-input').fill('echo while the host is busy');
      await island.getByTestId('assistant-input').press('Enter');
      await expect(island.getByTestId('assistant-question')).toHaveText('echo while the host is busy', { timeout: 1000 });
      await expect(island.getByTestId('assistant-status')).toHaveText('Sending…');
      await island.getByTestId('assistant-input').fill('echo and one more');
      await island.getByTestId('assistant-input').press('Enter');
      await expect(island.getByTestId('assistant-queued')).toHaveCount(1);
    } finally {
      process.kill(hostPid, 'SIGCONT');
    }
    await expect(island.getByTestId('assistant-answer')).toContainText('Got: echo and one more', { timeout: 30_000 });
    await expect(island.getByTestId('assistant-history').last()).toContainText('Got: echo while the host is busy');
    // Выше история, а ответ дописался внизу и виден: середина держится у низа.
    const answerBox = (await island.getByTestId('assistant-answer').boundingBox())!;
    const scrollBox = (await island.getByTestId('assistant-scroll').boundingBox())!;
    expect(answerBox.y + answerBox.height).toBeLessThanOrEqual(scrollBox.y + scrollBox.height + 1);

    // 7. Длинный вопрос, длинный ответ и карточка не выходят за кадр острова (окно фиксированное): ответ и карточка
    // прокручиваются, кнопка Send видна, поле ввода — в кадре, колесо мыши листает ответ.
    await island.getByTestId('assistant-input').fill(`long tell the room to skip Safari tests ${'and explain the whole plan in detail '.repeat(8)}`);
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-card')).toContainText(LETTER, { timeout: 30_000 });
    await expect(island.getByTestId('assistant-answer')).toContainText('Detail 40.', { timeout: 30_000 });
    const frameHeight = await island.evaluate(() => window.innerHeight);
    const bottomOf = async (testId: string): Promise<number> => {
      const box = (await island.getByTestId(testId).boundingBox())!;
      return box.y + box.height;
    };
    expect(await bottomOf('island')).toBeLessThanOrEqual(frameHeight);
    expect(await bottomOf('assistant-input')).toBeLessThanOrEqual(frameHeight);
    const scroll = island.getByTestId('assistant-scroll');
    expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await bottomOf('assistant-send')).toBeLessThanOrEqual(await bottomOf('assistant-scroll'));
    const pinned = await scroll.evaluate((element) => element.scrollTop);
    await scroll.hover();
    await island.mouse.wheel(0, -400);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop), { message: 'колесо листает ответ вверх' }).toBeLessThan(pinned);

    await island.keyboard.press('Escape');
    await expect(island.getByTestId('assistant-view')).toHaveCount(0);
  });

  /**
   * Запуск приложения со стабом и включённым помощником: общий вход тестов ниже. `env` — добавочные переменные окна
   * (подмены голоса), `assistant` — добавочные настройки помощника (речь, язык).
   */
  async function launchWithAssistant(env: Record<string, string> = {}, assistant: Record<string, unknown> = {}): Promise<Page> {
    app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_CLAUDE_BIN: stubAgent,
        PARLEY_GLM_BIN: path.join(home, 'no-glm'),
        PARLEY_SKIP_VERSION_PROBE: '',
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_ISLAND: '',
        ...env,
      },
    });
    const window = await mainWindowOf(app);
    await resizeMain(app, 800, 500);
    await expect(window.getByTestId('landing')).toBeVisible();
    await window.evaluate(
      (extra) => (globalThis as unknown as Parley).parley.app.saveUi({ assistant: { enabled: true, provider: 'claude', ...extra } }),
      assistant,
    );
    return window;
  }

  /** Палитра ⌘J → «Ask the assistant» → вид помощника на острове. */
  async function openAssistant(window: Page): Promise<Page> {
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type('Ask the assistant');
    await expect(window.locator('[data-palette] [role="option"]').first()).toContainText('Ask the assistant');
    await window.keyboard.press('Enter');
    await expect.poll(() => islandPage(app!) !== undefined, { message: 'остров создан' }).toBe(true);
    const island = islandPage(app!)!;
    await expect(island.getByTestId('assistant-view')).toBeVisible();
    return island;
  }

  test('«create room Release» → карточка новой комнаты → Create → «Done ✓» → комната в сайдбаре', async () => {
    test.setTimeout(120_000);
    const window = await launchWithAssistant();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'planner',
      task: '',
      parent: null,
    });
    // Обзор помощника строится из снимка работ хоста: ждём работу с сессией в снимке.
    type WorksList = { entries: Array<{ map: { work: { id: string }; sessions: unknown[] } }> };
    await expect
      .poll(
        async () => (await call<WorksList>(window, 'works.list', {})).entries.find((entry) => entry.map.work.id === workId)?.map.sessions.length ?? 0,
        { message: 'сессия в снимке работ хоста', timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    expect(ref.sessionId).not.toBe('');

    const island = await openAssistant(window);
    await island.getByTestId('assistant-input').fill('create room Release');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-card')).toContainText('New room in', { timeout: 30_000 });
    await expect(island.getByTestId('assistant-room-line')).toContainText('Release', { timeout: 30_000 });
    // Кнопка взводится через 500 мс.
    await island.waitForTimeout(600);
    await island.getByTestId('assistant-send').click();
    await expect(island.getByTestId('assistant-done')).toContainText('Done ✓');

    await expect(window.locator('[data-room-row]').filter({ hasText: 'Release' })).toHaveCount(1);
  });

  test('«check in 2 seconds» → ответ → Esc → остров сам раскрывается с ответом по напоминанию', async () => {
    test.setTimeout(120_000);
    const window = await launchWithAssistant();
    const island = await openAssistant(window);
    await island.getByTestId('assistant-input').fill('check in 2 seconds');
    await island.getByTestId('assistant-input').press('Enter');
    await expect(island.getByTestId('assistant-answer')).toContainText('I will check in 2 seconds.', { timeout: 30_000 });
    await island.keyboard.press('Escape');
    await expect(island.getByTestId('assistant-view')).toHaveCount(0);

    // Через 2 с хост запускает ход по напоминанию: остров открывается сам.
    await expect(island.getByTestId('assistant-view')).toBeVisible({ timeout: 10_000 });
    await expect(island.getByTestId('assistant-answer')).toContainText('Reminder: the room is fine.', { timeout: 10_000 });
  });

  test('речь: ответ сферой → лицо с эмоцией каждого предложения → «Done» → покой; меток «[[» нет; смена голоса на мужской доходит до агента (G1)', async () => {
    test.setTimeout(120_000);
    const window = await launchWithAssistant(SPEECH_ENV, { speak: true, language: 'en' });
    // Длинные имена работы и комнаты (правило визуальных проверок): лицо и подписи не должны их задеть.
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'planner',
      task: '',
      parent: null,
    });
    await call(window, 'rooms.create', { projectPath: project, workId, title: ROOM_TITLE, members: [ref.sessionId], lead: ref.sessionId, quiet: true });

    const island = await openAssistant(window);
    // Значок динамика показывает «Speak answers».
    await expect(island.getByTestId('assistant-speak')).toHaveAttribute('aria-pressed', 'true');
    await recordFace(island);
    await ask(island, 'moods how is it going?');
    await expect(island.getByTestId('assistant-answer')).toContainText('Did you expect that result?', { timeout: 30_000 });
    // Речь кончилась: «Done» 1 с, затем покой (облако).
    await expect.poll(async () => (await faceLog(island)).at(-1)?.shape, { message: 'рой вернулся в покой', timeout: 30_000 }).toBe('cloud');

    const log = await faceLog(island);
    const firstFace = log.findIndex((entry) => entry.shape === 'face');
    const lastFace = log.findLastIndex((entry) => entry.shape === 'face');
    expect(firstFace, JSON.stringify(log)).toBeGreaterThan(0);
    // Пока первое предложение не готово («Answering») — сфера; лицо — когда оно зазвучало.
    expect(log.slice(0, firstFace).some((entry) => entry.shape === 'sphere' && entry.status === 'Answering'), JSON.stringify(log)).toBe(true);
    // Лицо говорит («Speaking»), эмоция меняется на границах предложений (L3): метки joy, sad, surprise.
    const faces = log.slice(firstFace, lastFace + 1);
    expect(faces.every((entry) => entry.shape === 'face' && entry.status === 'Speaking'), JSON.stringify(log)).toBe(true);
    expect(runs(faces.map((entry) => entry.emo))).toEqual(['joy', 'sad', 'surprise']);
    // После лица — сфера с подписью «Done», затем облако.
    const after = log.slice(lastFace + 1);
    const settled = after.findIndex((entry) => entry.shape === 'sphere' && entry.status === 'Done');
    expect(settled, JSON.stringify(log)).toBeGreaterThanOrEqual(0);
    expect(after.slice(settled).some((entry) => entry.shape === 'cloud'), JSON.stringify(log)).toBe(true);
    // Метки эмоций до острова не доходят: ни в ответе, ни в истории.
    expect(await island.locator('body').innerText()).not.toContain('[[');

    // G1: разговор идёт голосом по умолчанию (женский), строки о смене голоса нет.
    await ask(island, 'voice check');
    await expect(island.getByTestId('assistant-answer')).toContainText('Voice note: none.', { timeout: 30_000 });
    // Settings → Assistant → мужской голос посреди разговора.
    await window.keyboard.press('Meta+J');
    await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
    await window.keyboard.type('Settings');
    await window.keyboard.press('Enter');
    const settings = window.getByRole('dialog');
    await settings.getByRole('tab', { name: 'Assistant' }).click();
    await settings.getByRole('radio', { name: 'Ryan' }).check();
    await window.keyboard.press('Escape');
    await expect(window.getByRole('dialog')).toBeHidden();
    // Следующий ход несёт строку о смене рода, разговор тот же.
    await ask(island, 'voice check');
    await expect(island.getByTestId('assistant-answer')).toContainText(`Voice note: ${MALE_NOTE}.`, { timeout: 30_000 });
  });

  test('речь: первое предложение звучит, пока ответ ещё идёт (B26 F-B26-5)', async () => {
    test.setTimeout(120_000);
    const window = await launchWithAssistant(SPEECH_ENV, { speak: true, language: 'en' });
    await call(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const island = await openAssistant(window);
    await ask(island, 'stream long');
    await expect(island.getByTestId('assistant-status')).toHaveText('Speaking', { timeout: 30_000 });
    // Лицо уже говорит, а последнее предложение ответа ещё не пришло.
    expect(await island.getByTestId('assistant-answer').innerText()).not.toContain('Streamed sentence 10 is here.');
    await expect(island.getByTestId('assistant-answer')).toContainText('Streamed sentence 10 is here.', { timeout: 30_000 });
  });

  test('речь: ответ перед карточкой звучит лицом, Send обрывает речь сразу (B26 F-B26-4)', async () => {
    test.setTimeout(120_000);
    const window = await launchWithAssistant(SPEECH_ENV, { speak: true, language: 'en' });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'planner',
      task: '',
      parent: null,
    });
    await call(window, 'rooms.create', { projectPath: project, workId, title: ROOM_TITLE, members: [ref.sessionId], lead: ref.sessionId, quiet: true });
    type WorksList = { entries: Array<{ map: { work: { id: string }; rooms: unknown[] } }> };
    await expect
      .poll(
        async () => (await call<WorksList>(window, 'works.list', {})).entries.find((entry) => entry.map.work.id === workId)?.map.rooms.length ?? 0,
        { message: 'комната в снимке работ хоста', timeout: 30_000 },
      )
      .toBe(1);

    const island = await openAssistant(window);
    await recordFace(island);
    // Длинный ответ перед карточкой: лицо говорит, пока карточка ждёт решения.
    await ask(island, 'long tell the room to skip Safari tests');
    await expect(island.getByTestId('assistant-card')).toContainText(LETTER, { timeout: 30_000 });
    await expect(island.getByTestId('assistant-status')).toHaveText('Speaking', { timeout: 30_000 });
    expect((await faceLog(island)).some((entry) => entry.shape === 'face' && entry.status === 'Speaking')).toBe(true);

    // Send посреди речи: речь обрывается раньше, чем через 900 мс зазвучит «Sent».
    await island.waitForTimeout(600);
    await island.getByTestId('assistant-send').click();
    await expect(island.getByTestId('assistant-status')).not.toHaveText('Speaking', { timeout: 800 });
    await expect(island.getByTestId('assistant-sent')).toBeVisible();
  });

  test('речь: хоткей во время лица только раскрывает — без записи, лицо остаётся; Esc во время речи закрывает, при новом открытии лица нет', async () => {
    test.setTimeout(120_000);
    const window = await launchWithAssistant(SPEECH_ENV, { speak: true, language: 'en' });
    await call(window, 'works.create', { projectPath: project, title: WORK_TITLE, goal: '' });
    const island = await openAssistant(window);
    const swarm = island.getByTestId('assistant-view').getByTestId('swarm');

    // База: вне речи хоткей начинает запись — голосовой ввод выключен, и остров говорит об этом строкой.
    await pressAssistantHotkey(app!);
    await expect(island.getByText('Voice is off — Settings → Voice')).toBeVisible();

    // Долгая речь (24 предложения): хоткей во время лица записи не начинает и лицо не обрывает.
    await ask(island, 'speak long');
    await expect(swarm).toHaveAttribute('data-shape', 'face', { timeout: 30_000 });
    await pressAssistantHotkey(app!);
    await island.waitForTimeout(500);
    await expect(swarm).toHaveAttribute('data-shape', 'face');
    await expect(island.getByTestId('assistant-status')).toHaveText('Speaking');
    await expect(island.getByText('Voice is off — Settings → Voice')).toHaveCount(0);
    await expect(island.getByTestId('assistant-mic-elapsed')).toHaveCount(0);

    // Esc во время речи закрывает режим и глушит речь: при новом открытии лица нет и оно не возвращается.
    await island.keyboard.press('Escape');
    await expect(island.getByTestId('assistant-view')).toHaveCount(0);
    const again = await openAssistant(window);
    const fresh = again.getByTestId('assistant-view').getByTestId('swarm');
    await expect(fresh).not.toHaveAttribute('data-shape', 'face');
    await again.waitForTimeout(1500);
    await expect(fresh).not.toHaveAttribute('data-shape', 'face');
    await expect(again.getByTestId('assistant-status')).not.toHaveText('Speaking');
  });

  test('голос не скачан (G3): ответ текстом без лица и строка-подсказка один раз; Parley ничего не качает', async () => {
    // Без `PARLEY_TTS=fake` — настоящая служба голоса: на Apple Silicon с пустым домом веса «не скачаны». На x64 голос
    // недоступен вовсе (Р8), и подсказки о скачивании там нет.
    test.skip(process.platform !== 'darwin' || process.arch !== 'arm64', 'нейроголос есть только на Apple Silicon');
    test.setTimeout(120_000);
    const window = await launchWithAssistant({ PARLEY_VOICE: 'fake' }, { speak: true, language: 'en' });
    const island = await openAssistant(window);
    await recordFace(island);
    const hint = island.getByText('Voice "Serena" isn\'t downloaded — open Settings');

    await ask(island, 'moods how is it going?');
    await expect(island.getByTestId('assistant-answer')).toContainText('Did you expect that result?', { timeout: 30_000 });
    await expect(hint).toBeVisible();
    await island.waitForTimeout(1000);
    expect((await faceLog(island)).filter((entry) => entry.shape === 'face')).toEqual([]);

    // Второй ответ — снова текстом, строка не повторяется.
    await ask(island, 'voice check');
    await expect(island.getByTestId('assistant-answer')).toContainText('Voice note: none.', { timeout: 30_000 });
    await island.waitForTimeout(1000);
    await expect(hint).toHaveCount(0);
    expect((await faceLog(island)).filter((entry) => entry.shape === 'face')).toEqual([]);
    // Весов в доме теста нет: скачивание — только по кнопке в Settings.
    const weights = await readdir(path.join(home, 'desktop', 'voice', 'tts')).catch(() => [] as string[]);
    expect(weights.filter((name) => name.endsWith('.gguf'))).toEqual([]);
  });
});
