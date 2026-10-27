import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

// Аккаунты Claude Code (спека подписок 2026-10-21, раздел 9): окно, настоящий хост и изолированный Claude Code стаб
// `stub-custom-agent.mjs` (сессии, `auth status|login|logout`, `STUB_MCP`). Настоящий вход в браузере не нужен: вход стаба -
// файл `stub-auth.json` в папке аккаунта. Только поддельные ключи и loopback; настоящий ~ не читается и не пишется: HOME
// дочерних процессов - временный. `E2E_DPR=2` запускает окно с `--force-device-scale-factor=2`.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stub = path.join(dirname, 'stub-custom-agent.mjs');
const dpr = process.env.E2E_DPR === '2' ? '2' : '1';
const ACCOUNT = 'custom-claude-2';
/** Ровно 40 знаков - предел поля имени аккаунта. */
const LONG_NAME = 'Personal Max subscription second account';
/** Длинный адрес в строке состояния: шире диалога на 800x500, но с дефисами - браузер переносит его по ним. */
const LONG_EMAIL = 'very.long.first.name.and.surname.of.the.account.owner@subdomain.company-name.example.test';
/** То же без единого места переноса (ни пробелов, ни дефисов: точку между буквами браузер не рвёт); часть до «@» - 60 знаков, в пределах 64 по RFC 5321. */
const UNBREAKABLE_EMAIL = 'firstname.middlename.lastname.of.the.account.owner.long.name@subdomain.company.example.test';

interface Ref { projectPath: string; workId: string; sessionId: string }
interface Bridge { parley: { call: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => void } }
interface Launch {
  sessionId: string; configDir: string | null; secureStorageDir: boolean; baseUrl: string | null; keyOk: boolean; anyKeyVar: boolean;
  managedByHost: boolean; managedVarSet: boolean; anthropicVars: string[]; oauthVars: string[];
  systemPrompt: boolean; linkRule: boolean; linkRuleDir: boolean; resume: boolean;
}
interface AuthCall { command: string; configDir: string | null; anthropicVars: string[]; oauthVars: string[]; managedVarSet: boolean; code?: string | null; loggedIn?: boolean }
interface McpEntry { session: string; tool: string; isError: boolean; text: string }
interface WorkList { entries: Array<{ projectPath: string; map: { work: { id: string }; sessions: Array<{ id: string; label: string; provider: string }> } }> }
interface StoredRecord { kind?: string; id: string; label: string; link?: boolean; baseUrl?: string; auth?: string; models?: unknown }
interface MapProvider { id: string; label: string; family: string | null; available: boolean; limits?: { fiveHour: { usedPercent: number } | null; week: { usedPercent: number } | null; at: string } }

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return await window.evaluate(({ method, params }) => (globalThis as unknown as Bridge).parley.call(method, params), { method, params }) as T;
}
async function jsonLines<T>(file: string): Promise<T[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    try { return line === '' ? [] : [JSON.parse(line) as T]; }
    catch { return []; } // Последняя строка ещё может писаться.
  });
}
async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, ...size }), { width, height });
}
async function pickTheme(window: Page, theme: 'light' | 'dark'): Promise<void> {
  await window.keyboard.press('Meta+J');
  await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
  await window.keyboard.type(`Theme: ${theme}`);
  await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(`Theme: ${theme}`);
  await window.keyboard.press('Enter');
  await expect(window.locator('[data-palette]')).toHaveCount(0);
  if (theme === 'dark') await expect(window.locator('html')).toHaveClass(/\bdark\b/);
  else await expect(window.locator('html')).not.toHaveClass(/\bdark\b/);
}
const exists = (file: string): Promise<boolean> => lstat(file).then(() => true, () => false);

