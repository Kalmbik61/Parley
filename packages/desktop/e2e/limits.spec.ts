import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Лимиты подписок в строке статуса (кусок 9b, спека комнат Organic, 3.5). Данные — как у настоящего
 * `claude`: тест кладёт файл `limits/<сессия>.json` в каталог работы так, как его пишет скрипт строки статуса
 * (`{ at, rateLimits }`, `resets_at` в Unix-секундах, атомарно), а хост, запущенный с малым
 * `PARLEY_LIMITS_POLL_MS`, подхватывает его и шлёт окну `providers.limitsChanged`. Настоящий `claude` не
 * запускается никогда — только стаб `PARLEY_CLAUDE_BIN`; `resets_at` — в будущем, чтобы хост не отбросил окно.
 *
 * Codex — так же по данным, а не по запуску: `PARLEY_CODEX_BIN` указывает на стаб (проба версии в E2E выключена,
 * команда только должна найтись), а rollout-лог с `token_count` лежит в корне логов Codex этого теста.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

/** Метка провайдера, которой нечем уместиться в 800×500 (около 400 px): потолков ширины у имени нет, урезает её только нехватка места. */
const LONG_LABEL = 'Extremely Long Provider Label For The Status Bar Layout Check';

/** `E2E_DPR=2` запускает окно с `--force-device-scale-factor=2`; без неё — как было, без флага. */
const dprArgs = process.env.E2E_DPR === '2' ? ['--force-device-scale-factor=2'] : [];

/**
 * Время сброса в тексте лимитов (P7), только в широкой строке (от 1060 px содержимого, окно ≈ 1092 и шире): «↻9:30 PM» у
 * пяти часов, «↻Sat 9:30 PM» у недели — местное, как в тултипе. В узкой строке (800×500) текст прежний, без сбросов.
 */
const FIVE_HOUR_RESET = String.raw`↻\d{1,2}:\d{2}\s[AP]M`;
const WEEK_RESET = String.raw`↻[A-Z][a-z]{2} \d{1,2}:\d{2}\s[AP]M`;
/** Весь текст лимитов в широкой строке: «58% 5h ↻9:30 PM · 41% wk ↻Sat 9:30 PM»; недели нет — без второй половины. */
const limitsLine = (fiveHour: number, week: number | null): RegExp =>
  new RegExp(`^${fiveHour}% 5h ${FIVE_HOUR_RESET}${week === null ? '' : ` · ${week}% wk ${WEEK_RESET}`}$`);

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function newSession(window: Page, workId: string, provider: string, label: string): Promise<string> {
  const created = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
    projectPath: project,
    workId,
    provider,
    label,
    task: '',
    parent: null,
  });
  return created.ref.sessionId;
}

/**
 * Файл лимитов сессии — то, что пишет скрипт строки статуса (`core/src/work/statusline.ts`): `{ at, rateLimits }`
 * во временный файл рядом и `rename`, чтобы хост не прочитал недописанное. Окна — как в `rate_limits` Claude Code:
 * `five_hour` и `seven_day`, `used_percentage` и `resets_at` в Unix-секундах; сбросы — впереди.
 */
