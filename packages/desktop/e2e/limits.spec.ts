import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Лимиты подписок в строке статуса (кусок 9b, спека комнат Organic, 3.5). Данные — как у настоящего
 * `claude`: тест кладёт файл `limits/<сессия>.json` в каталог работы так, как его пишет скрипт строки статуса
 * (`{ at, rateLimits }`, `resets_at` в Unix-секундах, атомарно), а хост, запущенный с малым
 * `HARNAS_LIMITS_POLL_MS`, подхватывает его и шлёт окну `providers.limitsChanged`. Настоящий `claude` не
 * запускается никогда — только стаб `HARNAS_CLAUDE_BIN`; `resets_at` — в будущем, чтобы хост не отбросил окно.
 *
 * Codex — так же по данным, а не по запуску: `HARNAS_CODEX_BIN` указывает на стаб (проба версии в E2E выключена,
 * команда только должна найтись), а rollout-лог с `token_count` лежит в корне логов Codex этого теста.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
/** Свой каталог проекта у каждого теста (`makeTempProject`). */
let project = '';

/** Метка провайдера, которой нечем уместиться в 800×500 (около 400 px): потолков ширины у имени нет, урезает её только нехватка места. */
const LONG_LABEL = 'Extremely Long Provider Label For The Status Bar Layout Check';

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
  const dir = path.join(project, '.harnas', 'works', workId, 'limits');
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

