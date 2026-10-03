import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';

// Только поддельные ключи и локальные HTTP-хуки. Это проверка проводки Parley,
// а не реальной аутентификации Claude Code, API Z.ai или первого onboarding.
const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stub = path.join(dirname, 'stub-glm-agent.mjs');
const shots = path.resolve(dirname, '../../../.omc/reviews/shots');
const FIRST_KEY = 'e2e-fake-zai-key-never-valid-0001';
const SECOND_KEY = 'e2e-fake-zai-key-never-valid-0002';
const DEFAULT_MODEL = 'glm-5.3[1m]';
const FLASH_MODEL = 'glm-5.3-flash[1m]';
const visual = process.env.PARLEY_E2E_VISUAL === '1';

interface Ref { projectPath: string; workId: string; sessionId: string }
interface Bridge { parley: { call: (method: string, params: unknown) => Promise<unknown>; notify: (method: string, params: unknown) => void } }
interface Launch {
  sessionId: string; settings: string; settingsModel: string | null; model: string | null;
  resume: boolean; channels: boolean; mcp: boolean; systemPrompt: boolean;
  managedByHost: boolean; authPresent: boolean; firstKey: boolean; secondKey: boolean;
  fakeKeyAnywhere: boolean; hookCapability: boolean; hookToken: boolean;
  capabilitySettings: boolean; trustedEndpoint: boolean; trustedAliases: boolean; settingsHaveKey: boolean;
}
interface HookLine { sessionId: string; event: string; status: number; response: Record<string, unknown> }
interface WorkList { entries: Array<{ projectPath: string; map: { work: { id: string }; sessions: Array<{ id: string; label: string; provider: string }> } }> }

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
  // Видимый проход открывает настоящий Search; функциональный тест сохраняет проверку ⌘J.
  if (visual) await window.getByRole('button', { name: 'Search ⌘J', exact: true }).first().click();
  else await window.keyboard.press('Meta+J');
  await expect(window.locator('[data-palette] [cmdk-input]')).toBeFocused();
  await window.keyboard.type(`Theme: ${theme}`);
  await expect(window.locator('[data-palette] [role="option"]').first()).toContainText(`Theme: ${theme}`);
  await window.keyboard.press('Enter');
  await expect(window.locator('[data-palette]')).toHaveCount(0);
  if (theme === 'dark') await expect(window.locator('html')).toHaveClass(/\bdark\b/);
  else await expect(window.locator('html')).not.toHaveClass(/\bdark\b/);
}
async function inWindow(window: Page, locator: Locator): Promise<void> {
  // Radix считает collision placement после монтирования. Ждём те же строгие границы.
  try {
    await expect(async () => {
      const box = await locator.boundingBox();
      expect(box).not.toBeNull();
      const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    }).toPass({ timeout: 5000, intervals: [50, 100, 250] });
  } catch (error) {
    await mkdir(shots, { recursive: true });
    await window.screenshot({ path: path.join(shots, 'task8-layout-failure.png'), animations: 'disabled' });
    console.log('layout-failure', await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const wrapper = element.parentElement;
      return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, position: style.position, transform: style.transform, side: element.getAttribute('data-side'), wrapperStyle: wrapper?.getAttribute('style') };
    }));
    throw error;
  }
}

class Hooks {
  constructor(private readonly window: Page, private readonly ref: Ref, private readonly log: string) {}
  async lines(event: string): Promise<HookLine[]> {
    return (await jsonLines<HookLine>(this.log)).filter((line) => line.sessionId === this.ref.sessionId && line.event === event);
  }
  async hold(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    await this.window.evaluate(({ ref, data }) => (globalThis as unknown as Bridge).parley.notify('pty.input', { ref, data }), {
      ref: this.ref, data: `STUB_HOOK ${JSON.stringify({ hook_event_name: event, ...fields })}\r`,
    });
  }
  async fire(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const before = (await this.lines(event)).length;
    await this.hold(event, fields);
    await expect.poll(async () => (await this.lines(event)).length, { timeout: 15_000, message: `loopback ${event}` }).toBeGreaterThan(before);
    expect((await this.lines(event))[before]?.status).toBe(200);
  }
}

