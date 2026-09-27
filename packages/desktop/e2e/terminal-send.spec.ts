import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopHost } from './stop-host.js';
import { makeTempProject } from './tmp.js';

/**
 * Отправка из окна агенту (кусок 5.4, тест 10; спека 8.5, 8.6). Агент — stub в режиме
 * `STUB_BRACKETED=1`: включает bracketed paste и печатает вставку как `PASTE<<текст>>`.
 *
 * Буфер обмена человека тесты не читают и не пишут (решение контролёра 5.4):
 * - скриншот — `HARNAS_DROPS=fake`: main сохраняет в `drops/` фиксированную картинку 1×1
 *   вместо картинки буфера, а событие `paste` с картинкой — синтетическое `ClipboardEvent`
 *   со своим `DataTransfer`;
 * - файл из Finder — синтетические `dragover`/`drop` с `File` из временного каталога. `File`
 *   с путём на диске даёт только выбор файла: он ставится в скрытый `<input type=file>`
 *   через `setInputFiles` (системного окна нет), путь из него читает `webUtils.getPathForFile`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const hostEntry = path.resolve(dirname, '../../host/dist/main.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');

test.skip(!existsSync(hostEntry), `packages/host/dist/main.js не собран — сначала pnpm --filter @harnas/host build: ${hostEntry}`);

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

type Harnas = { harnas: { call: (method: string, params: unknown) => Promise<unknown> } };

/** Текст экрана терминала: строки DOM-рендера подряд — перенесённая строка склеивается. */
async function screenText(window: Page): Promise<string> {
  return window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

async function sendToAgent(window: Page, ref: Ref, text: string, submit: boolean): Promise<unknown> {
  return window.evaluate(
    ({ ref: target, text: body, submit: enter }) =>
      (globalThis as unknown as Harnas).harnas.call('pty.send', { ref: target, text: body, submit: enter }),
    { ref, text, submit },
  );
}

/** Синтетический бросок файла на поле ввода терминала — как в тесте броска ниже; исход preventDefault. */
async function dropFile(window: Page, file: string): Promise<{ over: boolean; drop: boolean }> {
  await window.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'e2e-drop-input';
    input.style.display = 'none';
    document.body.appendChild(input);
  });
  await window.locator('#e2e-drop-input').setInputFiles(file);
  return window.locator('.xterm-helper-textarea').first().evaluate((textarea) => {
    const input = document.getElementById('e2e-drop-input') as HTMLInputElement;
    const picked = input.files?.[0];
    if (picked === undefined) throw new Error('файл не выбран');
    const data = new DataTransfer();
    data.items.add(picked);
    const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
    textarea.dispatchEvent(over);
    const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
    textarea.dispatchEvent(drop);
    input.remove();
    return { over: over.defaultPrevented, drop: drop.defaultPrevented };
  });
}