/** Строка в журнал событий сессии — то, что дописал бы хук Claude Code. */
async function hookEvent(workId: string, sessionId: string, event: Record<string, string>): Promise<void> {
  const dir = path.join(project, '.harnas', 'works', workId, 'events');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(event)}\n`);
}

interface Box {
  left: number;
  right: number;
  width: number;
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
    // Малый период опроса — иначе числа появились бы через полминуты (`HARNAS_LIMITS_POLL_MS`, зажат в [200, 2^31−1]).
    const env = {
      ...process.env,
      HARNAS_HOME: home,
      HARNAS_CLAUDE_BIN: stubAgent,
      HARNAS_TERMINAL_RENDERER: 'dom',
      HARNAS_LIMITS_POLL_MS: '200',
      ...extraEnv,
    };
    const electronApp = await electron.launch({ args: [mainEntry], env });
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
    // 58.7 → 58, 41.9 → 41: проценты целые, округление вниз.
    await expect(limits).toHaveText('58% 5h · 41% wk', { timeout: 15_000 });
    await expect(limits).toHaveAttribute('title', /^5-hour window resets at .+ · Weekly window resets [A-Z][a-z]{2} .+ · Updated .+$/);
    // До порога — обычные цвета: заливка полоски neutral-800, текст без accent-700.
    await expect(limits.locator('[data-limits-fill]')).toHaveClass(/\bbg-neutral-800\b/);
    // Заливка — пятичасовое окно, целые проценты: 58 % трека.
    await expect(limits.locator('[data-limits-fill]')).toHaveAttribute('style', /width:\s*58%/);
    await expect(segment.getByText('58% 5h · 41% wk')).not.toHaveClass(/text-accent-700/);

    // Новые числа: пятичасовое окно перешло 80 % — то же событие меняет текст и красит его и полоску.
    await writeLimits(workId, sessionId, 85.2, 41.9);
    await expect(limits).toHaveText('85% 5h · 41% wk', { timeout: 15_000 });
    await expect(segment.getByText('85% 5h · 41% wk')).toHaveClass(/text-accent-700/);
    await expect(limits.locator('[data-limits-fill]')).toHaveClass(/\bbg-accent-700\b/);

    // Одно окно остаётся одним: недельного нет — «70% 5h», без «wk».
    await writeLimits(workId, sessionId, 70, null);
    await expect(limits).toHaveText('70% 5h', { timeout: 15_000 });
    await expect(limits).toHaveAttribute('title', /^5-hour window resets at .+ · Updated .+$/);
  });

  test('800×500 и провайдер с очень длинной меткой: правые сегменты в окне, полоски целые, сжимается текст лимитов', async () => {
    // Свой провайдер в реестре дома — `providers.json` (спека 5): метка длиннее, чем помещается в строке. Команда —
    // тот же стаб: агент в тесте не настоящий.
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({ 'zeta-agent': { badge: LONG_LABEL, mark: 'Ze', command: stubAgent, linkBy: 'cwd+time' } }),
    );
    const window = await launch({ width: 800, height: 500 });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-limits-long', goal: '' });
    const claude = await newSession(window, workId, 'claude', 'один');
    const zeta = await newSession(window, workId, 'zeta-agent', 'два');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    // Сегмент внимания — самый широкий из правых: «1 needs you».
    await hookEvent(workId, claude, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    await writeLimits(workId, claude, 58.7, 41.9);
    await writeLimits(workId, zeta, 12, 97);

    const claudeLimits = window.locator('[data-provider-segment="claude"] [data-limits]');
    const zetaLimits = window.locator('[data-provider-segment="zeta-agent"] [data-limits]');
    await expect(claudeLimits).toBeVisible({ timeout: 15_000 });
    await expect(zetaLimits).toBeVisible({ timeout: 15_000 });
    const attention = window.getByRole('button', { name: '1 needs you' });
    await expect(attention).toBeVisible({ timeout: 15_000 });
    const wake = window.getByRole('button', { name: 'Auto-wake on' });

    const box = async (locator: Locator): Promise<Box> =>
      locator.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: rect.width };
      });
    const viewport = await window.evaluate(() => window.innerWidth);

    // Правый блок целиком в окне и не наезжает на провайдеров: внимание, связь с хостом, будильник не уехали. Провайдеры
    // идут слева направо, последний — zeta-agent, и его блок лимитов — последний элемент его сегмента.
    await expect
      .poll(async () => {
        const [att, wk, lim] = [await box(attention), await box(wake), await box(zetaLimits)];
        return att.left >= lim.right && wk.right <= viewport && wk.left >= att.right;
      })
      .toBe(true);

    // Полоска — 44 в каждом блоке: сжимается текст, а не она.
    for (const limits of [claudeLimits, zetaLimits]) {
      const bar = await box(limits.locator(':scope > span').first());
      expect(bar.width).toBeCloseTo(44, 0);
    }
    // Текст лимитов обрезан многоточием хотя бы у одного провайдера: места на оба целиком нет.
    const clipped = await window.evaluate(() =>
      [...document.querySelectorAll('[data-limits]')].map((block) => {
        const text = block.lastElementChild as HTMLElement;
        return text.scrollWidth > text.clientWidth;
      }),
    );
    expect(clipped.some(Boolean)).toBe(true);
  });

  test('800×500 и любая нехватка места: текст лимитов — целиком, с многоточием или спрятан; обрывка первой цифры нет, полоски целы', async () => {
    // Claude — по файлу данных, Codex — по логу и стабу: два текста лимитов разной длины («58% 5h · 41% wk» и «85% 5h»).
    const codexRoot = path.join(home, 'codex-sessions');
    await writeCodexLimits(codexRoot, 85.4);
    const window = await launch({ width: 800, height: 500 }, { HARNAS_CODEX_BIN: stubAgent, HARNAS_CODEX_SESSIONS_DIR: codexRoot });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-limits-sweep', goal: '' });
    const claude = await newSession(window, workId, 'claude', 'один');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await writeLimits(workId, claude, 58.7, 41.9);
    await expect(window.locator('[data-provider-segment="claude"] [data-limits]')).toHaveText('58% 5h · 41% wk', { timeout: 15_000 });
    await expect(window.locator('[data-provider-segment="codex"] [data-limits]')).toHaveText('85% 5h', { timeout: 15_000 });

    // Обход нехватки: правое поле строки растёт на пиксель за шаг, и места на тексты убывает от «всё помещается» до «остались
    // одни полоски». Chromium при `text-overflow: ellipsis` оставляет первый знак и тогда, когда многоточие рядом с ним не
    // помещается: у Codex на 800×500 от «85% 5h» была видна одна «8». Обрывок — текст на виду, обрезанный и уже, чем три знака
    // и многоточие (28 px в Figtree 12px: три цифры по 6.9 и многоточие 7.4). Нулевой ширины текст не рисуется: он не на виду.
    const sweep = await window.evaluate(() => {
      const row = document.querySelector('[data-provider-segment]')?.parentElement as HTMLElement;
      const MIN_SHOWN = 28;
      const stubs: string[] = [];
      const states: Record<string, Set<string>> = {};
      const bars: number[] = [];
      for (let extra = 0; extra <= 260; extra += 1) {
        row.style.paddingRight = `${14 + extra}px`;
        document.querySelectorAll<HTMLElement>('[data-limits]').forEach((block, index) => {
          const text = block.lastElementChild as HTMLElement;
          const box = text.getBoundingClientRect();
          const frame = block.getBoundingClientRect();
          const bar = (block.firstElementChild as HTMLElement).getBoundingClientRect();
          bars.push(bar.width);
          const shown = box.width >= 0.5 && box.top < frame.bottom - 0.5;
          const cut = text.scrollWidth > text.clientWidth;
          const state = !shown ? 'hidden' : cut ? 'cut' : 'full';
          (states[String(index)] ??= new Set()).add(state);
          if (state === 'cut' && box.width < MIN_SHOWN) stubs.push(`extra ${extra}, блок ${index}: ${box.width.toFixed(1)} px`);
        });
      }
      row.style.paddingRight = '';
      return { stubs, states: Object.fromEntries(Object.entries(states).map(([key, set]) => [key, [...set].sort()])), bars };
    });
    // Обрывков нет; при провале — число шагов обхода и первые три, а не сотни строк.
    expect({ count: sweep.stubs.length, first: sweep.stubs.slice(0, 3) }).toEqual({ count: 0, first: [] });
    // Обход прошёл все три состояния у обоих: иначе он ничего не проверил.
    expect(sweep.states).toEqual({ '0': ['cut', 'full', 'hidden'], '1': ['cut', 'full', 'hidden'] });
    // Полоска — 44 при любой нехватке: пропадает текст, а не она.
    expect(Math.min(...sweep.bars)).toBeCloseTo(44, 0);
    expect(Math.max(...sweep.bars)).toBeCloseTo(44, 0);
  });

  test('1400×900 и провайдер с очень длинной меткой: имя показано целиком — потолка ширины у имени нет', async () => {
    await writeFile(
      path.join(home, 'providers.json'),
      JSON.stringify({ 'zeta-agent': { badge: LONG_LABEL, mark: 'Ze', command: stubAgent, linkBy: 'cwd+time' } }),
    );
    const window = await launch({ width: 1400, height: 900 });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-limits-wide', goal: '' });
    await newSession(window, workId, 'zeta-agent', 'один');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    const name = window.locator('[data-provider-segment="zeta-agent"]').getByText(LONG_LABEL);
    await expect(name).toBeVisible();
    // Места в строке хватает с запасом (1400): длинное имя — целиком, а не обрезано на жёсткой ширине 160.
    const measured = await name.evaluate((el) => ({ width: el.getBoundingClientRect().width, cut: el.scrollWidth > el.clientWidth }));
    expect(measured.cut).toBe(false);
    expect(measured.width).toBeGreaterThan(160);
  });

  test('800×500, Claude Code, Codex и GLM: сжимается только текст лимитов — имена и полоски целы, правые сегменты на месте', async () => {
    // Codex — по логу и стабу: команда `codex` находится (`HARNAS_CODEX_BIN`), но не запускается — пробы версий в E2E нет.
    // GLM — встроенный провайдер без источника лимитов: сегмент из значка и имени, сжимать в нём нечего.
    const codexRoot = path.join(home, 'codex-sessions');
    await writeCodexLimits(codexRoot, 85.4);
    const window = await launch(
      { width: 800, height: 500 },
      { HARNAS_CODEX_BIN: stubAgent, HARNAS_GLM_BIN: stubAgent, HARNAS_CODEX_SESSIONS_DIR: codexRoot },
    );
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-limits-both', goal: '' });
    const claude = await newSession(window, workId, 'claude', 'один');
    const done = await newSession(window, workId, 'claude', 'два');
    await expect(window.getByTestId('app-shell')).toBeVisible();
    // Правый блок пошире: «1 needs you · 1 unseen» — без версий CLI (в E2E проба выключена) обе строки иначе поместились бы.
    await hookEvent(workId, claude, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    await hookEvent(workId, done, { hook_event_name: 'UserPromptSubmit' });
    await hookEvent(workId, done, { hook_event_name: 'Stop' });
    await writeLimits(workId, claude, 58.7, 41.9);

    const claudeSegment = window.locator('[data-provider-segment="claude"]');
    const codexSegment = window.locator('[data-provider-segment="codex"]');
    await expect(claudeSegment.locator('[data-limits]')).toHaveText('58% 5h · 41% wk', { timeout: 15_000 });
    // Codex: окно 300 минут — пятичасовое, недельного нет; 85.4 → 85, и это уже предупреждение.
    await expect(codexSegment.locator('[data-limits]')).toHaveText('85% 5h', { timeout: 15_000 });
    await expect(codexSegment.getByText('85% 5h')).toHaveClass(/text-accent-700/);
    await expect(window.getByRole('button', { name: '1 needs you · 1 unseen' })).toBeVisible({ timeout: 15_000 });

    await expect(window.locator('[data-provider-segment="glm"]')).toContainText('GLM');

    // Обычные значения при самом узком окне: места на все тексты целиком нет — обрезаются они, и только они. Имя — второй
    // элемент сегмента (после значка), у сегмента с лимитами последний — блок лимитов, а в нём полоска и текст.
    const measured = await window.evaluate(() => {
      const one = (id: string) => {
        const segment = document.querySelector(`[data-provider-segment="${id}"]`) as HTMLElement;
        const name = segment.children[1] as HTMLElement;
        const block = segment.querySelector('[data-limits]') as HTMLElement | null;
        const text = block?.lastElementChild as HTMLElement | undefined;
        return {
          name: name.textContent,
          nameCut: name.scrollWidth > name.clientWidth,
          bar: block === null ? null : (block.firstElementChild as HTMLElement).getBoundingClientRect().width,
          textCut: text === undefined ? false : text.scrollWidth > text.clientWidth,
        };
      };
      const wake = [...document.querySelectorAll('button')].find((el) => el.textContent === 'Auto-wake on');
      return {
        claude: one('claude'),
        codex: one('codex'),
        glm: one('glm'),
        wakeRight: wake?.getBoundingClientRect().right ?? Infinity,
        viewport: window.innerWidth,
      };
    });
    expect([measured.claude.name, measured.codex.name, measured.glm.name]).toEqual(['Claude Code', 'Codex', 'GLM']);
    // Порядок сжатия: имена всех трёх не тронуты (у GLM лимитов нет, и его доля нехватки не должна съесть имя), текст лимитов
    // обрезан хотя бы у одного, полоски целые (44).
    expect([measured.claude.nameCut, measured.codex.nameCut, measured.glm.nameCut]).toEqual([false, false, false]);
    expect(measured.claude.textCut || measured.codex.textCut).toBe(true);
    expect(measured.claude.bar).toBeCloseTo(44, 0);
    expect(measured.codex.bar).toBeCloseTo(44, 0);
    expect(measured.wakeRight).toBeLessThanOrEqual(measured.viewport);
  });
});