/** Дерево папки: путь, вид и sha256 содержимого (у ссылки - её цель). Папки нет - пустой список. */
async function tree(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const rel = path.relative(root, full);
      if (info.isSymbolicLink()) out.push(`${rel} link ${await readlink(full)}`);
      else if (info.isDirectory()) { out.push(`${rel} dir`); await walk(full); }
      else out.push(`${rel} file ${createHash('sha256').update(await readFile(full)).digest('hex')}`);
    }
  };
  await walk(root);
  return out;
}
/** Ни документ, ни диалог, ни один его элемент не уходят вбок за границы окна/диалога. */
async function noHorizontalOverflow(dialog: Locator): Promise<void> {
  await expect(async () => {
    const report = await dialog.evaluate((root) => {
      const box = root.getBoundingClientRect();
      const wide = Array.from(root.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return [];
        // Невидимое не раздвигает диалог: так xterm прячет за краем (-9999em) свой измеритель ширины знака.
        if (getComputedStyle(element).visibility === 'hidden') return [];
        const overflowing = rect.right > box.right + 1 || rect.left < box.left - 1;
        const scrolls = element.scrollWidth > element.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowX);
        return overflowing || scrolls ? [`${element.tagName}.${String(element.className).slice(0, 40)} ${Math.round(rect.left)}-${Math.round(rect.right)} of ${Math.round(box.left)}-${Math.round(box.right)}`] : [];
      });
      return {
        wide,
        doc: document.documentElement.scrollWidth - innerWidth,
        dialog: root.scrollWidth - root.clientWidth,
        inside: box.left >= -1 && box.right <= innerWidth + 1,
      };
    });
    expect(report.wide).toEqual([]);
    expect(report.doc).toBeLessThanOrEqual(0);
    expect(report.dialog).toBeLessThanOrEqual(1);
    expect(report.inside).toBe(true);
  }).toPass({ timeout: 5000, intervals: [100, 250] });
}
/** Файл как строка пути и sha256; нет файла - `absent`. */
async function fileMark(file: string): Promise<string> {
  const data = await readFile(file).catch(() => null);
  return `${file} ${data === null ? 'absent' : createHash('sha256').update(data).digest('hex')}`;
}

/**
 * Файл лимитов сессии - то, что пишет скрипт строки статуса (`core/src/work/statusline.ts`): `{ at, rateLimits }` во
 * временный файл рядом и `rename`; окна как в `rate_limits` Claude Code, сбросы впереди (как в `limits.spec.ts`).
 */
async function writeLimits(project: string, workId: string, sessionId: string, fiveHour: number, week: number): Promise<void> {
  const dir = path.join(project, '.parley', 'works', workId, 'limits');
  await mkdir(dir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000);
  const rateLimits = {
    five_hour: { used_percentage: fiveHour, resets_at: nowSec + 2 * 3600 },
    seven_day: { used_percentage: week, resets_at: nowSec + 3 * 86_400 },
  };
  const file = path.join(dir, `${sessionId}.json`);
  await writeFile(`${file}.tmp`, `${JSON.stringify({ at: new Date().toISOString(), rateLimits })}\n`);
  await rename(`${file}.tmp`, file);
}

