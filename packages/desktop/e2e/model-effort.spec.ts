import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

/**
 * Нормалайзер модели и effort (спека 2026-10-06, раздел 8, строка E2E). Диалог новой сессии показывает модели и уровни
 * Codex из каталога самого CLI и сбрасывает уровень, которого у новой модели нет; меню «модель · effort» в чате зовёт
 * `sessions.setEffort` и `sessions.setModel` хоста, и ни один выбор не идёт текстом `/model`.
 *
 * Настоящие CLI не запускаются. `codex` — `stub-codex-agent.mjs`: на `codex debug models` он печатает урезанный каталог
 * `fixtures/codex-debug-models.json` — две видимые модели не в порядке `priority` и одну скрытую, так что список из
 * каталога не спутать со встроенным (там семь моделей). `claude` — `stub-echo-agent.mjs` с ползунком `/effort`
 * (`STUB_EFFORT_SLIDER=1`, нужен сырой режим `STUB_BRACKETED=1`) и журналом флагов запуска (`STUB_LAUNCH_LOG`).
 * Проба версий и каталога включена (`PARLEY_SKIP_VERSION_PROBE: ''`; `global-setup.ts` выключает её всем): вид Chat
 * доступен только при известной версии `claude`, а каталог Codex хост спрашивает той же пробой.
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

interface MapSession {
  id: string;
  provider: string;
  model?: string;
  effort?: string;
}

type Parley = { parley: { call: (method: string, params: unknown) => Promise<unknown> } };

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
}

/** Сессии работы из снимка хоста — выбор модели и effort, который хост записал в карту. */
async function sessionsOf(window: Page, workId: string): Promise<MapSession[]> {
  const list = await call<{ entries: Array<{ map: { work: { id: string }; sessions: MapSession[] } }> }>(window, 'works.list', {});
  return list.entries.find((entry) => entry.map.work.id === workId)?.map.sessions ?? [];
}

/** Имена пунктов открытого списка Radix Select: пункт связан со своим `ItemText`, описание второй строкой в имя не входит. */
async function optionNames(window: Page): Promise<string[]> {
  const options = window.getByRole('option');
  await expect(options.first()).toBeVisible();
  return options.evaluateAll((nodes) =>
    nodes.map((node) => document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''),
  );
}

/** Старты процесса сессии по журналу стаба `claude`: флаги модели и effort каждого запуска. */
async function launchesOf(file: string, sessionId: string): Promise<Array<{ model: unknown; effort: unknown; resume: unknown }>> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['sessionId'] === sessionId)
    .map((record) => ({ model: record['model'], effort: record['effort'], resume: record['resume'] }));
}

