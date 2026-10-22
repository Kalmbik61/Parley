import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

// Свои провайдеры (спека 2026-10-17, разделы 4-6): окно, настоящий хост и изолированный Claude Code стаб.
// Только поддельные ключи и loopback; настоящий ~ не читается и не пишется: HOME дочерних процессов - временный.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stub = path.join(dirname, 'stub-custom-agent.mjs');
const FAKE_KEY = 'e2e-fake-custom-key-never-valid-0001';

interface Ref { projectPath: string; workId: string; sessionId: string }
interface Bridge { parley: { call: (method: string, params: unknown) => Promise<unknown> } }
interface Launch {
  sessionId: string; settings: string; model: string | null; resume: boolean; systemPrompt: boolean;
  linkRule: boolean; linkRuleDir: boolean; configDir: string | null; secureStorageDir: boolean;
  baseUrl: string | null; keyOk: boolean; keyVar: string | null; anyKeyVar: boolean;
  fakeKeyAnywhere: boolean; fakeKeyInArgv: boolean; fakeKeyInSettings: boolean; managedByHost: boolean;
  opusModel: string | null; sonnetModel: string | null; haikuModel: string | null; subagentModel: string | null;
}
interface WorkList { entries: Array<{ projectPath: string; map: { work: { id: string }; sessions: Array<{ id: string; label: string; provider: string }> } }> }
interface StoredProvider { id: string; label: string; baseUrl: string; auth: string; models: { opus: string; sonnet: string; haiku: string; subagent: string }; linkClaude: boolean }

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
/** Файл как строка пути и sha256; нет файла - `absent`. */
async function fileMark(file: string): Promise<string> {
  const data = await readFile(file).catch(() => null);
  return `${file} ${data === null ? 'absent' : createHash('sha256').update(data).digest('hex')}`;
}