test.describe('подключение провайдеров на изолированном Claude Code стабе', () => {
  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;
  let errors: string[];
  const cardOf = (window: Page): Locator => window.locator('[data-provider-card="glm"]');
  const segment = (window: Page, provider: string): Locator => window.locator(`[data-provider-segment="${provider}"]`);
  const launches = (): Promise<Launch[]> => jsonLines<Launch>(path.join(home, 'launches.jsonl'));

  test.beforeEach(async () => {
    home = await makeTempHome('providers-connect');
    project = await makeTempProject('providers-connect');
    errors = [];
    await mkdir(path.join(home, 'user'), { recursive: true });
  });
  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  async function open(): Promise<{ app: ElectronApplication; window: Page }> {
    // Не читаем файлы учётных данных; у дочерних процессов HOME и Parley home временные.
    // PATH остаётся для node/devtools, а Codex отсутствует через явный абсолютный override.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !/^(ANTHROPIC_|CLAUDE_|CODEX_|OPENAI_|ZAI_|Z_AI_|AWS_|AZURE_|GOOGLE_|GEMINI_|BEDROCK_|VERTEX_)/i.test(name) &&
      !/(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)/i.test(name) && !/^(PARLEY|HARNAS)_.*_BIN$/i.test(name),
    )) as Record<string, string>;
    Object.assign(env, {
      HOME: path.join(home, 'user'), PARLEY_HOME: home, HARNAS_HOME: home,
      PARLEY_CLAUDE_PROJECTS_DIR: path.join(home, 'claude-projects'),
      PARLEY_CLAUDE_BIN: stub, PARLEY_CODEX_BIN: path.join(home, 'absent-codex'),
      PARLEY_GLM_BIN: path.join(home, 'absent-glm-wrapper'), PARLEY_SKIP_VERSION_PROBE: '',
      PARLEY_TERMINAL_RENDERER: 'dom', STUB_LAUNCH_LOG: path.join(home, 'launches.jsonl'), STUB_HOOK_LOG: path.join(home, 'hooks.jsonl'),
    });
    const app = await electron.launch({ args: [mainEntry], env, ...(visual ? { slowMo: 350 } : {}) });
    running = app;
    const window = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    window.on('pageerror', (error) => errors.push(error.message));
    await resize(app, 1400, 900);
    await expect(window.getByTestId('landing')).toBeVisible();
    await expect(segment(window, 'claude')).toContainText('2.1.287');
    return { app, window };
  }
  async function create(window: Page, workId: string, provider: 'claude' | 'glm', label: string, model?: string): Promise<Ref> {
    return (await call<{ ref: Ref }>(window, 'sessions.create', { projectPath: project, workId, provider, label, task: '', parent: null, ...(model === undefined ? {} : { model }) })).ref;
  }
  async function launchOf(ref: Ref, index = 0): Promise<Launch> {
    await expect.poll(async () => (await launches()).filter((line) => line.sessionId === ref.sessionId).length, { timeout: 15_000 }).toBeGreaterThan(index);
    return (await launches()).filter((line) => line.sessionId === ref.sessionId)[index]!;
  }
  async function openSession(window: Page, ref: Ref): Promise<void> {
    await window.locator(`[data-session-id="${ref.sessionId}"]`).click();
    await expect.poll(async () => window.locator('.xterm-rows').first().evaluate((rows) => Array.from(rows.children, (row) => row.textContent ?? '').join(''))).toContain('stub-glm ready');
  }
  async function save(card: Locator, key: string, action: 'Save' | 'Replace' = 'Save'): Promise<void> {
    await card.getByLabel('Z.ai API key').fill(key);
    await card.getByRole('button', { name: action, exact: true }).click();
    await expect(card.getByLabel('Z.ai API key')).toHaveValue('');
    await expect(card).toContainText(`••••${key.slice(-4)}`);
  }
  async function saveFromStatus(window: Page): Promise<void> {
    await segment(window, 'glm').click();
    await save(cardOf(window), FIRST_KEY);
    await window.keyboard.press('Escape');
    await expect(cardOf(window)).toHaveCount(0);
    await expect(segment(window, 'glm')).toBeFocused();
    await expect(segment(window, 'glm')).not.toHaveClass(/opacity-50/);
  }
  async function seed(window: Page): Promise<string> {
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'providers-e2e', goal: '' });
    const ref = await create(window, workId, 'claude', 'ordinary seed');
    await launchOf(ref);
    await window.locator(`[data-work-key="${project} ${workId}"]:not([role="tab"])`).locator('[data-work-title]').first().click();
    return workId;
  }

  test('Save в открытом диалоге, Flash, Replace для следующего процесса, Remove запрещает new/resume', async () => {
    test.setTimeout(120_000);
    const { window } = await open();
    await expect(window.locator('[data-provider-segment]')).toHaveCount(3);
    expect(await window.locator('[data-provider-segment]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-provider-segment')))).toEqual(['claude', 'codex', 'glm']);
    await expect(segment(window, 'codex')).toHaveClass(/opacity-50/);
    await expect(segment(window, 'codex')).not.toContainText(/not found|\d+\.\d+/);
    await expect(segment(window, 'glm')).toHaveClass(/opacity-50/);
    const workId = await seed(window);
    await window.keyboard.press('Meta+T');
    const dialog = window.getByRole('dialog', { name: 'New session', exact: true });
    await expect(dialog).toBeVisible();
    const glm = dialog.getByRole('radio', { name: 'GLM', exact: true });
    await glm.click();
    await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(cardOf(window)).toContainText('Not connected');
    await save(cardOf(window), FIRST_KEY);
    await expect(cardOf(window)).toContainText('Connected');
    expect((await stat(path.join(home, 'secrets.json'))).mode & 0o777).toBe(0o600);
    // Проверяем только собственный временный файл, не показывая содержимое в ошибке.
    expect((await readFile(path.join(home, 'secrets.json'), 'utf8')).includes(FIRST_KEY)).toBe(true);
    await expect(window.locator('body')).not.toContainText(FIRST_KEY);
    await window.keyboard.press('Escape');
    await glm.click();
    await expect(glm).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
    await expect(window.getByRole('option', { name: 'GLM-5.3 (1M context)', exact: true })).toBeVisible();
    await window.getByRole('option', { name: 'GLM-5.3 Flash (1M context)', exact: true }).click();
    await dialog.getByPlaceholder('Optional').fill('flash from dialog');
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 20_000 });
    const list = await call<WorkList>(window, 'works.list', {});
    const flash = list.entries.find((entry) => entry.map.work.id === workId)!.map.sessions.find((session) => session.label === 'flash from dialog')!;
    const flashRef = { projectPath: project, workId, sessionId: flash.id };
    expect(await launchOf(flashRef)).toMatchObject({ model: FLASH_MODEL, settingsModel: FLASH_MODEL, firstKey: true, secondKey: false, settings: 'settings-glm.json' });
    await call(window, 'sessions.stop', { ref: flashRef });
    await call(window, 'sessions.resume', { ref: flashRef });
    expect(await launchOf(flashRef, 1)).toMatchObject({ resume: true, model: DEFAULT_MODEL, settingsModel: DEFAULT_MODEL, firstKey: true });

    await segment(window, 'glm').click();
    await save(cardOf(window), SECOND_KEY, 'Replace');
    await window.keyboard.press('Escape');
    const next = await create(window, workId, 'glm', 'next default');
    expect(await launchOf(next)).toMatchObject({ firstKey: false, secondKey: true, model: DEFAULT_MODEL, settingsModel: DEFAULT_MODEL });
    await call(window, 'sessions.stop', { ref: next });
    await call(window, 'sessions.resume', { ref: next });
    expect(await launchOf(next, 1)).toMatchObject({ resume: true, secondKey: true, model: DEFAULT_MODEL, settingsModel: DEFAULT_MODEL });
    await call(window, 'sessions.stop', { ref: next });

    // Другой renderer snapshot (диалог) обновляется после Remove, сохраняя выбранный GLM.
    await window.keyboard.press('Meta+T');
    await expect(dialog).toBeVisible();
    await expect(glm).toHaveAttribute('aria-checked', 'true');
    await glm.click();
    await cardOf(window).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(cardOf(window)).toContainText('Not connected');
    await expect(cardOf(window).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await expect(cardOf(window)).not.toContainText('••••0002');
    await window.keyboard.press('Escape');
    await expect(dialog).toContainText('GLM is unavailable. Connect it or choose another agent.');
    await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
    await expect(glm).toHaveAttribute('aria-checked', 'true');
    await expect(segment(window, 'glm')).toHaveClass(/opacity-50/);
    expect(await stat(path.join(home, 'secrets.json')).then(() => true, () => false)).toBe(false);
    const before = (await launches()).length;
    const beforeIds = (await call<WorkList>(window, 'works.list', {})).entries.flatMap((entry) => entry.map.sessions.map((session) => session.id));
    await expect(create(window, workId, 'glm', 'must not start')).rejects.toThrow();
    await expect(call(window, 'sessions.resume', { ref: next })).rejects.toThrow();
    expect((await launches()).length).toBe(before);
    expect((await call<WorkList>(window, 'works.list', {})).entries.flatMap((entry) => entry.map.sessions.map((session) => session.id))).toEqual(beforeIds);
    expect(errors).toEqual([]);
  });

  test('GLM family: Terminal до хуков, Chat/permission по CAPABILITY; соседний Claude без Z.ai key', async () => {
    test.setTimeout(90_000);
    const { window } = await open();
    const workId = await seed(window);
    await saveFromStatus(window);
    const ref = await create(window, workId, 'glm', 'glm chat');
    await openSession(window, ref);
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await expect(window.getByRole('radio', { name: 'Chat', exact: true })).toBeVisible();
    expect(await launchOf(ref)).toMatchObject({
      settings: 'settings-glm.json', settingsModel: DEFAULT_MODEL, model: DEFAULT_MODEL,
      managedByHost: true, authPresent: true, firstKey: true, secondKey: false,
      hookCapability: true, hookToken: false, capabilitySettings: true,
      channels: false, mcp: true, systemPrompt: true, settingsHaveKey: false,
      trustedEndpoint: true, trustedAliases: true,
    });
    const hooks = new Hooks(window, ref, path.join(home, 'hooks.jsonl'));
    await hooks.fire('SessionStart', { source: 'startup', model: DEFAULT_MODEL, permission_mode: 'default', cwd: project });
    const chat = window.getByTestId('chat-view');
    await expect(chat).toBeVisible();
    await hooks.fire('UserPromptSubmit', { prompt: 'Say hello from GLM', permission_mode: 'default' });
    await hooks.fire('MessageDisplay', { message_id: 'glm-hello', index: 0, final: true, delta: 'Hello from the GLM fixture.' });
    await expect(chat.getByTestId('chat-text')).toContainText('Hello from the GLM fixture.');
    const input = { command: 'echo fixture', description: 'Only a fake hook; no command executes' };
    await hooks.fire('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 'glm-tool-1', permission_mode: 'default' });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: input, permission_mode: 'default', permission_suggestions: [] });
    const permission = chat.locator('[data-testid="chat-card"][data-card-kind="permission"][data-card-state="pending"]');
    await expect(permission).toHaveCount(1);
    await expect(async () => {
      const allow = permission.getByTestId('card-allow');
      if (await allow.isVisible()) await allow.click({ timeout: 2000 });
      expect((await hooks.lines('PermissionRequest')).length).toBe(1);
    }).toPass({ timeout: 20_000, intervals: [300, 500, 1000] });
    expect((await hooks.lines('PermissionRequest'))[0]).toMatchObject({ status: 200, response: { hookSpecificOutput: { decision: { behavior: 'allow' } } } });
    await hooks.fire('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 'glm-tool-1', permission_mode: 'default', tool_response: { stdout: 'fixture', stderr: '' } });
    await hooks.fire('Stop', { last_assistant_message: 'Hello from the GLM fixture.', stop_hook_active: false });
    // Выбор /model в текущем процессе не записывается как launch model следующего resume.
    const field = chat.getByTestId('chat-composer').locator('textarea');
    await field.fill('/model ');
    await expect(window.getByTestId('chat-suggestions')).toContainText('GLM-5.3 Flash');
    await field.fill('');
    await window.getByRole('radio', { name: 'Terminal', exact: true }).click();
    await window.getByRole('radio', { name: 'Chat', exact: true }).click();
    await expect(chat.getByTestId('chat-text')).toContainText('Hello from the GLM fixture.');
    await chat.getByTestId('chat-model').click();
    const choices = window.getByTestId('chat-model-option');
    await expect(choices).toHaveCount(2);
    await expect(choices.nth(0)).toHaveAttribute('data-model', DEFAULT_MODEL);
    await expect(choices.nth(1)).toHaveAttribute('data-model', FLASH_MODEL);
    await choices.nth(1).click();
    await call(window, 'sessions.stop', { ref });
    await call(window, 'sessions.resume', { ref });
    expect(await launchOf(ref, 1)).toMatchObject({ resume: true, model: DEFAULT_MODEL, settingsModel: DEFAULT_MODEL });

    const ordinary = await create(window, workId, 'claude', 'ordinary after save');
    await openSession(window, ordinary);
    expect(await launchOf(ordinary)).toMatchObject({
      settings: 'settings.json', authPresent: false, fakeKeyAnywhere: false, firstKey: false, secondKey: false,
      managedByHost: false, hookToken: true, hookCapability: false, capabilitySettings: false,
      trustedEndpoint: false, trustedAliases: false, settingsHaveKey: false,
    });
    const ordinaryHooks = new Hooks(window, ordinary, path.join(home, 'hooks.jsonl'));
    await ordinaryHooks.fire('SessionStart', { source: 'startup', model: 'sonnet', permission_mode: 'default', cwd: project });
    await expect(window.getByTestId('chat-view')).toBeVisible();
    await ordinaryHooks.fire('UserPromptSubmit', { prompt: 'Ordinary Claude fixture', permission_mode: 'default' });
    await ordinaryHooks.fire('MessageDisplay', { message_id: 'ordinary-hello', index: 0, final: true, delta: 'Ordinary Claude remains separate.' });
    await ordinaryHooks.fire('Stop', { last_assistant_message: 'Ordinary Claude remains separate.', stop_hook_active: false });
    await expect(window.getByTestId('chat-view').getByTestId('chat-text')).toContainText('Ordinary Claude remains separate.');
    expect(errors).toEqual([]);
  });

  test('800×500: порядок, доступная клавиатура, карточки и диалог в светлой и тёмной темах', async () => {
    test.setTimeout(90_000);
    const { app, window } = await open();
    await seed(window);
    await resize(app, 800, 500);
    await mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      for (const provider of ['claude', 'codex', 'glm']) {
        await inWindow(window, segment(window, provider));
        await segment(window, provider).focus();
        await window.keyboard.press('Enter');
        const card = window.locator(`[data-provider-card="${provider}"]`);
        await expect(card).toBeVisible();
        const popover = card.locator('..');
        await inWindow(window, popover);
        if (provider === 'glm') {
          const field = card.getByLabel('Z.ai API key');
          await field.focus();
          await expect(field).toBeFocused();
          await field.fill('e2e-fake-unused-key');
          await field.press('Enter');
          await expect(card.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
          await window.screenshot({ path: path.join(shots, `task8-glm-${theme}-800x500.png`), animations: 'disabled' });
        }
        await window.keyboard.press('Escape');
        await expect(card).toHaveCount(0);
        await expect(segment(window, provider)).toBeFocused();
      }
      await window.keyboard.press('Meta+T');
      const dialog = window.getByRole('dialog', { name: 'New session', exact: true });
      await expect(dialog).toBeVisible();
      const claude = dialog.getByRole('radio', { name: 'Claude', exact: true });
      await claude.focus();
      await window.keyboard.press('ArrowRight');
      const codexCard = window.locator('[data-provider-card="codex"]');
      await expect(codexCard).toBeVisible();
      await expect(codexCard.getByRole('button').first()).toBeFocused();
      await window.keyboard.press('Escape');
      try {
        await expect(codexCard).toHaveCount(0);
        await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).toBeFocused();
      } catch (error) {
        await window.screenshot({ path: path.join(shots, `task8-codex-focus-failure-${theme}.png`), animations: 'disabled' });
        console.log('codex-focus-failure', theme, await window.evaluate(() => {
          const active = document.activeElement;
          const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((element) => element.querySelector('h2')?.textContent === 'New session');
          const trigger = dialog?.querySelector<HTMLButtonElement>('[role="radio"][title="Codex"]');
          const card = document.querySelector('[data-provider-card="codex"]');
          return {
            active: active === null ? null : { tag: active.tagName, id: active.id, role: active.getAttribute('role'), label: active.getAttribute('aria-label') ?? active.getAttribute('title') ?? (active.matches('button,a,[role="radio"]') ? active.textContent?.trim().slice(0, 100) : null) },
            dialogPresent: dialog !== undefined, dialogState: dialog?.getAttribute('data-state'),
            cardPresent: card !== null, cardState: card?.parentElement?.getAttribute('data-state'),
            trigger: trigger === undefined || trigger === null ? null : { connected: trigger.isConnected, disabled: trigger.disabled, state: trigger.getAttribute('data-state'), expanded: trigger.getAttribute('aria-expanded') },
          };
        }));
        throw error;
      }
      await window.keyboard.press('ArrowRight');
      const glm = dialog.getByRole('radio', { name: 'GLM', exact: true });
      await expect(cardOf(window)).toBeVisible();
      await expect(cardOf(window).getByLabel('Z.ai API key')).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(glm).toBeFocused();
      await window.keyboard.press('Enter');
      const card = cardOf(window);
      await expect(card).toBeVisible();
      await expect(card.getByLabel('Z.ai API key')).toBeFocused();
      await inWindow(window, card.locator('..'));
      await expect(claude).toHaveAttribute('aria-checked', 'true');
      const field = card.getByLabel('Z.ai API key');
      await expect(field).toHaveValue('');
      await expect(field).toBeFocused();
      await expect(field).toBeInViewport({ ratio: 1 });
      await window.screenshot({ path: path.join(shots, `task8-focused-key-before-scroll-${theme}.png`), animations: 'disabled' });
      console.log('focused-key-before-scroll', theme, await card.locator('..').evaluate((content) => {
        const field = content.querySelector('input[type="password"]');
        const box = content.getBoundingClientRect();
        const fieldBox = field?.getBoundingClientRect();
        const style = getComputedStyle(content);
        return {
          focused: document.activeElement === field,
          outer: { x: box.x, y: box.y, width: box.width, height: box.height },
          field: fieldBox === undefined ? null : { x: fieldBox.x, y: fieldBox.y, width: fieldBox.width, height: fieldBox.height },
          scrollTop: content.scrollTop, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight,
          maxHeight: style.maxHeight,
          availableHeight: style.getPropertyValue('--radix-popover-content-available-height'),
        };
      }));
      await field.scrollIntoViewIfNeeded();
      await field.focus();
      await expect(field).toBeFocused();
      await expect(field).toBeInViewport({ ratio: 1 });
      await field.fill('e2e-fake-unused-key');
      const saveButton = card.getByRole('button', { name: 'Save', exact: true });
      await expect(saveButton).toBeEnabled();
      await saveButton.focus();
      await saveButton.scrollIntoViewIfNeeded();
      await expect(saveButton).toBeFocused();
      await expect(saveButton).toBeInViewport({ ratio: 1 });
      await window.screenshot({ path: path.join(shots, `task8-glm-dialog-${theme}-800x500.png`), animations: 'disabled' });
      await window.keyboard.press('Escape');
      await expect(card).toHaveCount(0);
      await expect(glm).toBeFocused();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeInViewport();
      await window.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
    expect(errors).toEqual([]);
  });

  test('визуальный проход: видимое окно, карточки, GLM Chat и permission в обеих темах', async () => {
    test.skip(!visual, 'Отдельный видимый проход включается PARLEY_E2E_VISUAL=1');
    test.setTimeout(300_000);
    const { app, window } = await open();
    const workId = await seed(window);
    await mkdir(shots, { recursive: true });
    // Паузы только для показа человеку/визуальному агенту, не для корректности ожиданий.
    const present = async (name: string): Promise<void> => {
      await window.waitForTimeout(600);
      await window.screenshot({ path: path.join(shots, `task8-visible-${name}.png`), animations: 'disabled' });
    };
    await resize(app, 800, 500);
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      for (const provider of ['claude', 'codex', 'glm']) {
        await segment(window, provider).click();
        const card = window.locator(`[data-provider-card="${provider}"]`);
        await expect(card).toBeVisible();
        await inWindow(window, card.locator('..'));
        await present(`${provider}-${theme}`);
        await window.keyboard.press('Escape');
        await expect(card).toHaveCount(0);
        await expect(segment(window, provider)).toBeFocused();
      }
    }
    await saveFromStatus(window);
    await window.keyboard.press('Meta+T');
    const dialog = window.getByRole('dialog', { name: 'New session', exact: true });
    await dialog.getByRole('radio', { name: 'GLM', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Model', exact: true }).click();
    await expect(window.getByRole('option', { name: 'GLM-5.3 Flash (1M context)', exact: true })).toBeVisible();
    await present('glm-models');
    await window.keyboard.press('Escape');
    await expect(window.getByRole('option', { name: 'GLM-5.3 Flash (1M context)', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('combobox', { name: 'Model', exact: true })).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const ref = await create(window, workId, 'glm', 'visible GLM');
    await openSession(window, ref);
    await expect(window.getByTestId('chat-view')).toHaveCount(0);
    await present('first-terminal');
    const hooks = new Hooks(window, ref, path.join(home, 'hooks.jsonl'));
    await hooks.fire('SessionStart', { source: 'startup', model: DEFAULT_MODEL, permission_mode: 'default', cwd: project });
    await hooks.fire('UserPromptSubmit', { prompt: 'Show a fake permission request', permission_mode: 'default' });
    await hooks.fire('MessageDisplay', { message_id: 'visible-glm', index: 0, final: true, delta: 'The GLM fixture is ready. This is a local UI demonstration.' });
    await hooks.hold('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'echo visual-fixture', description: 'Fake request; no command executes' }, permission_mode: 'default', permission_suggestions: [] });
    const permission = window.locator('[data-testid="chat-card"][data-card-kind="permission"][data-card-state="pending"]');
    await expect(permission).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await pickTheme(window, theme);
      await expect(permission.getByTestId('card-allow')).toBeInViewport();
      await expect(permission.getByTestId('card-deny')).toBeInViewport();
      await present(`glm-permission-${theme}`);
    }
    await permission.getByTestId('card-allow').click();
    await expect.poll(async () => (await hooks.lines('PermissionRequest')).length).toBe(1);
    await hooks.fire('Stop', { last_assistant_message: 'The fake permission was approved.', stop_hook_active: false });
    await present('glm-approved');
    expect(errors).toEqual([]);
  });
});
