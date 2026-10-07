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
 * Панель агентов правого сайдбара (план 2026-10-07, часть A, Task 6; спека 5.1). Как в `chat-hooks.spec.ts`, `claude`
 * играет стаб `stub-echo-agent.mjs`, а события агента — строки `STUB_HOOK <json>` через `pty.input` (хуки HTTP на хост).
 * Проверяется путь «тулбар → вкладка Agents → экран агента → назад», вход через поповер агентов в сайдбаре и раскладка
 * 800×500 с длинными значениями (описание 240 знаков, задание 30 строк, команда 140 знаков). `E2E_DPR=2` запускает
 * окно с `--force-device-scale-factor=2`. Снимки — в `test-results/agents-panel/` (не коммитятся).
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const shots = path.resolve(dirname, '../test-results/agents-panel');
const dpr = process.env.E2E_DPR === '2' ? '2' : '1';

const MODEL = 'claude-sonnet-4-5';
const AGENT_ID = 'agE2E';
const DESCRIPTION =
  'Explore the feed reducer and find every place where agent cards are created, merged and finished — '.repeat(
    2,
  );
const COMMAND = `grep -rn "agentCard" packages/desktop/src/renderer/chat --include=*.ts --include=*.tsx | sort | uniq -c | head -${'9'.repeat(40)}`;
const PROMPT = Array.from(
  { length: 30 },
  (_, at) => `Step ${at + 1}: inspect the reducer and note where cards change.`,
).join('\n');

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

type Parley = {
  parley: {
    call: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
  };
};

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return (await window.evaluate(
    ({ method: name, params: body }) => (globalThis as unknown as Parley).parley.call(name, body),
    { method, params },
  )) as T;
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

/** Снимок после смены размера: переходы должны догореть. */
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

  /** Печатает строку STUB_HOOK в терминал стаба сырым вводом (`pty.input`); ответа не ждёт. */
  async hold(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const body = JSON.stringify({ hook_event_name: event, ...fields });
    await this.window.evaluate(
      ({ ref, data }) =>
        (globalThis as unknown as Parley).parley.notify('pty.input', { ref, data }),
      { ref: this.ref, data: `STUB_HOOK ${body}\r` },
    );
  }

  /** Шлёт событие, на которое хост отвечает сразу, и ждёт его строку в журнале ответов (код 200). */
  async fire(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    const before = (await this.lines(event)).length;
    await this.hold(event, fields);
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
  app: ElectronApplication;
  window: Page;
  ref: Ref;
  hooks: Hooks;
  errors: string[];
}

