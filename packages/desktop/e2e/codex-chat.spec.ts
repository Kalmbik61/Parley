import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Вид Chat у Codex на журнале (план 2026-10-07, часть C, Task 17; спека 3, 5.2–5.7): лента строится из rollout-файла
 * Codex, а не из хуков. Агент — заглушка `stub-codex-agent.mjs`: версия `0.160.0` из `STUB_CODEX_VERSION`, журнал
 * в `STUB_CODEX_SESSIONS` (он же `PARLEY_CODEX_SESSIONS_DIR` хоста), команды `STUB_*` пишут в журнал элементы
 * (`STUB_CMD`, `STUB_EDIT`, `STUB_SAY`, `STUB_SUBAGENT`) — отправка окна (`pty.send`) и поле Chat. Проба версий
 * включена (`PARLEY_SKIP_VERSION_PROBE: ''`), claude и glm тоже подменены: настоящие CLI в E2E не запускаются.
 * Хуки Codex (Task 22, поправка к части D): настройка `codexApprovals` включается `settings.set` до создания сессии;
 * `STUB_CODEX_HOOKS_TRUSTED=1` — стаб вызывает хуки из `-c hooks.*` (доверие дано), без него — как неодобренные;
 * срок подсказки сокращён `PARLEY_CODEX_HOOK_GRACE_MS`. `STUB_ARGV_LOG` — argv стаба для проверки `-c hooks.*`.
 * `E2E_DPR=2` запускает окно с `--force-device-scale-factor=2`. Снимки — в `test-results/codex-chat/` (не коммитятся).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubEcho = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const shots = path.resolve(dirname, '../test-results/codex-chat');
const dpr = process.env.E2E_DPR === '2' ? '2' : '1';

const THREAD = '019ce3d5-584a-7be2-922e-b8185a8d7c19';
const SUB = 'th-sub';
/** Команда ровно в 140 знаков: длинная строка `Bash` не должна выпирать из ленты. */
const COMMAND =
  `grep -rn "agentCard" packages/desktop/src/renderer --include=*.ts --include=*.tsx | sort | uniq -c | sort -rn | head -${'9'.repeat(60)}`.slice(
    0,
    140,
  );
/** Начало задания агента — как его пишет заглушка (`CHILD_TASK`). */
const CHILD_TASK_HEAD = 'Найди все места, где строится карточка агента';

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

type Parley = { parley: { call: (m: string, p: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as Parley).parley.call(m, p), [
    method,
    params,
  ] as const) as Promise<T>;
}

/** Текст экрана терминала: строки DOM-рендера подряд. */
async function screenText(window: Page): Promise<string> {
  return window
    .locator('.xterm-rows')
    .first()
    .evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''));
}

/** Путь правки в 120 знаков (под каталогом проекта): строка правки в ленте не должна выпирать. */
function longEditPath(project: string): string {
  return `${`${project}/src/${'nested-directory-'.repeat(12)}`.slice(0, 117)}.ts`;
}

