import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
// @ts-expect-error — .mjs без деклараций: форма результата описана ниже в FakeTelegram.
import { startFakeTelegram } from './fake-telegram.mjs';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Канал Telegram (план B, задача 14): Settings → Notifications → раздел Telegram → токен → привязка кодом → вопрос
 * помощнику из чата Telegram → выключатель «Send to Telegram». Telegram подменяет `fake-telegram.mjs`: Bot API
 * на 127.0.0.1 в процессе Playwright, хост ходит в него по `PARLEY_TELEGRAM_API`. Вместо `claude` — тот же
 * `stub-assistant-agent.mjs`, что у `assistant.spec.ts`: на неизвестный вопрос он отвечает «Nothing is open right now.».
 * Каркас — как у `assistant.spec.ts`; окно 800×500, остров включён пустым `PARLEY_ISLAND`.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-assistant-agent.mjs');

/** Токен нужной формы `<id>:<35 знаков>`; сервер всё равно принимает любой. */
const TOKEN = `123456:${'A'.repeat(35)}`;
const OWNER_CHAT = 777;

interface FakeTelegram {
  url: string;
  push: (update: Record<string, unknown>) => void;
  sent: () => Array<{ method: string; chatId: number; text: string }>;
  requests: () => Array<{ method: string; body: Record<string, unknown>; at: number }>;
  close: () => Promise<void>;
}

type Parley = {
  parley: {
    app: { saveUi: (patch: unknown) => Promise<unknown> };
  };
};

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

test.describe('канал Telegram', () => {
  let home: string;
  let project: string;
  let app: ElectronApplication | null = null;
  let fake: FakeTelegram | null = null;
  let updateId = 1000;

  test.beforeEach(async () => {
    home = await makeTempHome('telegram');
    project = await makeTempProject('telegram');
    fake = (await startFakeTelegram()) as FakeTelegram;
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await fake?.close();
    fake = null;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Апдейт «личное сообщение от владельца» в том виде, в каком его присылает Telegram. */
  function ownerMessage(text: string): Record<string, unknown> {
    updateId += 1;
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT, type: 'private' },
        from: { id: OWNER_CHAT, username: 'owner', first_name: 'Owner' },
        text,
      },
    };
  }

  test('токен → Check → Link → /start код → вопрос боту → ответ помощника → выключатель останавливает опрос', async () => {
    test.setTimeout(180_000);
    const bot = fake!;
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
        PARLEY_TELEGRAM_API: bot.url,
      },
    });
    const window = await mainWindowOf(app);
    await resizeMain(app, 800, 500);
    await expect(window.getByTestId('landing')).toBeVisible();

    // 1. Помощник включаем (вопросы из Telegram идут ему); Settings → Notifications → раздел Telegram.
    await window.evaluate(() => (globalThis as unknown as Parley).parley.app.saveUi({ assistant: { enabled: true, provider: 'claude' } }));
    await window.keyboard.press('Meta+,');
    await window.getByRole('tab', { name: 'Notifications' }).click();
    const section = window.getByTestId('telegram-section');
    await expect(section).toBeVisible();
    const status = window.getByTestId('telegram-status');

    // 2. Токен → Check: хост спрашивает у фейка getMe и показывает имя бота.
    await window.getByTestId('telegram-token').fill(TOKEN);
    await window.getByTestId('telegram-check').click();
    await expect(status).toContainText('@parley_fake_bot', { timeout: 30_000 });

    // 3. Link → код на экране → бот получает «/start <код>» от владельца → привязка.
    await window.getByTestId('telegram-link').click();
    const code = window.getByTestId('telegram-code');
    await expect(code).toBeVisible();
    const linkCode = (await code.innerText()).trim();
    expect(linkCode).not.toBe('');
    bot.push(ownerMessage(`/start ${linkCode}`));
    await expect(status).toContainText('Linked: @owner', { timeout: 30_000 });
    await expect
      .poll(() => bot.sent().some((message) => message.chatId === OWNER_CHAT && message.text.includes('Linked to ')), {
        message: 'бот ответил в чат владельца, что привязка выполнена',
        timeout: 30_000,
      })
      .toBe(true);

    // 4. Вопрос в чат бота → ход помощника (стаб) → ответ уходит в тот же чат.
    bot.push(ownerMessage('what is going on?'));
    await expect
      .poll(() => bot.sent().some((message) => message.chatId === OWNER_CHAT && message.text.includes('Nothing is open right now')), {
        message: 'ответ помощника пришёл в чат владельца',
        timeout: 30_000,
      })
      .toBe(true);

    // 5. «Send to Telegram» выкл → статус «Off», хост перестаёт опрашивать getUpdates.
    await window.getByTestId('telegram-enabled').click();
    await expect(status).toHaveText('Off', { timeout: 30_000 });
    // Опрос, начатый до выключения, мог дойти до журнала позже статуса: даём ему осесть и только потом считаем.
    await window.waitForTimeout(500);
    const polls = (): number => bot.requests().filter((request) => request.method === 'getUpdates').length;
    const before = polls();
    await window.waitForTimeout(3000);
    expect(polls()).toBe(before);
  });
});