test.describe('аккаунты Claude Code на изолированном Claude Code стабе', () => {
  let home: string;
  let user: string;
  let project: string;
  let running: ElectronApplication | null = null;
  let errors: string[];
  let extraEnv: Record<string, string>;
  const settingsDialog = (window: Page): Locator => window.getByRole('dialog', { name: 'Settings', exact: true });
  const segment = (window: Page, provider: string): Locator => window.locator(`[data-provider-segment="${provider}"]`);
  const launches = (): Promise<Launch[]> => jsonLines<Launch>(path.join(home, 'launches.jsonl'));
  const authCalls = (): Promise<AuthCall[]> => jsonLines<AuthCall>(path.join(home, 'auth-calls.jsonl'));
  const mcpEntries = (): Promise<McpEntry[]> => jsonLines<McpEntry>(path.join(home, 'mcp.jsonl'));
  const providerDir = (id: string): string => path.join(home, 'providers', id);
  /** Записи `custom-providers.json`; файла ещё нет (первый Save не дошёл до диска) - пустой список. */
  const stored = async (): Promise<StoredRecord[]> => {
    const text = await readFile(path.join(home, 'custom-providers.json'), 'utf8').catch(() => null);
    return text === null ? [] : (JSON.parse(text) as { providers: StoredRecord[] }).providers;
  };

  test.beforeEach(async () => {
    home = await makeTempHome('claude-account');
    project = await makeTempProject('claude-account');
    user = path.join(home, 'user');
    errors = [];
    extraEnv = {
      // Унаследованные от человека вход и ключи: аккаунту подписки не должно достаться ничего из них (спека подписок 5.3).
      CLAUDE_CODE_OAUTH_TOKEN: 'e2e-fake-inherited-oauth-token', ANTHROPIC_API_KEY: 'e2e-fake-inherited-api-key',
      ANTHROPIC_AUTH_TOKEN: 'e2e-fake-inherited-auth-token', CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      // Вход стаба кончается сам через секунду, если код не набран; почта по умолчанию - своя у стаба.
      STUB_LOGIN_WAIT_MS: '1000', STUB_AUTH_EMAIL: '',
    };
    // Поддельные настройки Claude Code человека: из них аккаунт подтягивает ссылки (спека подписок 5.4).
    await mkdir(path.join(user, '.claude', 'skills', 'my-skill'), { recursive: true });
    await mkdir(path.join(user, '.claude', 'agents'), { recursive: true });
    await writeFile(path.join(user, '.claude', 'CLAUDE.md'), '# Fake human rules\n');
    await writeFile(path.join(user, '.claude', 'settings.json'), '{"theme":"fake"}\n');
    await writeFile(path.join(user, '.claude', 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: fake\n---\n');
    await writeFile(path.join(user, '.claude', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: fake\n---\n');
    await writeFile(path.join(user, '.claude.json'), '{"numStartups":3}\n');
  });
  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function open(): Promise<{ app: ElectronApplication; window: Page }> {
    // Окружение без учётных данных; HOME и дом Parley - временные. PARLEY_CLAUDE_PROJECTS_DIR не задан: история
    // аккаунта читается из его папки (спека подписок 5.7), у обычной сессии стаб пишет в $HOME/.claude/projects.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|ZAI_|Z_AI_|AWS_|AZURE_|GOOGLE_|GEMINI_|BEDROCK_|VERTEX_)/i.test(name) &&
      !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) && !/^(PARLEY|HARNAS)_.*_BIN$/i.test(name) &&
      !/^(PARLEY|HARNAS)_CLAUDE_PROJECTS_DIR$/i.test(name) && !/^STUB_/i.test(name),
    )) as Record<string, string>;
    Object.assign(env, {
      HOME: user, PARLEY_HOME: home, HARNAS_HOME: home,
      PARLEY_CLAUDE_BIN: stub, PARLEY_CODEX_BIN: path.join(home, 'absent-codex'),
      PARLEY_GLM_BIN: path.join(home, 'absent-glm-wrapper'), PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom', PARLEY_LIMITS_POLL_MS: '200',
      STUB_LAUNCH_LOG: path.join(home, 'launches.jsonl'), STUB_HOOK_LOG: path.join(home, 'hooks.jsonl'),
      STUB_AUTH_LOG: path.join(home, 'auth-calls.jsonl'), STUB_MCP_LOG: path.join(home, 'mcp.jsonl'),
      ...extraEnv,
    });
    const app = await electron.launch({ args: [mainEntry, `--force-device-scale-factor=${dpr}`], env });
    running = app;
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    window.on('pageerror', (error) => errors.push(error.message));
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    // Масштаб - тот, что просили (`E2E_DPR`): иначе прогон «при DPR 2» ничего не проверял бы.
    expect(await window.evaluate(() => globalThis.devicePixelRatio)).toBe(Number(dpr));
    // Версия стаба 2.1.304 - не ниже минимальной для аккаунтов подписки (спека подписок 9.1).
    await expect(segment(window, 'claude')).toContainText('2.1.304');
    return { app, window };
  }
  async function openAdd(window: Page): Promise<Locator> {
    await window.getByRole('button', { name: 'Add provider', exact: true }).click();
    const dialog = settingsDialog(window);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-custom-provider-step="vendor"]')).toBeVisible();
    return dialog;
  }
  /** «+» - плитка Claude account - (имя) - Save: сохранённый аккаунт; возвращает диалог и id, который выдал хост. */
  async function createAccount(window: Page, name = ''): Promise<{ dialog: Locator; id: string }> {
    const dialog = await openAdd(window);
    await dialog.locator('[data-vendor-tile="claude-account"]').click();
    const form = dialog.locator('[data-account-form="new"]');
    await expect(form).toBeVisible();
    if (name !== '') await form.getByLabel('Name', { exact: true }).fill(name);
    const before = (await stored()).length;
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await stored()).length).toBe(before + 1);
    const id = (await stored()).at(-1)!.id;
    await expect(dialog.locator(`[data-provider-pill="${id}"]`)).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator(`[data-account-form="${id}"]`)).toBeVisible();
    return { dialog, id };
  }
  /** Sign in: стаб печатает ссылку, ждёт секунду и «входит»; ждём состояние `Signed in`. */
  async function signIn(dialog: Locator, id: string): Promise<void> {
    const form = dialog.locator(`[data-account-form="${id}"]`);
    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(form.locator('[data-account-state]')).toHaveAttribute('data-account-state', 'signed-in', { timeout: 20_000 });
  }
  /** Работа с одной обычной сессией `claude`: из неё агенты зовут `STUB_MCP`, она же сосед аккаунта. */
  async function seed(window: Page): Promise<{ workId: string; ref: Ref }> {
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'account-e2e', goal: '' });
    const { ref } = await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'ordinary seed', task: '', parent: null });
    await launchOf(ref);
    await window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator('[data-work-title]').first().click();
    return { workId, ref };
  }
  async function launchOf(ref: Ref, index = 0): Promise<Launch> {
    await expect.poll(async () => (await launches()).filter((line) => line.sessionId === ref.sessionId).length, { timeout: 15_000 }).toBeGreaterThan(index);
    return (await launches()).filter((line) => line.sessionId === ref.sessionId)[index]!;
  }
  /** Пилюля провайдера в диалоге New session - сессия с этим названием. */
  async function startFromDialog(window: Page, workId: string, pill: string, name: string): Promise<Ref> {
    await window.keyboard.press('Meta+T');
    const dialog = window.getByRole('dialog', { name: 'New session', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: pill, exact: true }).click();
    await expect(dialog.getByRole('radio', { name: pill, exact: true })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByPlaceholder('Optional').fill(name);
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    const list = await call<WorkList>(window, 'works.list', {});
    const session = list.entries.find((entry) => entry.map.work.id === workId)!.map.sessions.find((item) => item.label === name)!;
    return { projectPath: project, workId, sessionId: session.id };
  }

  test('«+» - Claude account - Save без имени: пилюля и сегмент «Claude Code 2» приглушены, «Not signed in»; на диске ни адреса, ни ключа, в папке ссылки на ~/.claude', async () => {
    test.setTimeout(90_000);
    const { window } = await open();
    const claudeDir = path.join(user, '.claude');
    const before = { dir: await tree(claudeDir), json: await fileMark(path.join(user, '.claude.json')) };
    await expect(window.locator('[data-provider-segment]')).toHaveCount(3);

    const dialog = await openAdd(window);
    // Плитки: аккаунты первыми, Codex - позже (этап 3); прежние плитки вендоров на месте.
    await expect(dialog.locator('[data-vendor-tile="claude-account"]')).toBeEnabled();
    await expect(dialog.locator('[data-vendor-tile="codex-account"]')).toBeDisabled();
    await expect(dialog.locator('[data-vendor-tile="codex-account"]')).toContainText('Coming soon');
    for (const id of ['kimi', 'minimax', 'qwen', 'deepseek', 'openrouter', 'own']) await expect(dialog.locator(`[data-vendor-tile="${id}"]`)).toBeVisible();
    await dialog.locator('[data-vendor-tile="claude-account"]').click();

    const form = dialog.locator('[data-account-form="new"]');
    await expect(form).toBeVisible();
    // Имя не введено: подсказка в поле - стандартное имя; «Bring from Claude Code» включено; вход возможен только у сохранённого.
    await expect(form.getByLabel('Name', { exact: true })).toHaveAttribute('placeholder', 'Claude Code 2');
    await expect(form.getByRole('checkbox', { name: 'Bring from Claude Code', exact: true })).toBeChecked();
    await expect(form.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
    await form.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(dialog.locator(`[data-provider-pill="${ACCOUNT}"]`)).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator(`[data-provider-pill="${ACCOUNT}"]`)).toContainText('Claude Code 2');
    // Пилюля приглушена, зелёной точки нет: аккаунт не вошёл.
    await expect(dialog.locator(`[data-provider-pill="${ACCOUNT}"]`)).toHaveClass(/opacity-45/);
    await expect(dialog.locator(`[data-provider-pill="${ACCOUNT}"] [data-connected-dot]`)).toHaveCount(0);
    const saved = dialog.locator(`[data-account-form="${ACCOUNT}"]`);
    await expect(saved).toBeVisible();
    await expect(saved.locator('[data-account-state]')).toHaveAttribute('data-account-state', 'not-signed-in');
    await expect(saved.locator('[data-account-state]')).toHaveText('Not signed in');
    await expect(saved.getByLabel('Name', { exact: true })).toHaveValue('Claude Code 2');
    await expect(saved.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await expect(saved).toContainText(providerDir(ACCOUNT));
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Сегмент в строке статуса: имя аккаунта, приглушён, без версии и шкалы.
    await expect(window.locator('[data-provider-segment]')).toHaveCount(4);
    await expect(segment(window, ACCOUNT)).toContainText('Claude Code 2');
    await expect(segment(window, ACCOUNT)).toHaveClass(/opacity-50/);
    await expect(segment(window, ACCOUNT).locator('[data-limits]')).toHaveCount(0);
    await expect(segment(window, 'claude')).not.toHaveClass(/opacity-50/);

    // Описание аккаунта: ни адреса, ни ключа, ни моделей; секретов на диске нет вовсе.
    const [record] = await stored();
    expect(record).toMatchObject({ kind: 'claude-account', id: ACCOUNT, label: 'Claude Code 2', link: true });
    for (const field of ['baseUrl', 'auth', 'models', 'linkClaude']) expect(record).not.toHaveProperty(field);
    expect(await stored()).toHaveLength(1);
    expect(await exists(path.join(home, 'secrets.json'))).toBe(false);

    // Папка аккаунта: 0700, онбординг посеян, поштучные ссылки на поддельный <HOME>/.claude.
    const folder = providerDir(ACCOUNT);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((JSON.parse(await readFile(path.join(folder, '.claude.json'), 'utf8')) as { hasCompletedOnboarding?: boolean }).hasCompletedOnboarding).toBe(true);
    expect((await lstat(path.join(folder, 'projects'))).isDirectory()).toBe(true);
    expect(await readlink(path.join(folder, 'CLAUDE.md'))).toBe(path.join(claudeDir, 'CLAUDE.md'));
    expect(await readlink(path.join(folder, 'skills', 'my-skill'))).toBe(path.join(claudeDir, 'skills', 'my-skill'));
    expect(await readlink(path.join(folder, 'agents', 'reviewer.md'))).toBe(path.join(claudeDir, 'agents', 'reviewer.md'));
    expect(await exists(path.join(folder, 'stub-auth.json'))).toBe(false);
    // Сохранение настроек человека не тронуло.
    expect({ dir: await tree(claudeDir), json: await fileMark(path.join(user, '.claude.json')) }).toEqual(before);
    expect(errors).toEqual([]);
  });

  test('Sign in: терминал показывает вывод входа, набранный код доходит до процесса; после выхода «Signed in», сегмент не приглушён, ключа нет', async () => {
    test.setTimeout(120_000);
    // Стаб ждёт код до 30 секунд: тест набирает его в терминале входа и проверяет, что ввод дошёл до процесса.
    extraEnv['STUB_LOGIN_WAIT_MS'] = '30000';
    const { window } = await open();
    const { dialog, id } = await createAccount(window);
    const form = dialog.locator(`[data-account-form="${id}"]`);
    expect(id).toBe(ACCOUNT);

    await form.getByRole('button', { name: 'Sign in', exact: true }).click();
    const terminal = form.locator('[data-sign-in-terminal]');
    await expect(terminal).toBeVisible();
    await expect(form.locator('[data-account-state]')).toHaveText('Signing in…');
    await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    // Вывод настоящего `claude auth login` (спека 9.1): ссылка и поле кода.
    const screen = terminal.locator('.xterm-rows');
    await expect(screen).toContainText('Opening browser to sign in…');
    await expect(screen).toContainText('https://stub.invalid/login');
    await expect(screen).toContainText('Paste code here if prompted >');
    // Код из браузера: набранное уходит процессу входа, а его эхо (PTY) возвращается в терминал.
    await terminal.locator('.xterm-helper-textarea').focus();
    await window.keyboard.type('424242');
    await expect(screen).toContainText('424242');
    await window.keyboard.press('Enter');
    await expect(screen).toContainText('Login successful.');

    await expect(form.locator('[data-account-state]')).toHaveAttribute('data-account-state', 'signed-in', { timeout: 20_000 });
    await expect(form.locator('[data-account-state]')).toHaveText('Signed in');
    await expect(form.locator('[data-account-detail]')).toHaveText('second@example.test · max');
    await expect(form.locator('[data-sign-in-result]')).toHaveText('Signed in.');
    await expect(form.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
    await expect(dialog.locator(`[data-provider-pill="${id}"] [data-connected-dot]`)).toBeVisible();
    await expect(dialog.locator(`[data-provider-pill="${id}"]`)).not.toHaveClass(/opacity-45/);
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Сегмент ожил: не приглушён, версия стаба. Карточка в поповере называет состояние.
    await expect(segment(window, id)).not.toHaveClass(/opacity-50/);
    await expect(segment(window, id)).toContainText('2.1.304');
    await segment(window, id).click();
    await expect(window.locator(`[data-provider-card="${id}"]`)).toContainText('Signed in');
    await window.keyboard.press('Escape');

    // Все вызовы CLI - в папке аккаунта и в чистом окружении (унаследованные ключ и токен срезаны); код дошёл до `login`.
    const calls = await authCalls();
    expect(calls.map((item) => item.command)).toEqual(expect.arrayContaining(['status', 'login']));
    for (const item of calls) {
      expect(item).toMatchObject({ configDir: providerDir(id), anthropicVars: [], oauthVars: [], managedVarSet: false });
    }
    expect(calls.find((item) => item.command === 'login')).toMatchObject({ code: '424242' });
    // Вход живёт в папке аккаунта; ключа Parley не хранит.
    expect(JSON.parse(await readFile(path.join(providerDir(id), 'stub-auth.json'), 'utf8'))).toMatchObject({ loggedIn: true, email: 'second@example.test' });
    expect(await exists(path.join(home, 'secrets.json'))).toBe(false);
    expect(await exists(path.join(user, '.claude', 'stub-auth.json'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('New session на аккаунте: признаки запуска чистые и со своей папкой, соседний Claude - без CLAUDE_CONFIG_DIR, ~/.claude не тронут', async () => {
    test.setTimeout(120_000);
    const { window } = await open();
    const { workId } = await seed(window);
    const claudeDir = path.join(user, '.claude');
    const claudeJson = path.join(user, '.claude.json');
    const before = { dir: await tree(claudeDir), json: await fileMark(claudeJson) };
    expect(before.dir.length).toBeGreaterThan(0);

    const { dialog, id } = await createAccount(window);
    await signIn(dialog, id);
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    const ref = await startFromDialog(window, workId, 'Claude Code 2', 'account session');
    const folder = providerDir(id);
    expect(await launchOf(ref)).toMatchObject({
      configDir: folder, secureStorageDir: false, baseUrl: null, keyOk: false, anyKeyVar: false,
      managedByHost: false, managedVarSet: false, anthropicVars: [], oauthVars: [],
      systemPrompt: true, linkRule: true, linkRuleDir: true, resume: false,
    });
    // История аккаунта - в его папке, а не в <HOME>/.claude.
    expect((await readdir(path.join(folder, 'projects', 'stub-project'))).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    await call(window, 'sessions.stop', { ref });
    await call(window, 'sessions.resume', { ref });
    expect(await launchOf(ref, 1)).toMatchObject({ resume: true, configDir: folder, anthropicVars: [], oauthVars: [], managedVarSet: false, linkRule: true });
    await call(window, 'sessions.stop', { ref });
    // Ни Save, ни вход, ни запуск, ни resume не изменили ни одного байта в <HOME>/.claude.
    expect({ dir: await tree(claudeDir), json: await fileMark(claudeJson) }).toEqual(before);

    // Соседняя сессия обычного Claude Code ничего из папки аккаунта не получает. Унаследованные ключ и токен ей достаются
    // (ничто их не срезает), то есть чистота окружения аккаунта выше - работа хоста, а не пустое окружение теста.
    const { ref: ordinary } = await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'ordinary after account', task: '', parent: null });
    expect(await launchOf(ordinary)).toMatchObject({
      configDir: null, secureStorageDir: false, linkRule: false,
      anthropicVars: expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) as string[],
      oauthVars: expect.arrayContaining(['CLAUDE_CODE_OAUTH_TOKEN']) as string[], managedVarSet: true,
    });
    expect(errors).toEqual([]);
  });

  test('лимиты: файл данных сессии аккаунта - шкала у его сегмента, у claude нет; get_map из сессии claude отдаёт limits аккаунта', async () => {
    test.setTimeout(120_000);
    const { window } = await open();
    const { workId, ref: seedRef } = await seed(window);
    const { dialog, id } = await createAccount(window);
    await signIn(dialog, id);
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const ref = await startFromDialog(window, workId, 'Claude Code 2', 'account session');
    await launchOf(ref);

    // Данных ещё нет - шкалы нет нигде.
    await expect(segment(window, id).locator('[data-limits]')).toHaveCount(0);
    await writeLimits(project, workId, ref.sessionId, 58.7, 41.9);
    const meter = segment(window, id).locator('[data-limits]');
    await expect(meter).toHaveText('58% 5h · 41% wk', { timeout: 15_000 });
    await expect(segment(window, 'claude').locator('[data-limits]')).toHaveCount(0);

    // Агент обычной сессии зовёт `get_map {field: "providers"}`: строки провайдеров приходят от хоста (спека подписок 5.8).
    await window.evaluate(([target, line]) => (globalThis as unknown as Bridge).parley.notify('pty.input', { ref: target, data: line }), [seedRef, 'STUB_MCP get_map {"field":"providers"}\r'] as const);
    await expect.poll(async () => (await mcpEntries()).filter((entry) => entry.tool === 'get_map').length, { timeout: 30_000 }).toBeGreaterThan(0);
    const entry = (await mcpEntries()).find((item) => item.tool === 'get_map')!;
    expect(entry).toMatchObject({ session: seedRef.sessionId, isError: false });
    const catalog = JSON.parse(entry.text) as { providers: MapProvider[]; note?: string };
    expect(catalog).not.toHaveProperty('note');
    const account = catalog.providers.find((row) => row.id === id)!;
    expect(account).toMatchObject({ label: 'Claude Code 2', family: 'claude', available: true });
    expect(account.limits?.fiveHour?.usedPercent).toBeCloseTo(58.7, 1);
    expect(account.limits?.week?.usedPercent).toBeCloseTo(41.9, 1);
    // У глобального claude данных лимитов в этом тесте нет: поля нет вовсе.
    expect(catalog.providers.find((row) => row.id === 'claude')).not.toHaveProperty('limits');
    expect(errors).toEqual([]);
  });

  test('Sign out - «Not signed in»; Delete без Sign out снимает вход (logout), с «Also delete its folder» - аккаунта и папки нет, ~/.claude цел', async () => {
    test.setTimeout(120_000);
    const { window } = await open();
    const claudeDir = path.join(user, '.claude');
    const before = { dir: await tree(claudeDir), json: await fileMark(path.join(user, '.claude.json')) };
    const { dialog, id } = await createAccount(window);
    await signIn(dialog, id);
    const form = dialog.locator(`[data-account-form="${id}"]`);
    const folder = providerDir(id);
    expect(await exists(path.join(folder, 'stub-auth.json'))).toBe(true);

    await form.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(form.locator('[data-account-state]')).toHaveAttribute('data-account-state', 'not-signed-in', { timeout: 20_000 });
    await expect(form.locator('[data-account-state]')).toHaveText('Not signed in');
    await expect(form.locator('[data-account-detail]')).toHaveCount(0);
    await expect(form.locator('[data-sign-in-terminal]')).toHaveCount(0);
    await expect(form.locator('[data-sign-in-result]')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    expect(await exists(path.join(folder, 'stub-auth.json'))).toBe(false);
    expect((await authCalls()).find((item) => item.command === 'logout')).toMatchObject({ configDir: folder, anthropicVars: [], oauthVars: [] });
    await window.keyboard.press('Escape');
    await expect(segment(window, id)).toHaveClass(/opacity-50/);

    // Delete без предварительного Sign out (решение 12): вход снимает само удаление. Папка остаётся, поэтому исчезнувший
    // stub-auth.json - заслуга `claude auth logout`, а не удаления папки.
    await window.getByRole('button', { name: 'Add provider', exact: true }).click();
    await dialog.locator(`[data-provider-pill="${id}"]`).click();
    await signIn(dialog, id);
    expect(await exists(path.join(folder, 'stub-auth.json'))).toBe(true);
    await form.getByRole('button', { name: 'Delete', exact: true }).click();
    const keep = dialog.getByRole('group', { name: 'Delete', exact: true });
    await expect(keep.getByRole('checkbox', { name: 'Also delete its folder', exact: true })).toHaveAttribute('aria-checked', 'false');
    await keep.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog.locator(`[data-provider-pill="${id}"]`)).toHaveCount(0);
    await expect(segment(window, id)).toHaveCount(0);
    expect(await exists(folder)).toBe(true);
    expect(await exists(path.join(folder, 'stub-auth.json'))).toBe(false);
    const logouts = (await authCalls()).filter((item) => item.command === 'logout');
    expect(logouts).toHaveLength(2);
    expect(logouts[1]).toMatchObject({ configDir: folder, anthropicVars: [], oauthVars: [] });
    expect(await stored()).toEqual([]);

    // Второй аккаунт: оставшаяся папка занимает прежний id. Delete с галочкой про папку - аккаунта и папки нет.
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const second = await createAccount(window);
    expect(second.id).not.toBe(id);
    const secondFolder = providerDir(second.id);
    await dialog.locator(`[data-account-form="${second.id}"]`).getByRole('button', { name: 'Delete', exact: true }).click();
    const confirm = dialog.getByRole('group', { name: 'Delete', exact: true });
    await expect(confirm).toContainText(`Delete Claude Code ${second.id.slice('custom-claude-'.length)}?`);
    await confirm.getByRole('checkbox', { name: 'Also delete its folder', exact: true }).click();
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog.locator(`[data-provider-pill="${second.id}"]`)).toHaveCount(0);
    await expect(segment(window, second.id)).toHaveCount(0);
    await expect.poll(() => exists(secondFolder)).toBe(false);
    // Выход идёт и у аккаунта, который не входил: удалению нужен только он сам.
    expect((await authCalls()).filter((item) => item.command === 'logout').at(-1)).toMatchObject({ configDir: secondFolder });
    expect(await stored()).toEqual([]);
    // Удаление папки сняло ссылки, а не их цели.
    expect({ dir: await tree(claudeDir), json: await fileMark(path.join(user, '.claude.json')) }).toEqual(before);
    expect(await readFile(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# Fake human rules\n');
    expect(await exists(path.join(home, 'secrets.json'))).toBe(false);
    expect(errors).toEqual([]);
  });

  test('800×500: плитки, форма, терминал входа и подтверждение удаления без горизонтального скролла; длинные имя и почта; светлая и тёмная темы', async () => {
    // Снимки уходят в папку результатов теста, а не в репозиторий.
    const shots = test.info().outputPath('shots');
    test.setTimeout(180_000);
    // Вход держится, пока тест не наберёт код: терминал виден при проверке; почта - длинная и без пробелов.
    extraEnv['STUB_LOGIN_WAIT_MS'] = '60000';
    extraEnv['STUB_AUTH_EMAIL'] = LONG_EMAIL;
    const { app, window } = await open();
    await resize(app, 800, 500);
    await mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      const dialog = await openAdd(window);
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-tiles-${theme}-800x500.png`), animations: 'disabled' });

      await dialog.locator('[data-vendor-tile="claude-account"]').click();
      const fresh = dialog.locator('[data-account-form="new"]');
      await expect(fresh).toBeVisible();
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-form-${theme}-800x500.png`), animations: 'disabled' });

      // Сохранённый аккаунт с самым длинным именем (40 знаков): пилюля, поле и подтверждение удаления не раздвигают диалог.
      await fresh.getByLabel('Name', { exact: true }).fill(LONG_NAME);
      const known = (await stored()).length;
      await fresh.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(async () => (await stored()).length).toBe(known + 1);
      const id = (await stored()).at(-1)!.id;
      const form = dialog.locator(`[data-account-form="${id}"]`);
      await expect(form).toBeVisible();
      await expect(form.getByLabel('Name', { exact: true })).toHaveValue(LONG_NAME);
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-saved-${theme}-800x500.png`), animations: 'disabled' });

      // Терминал входа: стаб ждёт код, терминал и кнопка Cancel на экране.
      await form.getByRole('button', { name: 'Sign in', exact: true }).click();
      const terminal = form.locator('[data-sign-in-terminal]');
      // На 800x500 терминал был бы ниже края диалога: он сам прокручивается на виду (SignInTerminal), без прокрутки от
      // человека - иначе ссылка входа не видна. Проверка: нижний край терминала открыт (под этой точкой он, а не обрезка).
      await expect.poll(() => terminal.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 6);
        return hit !== null && element.contains(hit);
      })).toBe(true);
      await expect(terminal.locator('.xterm-rows')).toContainText('Paste code here if prompted >');
      await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-signing-in-${theme}-800x500.png`), animations: 'disabled' });

      // Код набран: «Signed in» с длинной почтой в строке состояния.
      await terminal.locator('.xterm-helper-textarea').focus();
      await window.keyboard.type('1');
      await window.keyboard.press('Enter');
      await expect(form.locator('[data-account-state]')).toHaveAttribute('data-account-state', 'signed-in', { timeout: 20_000 });
      await expect(form.locator('[data-account-detail]')).toContainText(LONG_EMAIL);
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-signed-in-${theme}-800x500.png`), animations: 'disabled' });

      // Строка статуса с длинным именем: сегмент аккаунта целиком в окне, документ не шире окна.
      await window.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(segment(window, id)).toBeVisible();
      await expect.poll(() => window.evaluate((provider) => {
        const rect = document.querySelector(`[data-provider-segment="${provider}"]`)!.getBoundingClientRect();
        return { inside: rect.left >= 0 && rect.right <= innerWidth, doc: document.documentElement.scrollWidth - innerWidth };
      }, id)).toEqual({ inside: true, doc: 0 });
      await window.screenshot({ path: path.join(shots, `claude-account-status-bar-${theme}-800x500.png`), animations: 'disabled' });

      // Подтверждение удаления с папкой; следующая тема начинает с чистого списка.
      await window.getByRole('button', { name: 'Add provider', exact: true }).click();
      await dialog.locator(`[data-provider-pill="${id}"]`).click();
      await form.getByRole('button', { name: 'Delete', exact: true }).click();
      const confirm = dialog.getByRole('group', { name: 'Delete', exact: true });
      await expect(confirm).toContainText(`Delete ${LONG_NAME}?`);
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-delete-${theme}-800x500.png`), animations: 'disabled' });
      await confirm.getByRole('checkbox', { name: 'Also delete its folder', exact: true }).click();
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog.locator(`[data-provider-pill="${id}"]`)).toHaveCount(0);
      await expect.poll(() => exists(providerDir(id))).toBe(false);
      await window.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  });

  test('800×500: почта без мест переноса не раздвигает строку состояния аккаунта; светлая и тёмная темы', async () => {
    const shots = test.info().outputPath('shots');
    test.setTimeout(120_000);
    // Вход кончается сам через секунду (стаб без набранного кода): нужна только строка «Signed in» с почтой.
    extraEnv['STUB_AUTH_EMAIL'] = UNBREAKABLE_EMAIL;
    const { app, window } = await open();
    await resize(app, 800, 500);
    await mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      const { dialog, id } = await createAccount(window);
      await signIn(dialog, id);
      const form = dialog.locator(`[data-account-form="${id}"]`);
      await expect(form.locator('[data-account-detail]')).toContainText(UNBREAKABLE_EMAIL);
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `claude-account-long-email-${theme}-800x500.png`), animations: 'disabled' });
      // Следующая тема начинает с чистого списка: аккаунт и его папка удаляются.
      await form.getByRole('button', { name: 'Delete', exact: true }).click();
      const confirm = dialog.getByRole('group', { name: 'Delete', exact: true });
      await confirm.getByRole('checkbox', { name: 'Also delete its folder', exact: true }).click();
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(dialog.locator(`[data-provider-pill="${id}"]`)).toHaveCount(0);
      await expect.poll(() => exists(providerDir(id))).toBe(false);
      await window.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  });
});