async function writeLimits(workId: string, sessionId: string, fiveHour: number | null, week: number | null): Promise<void> {
  const dir = path.join(project, '.parley', 'works', workId, 'limits');
  await mkdir(dir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const rateLimits: Record<string, { used_percentage: number; resets_at: number }> = {};
  if (fiveHour !== null) rateLimits['five_hour'] = { used_percentage: fiveHour, resets_at: nowSec + 2 * 3600 };
  if (week !== null) rateLimits['seven_day'] = { used_percentage: week, resets_at: nowSec + 3 * 86_400 };
  const file = path.join(dir, `${sessionId}.json`);
  await writeFile(`${file}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), rateLimits })}\n`);
  await rename(`${file}.tmp`, file);
}

/**
 * rollout-лог Codex с одним `token_count` (`core/src/codex/limits.ts`): окно 300 минут — пять часов, второго нет.
 * Раскладка каталогов — ровно `<год>/<месяц>/<день>/rollout-*-<uuid>.jsonl`.
 */
async function writeCodexLimits(root: string, usedPercent: number): Promise<void> {
  const now = new Date();
  const dir = path.join(root, String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  await mkdir(dir, { recursive: true });
  const record = {
    timestamp: now.toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: { primary: { used_percent: usedPercent, window_minutes: 300, resets_at: Math.floor(now.getTime() / 1000) + 3 * 3600 } },
    },
  };
  await writeFile(path.join(dir, 'rollout-2026-09-29T18-00-00-01234567-89ab-cdef-0123-456789abcdef.jsonl'), `${JSON.stringify(record)}\n`);
}

test.describe('лимиты подписок в строке статуса (кусок 9b)', () => {
  let home: string;
  let app: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('limits');
    project = await makeTempProject('limits');
  });

  test.afterEach(async () => {
    await stopApp(app);
    app = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(size: { width: number; height: number }, extraEnv: Record<string, string> = {}): Promise<Page> {
    // Малый период опроса — иначе числа появились бы через полминуты (`PARLEY_LIMITS_POLL_MS`, зажат в [200, 2^31−1]).
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_TERMINAL_RENDERER: 'dom',
      PARLEY_LIMITS_POLL_MS: '200',
      ...extraEnv,
    };
    const electronApp = await electron.launch({ args: [mainEntry, ...dprArgs], env });
    app = electronApp;
    const window = await electronApp.firstWindow();
    await electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...bounds }), size);
    await expect(window.getByTestId('landing')).toBeVisible();
    return window;
  }

  test('файл данных строки статуса — «58% 5h · 41% wk» в сегменте Claude Code; новый файл меняет числа на месте, от 80 % — accent-700', async () => {
    const window = await launch({ width: 1400, height: 900 });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-limits', goal: '' });
    const sessionId = await newSession(window, workId, 'claude', 'один');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    // Сегмент — `display: contents`, своей рамки у него нет: смотрим на его имя.
    const segment = window.locator('[data-provider-segment="claude"]');
    await expect(segment.getByText('Claude Code')).toBeVisible();
    // Данных ещё нет — сегмент как был: значок и имя.
    await expect(segment.locator('[data-limits]')).toHaveCount(0);

    await writeLimits(workId, sessionId, 58.7, 41.9);
    const limits = segment.locator('[data-limits]');
    // 58.7 → 58, 41.9 → 41: проценты целые, округление вниз; 1400 — строка широкая, рядом с процентами время сброса (P7).
    await expect(limits).toHaveText(limitsLine(58, 41), { timeout: 15_000 });
    // Места хватает: времена сброса показаны целиком, без многоточия.
    const resets = limits.locator('[data-limit-reset]');
    await expect(resets).toHaveCount(2);
    for (const reset of await resets.all()) {
      const fit = await reset.evaluate((el) => ({ width: el.getBoundingClientRect().width, cut: el.scrollWidth > el.clientWidth }));
      expect(fit.width).toBeGreaterThan(30);
      expect(fit.cut).toBe(false);
    }
    await expect(limits).toHaveAttribute('title', /^5-hour window resets at .+ · Weekly window resets [A-Z][a-z]{2} .+ · Updated .+$/);
    // До порога — обычные цвета: заливка полоски neutral-800, текст без accent-700.
    await expect(limits.locator('[data-limits-fill]')).toHaveClass(/\bbg-neutral-800\b/);
    // Заливка — пятичасовое окно, целые проценты: 58 % трека.
    await expect(limits.locator('[data-limits-fill]')).toHaveAttribute('style', /width:\s*58%/);
    const text = limits.locator(':scope > span').last();
    await expect(text).not.toHaveClass(/text-accent-700/);

    // Новые числа: пятичасовое окно перешло 80 % — то же событие меняет текст и красит его и полоску.
    await writeLimits(workId, sessionId, 85.2, 41.9);
    await expect(limits).toHaveText(limitsLine(85, 41), { timeout: 15_000 });
    await expect(text).toHaveClass(/text-accent-700/);
    await expect(limits.locator('[data-limits-fill]')).toHaveClass(/\bbg-accent-700\b/);

    // Одно окно остаётся одним: недельного нет — «70% 5h», без «wk».
    await writeLimits(workId, sessionId, 70, null);
    await expect(limits).toHaveText(limitsLine(70, null), { timeout: 15_000 });
    await expect(limits).toHaveAttribute('title', /^5-hour window resets at .+ · Updated .+$/);
  });

  test('подключённые провайдеры: переполнение раскрывается по клику и пересчитывается при изменении окна', async () => {
    // Готовая инструкция: уведомление о создании PARLEY.md не перекрывает проверяемый поповер.
    await writeFile(path.join(project, 'PARLEY.md'), '# Test project\n');
    await writeFile(path.join(home, 'providers.json'), JSON.stringify({
      'zeta-agent': { badge: LONG_LABEL, mark: 'Ze', command: stubAgent, linkBy: 'cwd+time' },
    }));
    const codexRoot = path.join(home, 'codex-sessions');
    await writeCodexLimits(codexRoot, 85.4);
    const window = await launch({ width: 800, height: 500 }, {
      PARLEY_CODEX_BIN: stubAgent, PARLEY_CODEX_SESSIONS_DIR: codexRoot,
    });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'overflow', goal: '' });
    const session = await newSession(window, workId, 'claude', 'one');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await writeLimits(workId, session, 58.7, 41.9);
    const row = window.locator('[data-connected-providers]');
    const more = row.getByRole('button', { name: 'More connected providers' });
    await expect(row.locator('[data-provider-segment="claude"] [data-limits]')).toContainText('58% 5h', { timeout: 15_000 });
    await expect(window.getByRole('button', { name: 'Add provider', exact: true })).toHaveCount(0);
    await expect(row.locator('[data-provider-segment="glm"]')).toHaveCount(0);

    for (const width of [800, 1100, 1400, 800]) {
      await (app as ElectronApplication).evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width, height: 600 }), width);
      // Каждый видимый сегмент целиком внутри своей области; правая часть панели остаётся в окне.
      await expect.poll(() => row.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const slots = [...el.querySelectorAll<HTMLElement>('[data-provider-slot]')].filter((slot) => !slot.hasAttribute('aria-hidden'));
        const wake = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Auto-wake on');
        return slots.every((slot) => slot.getBoundingClientRect().right <= box.right + 1) && (wake?.getBoundingClientRect().right ?? Infinity) <= innerWidth;
      })).toBe(true);
      const visible = await row.locator('[data-provider-segment]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-provider-segment')));
      if (visible.length < 3) {
        await more.click();
        const popup = window.getByRole('dialog', { name: 'More connected providers' });
        await expect(popup).toBeVisible();
        const hidden = await popup.locator('[data-provider-segment]').evaluateAll((elements) => elements.map((el) => el.getAttribute('data-provider-segment')));
        expect([...visible, ...hidden]).toEqual(['claude', 'codex', 'zeta-agent']);
        const codex = window.locator('[data-provider-segment="codex"] [data-limits]');
        await expect(codex).toContainText('85% 5h');
        if (width === 800) await popup.screenshot({ path: test.info().outputPath('provider-overflow.png'), animations: 'disabled' });
        await window.keyboard.press('Escape');
        await expect(popup).toHaveCount(0);
      } else {
        await expect(more).toHaveCount(0);
      }
    }
    await expect(more).toBeVisible();
  });
});
