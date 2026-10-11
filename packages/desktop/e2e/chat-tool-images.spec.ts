import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Скриншоты из результатов инструментов в ленте Chat (план 2026-10-09, Task 6). Как в `chat-hooks.spec.ts`, `claude`
 * играет стаб `stub-echo-agent.mjs`, а события агента — строки `STUB_HOOK <json>` через `pty.input` (HTTP-хуки на
 * хост). Стаб менять не пришлось: тело `tool_response` он передаёт хосту как есть, поэтому массив блоков
 * `[{type:'text'}, {type:'image', source:{type:'base64', …}}]` — это обычный `PostToolUse`.
 *
 * Путь целиком, без подмен: тело хука → хост кладёт base64 в файл `<PARLEY_HOME>/feed-images/<sha256>.png` и несёт в
 * ленте ссылку → окно просит у main миниатюру (настоящий `nativeImage`) → миниатюра 160×120 под строкой вызова →
 * клик открывает просмотр, который просит у main тот же файл на 1600 px (первый прогон `maxPx` через настоящий
 * Electron: юнит-тесты main подставляют `nativeImage`). Проверяется и то, чего окно не видит: файл лежит в доме
 * теста, а не в настоящем `~/.parley`, права 0600/0700, base64 в ленте хоста нет, лишняя седьмая картинка не
 * записана.
 *
 * Окно 800×500 при DPR 1 и 2 (`--force-device-scale-factor`): один скриншот, затем вызов с очень длинным именем
 * инструмента и семью картинками — ряд из шести миниатюр переносится, не раздвигает ленту вбок и не наезжает
 * на следующую строку. Снимки — в `test-results/chat-tool-images/` (не коммитятся).
 *
 * Пропорции картинки — отдельный тест в конце: настоящий main отдаёт миниатюру и крупную версию в пропорциях исходника
 * (на macOS системная миниатюра квадратного ящика растягивала картинку; см. там).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const shots = path.resolve(dirname, '../test-results/chat-tool-images');

const MODEL = 'claude-sonnet-4-5';
/** Инструмент и вид блоков — как у Chrome DevTools MCP в Claude Code: текст и картинка Anthropic. */
const SHOT_TOOL = 'mcp__chrome-devtools__take_screenshot';
/** Имя MCP-инструмента в 130 знаков: строка вызова обрезает его многоточием, а ряд миниатюр от этого не зависит. */
const LONG_TOOL =
  'mcp__playwright-browser-automation-with-a-very-long-server-name__take_a_full_page_screenshot_of_the_whole_document';
/** Сколько картинок лента показывает у одного вызова (`FEED_IMAGES_PER_CALL`); седьмая — «[image omitted]». */
const SHOWN = 6;
/** Ширина и высота миниатюры в ленте, px (рамка 160×120 в `ToolImages`). */
const THUMB = { width: 160, height: 120 };

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

/** Строка `STUB_HOOK_LOG`: событие, код ответа хоста и его тело. */
interface HookLine {
  event: string;
  status: number;
  response: Record<string, unknown>;
}

/** Из снимка ленты хоста (`feed.snapshot`) тесту нужны только вызовы и ссылки на картинки их результатов. */
interface SnapshotItem {
  kind: string;
  toolUseId?: string;
  response?: { text: string; images?: Array<{ path: string; mime: string; bytes?: number }> };
}

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
    app: { imageThumbnail: (file: string, maxPx?: number) => Promise<string | null> };
  };
};

type Rgb = readonly [number, number, number];

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

/** Миниатюра файла, как её отдаёт main окну (сторона по умолчанию — 320 px). */
async function thumbnailOf(window: Page, file: string): Promise<string | null> {
  return window.evaluate(
    (target) => (globalThis as unknown as Parley).parley.app.imageThumbnail(target),
    file,
  );
}

async function pickTheme(window: Page, label: 'Theme: dark' | 'Theme: light'): Promise<void> {
  await window.keyboard.press('Meta+J');
  await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
  await window.keyboard.type(label);
  await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(label);
  await window.keyboard.press('Enter');
  await expect(window.locator('[data-palette]')).toHaveCount(0);
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window
    .locator('.xterm-rows')
    .first()
    .evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }),
    { width, height },
  );
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('у элемента нет рамки — он не показан');
  return box;
}

const naturalSize = (image: Locator): Promise<{ width: number; height: number }> =>
  image.evaluate((img) => ({
    width: (img as HTMLImageElement).naturalWidth,
    height: (img as HTMLImageElement).naturalHeight,
  }));
const naturalWidth = async (image: Locator): Promise<number> => (await naturalSize(image)).width;