test.describe('панель Agents правого сайдбара (план 2026-10-07, Task 6)', () => {
  test.setTimeout(120_000);

  let home: string;
  let project: string;
  let running: ElectronApplication | null = null;

  test.beforeEach(async () => {
    home = await makeTempHome('agents-panel');
    project = await makeTempProject('agents-panel');
    await mkdir(shots, { recursive: true });
  });

  test.afterEach(async () => {
    await stopApp(running);
    running = null;
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  /** Окно со стабом вместо `claude`, работа и одна сессия с открытой вкладкой; первый хук делает вкладку чатом. */
  async function open(width: number, height: number): Promise<Opened> {
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
    await resize(app, width, height);
    await expect(window.getByTestId('landing')).toBeVisible();
    const errors: string[] = [];
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    const work = await call<{ workId: string }>(window, 'works.create', {
      projectPath: project,
      title: 'e2e-agents-panel',
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
    await expect.poll(() => screenText(window)).toContain('stub-echo');
    const hooks = new Hooks(window, ref, logFile);
    await hooks.fire('SessionStart', {
      source: 'startup',
      model: MODEL,
      permission_mode: 'default',
      cwd: project,
    });
    await expect(window.getByTestId('chat-view')).toBeVisible();
    return { app, window, ref, hooks, errors };
  }

  /** Фоновый агент с длинными значениями: описание, задание в 30 строк, вложенный `Bash` с длинной командой. */
  async function launchAgent(hooks: Hooks): Promise<void> {
    await hooks.fire('UserPromptSubmit', {
      prompt: 'Explore the repository',
      permission_mode: 'default',
    });
    const input = { description: DESCRIPTION, prompt: PROMPT, subagent_type: 'Explore' };
    await hooks.fire('PreToolUse', {
      tool_name: 'Agent',
      tool_input: input,
      tool_use_id: 'toolu_e2e1',
      permission_mode: 'default',
    });
    await hooks.fire('PostToolUse', {
      tool_name: 'Agent',
      tool_input: input,
      tool_use_id: 'toolu_e2e1',
      permission_mode: 'default',
      tool_response: {
        isAsync: true,
        status: 'async_launched',
        agentId: AGENT_ID,
        description: DESCRIPTION,
      },
    });
    const snapshot = [
      {
        id: AGENT_ID,
        type: 'subagent',
        status: 'running',
        agent_type: 'Explore',
        description: DESCRIPTION,
      },
    ];
    await hooks.fire('SubagentStart', {
      agent_id: AGENT_ID,
      agent_type: 'Explore',
      background_tasks: snapshot,
    });
    await hooks.fire('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: COMMAND },
      tool_use_id: 'toolu_e2e_child',
      agent_id: AGENT_ID,
      agent_type: 'Explore',
      permission_mode: 'default',
    });
  }

  test('тулбар открывает панель Agents, экран агента показывает задание, шаги и итог, «All agents» возвращает список', async () => {
    const { window, hooks, errors } = await open(1400, 900);
    await launchAgent(hooks);
    const chat = window.getByTestId('chat-view');
    await chat.getByTestId('chat-agents-running').click();

    const tab = window.getByRole('tab', { name: 'Agents' });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const panel = window.getByTestId('agents-panel');
    const row = panel.getByTestId('agents-row-running');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(DESCRIPTION.slice(0, 40));
    await expect(row).toContainText(COMMAND.slice(0, 30));

    await row.click();
    const detail = window.getByTestId('agent-detail');
    await expect(detail).toBeVisible();
    await detail.getByRole('button', { name: 'Show all' }).click();
    await expect(detail).toContainText('Step 30');
    await expect(detail).toContainText(COMMAND.slice(0, 30));

    await hooks.fire('SubagentStop', {
      agent_id: AGENT_ID,
      agent_type: 'Explore',
      last_assistant_message: 'Done: 3 places',
      agent_transcript_path: path.join(project, 'subagents', `agent-${AGENT_ID}.jsonl`),
      stop_hook_active: false,
    });
    await expect(detail.getByRole('heading', { name: 'Result' })).toBeVisible();
    await expect(detail).toContainText('Done: 3 places');
    await expect(detail).toBeVisible();

    await detail.getByRole('button', { name: 'All agents' }).click();
    await expect(window.getByTestId('agent-detail')).toHaveCount(0);
    await window.getByRole('button', { name: 'Finished (1)' }).click();
    await expect(window.getByTestId('agents-row-finished')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('бейдж агентов в сайдбаре: строка поповера открывает экран этого агента во вкладке Agents', async () => {
    const { window, ref, hooks, errors } = await open(1400, 900);
    await launchAgent(hooks);
    const badge = window
      .locator(`[data-session-id="${ref.sessionId}"]`)
      .getByTestId('agents-badge');
    await expect(badge).toHaveText('1 agent', { timeout: 20_000 });
    await badge.click();
    await window.getByTestId('agents-popover').getByTestId('agents-popover-row').click();
    await expect(window.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(window.getByTestId('agent-detail')).toBeVisible();
    await expect(window.getByTestId('agent-detail')).toContainText(DESCRIPTION.slice(0, 40));
    expect(errors).toEqual([]);
  });

  for (const closeLeft of [false, true]) {
    test(`раскладка 800×500 с длинными значениями, левый сайдбар ${closeLeft ? 'закрыт' : 'открыт'}: ничего не вылезает за край`, async () => {
      const { window, hooks, errors } = await open(800, 500);
      if (closeLeft) await window.keyboard.press('Meta+B');
      await launchAgent(hooks);
      const chat = window.getByTestId('chat-view');
      await expect(chat.getByTestId('chat-agents-running')).toBeVisible();
      await chat.getByTestId('chat-agents-running').click();
      const sidebar = window.getByTestId('right-sidebar');
      if ((await sidebar.count()) === 0) {
        // Места нет — прежнее поведение: прокрутка ленты к карточке агента, сайдбара нет.
        await expect(window.getByTestId('chat-agent')).toBeVisible();
        await shot(window, `no-room-800x500-left-${closeLeft ? 'closed' : 'open'}`);
        expect(errors).toEqual([]);
        return;
      }
      await expect(window.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const fits = async (name: string): Promise<void> => {
        const edge = (await boxOf(sidebar)).x + (await boxOf(sidebar)).width;
        const root = window.getByTestId(name);
        expect(
          await root.evaluate((element) => element.scrollWidth <= element.clientWidth),
          `${name}: scrollWidth`,
        ).toBe(true);
        const rows = await root.locator('button, section, header, li, p').all();
        for (const item of rows) {
          const box = await item.boundingBox();
          if (box !== null)
            expect(box.x + box.width, `${name}: край элемента`).toBeLessThanOrEqual(edge + 0.5);
        }
      };
      await expect(window.getByTestId('agents-row-running')).toHaveCount(1);
      await fits('agents-panel');
      await shot(window, `list-800x500-left-${closeLeft ? 'closed' : 'open'}`);
      await window.getByTestId('agents-row-running').click();
      await expect(window.getByTestId('agent-detail')).toBeVisible();
      await window.getByTestId('agent-detail').getByRole('button', { name: 'Show all' }).click();
      await fits('agent-detail');
      await shot(window, `detail-800x500-left-${closeLeft ? 'closed' : 'open'}`);
      expect(errors).toEqual([]);
    });
  }
});