test.describe('модель и effort: диалог по каталогу Codex и меню чата (нормалайзер 2026-10-06)', () => {
  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('model-effort');
    project = await makeTempProject('model-effort');
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function launch(extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page; errors: string[] }> {
    const env = {
      ...process.env,
      PARLEY_HOME: home,
      PARLEY_CLAUDE_BIN: stubAgent,
      PARLEY_CODEX_BIN: stubCodex,
      PARLEY_GLM_BIN: path.join(home, 'no-glm'),
      PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom',
      ...extraEnv,
    };
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    return { app, window, errors };
  }

  test('диалог: модели и уровни Codex из `codex debug models`, Ultra у GPT-6.1-Sol, сброс в Default на GPT-6-Luna, окно 800×500', async () => {
    test.setTimeout(90_000);
    const { app, window, errors } = await launch();
    // Хост ответил каталогом стаба: видимые модели по priority, скрытой нет.
    await expect
      .poll(
        async () => {
          const { providers } = await call<{ providers: Array<{ id: string; models?: Array<{ id: string }> | null }> }>(window, 'providers.list', {});
          return providers.find((provider) => provider.id === 'codex')?.models?.map((model) => model.id) ?? null;
        },
        { timeout: 20_000 },
      )
      .toEqual(['gpt-6.1-sol', 'gpt-6-luna']);

    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-model-effort', goal: '' });
    await call(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'seed', task: '', parent: null });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator('[data-work-title]').first().click();
    await resize(app, 800, 500);

    await window.keyboard.press('Meta+T');
    const dialog = window.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New session' })).toBeVisible();
    await dialog.getByRole('radiogroup', { name: 'Agent 1' }).getByRole('radio', { name: 'Codex' }).click();
    const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
    const effort = dialog.getByRole('combobox', { name: 'Effort', exact: true });
    await expect(effort).toHaveText('Default');

    await model.click();
    expect(await optionNames(window)).toEqual(['Default', 'GPT-6.1-Sol', 'GPT-6-Luna']);
    await window.getByRole('option', { name: 'GPT-6.1-Sol', exact: true }).click();

    await effort.click();
    expect(await optionNames(window)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    // Описание уровня из каталога — второй строкой пункта.
    await expect(window.getByRole('option', { name: 'Ultra', exact: true })).toContainText('Maximum reasoning with automatic task delegation');
    await window.getByRole('option', { name: 'Extra high', exact: true }).click();
    await expect(effort).toHaveText('Extra high');
    // 800×500: подпись уровня видна целиком, поле — внутри диалога.
    expect(
      await effort.evaluate((trigger) => {
        const dialogBox = trigger.closest('[role="dialog"]')!.getBoundingClientRect();
        const value = trigger.querySelector('span')!;
        return { inside: trigger.getBoundingClientRect().right <= dialogBox.right + 0.5, whole: value.scrollWidth <= value.clientWidth };
      }),
    ).toEqual({ inside: true, whole: true });

    await effort.click();
    await window.getByRole('option', { name: 'Ultra', exact: true }).click();
    await expect(effort).toHaveText('Ultra');
    await model.click();
    await window.getByRole('option', { name: 'GPT-6-Luna', exact: true }).click();
    // У Luna нет Ultra — уровень вернулся в Default, и в списке его нет.
    await expect(effort).toHaveText('Default');
    await effort.click();
    expect(await optionNames(window)).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    await window.getByRole('option', { name: 'Max', exact: true }).click();

    await dialog.getByRole('button', { name: 'Start session' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // В карте — ровно явный выбор: его и получит Codex флагами.
    await expect
      .poll(async () => (await sessionsOf(window, workId)).filter((session) => session.provider === 'codex').map((session) => ({ model: session.model, effort: session.effort })), { timeout: 15_000 })
      .toEqual([{ model: 'gpt-6-luna', effort: 'max' }]);
    expect(errors).toEqual([]);
  });

  test('чат: «модель · effort» в окне 800×500, уровень — ползунком /effort, модель — перезапуском с флагами из карты', async () => {
    test.setTimeout(120_000);
    const launchLog = path.join(home, 'launches.jsonl');
    const { app, window, errors } = await launch({ STUB_BRACKETED: '1', STUB_EFFORT_SLIDER: '1', STUB_LAUNCH_LOG: launchLog });
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'e2e-chat-choice', goal: '' });
    const { ref } = await call<{ ref: Ref }>(window, 'sessions.create', {
      projectPath: project,
      workId,
      provider: 'claude',
      label: 'choice',
      task: '',
      parent: null,
      model: 'opusplan[1m]',
      effort: 'xhigh',
    });
    await expect(window.getByTestId('app-shell')).toBeVisible();
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible({ timeout: 20_000 });
    const button = chat.getByTestId('chat-model');
    await expect(button).toHaveAttribute('title', 'Opus Plan (1M context) · Extra high');

    // 800×500: длинная модель обрезается многоточием, уровень виден целиком, кнопка не выходит за тулбар.
    await resize(app, 800, 500);
    await expect(chat).toBeVisible();
    expect(
      await button.evaluate((trigger) => {
        const bar = trigger.closest('[data-testid="chat-toolbar"]')!.getBoundingClientRect();
        const level = trigger.querySelector('[data-testid="chat-effort-label"]')!;
        return { inside: trigger.getBoundingClientRect().right <= bar.right + 0.5, whole: level.scrollWidth <= level.clientWidth };
      }),
    ).toEqual({ inside: true, whole: true });
    await resize(app, 1400, 900);

    // Уровень: хост открывает ползунок стаба, ставит Max стрелками и `s`, сверяет подвал; карта и кнопка — Max.
    await button.click();
    await expect(window.getByTestId('chat-effort-option')).toHaveCount(5);
    await window.locator('[data-testid="chat-effort-option"][data-effort="max"]').click();
    await expect(button).toHaveAttribute('title', 'Opus Plan (1M context) · Max', { timeout: 15_000 });
    expect((await sessionsOf(window, workId)).find((session) => session.id === ref.sessionId)).toMatchObject({ model: 'opusplan[1m]', effort: 'max' });

    // Модель: хост перезапускает сессию с флагами из карты — второй старт стаба с --model sonnet и тем же уровнем.
    await button.click();
    await window.locator('[data-testid="chat-model-option"][data-model="sonnet"]').click();
    await expect(button).toHaveAttribute('title', 'Sonnet · Max', { timeout: 20_000 });
    // Транскрипта у стаба нет — хост поднимает тот же id заново, а не `--resume`; флаги те же, из карты.
    await expect
      .poll(() => launchesOf(launchLog, ref.sessionId), { timeout: 20_000 })
      .toEqual([
        { model: 'opusplan[1m]', effort: 'xhigh', resume: false },
        { model: 'sonnet', effort: 'max', resume: false },
      ]);
    expect(errors).toEqual([]);
  });
});