/** Лента и само окно не прокручиваются вбок: ряд миниатюр не вылез за правый край. */
async function expectNoSideScroll(window: Page): Promise<void> {
  const feed = window.getByTestId('chat-view').getByTestId('chat-feed');
  expect(
    await feed.evaluate((element) => element.scrollWidth <= element.clientWidth),
    'лента прокручивается вбок',
  ).toBe(true);
  expect(
    await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth),
    'окно прокручивается вбок',
  ).toBe(true);
}

/**
 * Диалог просмотра целиком в окне: рамка, картинка и крестик внутри окна и друг друга, тело не прокручивается. Проверка
 * повторяется до успеха: появление диалога — анимация, и первые замеры могут быть чужими.
 */
async function expectDialogFits(window: Page, dialog: Locator): Promise<void> {
  const view = dialog.getByTestId('chat-tool-image-view');
  await expect(async () => {
    const viewport = await window.evaluate(() => ({
      width: globalThis.innerWidth,
      height: globalThis.innerHeight,
    }));
    const dialogBox = await boxOf(dialog);
    expect(dialogBox.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox.y).toBeGreaterThanOrEqual(0);
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(viewport.height + 0.5);
    const viewBox = await boxOf(view);
    expect(viewBox.x).toBeGreaterThanOrEqual(dialogBox.x - 0.5);
    expect(viewBox.x + viewBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 0.5);
    expect(viewBox.y + viewBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height + 0.5);
    const closeBox = await boxOf(dialog.getByRole('button', { name: 'Close' }));
    expect(closeBox.x).toBeGreaterThanOrEqual(dialogBox.x - 0.5);
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width + 0.5);
    // Тело диалога (картинка лежит в нём в абсолютно расположенной обёртке) не прокручивается ни вбок, ни вниз.
    expect(
      await view
        .locator('xpath=../..')
        .evaluate(
          (body) => body.scrollWidth <= body.clientWidth && body.scrollHeight <= body.clientHeight,
        ),
      'тело диалога прокручивается',
    ).toBe(true);
  }).toPass({ timeout: 10_000 });
}

/**
 * Диалог просмотра — доли окна, а не размер картинки: 90 % ширины и 85 % высоты (в пределах 1640×1240 и полей в 1 rem у
 * края окна). Так он открывается сразу своего размера и не прыгает, когда вместо миниатюры приходит большая версия.
 */
async function expectDialogSizedByWindow(window: Page, dialog: Locator): Promise<void> {
  const viewport = await window.evaluate(() => ({
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
  }));
  const box = await boxOf(dialog);
  expect(box.width).toBeCloseTo(Math.min(viewport.width * 0.9, 1640, viewport.width - 32), 0);
  expect(box.height).toBeCloseTo(Math.min(viewport.height * 0.85, 1240, viewport.height - 32), 0);
}

// ---------------------------------------------------------------------------------------------------
// Настоящий PNG для хука

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * «Скриншот страницы» из плоских блоков: тёмная шапка, светлая боковая панель, красный квадрат слева сверху и синий
 * справа снизу — по ним на снимке окна видно, что картинка не перевёрнута и не отражена, а по красному квадрату —
 * что её не растянули. Правый нижний пиксель несёт `nonce`: байты (а с ними и имя файла по sha256) у каждого
 * прогона свои, поэтому файл с таким именем в настоящем `~/.parley` мог бы появиться только от этого прогона.
 */