test.describe('свои провайдеры на изолированном Claude Code стабе', () => {
  let home: string;
  let user: string;
  let project: string;
  let running: ElectronApplication | null = null;
  let errors: string[];
  let extraEnv: Record<string, string>;
  const settingsDialog = (window: Page): Locator => window.getByRole('dialog', { name: 'Settings', exact: true });
  const segment = (window: Page, provider: string): Locator => window.locator(`[data-provider-segment="${provider}"]`);
  const launches = (): Promise<Launch[]> => jsonLines<Launch>(path.join(home, 'launches.jsonl'));
  const providerDir = (id: string): string => path.join(home, 'providers', id);

  test.beforeEach(async () => {
    home = await makeTempHome('custom-providers');
    project = await makeTempProject('custom-providers');
    user = path.join(home, 'user');
    errors = [];
    extraEnv = {};
    // Поддельные настройки Claude Code человека: из них провайдер подтягивает ссылки (спека 5.4).
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
    // Окружение без учётных данных; HOME и дом Parley - временные. PARLEY_CLAUDE_PROJECTS_DIR не задан:
    // история своего провайдера читается из его папки (спека 5.6), у обычной сессии стаб пишет в $HOME/.claude/projects.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|ZAI_|Z_AI_|AWS_|AZURE_|GOOGLE_|GEMINI_|BEDROCK_|VERTEX_)/i.test(name) &&
      !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) && !/^(PARLEY|HARNAS)_.*_BIN$/i.test(name) &&
      !/^(PARLEY|HARNAS)_CLAUDE_PROJECTS_DIR$/i.test(name),
    )) as Record<string, string>;
    Object.assign(env, {
      HOME: user, PARLEY_HOME: home, HARNAS_HOME: home,
      PARLEY_CLAUDE_BIN: stub, PARLEY_CODEX_BIN: path.join(home, 'absent-codex'),
      PARLEY_GLM_BIN: path.join(home, 'absent-glm-wrapper'), PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom', STUB_LAUNCH_LOG: path.join(home, 'launches.jsonl'), STUB_HOOK_LOG: path.join(home, 'hooks.jsonl'),
      ...extraEnv,
    });
    const app = await electron.launch({ args: [mainEntry], env });
    running = app;
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    window.on('pageerror', (error) => errors.push(error.message));
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    // Версия стаба 2.1.304 - не ниже минимальной для своих провайдеров (2.1.302) и для аккаунтов подписки (2.1.304).
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
  /** «+» - Kimi - ключ - Save: готовый провайдер `custom-kimi` с настоящей папкой на диске. */
  async function createKimi(window: Page, label = 'Kimi', id = 'custom-kimi'): Promise<Locator> {
    const dialog = await openAdd(window);
    await dialog.locator('[data-vendor-tile="kimi"]').click();
    const form = dialog.locator('[data-custom-provider-form]');
    await expect(form).toBeVisible();
    await form.getByLabel('Name in Parley', { exact: true }).fill(label);
    await form.getByLabel('API key', { exact: true }).fill(FAKE_KEY);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator(`[data-provider-pill="${id}"]`)).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator(`[data-custom-provider-form="${id}"]`)).toBeVisible();
    return dialog;
  }
  async function seed(window: Page): Promise<string> {
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'custom-e2e', goal: '' });
    const { ref } = await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'ordinary seed', task: '', parent: null });
    await launchOf(ref);
    await window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator('[data-work-title]').first().click();
    return workId;
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
  const stored = async (): Promise<StoredProvider[]> => {
    const data = JSON.parse(await readFile(path.join(home, 'custom-providers.json'), 'utf8')) as { providers: StoredProvider[] };
    return data.providers;
  };

  test('«+» - Kimi - ключ - Save: сегмент и пилюля; на диске ключа нет в описании, он в secrets.json, ссылки в папке провайдера', async () => {
    test.setTimeout(90_000);
    const { window } = await open();
    await expect(window.locator('[data-provider-segment]')).toHaveCount(3);
    const dialog = await openAdd(window);
    // Плитки вендоров: пять пресетов и «Own address».
    for (const id of ['kimi', 'minimax', 'qwen', 'deepseek', 'openrouter', 'own']) await expect(dialog.locator(`[data-vendor-tile="${id}"]`)).toBeVisible();
    await dialog.locator('[data-vendor-tile="kimi"]').click();
    const form = dialog.locator('[data-custom-provider-form]');
    await expect(form.getByLabel('Address (Anthropic-compatible)', { exact: true })).toHaveValue(/^https:\/\//);
    await expect(form.getByLabel('Instead of Sonnet', { exact: true })).toHaveValue(/kimi/i);
    await form.getByLabel('API key', { exact: true }).fill(FAKE_KEY);
    await form.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(dialog.locator('[data-provider-pill="custom-kimi"]')).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.locator('[data-provider-pill="custom-kimi"] [data-connected-dot]')).toBeVisible();
    await expect(dialog.locator('[data-custom-provider-form="custom-kimi"]')).toContainText('••••0001');
    await expect(window.locator('body')).not.toContainText(FAKE_KEY);
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(segment(window, 'custom-kimi')).toContainText('Kimi');
    await expect(segment(window, 'custom-kimi')).not.toHaveClass(/opacity-50/);

    // Описание без ключа; ключ - в secrets.json (0600) под своим id.
    expect((await readFile(path.join(home, 'custom-providers.json'), 'utf8')).includes(FAKE_KEY)).toBe(false);
    const [record] = await stored();
    expect(record).toMatchObject({ id: 'custom-kimi', label: 'Kimi', linkClaude: true });
    const secrets = await readFile(path.join(home, 'secrets.json'), 'utf8');
    expect(Object.keys(JSON.parse(secrets) as Record<string, unknown>)).toContain('custom:custom-kimi');
    expect(secrets.includes(FAKE_KEY)).toBe(true);
    expect((await stat(path.join(home, 'secrets.json'))).mode & 0o777).toBe(0o600);

    // Папка провайдера: поштучные ссылки на поддельный <HOME>/.claude.
    const folder = providerDir('custom-kimi');
    const source = path.join(user, '.claude');
    expect(await readlink(path.join(folder, 'CLAUDE.md'))).toBe(path.join(source, 'CLAUDE.md'));
    expect(await readlink(path.join(folder, 'skills', 'my-skill'))).toBe(path.join(source, 'skills', 'my-skill'));
    expect(await readlink(path.join(folder, 'agents', 'reviewer.md'))).toBe(path.join(source, 'agents', 'reviewer.md'));
    expect((await lstat(path.join(folder, 'skills'))).isDirectory()).toBe(true);
    expect((await lstat(path.join(folder, 'agents'))).isDirectory()).toBe(true);
    // Настройки человека не тронуты.
    expect(await readFile(path.join(source, 'settings.json'), 'utf8')).toBe('{"theme":"fake"}\n');
    expect(errors).toEqual([]);
  });

  test('«Own address» на loopback-заглушку без ключа: Save - Check - успешная проверка, заглушка получила модель Sonnet без [1m]', async () => {
    test.setTimeout(90_000);
    const requests: Array<{ url: string; model: string; authorization: boolean; apiKey: boolean }> = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { model?: string };
        requests.push({ url: request.url ?? '', model: body.model ?? '', authorization: request.headers.authorization !== undefined, apiKey: request.headers['x-api-key'] !== undefined });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const { window } = await open();
      const dialog = await openAdd(window);
      await dialog.locator('[data-vendor-tile="own"]').click();
      const form = dialog.locator('[data-custom-provider-form]');
      await form.getByLabel('Name in Parley', { exact: true }).fill('Local proxy');
      await form.getByLabel('Address (Anthropic-compatible)', { exact: true }).fill(`http://127.0.0.1:${port}`);
      await form.getByRole('checkbox', { name: 'One model for all slots', exact: true }).click();
      await form.getByLabel('Model', { exact: true }).fill('local-model[1m]');
      // Ключа нет, адрес локальный: Save доступен, Check - после сохранения.
      await expect(form.getByRole('button', { name: 'Check', exact: true })).toBeDisabled();
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog.locator('[data-custom-provider-form="custom-local-proxy"]')).toBeVisible();
      expect(requests).toEqual([]); // Save сеть не трогает: проверка - только по явному действию.
      const check = dialog.getByRole('button', { name: 'Check', exact: true });
      await expect(check).toBeEnabled();
      await check.click();
      await expect(dialog.locator('[data-custom-provider-form]')).toContainText(/Test request OK · checked/);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toEqual({ url: '/v1/messages', model: 'local-model', authorization: false, apiKey: false });
      expect(errors).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('New session: сессия своего провайдера запущена со своими признаками, соседний Claude - без них, ~/.claude не тронут', async () => {
    test.setTimeout(120_000);
    const { window } = await open();
    const workId = await seed(window);
    const claudeDir = path.join(user, '.claude');
    const claudeJson = path.join(user, '.claude.json');
    const before = { dir: await tree(claudeDir), json: await fileMark(claudeJson) };
    expect(before.dir.length).toBeGreaterThan(0);

    await createKimi(window);
    await window.keyboard.press('Escape');
    await expect(settingsDialog(window)).toBeHidden();
    const [record] = await stored();
    const ref = await startFromDialog(window, workId, 'Kimi', 'kimi session');
    const launch = await launchOf(ref);
    expect(launch).toMatchObject({
      configDir: providerDir('custom-kimi'), secureStorageDir: false, baseUrl: record!.baseUrl,
      keyOk: true, keyVar: record!.auth === 'api-key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN', fakeKeyInArgv: false, fakeKeyInSettings: false,
      managedByHost: true, opusModel: record!.models.opus, sonnetModel: record!.models.sonnet,
      haikuModel: record!.models.haiku, subagentModel: record!.models.subagent,
      systemPrompt: true, linkRule: true, linkRuleDir: true, resume: false,
    });
    // История своего провайдера - в его папке.
    expect((await readdir(path.join(providerDir('custom-kimi'), 'projects', 'stub-project'))).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1);
    await call(window, 'sessions.stop', { ref });
    await call(window, 'sessions.resume', { ref });
    expect(await launchOf(ref, 1)).toMatchObject({ resume: true, configDir: providerDir('custom-kimi'), keyOk: true, linkRule: true });
    await call(window, 'sessions.stop', { ref });
    // Ни сохранение, ни проверка ключа, ни запуск, ни resume не изменили ни одного байта в <HOME>/.claude.
    expect({ dir: await tree(claudeDir), json: await fileMark(claudeJson) }).toEqual(before);

    const { ref: ordinary } = await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label: 'ordinary after kimi', task: '', parent: null });
    expect(await launchOf(ordinary)).toMatchObject({
      configDir: null, secureStorageDir: false, baseUrl: null, keyOk: false, anyKeyVar: false, fakeKeyAnywhere: false,
      managedByHost: false, linkRule: false, opusModel: null, sonnetModel: null, haikuModel: null, subagentModel: null,
    });
    expect(errors).toEqual([]);
  });

  test('переименование не меняет id и папку; Delete по умолчанию оставляет папку, с «Also delete its folder» удаляет её', async () => {
    test.setTimeout(120_000);
    const { window } = await open();
    const dialog = await createKimi(window);
    const folder = providerDir('custom-kimi');
    const source = path.join(user, '.claude');
    const sourceBefore = await tree(source);
    const form = dialog.locator('[data-custom-provider-form]');

    // Переименование: id прежний, папка та же.
    await form.getByLabel('Name in Parley', { exact: true }).fill('Kimi Work');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.locator('[data-provider-pill="custom-kimi"]')).toContainText('Kimi Work');
    await expect(segment(window, 'custom-kimi')).toContainText('Kimi Work');
    expect((await stored()).map((item) => [item.id, item.label])).toEqual([['custom-kimi', 'Kimi Work']]);
    expect(await exists(folder)).toBe(true);
    expect(await readdir(path.join(home, 'providers'))).toEqual(['custom-kimi']);

    // Delete по умолчанию: сегмента нет, описания и ключа нет, папка осталась.
    await form.getByRole('button', { name: 'Delete provider', exact: true }).click();
    const confirm = dialog.getByRole('group', { name: 'Delete provider', exact: true });
    await expect(confirm).toContainText('Delete Kimi Work?');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(dialog.locator('[data-provider-pill="custom-kimi"]')).toHaveCount(0);
    await expect(segment(window, 'custom-kimi')).toHaveCount(0);
    expect(await stored()).toEqual([]);
    expect(await readFile(path.join(home, 'secrets.json'), 'utf8').catch(() => '')).not.toContain('custom:custom-kimi');
    expect(await exists(folder)).toBe(true);

    // Повторное создание: папка прежнего осталась, поэтому id новый (custom-kimi-2); Delete с удалением его папки.
    await window.keyboard.press('Escape');
    const again = await createKimi(window, 'Kimi', 'custom-kimi-2');
    const folderAgain = providerDir('custom-kimi-2');
    expect((await stored()).map((item) => item.id)).toEqual(['custom-kimi-2']);
    expect(await exists(folder)).toBe(true);
    await again.locator('[data-custom-provider-form]').getByRole('button', { name: 'Delete provider', exact: true }).click();
    const confirmAgain = again.getByRole('group', { name: 'Delete provider', exact: true });
    await confirmAgain.getByRole('checkbox', { name: 'Also delete its folder (history)', exact: true }).click();
    await confirmAgain.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(again.locator('[data-provider-pill="custom-kimi-2"]')).toHaveCount(0);
    await expect.poll(() => exists(folderAgain)).toBe(false);
    expect(await stored()).toEqual([]);
    // Оригиналы в <HOME>/.claude целы: удаление папки сняло ссылки, а не их цели.
    expect(await tree(source)).toEqual(sourceBefore);
    expect(await readFile(path.join(source, 'CLAUDE.md'), 'utf8')).toBe('# Fake human rules\n');
    expect(await exists(path.join(source, 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('800×500: плитки и форма без горизонтального скролла в светлой и тёмной темах', async () => {
    // Снимки уходят в папку результатов теста, а не в репозиторий.
    const shots = test.info().outputPath('shots');
    test.setTimeout(120_000);
    const { app, window } = await open();
    await resize(app, 800, 500);
    await mkdir(shots, { recursive: true });
    /** Ни документ, ни диалог, ни один его элемент не уходят вбок за границы окна/диалога. */
    const noHorizontalOverflow = async (dialog: Locator): Promise<void> => {
      await expect(async () => {
        const report = await dialog.evaluate((root) => {
          const box = root.getBoundingClientRect();
          const wide = Array.from(root.querySelectorAll<HTMLElement>('*')).flatMap((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return [];
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
    };
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      const dialog = await openAdd(window);
      await noHorizontalOverflow(dialog);
      await window.screenshot({ path: path.join(shots, `custom-providers-tiles-${theme}-800x500.png`), animations: 'disabled' });
      await dialog.locator('[data-vendor-tile="qwen"]').click(); // Самая широкая форма: выбор тарифа и длинный адрес.
      const form = dialog.locator('[data-custom-provider-form]');
      await expect(form).toBeVisible();
      await noHorizontalOverflow(dialog);
      await form.getByLabel('API key', { exact: true }).fill('e2e-fake-unused-key');
      await expect(form.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      await window.screenshot({ path: path.join(shots, `custom-providers-form-${theme}-800x500.png`), animations: 'disabled' });
      await window.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  });
});