test.describe('отправка агенту из окна (кусок 5.4)', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication;
  let window: Page;
  let ref: Ref;

  test.beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hh-e2e-send-'));
    project = await makeTempProject('terminal-send');
    const env = {
      ...process.env,
      HARNAS_HOME: home,
      HARNAS_CLAUDE_BIN: stubAgent,
      HARNAS_TERMINAL_RENDERER: 'dom',
      HARNAS_DROPS: 'fake',
      STUB_BRACKETED: '1',
    };
    app = await electron.launch({ args: [mainEntry], env });
    window = await app.firstWindow();
    await expect(window.getByTestId('landing')).toBeVisible();

    const work = (await window.evaluate(
      (projectPath: string) => (globalThis as unknown as Harnas).harnas.call('works.create', { projectPath, title: 'e2e-send', goal: '' }),
      project,
    )) as { workId: string };
    const session = (await window.evaluate(
      ({ workId, projectPath }: { workId: string; projectPath: string }) =>
        (globalThis as unknown as Harnas).harnas.call('sessions.create', {
          projectPath,
          workId,
          provider: 'claude',
          label: 'send',
          task: '',
          parent: null,
        }),
      { workId: work.workId, projectPath: project },
    )) as { ref: { sessionId: string } };
    ref = { projectPath: project, workId: work.workId, sessionId: session.ref.sessionId };

    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    // Stub запущен и уже включил bracketed paste: строка готовности печатается до ESC[?2004h,
    // а хост читает режим с экрана — ждём ещё чуть, пока он дойдёт.
    await expect.poll(() => screenText(window)).toContain('stub-echo готов');
    await window.waitForTimeout(300);
  });

  test.afterEach(async () => {
    await app.close();
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('pty.send многострочного текста с submit: true — PASTE<<, затем echo:, submitted: true', async () => {
    const result = await sendToAgent(window, ref, 'многострочный\nтекст', true);
    expect(result).toEqual({ inserted: true, submitted: true, reason: null });
    await expect.poll(() => screenText(window)).toContain('PASTE<<многострочный');
    await expect.poll(() => screenText(window)).toContain('echo: многострочный');
  });

  test('набрано abc без Enter → pty.send с submit: true даёт reason: draft, новой строки echo: нет', async () => {
    const input = window.locator('.xterm-helper-textarea');
    await input.click();
    await input.type('abc');
    await expect.poll(() => screenText(window)).toContain('abc');

    const result = await sendToAgent(window, ref, 'hi', true);
    expect(result).toEqual({ inserted: true, submitted: false, reason: 'draft' });
    await expect.poll(() => screenText(window)).toContain('PASTE<<hi>>');
    // Дольше окна Enter (500 мс): Enter так и не нажат.
    await window.waitForTimeout(1000);
    expect(await screenText(window)).not.toContain('echo:');
  });

  test('вставка картинки без текста — PNG 0600 в drops/, путь в кавычках без Enter', async () => {
    const prevented = await window.locator('.xterm-helper-textarea').first().evaluate((textarea) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' }));
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      textarea.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(prevented).toBe(true);

    const drops = path.join(home, 'desktop', 'drops');
    await expect.poll(async () => (await readdir(drops).catch(() => [])).length).toBe(1);
    const [name] = await readdir(drops);
    if (name === undefined) throw new Error('drops/ пуст');
    expect(name).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}\.png$/);
    const file = path.join(drops, name);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await expect.poll(() => screenText(window)).toContain(`PASTE<<'${file}' >>`);
    await window.waitForTimeout(1000);
    expect(await screenText(window)).not.toContain('echo:');
  });

  // Раунд fix-host-resync (review-5.4-B, Critical): после Resume открытая вкладка молчала —
  // хост терял её подписку на exit и о новом процессе не сообщал; обход — переключить вкладку.
  test('stub вышел → бросок даёт тост «isn\'t running» с Resume → после Resume бросок виден в той же вкладке', async () => {
    // Выход по команде самого stub, набранной в терминале, — сигналы и поиск pid не нужны.
    const input = window.locator('.xterm-helper-textarea');
    await input.click();
    await input.type('STUB_EXIT');
    await input.press('Enter');
    await expect.poll(async () => ((await window.evaluate(() => (globalThis as unknown as Harnas).harnas.call('host.info', {}))) as { liveSessions: number }).liveSessions).toBe(0);
    // Resume в тосте есть только у сессии, чей выход уже записан в карту (canResume); запись
    // идёт через файл карты и рассылку works.changed — на холодном старте дольше 5 с по умолчанию.
    await expect(window.getByText('Asleep').first()).toBeVisible({ timeout: 15_000 });

    const first = path.join(project, 'before-resume.txt');
    await writeFile(first, 'x');
    expect(await dropFile(window, first)).toEqual({ over: true, drop: true });
    const toast = window.locator('[data-sonner-toast]').filter({ hasText: "isn't running" });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Resume' }).click();
    await expect.poll(async () => ((await window.evaluate(() => (globalThis as unknown as Harnas).harnas.call('host.info', {}))) as { liveSessions: number }).liveSessions).toBe(1);

    // Новый stub включает bracketed paste не сразу после старта процесса, а экран вкладки без
    // исправления его строку готовности не покажет — ждём так же, как beforeEach после неё.
    await window.waitForTimeout(500);
    // Ни переключения вкладки, ни ручного pty.attach: вкладка та же, что была открыта.
    const second = path.join(project, 'after-resume.txt');
    await writeFile(second, 'y');
    expect(await dropFile(window, second)).toEqual({ over: true, drop: true });
    await expect.poll(() => screenText(window), { timeout: 10_000 }).toContain(`PASTE<<'${second}' >>`);
  });

  test('бросок файла на терминал — путь в кавычках shell без Enter', async () => {
    const dropped = path.join(project, "it's a file.txt");
    await writeFile(dropped, 'x');
    await window.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'e2e-drop-input';
      input.style.display = 'none';
      document.body.appendChild(input);
    });
    await window.locator('#e2e-drop-input').setInputFiles(dropped);

    const accepted = await window.locator('.xterm-helper-textarea').first().evaluate((textarea) => {
      const input = document.getElementById('e2e-drop-input') as HTMLInputElement;
      const file = input.files?.[0];
      if (file === undefined) throw new Error('файл не выбран');
      const data = new DataTransfer();
      data.items.add(file);
      const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
      textarea.dispatchEvent(over);
      const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
      textarea.dispatchEvent(drop);
      input.remove();
      return { over: over.defaultPrevented, drop: drop.defaultPrevented };
    });
    expect(accepted).toEqual({ over: true, drop: true });

    const quoted = `'${dropped.replaceAll("'", "'\\''")}'`;
    await expect.poll(() => screenText(window)).toContain(`PASTE<<${quoted} >>`);
    await window.waitForTimeout(1000);
    expect(await screenText(window)).not.toContain('echo:');
  });
});