function makeShot(
  width: number,
  height: number,
  nonce: number,
  paper: Rgb = [250, 250, 250],
): Buffer {
  const bar = Math.round(height * 0.08);
  const side = Math.round(width * 0.2);
  const mark = Math.round(height * 0.18);
  const pixel = (x: number, y: number): Rgb => {
    if (x === width - 1 && y === height - 1) {
      return [nonce & 255, (nonce >> 8) & 255, (nonce >> 16) & 255];
    }
    if (y < bar) return [32, 36, 48];
    if (x < side) return [226, 232, 240];
    if (x < side + mark && y < bar + mark) return [220, 38, 38];
    if (x >= width - mark && y >= height - mark) return [37, 99, 235];
    return paper;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  // 8 бит на канал, цвет RGB (тип 2), без чересстрочности.
  header.set([8, 2, 0, 0, 0], 8);
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * stride + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * PNG, который лишь объявляет размер: структурно настоящий (подпись, IHDR с CRC, IEND), но пикселей нет — файл в
 * сотню байт. Так выглядит «бомба»: декодер выделил бы ширина × высота × 4 байта.
 */
function declaredPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JPEG с JFIF и кадром SOF0 на `width`×`height`, без данных. */
function declaredJpeg(width: number, height: number): Buffer {
  const frame = Buffer.alloc(19);
  frame.set([0xff, 0xc0], 0);
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame.set([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 9);
  const jfif = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  return Buffer.concat([Buffer.from([0xff, 0xd8, ...jfif]), frame, Buffer.from([0xff, 0xd9])]);
}

/** Блок картинки результата так, как его отдаёт Claude Code хуку `PostToolUse` для MCP-инструмента. */
const imageBlock = (png: Buffer): Record<string, unknown> => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
});

/**
 * События хуков одной сессии: отправка строкой STUB_HOOK и чтение ответов хоста из `STUB_HOOK_LOG`.
 */
class Hooks {
  constructor(
    private readonly window: Page,
    private readonly ref: Ref,
    private readonly logFile: string,
  ) {}

  /** Ответы хоста, записанные стабом; недописанная строка пропускается. */
  async lines(event?: string): Promise<HookLine[]> {
    let text: string;
    try {
      text = await readFile(this.logFile, 'utf8');
    } catch {
      return [];
    }
    const lines: HookLine[] = [];
    for (const raw of text.split('\n')) {
      if (raw === '') continue;
      try {
        lines.push(JSON.parse(raw) as HookLine);
      } catch {
        // Строка ещё пишется — прочтётся при следующем опросе.
      }
    }
    return event === undefined ? lines : lines.filter((line) => line.event === event);
  }

  /** Шлёт событие, на которое хост отвечает сразу, и ждёт его строку в журнале ответов (код 200). */
  async fire(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const before = (await this.lines(event)).length;
    const body = JSON.stringify({ hook_event_name: event, ...fields });
    await this.window.evaluate(
      ({ ref, data }) =>
        (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data }),
      { ref: this.ref, data: `STUB_HOOK ${body}\r` },
    );
    await expect
      .poll(async () => (await this.lines(event)).length, {
        message: `ответ хоста на ${event}`,
        timeout: 15_000,
      })
      .toBeGreaterThan(before);
    expect((await this.lines(event))[before]?.status, `код ответа на ${event}`).toBe(200);
  }
}

interface Opened {
  window: Page;
  ref: Ref;
  hooks: Hooks;
  errors: string[];
}