async function shot(window: Page, name: string): Promise<void> {
  await window.waitForTimeout(500);
  await window.screenshot({ path: path.join(shots, `${name}-dpr${dpr}.png`) });
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

test.describe('вид Chat у Codex на журнале (план 2026-10-07, Task 17)', () => {
  test.setTimeout(120_000);

  let home: string;
  let project: string;
  let codexRoot: string;
  let argvLog: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('codex-chat');
    project = await makeTempProject('codex-chat');
    codexRoot = path.join(home, 'codex-sessions');
    argvLog = path.join(home, 'stub-argv.log');
    await mkdir(codexRoot, { recursive: true });
    await mkdir(shots, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  interface Opened {
    app: ElectronApplication;
    window: Page;
    ref: Ref;
    errors: string[];
  }

  /**
   * Окно со стабом Codex нужной версии и одной запущенной сессией; открыта вкладка сессии. `hooks`: `off` —
   * настройка `codexApprovals` выключена (по умолчанию), `trusted` — включена и стаб вызывает хуки, `untrusted` —
   * включена, но хуки не одобрены.
   */
  async function open(
    width: number,
    height: number,
    version = '0.160.0',
    hooks: 'off' | 'trusted' | 'untrusted' = 'off',
  ): Promise<Opened> {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubEcho,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_CODEX_SESSIONS_DIR: codexRoot,
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      STUB_CODEX_SESSIONS: codexRoot,
      STUB_CODEX_VERSION: version,
      STUB_CODEX_THREAD: THREAD,
      STUB_ARGV_LOG: argvLog,
      PARLEY_CODEX_HOOK_GRACE_MS: '1000',
      STUB_CODEX_HOOKS_TRUSTED: hooks === 'trusted' ? '1' : '',
    };
    const app = await electron.launch({
      args: [mainEntry, `--force-device-scale-factor=${dpr}`],
      env,
    });
    running = app;
    const window = await app.firstWindow();
    await resize(app, width, height);
    await expect(window.getByTestId('landing')).toBeVisible();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    if (hooks !== 'off') {
      await call(window, 'settings.set', { key: 'codexApprovals', value: 'true' });
    }
    const work = await call<{ workId: string }>(window, 'works.create', {
      projectPath: project,
      title: 'e2e-codex-chat',
      goal: '',
    });
    const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
      projectPath: project,
      workId: work.workId,
      provider: 'codex',
      label: 'кодекс',
      task: '',
      parent: null,
    });
    const ref: Ref = {
      projectPath: project,
      workId: work.workId,
      sessionId: created.ref.sessionId,
    };
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    // Вкладка уже открывается чатом, если журнал сессии нашёлся (вид Chat по умолчанию), иначе терминалом.
    await expect(
      window.getByTestId('chat-view').or(window.locator('.xterm').first()),
    ).toBeVisible();
    return { app, window, ref, errors };
  }

  /** Строка в агента как письмо окна: вставка и Enter; отказ хоста («ещё не Ready») повторяется. */
  async function stub(window: Page, ref: Ref, text: string): Promise<void> {
    await expect
      .poll(
        async () =>
          (await call<{ submitted: boolean }>(window, 'pty.send', { ref, text, submit: true }))
            .submitted,
        { timeout: 15_000, message: text },
      )
      .toBe(true);
  }

  async function toChat(window: Page): Promise<Locator> {
    const segment = window.getByRole('radio', { name: 'Chat' });
    await expect(segment).toBeEnabled({ timeout: 15_000 });
    await segment.click();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    return chat;
  }

  test('сегмент Chat включён; промпт, Bash, правка с диффом, ответ и черта конца хода; Terminal и обратно — тот же тред', async () => {
    const { window, ref, errors } = await open(1400, 900);
    const chat = await toChat(window);
    await expect(window.getByRole('radio', { name: 'Chat' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(window.locator('.xterm')).toHaveCount(0);

    // Ввод из поля Chat: вставка и Enter — заглушка пишет UserMessage, лента показывает промпт.
    await chat.getByTestId('chat-composer').getByRole('textbox').fill('Почини тесты');
    await window.keyboard.press('Enter');
    await expect(chat.getByTestId('chat-prompt').first()).toContainText('Почини тесты', {
      timeout: 20_000,
    });

    await stub(window, ref, `STUB_CMD ${COMMAND}`);
    const bash = chat.getByTestId('chat-tool').filter({ hasText: 'Bash' });
    await expect(bash).toHaveCount(1, { timeout: 20_000 });
    await expect(bash).toContainText(COMMAND);

    const editPath = longEditPath(project);
    await stub(window, ref, `STUB_EDIT ${editPath}`);
    const edit = chat.getByTestId('chat-tool').filter({ hasText: 'Edit' });
    await expect(edit).toHaveCount(1, { timeout: 20_000 });
    await edit.getByRole('button').first().click();
    await expect(edit.getByTestId('chat-diff')).toContainText('const b = 3');
    await expect(edit.locator('[data-diff-row="added"]')).toContainText('const b = 3');

    await stub(window, ref, 'STUB_SAY Готово');
    await expect(chat.getByTestId('chat-text').filter({ hasText: 'Готово' })).toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(chat.getByTestId('chat-turn')).toHaveCount(1);
    await expect(chat.getByTestId('chat-turn')).not.toHaveAttribute('data-turn-interrupted', '');
    await shot(window, 'feed-1400x900');

    // Terminal и обратно: тот же тред — экран заглушки показывает введённое, лента на месте без дублей.
    const promptsBefore = await chat.getByTestId('chat-prompt').count();
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect.poll(() => screenText(window)).toContain('enter: Почини тесты');
    await window.getByRole('radio', { name: 'Chat' }).click();
    await expect(chat.getByTestId('chat-tool').filter({ hasText: 'Bash' })).toHaveCount(1);
    await expect(chat.getByTestId('chat-prompt')).toHaveCount(promptsBefore);
    await expect(chat.getByTestId('chat-turn')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('Stop во время хода пишет в ленту черту «Interrupted»', async () => {
    const { window, ref, errors } = await open(1400, 900);
    const chat = await toChat(window);
    await stub(window, ref, 'STUB_WORK');
    const stop = chat.getByTestId('chat-stop');
    await expect(stop).toBeVisible({ timeout: 20_000 });
    await stop.click();
    await expect(chat.locator('[data-testid="chat-turn"][data-turn-interrupted]')).toContainText(
      'Interrupted',
      { timeout: 20_000 },
    );
    await expect(chat.getByTestId('chat-stop')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('запрос подтверждения в терминале Codex — баннер ожидания в ленте, переход в терминал показывает вопрос', async () => {
    const { window, ref, errors } = await open(1400, 900);
    const chat = await toChat(window);
    await stub(window, ref, 'STUB_APPROVAL');
    const banner = chat.getByTestId('chat-waiting-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await chat.getByTestId('chat-waiting-open').click();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect.poll(() => screenText(window)).toContain('enter: STUB_APPROVAL');
    expect(errors).toEqual([]);
  });

  test('агент: карточка в ленте, вкладка Agents с текущей командой, экран агента — задание и итог', async () => {
    const { window, ref, errors } = await open(1400, 900);
    const chat = await toChat(window);
    await stub(window, ref, `STUB_SUBAGENT ${SUB}`);
    await expect(chat.getByTestId('chat-agent')).toHaveCount(1, { timeout: 20_000 });
    const running = chat.getByTestId('chat-agents-running');
    await expect(running).toContainText('1 agent running');
    await running.click();

    await expect(window.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const row = window.getByTestId('agents-panel').getByTestId('agents-row-running');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('rg -n newAgent packages/core/src', { timeout: 20_000 });
    await shot(window, 'agents-list-1400x900');

    await row.click();
    const detail = window.getByTestId('agent-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(CHILD_TASK_HEAD);
    await shot(window, 'agent-detail-1400x900');

    await stub(window, ref, `STUB_SUBAGENT_DONE ${SUB}`);
    await expect(detail.getByRole('heading', { name: 'Result' })).toBeVisible({ timeout: 20_000 });
    await expect(detail).toContainText('Нашёл: reduce.ts:452');
    expect(errors).toEqual([]);
  });

  test('Codex 0.159.0: сегмент Chat выключен, подсказка называет нужную версию', async () => {
    const { window } = await open(1400, 900, '0.159.0');
    await expect(window.getByRole('radio', { name: 'Chat' })).toBeDisabled({ timeout: 15_000 });
    await expect(window.getByTitle('Chat needs Codex 0.160.0 or newer')).toHaveCount(1);
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect(window.locator('.xterm').first()).toBeVisible();
  });

  /** Запуски стаба из `STUB_ARGV_LOG`: argv и окружение Parley каждого. */
  async function launches(): Promise<Array<{ argv: string[]; env: Record<string, string> }>> {
    const text = await readFile(argvLog, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter((row) => row !== '')
      .map((row) => JSON.parse(row) as { argv: string[]; env: Record<string, string> })
      // Клиент ролей хоста (`app-server --stdio`) — не сессия под терминалом.
      .filter((launch) => launch.argv[0] !== 'app-server');
  }

  /** Терминальный ответ стаба на `STUB_PERMISSION`: строка `approved`, `denied` или `prompt` на экране. */
  async function terminalSays(window: Page): Promise<string> {
    await window.getByRole('radio', { name: 'Terminal' }).click();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    return screenText(window);
  }

  test('настройка выключена: в argv стаба нет hooks., PARLEY_HOOK_URL нет, подсказки про хуки нет', async () => {
    const { window, ref, errors } = await open(1400, 900);
    const chat = await toChat(window);
    await stub(window, ref, 'STUB_WORK');
    await expect(chat.getByTestId('chat-stop')).toBeVisible({ timeout: 20_000 });
    // Срок подсказки (1 с) давно вышел бы при включённой настройке.
    await window.waitForTimeout(2_500);
    await expect(chat.getByTestId('codex-hooks-hint')).toHaveCount(0);
    await expect.poll(async () => (await launches()).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const [first] = await launches();
    expect(first).toBeDefined();
    expect(first?.argv.some((arg) => arg.startsWith('hooks.'))).toBe(false);
    expect(first?.env['PARLEY_HOOK_URL']).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('настройка включена, хуки доверены: 7 пар -c hooks.*; Allow — в терминале approved, Deny — denied; вызов Bash без дубля', async () => {
    const { window, ref, errors } = await open(1400, 900, '0.160.0', 'trusted');
    const chat = await toChat(window);
    await expect.poll(async () => (await launches()).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const [first] = await launches();
    expect(first?.argv.filter((arg) => arg.startsWith('hooks.')).length).toBe(7);
    expect(first?.env['PARLEY_HOOK_URL']).toBeDefined();
    expect(first?.env['PARLEY_HOOK_TOKEN']).toBeDefined();

    await chat.getByTestId('chat-composer').getByRole('textbox').fill('Сделай');
    await window.keyboard.press('Enter');
    await expect(chat.getByTestId('chat-prompt').first()).toContainText('Сделай', { timeout: 20_000 });

    // Хуки пришли — подсказки про доверие нет, даже после срока ожидания.
    await window.waitForTimeout(2_500);
    await expect(chat.getByTestId('codex-hooks-hint')).toHaveCount(0);

    const pending = chat.locator('[data-testid="chat-card"][data-card-kind="permission"][data-card-state="pending"]');
    await stub(window, ref, 'STUB_PERMISSION touch ~/outside');
    await expect(pending).toHaveCount(1, { timeout: 20_000 });
    await expect(pending).toContainText('touch ~/outside');
    await expect(pending.getByTestId('card-allow')).toBeVisible();
    await expect(pending.getByTestId('card-deny')).toBeVisible();
    await expect(chat.getByTestId('chat-waiting-banner')).toHaveCount(0);
    await shot(window, 'permission-card-1400x900');
    await pending.getByTestId('card-allow').click();
    await expect(
      chat.locator('[data-testid="chat-card"][data-card-kind="permission"][data-card-state="allowed"]'),
    ).toHaveCount(1, { timeout: 20_000 });

    await stub(window, ref, 'STUB_PERMISSION rm -rf ~/outside');
    await expect(pending).toHaveCount(1, { timeout: 20_000 });
    await pending.getByTestId('card-deny').click();
    await expect(
      chat.locator('[data-testid="chat-card"][data-card-kind="permission"][data-card-state="denied"]'),
    ).toHaveCount(1, { timeout: 20_000 });

    // Ответы моста дошли до «TUI» стаба.
    await expect.poll(async () => {
      const text = await terminalSays(window);
      await window.getByRole('radio', { name: 'Chat' }).click();
      return text;
    }).toMatch(/approved[\s\S]*denied/);

    // Вызов команды с доверенными хуками (PreToolUse, запись журнала, PostToolUse): в ленте одна строка Bash, не две.
    await stub(window, ref, `STUB_CMD ${COMMAND}`);
    const bash = chat.getByTestId('chat-tool').filter({ hasText: COMMAND.slice(0, 40) });
    await expect(bash).toHaveCount(1, { timeout: 20_000 });
    await expect(bash).toHaveAttribute('data-tool-status', 'done', { timeout: 20_000 });
    await window.waitForTimeout(1_000);
    await expect(bash).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('настройка включена, хуки не одобрены: подсказка про доверие, Open terminal, STUB_APPROVAL — баннер ожидания без карточки', async () => {
    const { window, ref, errors } = await open(1400, 900, '0.160.0', 'untrusted');
    const chat = await toChat(window);
    const hint = chat.getByTestId('codex-hooks-hint');
    await expect(hint).toBeVisible({ timeout: 20_000 });
    await expect(hint).toContainText('Trust all and continue');
    await shot(window, 'hooks-hint-1400x900');

    await stub(window, ref, 'STUB_APPROVAL');
    await expect(chat.getByTestId('chat-waiting-banner')).toBeVisible({ timeout: 20_000 });
    await expect(chat.locator('[data-testid="chat-card"][data-card-kind="permission"]')).toHaveCount(0);

    await hint.getByRole('button', { name: 'Open terminal' }).click();
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect.poll(() => screenText(window)).toContain('enter: STUB_APPROVAL');
    expect(errors).toEqual([]);
  });

  /** Ничего в ленте не шире её рамки и не выпирает за правый край. */
  async function fitsChat(chat: Locator, name: string): Promise<void> {
    const box = await boxOf(chat);
    const edge = box.x + box.width;
    expect(
      await chat.evaluate((element) => element.scrollWidth <= element.clientWidth),
      `${name}: scrollWidth`,
    ).toBe(true);
    for (const item of await chat.locator('button, section, header, li, p, pre, textarea, input').all()) {
      const itemBox = await item.boundingBox();
      if (itemBox !== null) expect(itemBox.x + itemBox.width, `${name}: край элемента`).toBeLessThanOrEqual(edge + 0.5);
    }
  }

  test('800×500 с длинной командой: карточка Allow/Deny не вылезает за край', async () => {
    const longCommand = `touch ${'very-long-directory-name/'.repeat(8)}file-${'x'.repeat(60)}.txt`;
    const { window, ref, errors } = await open(800, 500, '0.160.0', 'trusted');
    const chat = await toChat(window);
    await stub(window, ref, `STUB_PERMISSION ${longCommand}`);
    const card = chat.locator('[data-testid="chat-card"][data-card-kind="permission"][data-card-state="pending"]');
    await expect(card).toHaveCount(1, { timeout: 20_000 });
    await expect(card.getByTestId('card-deny')).toBeVisible();
    await fitsChat(chat, 'карточка');
    await shot(window, 'permission-card-800x500');
    expect(errors).toEqual([]);
  });

  test('800×500: подсказка про хуки не вылезает за край', async () => {
    const { window, errors } = await open(800, 500, '0.160.0', 'untrusted');
    const chat = await toChat(window);
    await expect(chat.getByTestId('codex-hooks-hint')).toBeVisible({ timeout: 20_000 });
    await fitsChat(chat, 'подсказка');
    await shot(window, 'hooks-hint-800x500');
    expect(errors).toEqual([]);
  });

  for (const closeLeft of [false, true]) {
    test(`раскладка 800×500 с длинными значениями, левый сайдбар ${closeLeft ? 'закрыт' : 'открыт'}: лента и панель Agents не вылезают за край`, async () => {
      const { window, ref, errors } = await open(800, 500);
      if (closeLeft) await window.keyboard.press('Meta+B');
      const chat = await toChat(window);
      await chat.getByTestId('chat-composer').getByRole('textbox').fill('Почини тесты');
      await window.keyboard.press('Enter');
      await expect(chat.getByTestId('chat-prompt').first()).toContainText('Почини тесты', {
        timeout: 20_000,
      });
      await stub(window, ref, `STUB_CMD ${COMMAND}`);
      await stub(window, ref, `STUB_EDIT ${longEditPath(project)}`);
      await stub(window, ref, `STUB_SUBAGENT ${SUB}`);
      await expect(chat.getByTestId('chat-agent')).toHaveCount(1, { timeout: 20_000 });
      await expect(chat.getByTestId('chat-tool')).toHaveCount(2);
      await expect(
        chat.getByTestId('chat-tool').filter({ hasText: 'Edit' }).getByRole('button').first(),
      ).toBeVisible();
      await chat
        .getByTestId('chat-tool')
        .filter({ hasText: 'Edit' })
        .getByRole('button')
        .first()
        .click();
      await expect(chat.getByTestId('chat-diff')).toBeVisible();

      const fits = async (root: Locator, name: string, edge: number): Promise<void> => {
        expect(
          await root.evaluate((element) => element.scrollWidth <= element.clientWidth),
          `${name}: scrollWidth`,
        ).toBe(true);
        for (const item of await root.locator('button, section, header, li, p, pre').all()) {
          const box = await item.boundingBox();
          if (box !== null)
            expect(box.x + box.width, `${name}: край элемента`).toBeLessThanOrEqual(edge + 0.5);
        }
      };
      const feed = chat.getByTestId('chat-feed');
      await fits(feed, 'chat-feed', (await boxOf(chat)).x + (await boxOf(chat)).width);
      await shot(window, `feed-800x500-left-${closeLeft ? 'closed' : 'open'}`);

      await chat.getByTestId('chat-agents-running').click();
      const sidebar = window.getByTestId('right-sidebar');
      if ((await sidebar.count()) === 0) {
        // Места на сайдбар нет — прежнее поведение: прокрутка ленты к карточке агента.
        await expect(window.getByTestId('chat-agent')).toBeVisible();
        await shot(window, `agents-no-room-800x500-left-${closeLeft ? 'closed' : 'open'}`);
      } else {
        await expect(window.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        const edge = (await boxOf(sidebar)).x + (await boxOf(sidebar)).width;
        await expect(window.getByTestId('agents-row-running')).toHaveCount(1);
        await fits(window.getByTestId('agents-panel'), 'agents-panel', edge);
        await shot(window, `agents-list-800x500-left-${closeLeft ? 'closed' : 'open'}`);
        await window.getByTestId('agents-row-running').click();
        await expect(window.getByTestId('agent-detail')).toBeVisible();
        await fits(window.getByTestId('agent-detail'), 'agent-detail', edge);
        await shot(window, `agent-detail-800x500-left-${closeLeft ? 'closed' : 'open'}`);
      }
      expect(errors).toEqual([]);
    });
  }
});