test.describe('скриншоты из результатов инструментов в ленте Chat (план 2026-10-09, Task 6)', () => {
  test.setTimeout(180_000);

  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('chat-tool-images');
    project = await makeTempProject('chat-tool-images');
    // PARLEY.md уже есть: хост не создаёт его и не показывает тост «Parley added PARLEY.md…», который висел бы на снимках.
    await writeFile(path.join(project, 'PARLEY.md'), '# Team rules\n');
    await mkdir(shots, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Окно 800×500 со стабом вместо `claude`, работа и одна сессия; первый `SessionStart` делает вкладку чатом. */
  async function open(dpr: number): Promise<Opened> {
    const logFile = path.join(home, 'hook-log.jsonl');
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_BRACKETED: '1',
      STUB_HOOK_LOG: logFile,
      // Без собственных хуков стаба: вкладка начинается терминалом, чатом её делает первый SessionStart спека.
      STUB_NO_HOOKS: '1',
    };
    const app = await electron.launch({
      args: [mainEntry, `--force-device-scale-factor=${dpr}`],
      env,
    });
    running = app;
    const window = await app.firstWindow();
    await resize(app, 800, 500);
    await expect(window.getByTestId('landing')).toBeVisible();
    expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBe(dpr);
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

    const work = await call<{ workId: string }>(window, 'works.create', {
      projectPath: project,
      title: 'e2e-chat-tool-images',
      goal: '',
    });
    const session = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId: work.workId,
      provider: 'claude',
      label: 'chat',
      task: '',
      parent: null,
    });
    const ref = session.ref;
    await pickTheme(window, 'Theme: light');
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    await expect(window.getByTestId('terminal-body')).toBeVisible();
    // Стаб поднялся и читает ввод: до этого строка STUB_HOOK ушла бы в tty, пока он ещё не в сыром режиме.
    await expect.poll(() => screenText(window)).toContain('stub-echo');
    const hooks = new Hooks(window, ref, logFile);
    await hooks.fire('SessionStart', {
      source: 'startup',
      model: MODEL,
      permission_mode: 'default',
      cwd: project,
    });
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { window, ref, hooks, errors };
  }

  for (const dpr of [1, 2]) {
    test(`миниатюра под вызовом, просмотр на 1600 px, ряд из шести в окне 800×500 при DPR ${dpr}`, async () => {
      const { window, ref, hooks, errors } = await open(dpr);
      const chat = window.getByTestId('chat-view');
      const feed = chat.getByTestId('chat-feed');
      const calls = chat.getByTestId('chat-tool');
      /** Что и как измерено — в аннотации теста (отчёт Playwright), не в журнал прогона. */
      const measured = (what: string, value: unknown): void => {
        test
          .info()
          .annotations.push({ type: 'измерено', description: `${what}: ${JSON.stringify(value)}` });
      };
      /**
       * Снимок окна для человека. Указатель уводится с сайдбара: после клика по сессии над строкой висел её тултип и
       * закрывал ленту; переходы цвета должны догореть.
       */
      const shot = async (name: string): Promise<void> => {
        await window.mouse.move(640, 20);
        await window.waitForTimeout(500);
        await window.screenshot({ path: path.join(shots, `${name}-dpr${dpr}.png`) });
      };
      /**
       * Открывает просмотр кликом по миниатюре и ждёт, пока диалог доиграет появление (CSS-анимация Radix, 200 мс): на ходу
       * он сдвинут от центра, и клик по углу окна «вне диалога» попал бы в сам диалог, а замеры рамок были бы чужими.
       */
      const openPreview = async (opener: Locator, label: string): Promise<Locator> => {
        await opener.click();
        const dialog = window.getByRole('dialog', { name: label });
        await expect(dialog).toBeVisible();
        await dialog.evaluate((element) =>
          Promise.allSettled(
            element.getAnimations({ subtree: true }).map((animation) => animation.finished),
          ),
        );
        return dialog;
      };
      /** Вызов выше экрана ленты: к верху (строка и первые ряды) или к низу (раскрытый результат) — для снимка. */
      const scrollCall = (call: Locator, block: 'start' | 'end'): Promise<void> =>
        call.evaluate((element, edge) => element.scrollIntoView({ block: edge }), block);
      const nonce = Date.now() % 0xffffff;

      // a) Один скриншот: пока вызов идёт — картинок нет; PostToolUse с текстом и картинкой — ровно одна миниатюра.
      const png = makeShot(1280, 800, nonce);
      const input = { format: 'png' };
      await hooks.fire('UserPromptSubmit', {
        prompt: 'Take a screenshot of the page',
        permission_mode: 'default',
      });
      await hooks.fire('PreToolUse', {
        tool_name: SHOT_TOOL,
        tool_input: input,
        tool_use_id: 'toolu_shot1',
        permission_mode: 'default',
      });
      const single = calls.filter({ hasText: 'chrome-devtools · take_screenshot' });
      await expect(single).toHaveAttribute('data-tool-status', 'running');
      await expect(single.getByTestId('chat-tool-images')).toHaveCount(0);
      await hooks.fire('PostToolUse', {
        tool_name: SHOT_TOOL,
        tool_input: input,
        tool_use_id: 'toolu_shot1',
        permission_mode: 'default',
        tool_response: [{ type: 'text', text: 'Took a screenshot' }, imageBlock(png)],
      });
      await expect(single).toHaveAttribute('data-tool-status', 'done');
      const thumbs = single.getByTestId('chat-tool-image');
      await expect(thumbs).toHaveCount(1, { timeout: 15_000 });
      await expect(chat.getByTestId('chat-tool-images')).toHaveCount(1);
      await expect(chat.getByTestId('chat-tool-image-unavailable')).toHaveCount(0);
      const thumb = thumbs.first();
      const thumbImage = thumb.locator('img');
      await expect(thumb).toHaveAttribute('aria-label', 'Image 1 of 1');
      await expect(thumb).toHaveAttribute('title', 'Open image');
      await expect(thumbImage).toHaveAttribute('src', /^data:image\/png;base64,/);
      // Миниатюра настоящая: картинка разобрана браузером, а не пустой тег.
      await expect.poll(() => naturalWidth(thumbImage), { timeout: 15_000 }).toBeGreaterThan(0);
      measured('миниатюра, естественный размер, px', await naturalSize(thumbImage));
      // Миниатюра в пропорциях исходника (1280×800 → 320×200), а в рамке 160×120 вписана целиком, без обрезки.
      const thumbNatural = await naturalSize(thumbImage);
      expect(thumbNatural.width / thumbNatural.height).toBeCloseTo(1280 / 800, 1);
      await expect(thumbImage).toHaveCSS('object-fit', 'contain');
      const thumbBox = await boxOf(thumb);
      expect(thumbBox.width).toBeCloseTo(THUMB.width, 0);
      expect(thumbBox.height).toBeCloseTo(THUMB.height, 0);
      // Ряд — прямо под строкой вызова, не внутри раскрываемой части.
      const headline = single.locator('button[aria-expanded]');
      const headlineBox = await boxOf(headline);
      expect(thumbBox.y).toBeGreaterThanOrEqual(headlineBox.y + headlineBox.height - 0.5);
      await expectNoSideScroll(window);
      measured(
        'лента, клиентская ширина, px',
        await feed.evaluate((element) => element.clientWidth),
      );

      // b) Файл и лента хоста: ссылка на файл в доме теста, base64 в ленте нет, настоящий ~/.parley не тронут.
      const snapshot = await call<{ items: SnapshotItem[] }>(window, 'feed.snapshot', { ref });
      const tool = snapshot.items.find((item) => item.toolUseId === 'toolu_shot1');
      expect(tool?.response?.text).toMatch(/^Took a screenshot\n\[image png, \d+ KB\]$/);
      expect(tool?.response?.images).toHaveLength(1);
      expect(tool?.response?.images?.[0]).toMatchObject({ mime: 'image/png', bytes: png.length });
      expect(tool?.response?.images?.[0]?.path).toMatch(/[\\/]feed-images[\\/][0-9a-f]{24}\.png$/);
      const stored = tool!.response!.images![0]!.path;
      expect(JSON.stringify(snapshot)).not.toContain('iVBOR');
      expect(await chat.textContent()).not.toContain('iVBOR');
      expect(await realpath(stored)).toBe(
        path.join(await realpath(home), 'feed-images', path.basename(stored)),
      );
      expect((await readFile(stored)).equals(png)).toBe(true);
      expect((await stat(stored)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(stored))).mode & 0o777).toBe(0o700);
      expect(
        existsSync(path.join(os.homedir(), '.parley', 'feed-images', path.basename(stored))),
        'файл картинки лёг в настоящий ~/.parley',
      ).toBe(false);
      await shot('single-light');

      // c) Раскрытый вызов: текст результата с пометкой вместо base64; ряд миниатюр остаётся один, под строкой.
      await headline.click();
      const details = single.getByTestId('chat-tool-details');
      await expect(details).toBeVisible();
      expect(await details.getByTestId('chat-tool-result').textContent()).toMatch(
        /^Took a screenshot\n\[image png, \d+ KB\]$/,
      );
      await expect(details.getByTestId('chat-tool-images')).toHaveCount(0);
      await expect(single.getByTestId('chat-tool-image')).toHaveCount(1);
      expect(await details.textContent()).not.toContain('iVBOR');
      await expectNoSideScroll(window);
      await headline.click();
      await expect(details).toHaveCount(0);

      // d) Просмотр: клик открывает диалог «Image 1 of 1», через main приходит версия на 1600 px (крупнее миниатюры),
      // диалог в окне 800×500 целиком, крестик виден; Esc закрывает и возвращает фокус на миниатюру.
      const smallWidth = await naturalWidth(thumbImage);
      const dialog = await openPreview(thumb, 'Image 1 of 1');
      const view = dialog.getByTestId('chat-tool-image-view');
      await expect(view).toHaveAttribute('src', /^data:image\/png;base64,/);
      await expect
        .poll(() => naturalWidth(view), {
          message: 'крупная версия не пришла: в просмотре осталась миниатюра',
          timeout: 15_000,
        })
        .toBeGreaterThan(Math.max(smallWidth, 320));
      const previewNatural = await naturalSize(view);
      measured('просмотр, естественный размер, px', previewNatural);
      // Большая версия — в пропорциях исходника, вписана в рамку диалога целиком.
      expect(previewNatural.width / previewNatural.height).toBeCloseTo(1280 / 800, 1);
      await expect(view).toHaveCSS('object-fit', 'contain');
      await expectDialogFits(window, dialog);
      await expectDialogSizedByWindow(window, dialog);
      measured('диалог просмотра, px', await boxOf(dialog));
      await shot('preview-light');
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(thumb).toBeFocused();
      // Клик вне диалога тоже закрывает (угол окна — подложка, когда диалог встал на место).
      await openPreview(thumb, 'Image 1 of 1');
      await window.mouse.click(4, 4);
      await expect(dialog).toHaveCount(0);

      // e) Тёмная тема: миниатюра и просмотр (крестик на подложке поверх угла картинки).
      await pickTheme(window, 'Theme: dark');
      await shot('single-dark');
      await openPreview(thumb, 'Image 1 of 1');
      await expect.poll(() => naturalWidth(view), { timeout: 15_000 }).toBeGreaterThan(smallWidth);
      await expectDialogFits(window, dialog);
      await expectDialogSizedByWindow(window, dialog);
      await shot('preview-dark');
      await window.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      await hooks.fire('Stop', { last_assistant_message: 'Done.', stop_hook_active: false });

      // f) Длинные значения: имя инструмента в 130 знаков и семь картинок. Лента показывает шесть, седьмая — пометка;
      // файлов на диске шесть новых, а не семь. Ряд переносится по ширине ленты и не наезжает на следующую строку.
      const papers: Rgb[] = [
        [239, 68, 68],
        [249, 115, 22],
        [234, 179, 8],
        [34, 197, 94],
        [20, 184, 166],
        [59, 130, 246],
        [168, 85, 247],
      ];
      // Размеры и пропорции разные: рамка миниатюры 160×120 от них не зависит. Все длиннее 320 px, поэтому крупная версия
      // (до 1600) шире миниатюры: main уменьшает по длинной стороне вниз, вверх не тянет.
      const sizes = [
        { width: 640, height: 400 },
        { width: 480, height: 360 },
        { width: 512, height: 512 },
        { width: 360, height: 640 },
        { width: 720, height: 300 },
        { width: 600, height: 400 },
        { width: 640, height: 360 },
      ];
      const pages = sizes.map(({ width, height }, at) =>
        makeShot(width, height, nonce + at + 1, papers[at]),
      );
      const longInput = {
        url: `https://example.com/${'long-path-segment/'.repeat(8)}`,
        fullPage: true,
      };
      await hooks.fire('UserPromptSubmit', {
        prompt: 'Now capture every page of the report',
        permission_mode: 'default',
      });
      await hooks.fire('PreToolUse', {
        tool_name: LONG_TOOL,
        tool_input: longInput,
        tool_use_id: 'toolu_shot2',
        permission_mode: 'default',
      });
      await hooks.fire('PostToolUse', {
        tool_name: LONG_TOOL,
        tool_input: longInput,
        tool_use_id: 'toolu_shot2',
        permission_mode: 'default',
        tool_response: [{ type: 'text', text: 'Took 7 screenshots' }, ...pages.map(imageBlock)],
      });
      await hooks.fire('MessageDisplay', {
        message_id: 'msg-after',
        index: 0,
        final: true,
        delta: 'Both calls are captured above.',
      });
      await hooks.fire('Stop', {
        last_assistant_message: 'Both calls are captured above.',
        stop_hook_active: false,
      });
      const six = calls.filter({ hasText: 'playwright-browser-automation' });
      await expect(six).toHaveAttribute('data-tool-status', 'done');
      const sixThumbs = six.getByTestId('chat-tool-image');
      await expect(sixThumbs).toHaveCount(SHOWN, { timeout: 15_000 });
      await expect(chat.getByTestId('chat-tool-image-unavailable')).toHaveCount(0);
      await expect(chat.getByTestId('chat-tool-image')).toHaveCount(SHOWN + 1);

      // Ссылки хоста: шесть, по порядку блоков; седьмая картинка файла не получила.
      const second = await call<{ items: SnapshotItem[] }>(window, 'feed.snapshot', { ref });
      const refs = second.items.find((item) => item.toolUseId === 'toolu_shot2')?.response;
      expect(refs?.images).toHaveLength(SHOWN);
      expect(refs?.text).toMatch(
        new RegExp(
          `^Took 7 screenshots(\\n\\[image png, \\d+ KB\\]){${SHOWN}}\\n\\[image omitted\\]$`,
        ),
      );
      expect(JSON.stringify(second)).not.toContain('iVBOR');
      expect(await readdir(path.dirname(stored))).toHaveLength(1 + SHOWN);
      for (const [at, image] of refs!.images!.entries()) {
        expect((await readFile(image.path)).equals(pages[at]!), `файл ${at + 1}`).toBe(true);
        // Кнопка №at показывает файл №at: миниатюра в ней — та, что main отдаёт для этого файла.
        expect(
          await sixThumbs.nth(at).locator('img').getAttribute('src'),
          `порядок: ${at + 1}`,
        ).toBe(await thumbnailOf(window, image.path));
        await expect(sixThumbs.nth(at)).toHaveAttribute(
          'aria-label',
          `Image ${at + 1} of ${SHOWN}`,
        );
      }

      // Раскладка ряда: каждая миниатюра 160×120 внутри ряда, друг на друга не налезают, строк столько, сколько
      // нужно по ширине ряда, а следующая строка ленты начинается ниже последней строки миниатюр.
      const imagesRow = six.getByTestId('chat-tool-images');
      const rowBox = await boxOf(imagesRow);
      const gap = await imagesRow.evaluate((row) => parseFloat(getComputedStyle(row).columnGap));
      const boxes = [];
      for (let at = 0; at < SHOWN; at += 1) boxes.push(await boxOf(sixThumbs.nth(at)));
      for (const box of boxes) {
        expect(box.width).toBeCloseTo(THUMB.width, 0);
        expect(box.height).toBeCloseTo(THUMB.height, 0);
        expect(box.x).toBeGreaterThanOrEqual(rowBox.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 0.5);
      }
      for (let at = 1; at < boxes.length; at += 1) {
        const previous = boxes[at - 1]!;
        const box = boxes[at]!;
        // Слева направо, затем со следующей строки; в одной строке — не ближе зазора.
        if (Math.abs(previous.y - box.y) < 1) {
          expect(box.x).toBeGreaterThanOrEqual(previous.x + previous.width + gap - 0.5);
        } else {
          expect(box.y).toBeGreaterThanOrEqual(previous.y + previous.height - 0.5);
        }
      }
      const lines = new Set(boxes.map((box) => Math.round(box.y))).size;
      const perLine = Math.max(1, Math.floor((rowBox.width + gap) / (THUMB.width + gap)));
      expect(lines, `миниатюр в строке: ${perLine}, ширина ряда ${rowBox.width}`).toBe(
        Math.ceil(SHOWN / perLine),
      );
      // В окне 800×500 шесть миниатюр в одну строку не помещаются: ряд обязан переноситься на несколько строк.
      expect(rowBox.width).toBeLessThan(SHOWN * THUMB.width + (SHOWN - 1) * gap);
      expect(lines).toBeGreaterThan(1);
      measured('ряд из шести: ширина, миниатюр в строке, строк', {
        width: rowBox.width,
        perLine,
        lines,
      });
      const after = chat.getByTestId('chat-text').filter({ hasText: 'Both calls are captured' });
      await expect(after).toHaveCount(1);
      const lastLineBottom = Math.max(...boxes.map((box) => box.y + box.height));
      expect((await boxOf(after)).y).toBeGreaterThanOrEqual(lastLineBottom - 0.5);
      // Строки ленты (виртуальные, абсолютные) друг на друга не наезжают: высота строки с рядом измерена по переносу.
      const rowBoxes = [];
      for (const row of await chat.locator('[data-index]').all()) rowBoxes.push(await boxOf(row));
      rowBoxes.sort((a, b) => a.y - b.y);
      for (let at = 1; at < rowBoxes.length; at += 1) {
        expect(
          rowBoxes[at - 1]!.y + rowBoxes[at - 1]!.height,
          `строка ленты ${at} наезжает на предыдущую`,
        ).toBeLessThanOrEqual(rowBoxes[at]!.y + 0.5);
      }
      // Имя инструмента обрезано многоточием и из ленты не выходит.
      const name = six.locator('[data-tool-name]');
      expect(await name.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
      const feedBox = await boxOf(feed);
      const nameBox = await boxOf(name);
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(feedBox.x + feedBox.width + 0.5);
      await expectNoSideScroll(window);
      await scrollCall(six, 'start');
      await shot('six-dark');
      await pickTheme(window, 'Theme: light');
      await scrollCall(six, 'start');
      await shot('six-light');

      // g) Раскрытый вызов с длинными значениями: результат — текстом с пометками, лента вбок не растёт.
      await six.locator('button[aria-expanded]').click();
      const sixDetails = six.getByTestId('chat-tool-details');
      await expect(sixDetails).toBeVisible();
      await expect(sixDetails.getByTestId('chat-tool-images')).toHaveCount(0);
      await expect(six.getByTestId('chat-tool-image')).toHaveCount(SHOWN);
      await expectNoSideScroll(window);
      await scrollCall(six, 'end');
      await shot('six-expanded-light');

      // h) Просмотр одной из шести (последней в ряду, 600×400): подпись «Image 6 of 6», через main приходит версия на 1600 px —
      // шире миниатюры и шире 320, — Esc закрывает, фокус возвращается на миниатюру.
      const last = sixThumbs.nth(SHOWN - 1);
      await last.scrollIntoViewIfNeeded();
      const lastSmall = await naturalWidth(last.locator('img'));
      const lastDialog = await openPreview(last, `Image ${SHOWN} of ${SHOWN}`);
      const lastView = lastDialog.getByTestId('chat-tool-image-view');
      await expect
        .poll(() => naturalWidth(lastView), {
          message: 'крупная версия не пришла: в просмотре осталась миниатюра',
          timeout: 15_000,
        })
        .toBeGreaterThan(Math.max(lastSmall, 320));
      measured('просмотр шестой, естественный размер, px', await naturalSize(lastView));
      await expectDialogFits(window, lastDialog);
      await expectDialogSizedByWindow(window, lastDialog);
      await shot('six-preview-light');
      await window.keyboard.press('Escape');
      await expect(lastDialog).toHaveCount(0);
      await expect(last).toBeFocused();

      expect(errors).toEqual([]);
    });
  }

  /**
   * Пропорции картинки в ответе main (находка этого E2E, 2026-10-09). Раньше `app.imageThumbnail` просил у системы
   * миниатюру квадрата `side × side`, а настоящий Electron на macOS (`nativeImage.createThumbnailFromPath`) вписывает
   * картинку в названный ящик целиком, растягивая: из 1280×800 выходил квадрат 320×320 (для просмотра — 1600×1600), а лента
   * показывала его искажённым и обрезанным. Теперь PNG и JPEG main читает сам и уменьшает по длинной стороне, а GIF и
   * WebP, которых `createFromPath` не читает, просит у системы ящиком в пропорциях заголовка файла.
   *
   * Тест — настоящий main без ленты: файлы разных пропорций и форматов, размер ответа на обычную сторону (320) и на 1600.
   * Длинная сторона ответа — не больше запрошенной, меньшая картинка остаётся своего размера, пропорции исходника целы
   * (допуск 2 px на округление). PNG пишет сам тест; JPEG, GIF и три вида WebP (с потерями, без потерь, расширенный
   * VP8X) лежат в `fixtures/aspect/` как их отдали `sips` и `cwebp`, 640×400.
   */
  test('main отдаёт миниатюру и крупную версию в пропорциях исходной картинки', async () => {
    const generated = [
      { file: 'wide.png', width: 1280, height: 800 },
      { file: 'tall.png', width: 400, height: 800 },
      { file: 'square.png', width: 512, height: 512 },
      // Больше 1600 по длинной стороне: просмотр обязан уменьшить, а не отдать как есть.
      { file: 'big.png', width: 3200, height: 2000 },
    ];
    for (const source of generated) {
      await writeFile(path.join(project, source.file), makeShot(source.width, source.height, 7));
    }
    const fixtures = path.resolve(dirname, 'fixtures/aspect');
    const sources = [
      ...generated.map(({ file, ...size }) => ({ path: path.join(project, file), ...size })),
      ...['wide.jpg', 'wide.gif', 'wide-lossy.webp', 'wide-lossless.webp', 'wide-alpha.webp'].map(
        (file) => ({ path: path.join(fixtures, file), width: 640, height: 400 }),
      ),
    ];
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, PARLEY_HOME: home },
    });
    running = app;
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    for (const source of sources) {
      for (const maxPx of [undefined, 1600]) {
        const size = await window.evaluate(
          async ({ file, px }) => {
            const url = await (globalThis as unknown as Parley).parley.app.imageThumbnail(file, px);
            if (url === null) return null;
            const image = new Image();
            image.src = url;
            await image.decode();
            return { width: image.naturalWidth, height: image.naturalHeight };
          },
          { file: source.path, px: maxPx },
        );
        const label = `${path.basename(source.path)} ${source.width}×${source.height}, сторона ${maxPx ?? 'по умолчанию'}`;
        expect.soft(size, label).not.toBeNull();
        if (size === null) continue;
        // Длинная сторона — запрошенная (320 по умолчанию), но не больше, чем у самой картинки.
        const scale = Math.min(1, (maxPx ?? 320) / Math.max(source.width, source.height));
        const expected = {
          width: Math.round(source.width * scale),
          height: Math.round(source.height * scale),
        };
        const answer = `${label}: ответ ${size.width}×${size.height}, ждали ${expected.width}×${expected.height}`;
        expect.soft(Math.abs(size.width - expected.width), answer).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(size.height - expected.height), answer).toBeLessThanOrEqual(2);
        expect
          .soft(size.width / size.height, `${answer}: пропорции`)
          .toBeCloseTo(source.width / source.height, 1);
      }
    }
  });

  /**
   * Бомба: крошечный файл объявляет в заголовке картинку, которую декодер main выделил бы гигабайтами (PNG 20000×20000,
   * JPEG 65535×65535, сторона за 16 384). Настоящий main отвечает `null` — и на миниатюру, и на просмотр — и остаётся живым:
   * следующий запрос за обычной картинкой получает ответ.
   */
  test('main не декодирует картинку с огромным размером в заголовке и остаётся живым', async () => {
    const bombs = [
      { file: 'bomb.png', bytes: declaredPng(20000, 20000) },
      { file: 'bomb-wide.png', bytes: declaredPng(16385, 16) },
      { file: 'bomb.jpg', bytes: declaredJpeg(65535, 65535) },
    ];
    for (const { file, bytes } of bombs) {
      expect(bytes.length, file).toBeLessThan(300);
      await writeFile(path.join(project, file), bytes);
    }
    await writeFile(path.join(project, 'small.png'), makeShot(64, 40, 1));
    const app = await electron.launch({
      args: [mainEntry],
      env: { ...process.env, PARLEY_HOME: home },
    });
    running = app;
    const window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();
    for (const { file } of bombs) {
      for (const maxPx of [undefined, 1600]) {
        const answer = await window.evaluate(
          ({ target, px }) =>
            (globalThis as unknown as Parley).parley.app.imageThumbnail(target, px),
          { target: path.join(project, file), px: maxPx },
        );
        expect(answer, `${file}, сторона ${maxPx ?? 'по умолчанию'}`).toBeNull();
      }
    }
    expect(await thumbnailOf(window, path.join(project, 'small.png'))).toMatch(
      /^data:image\/png;base64,/,
    );
  });
});
