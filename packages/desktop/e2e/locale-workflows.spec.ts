import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';
import { seedTrust } from './trust-seed.js';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const claude = fileURLToPath(new URL('./stub-echo-agent.mjs', import.meta.url));
const codex = fileURLToPath(new URL('./stub-codex-agent.mjs', import.meta.url));
const workTitle = 'Отчёт Alpha';
const sessionName = 'Original Иван';
const roomTitle = 'Room Бета';
const planText = 'Plan: keep исходный текст.';
const itemTitle = 'Check the исходник';

interface WorkEntry {
  projectPath: string;
  map: {
    work: { id: string; title: string };
    sessions: Array<{ id: string; label: string }>;
    rooms: Array<{ id: string; title: string; lead: string | null; members: string[]; mode: string }>;
    plans?: Array<{ status: string; mode: string }>;
  };
}

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([name, args]) => {
    const bridge = (globalThis as unknown as { parley: { call(method: string, params: unknown): Promise<unknown> } }).parley;
    return bridge.call(name, args);
  }, [method, params] as const) as Promise<T>;
}

const cases = [
  {
    locale: 'en', newWorkIn: /^New workspace in /, newWork: 'New workspace', title: 'Title',
    createWork: 'Create workspace', titleRequired: 'Enter a title', newSession: 'New session',
    sessionName: 'Session name', startSession: 'Start session', chat: 'Chat', terminal: 'Terminal',
    chatEmpty: 'Nothing here yet', chatInput: 'Message to Claude', addAgent: 'Add agent',
    newRoom: 'New room', roomName: 'Room name', mode: 'Mode', checklist: 'Checklist', createRoom: 'Create room',
    roomEmpty: 'Write the task for everyone below. The lead collects positions and brings you a decision.',
    proposed: 'Proposed plan', accept: 'Accept', plan: 'Plan', ready: 'Ready', evidence: 'Mark done',
  },
  {
    locale: 'ru', newWorkIn: /^Новая работа в проекте /, newWork: 'Новая работа', title: 'Название',
    createWork: 'Создать работу', titleRequired: 'Введите название', newSession: 'Новая сессия',
    sessionName: 'Название сессии', startSession: 'Запустить сессию', chat: 'Чат', terminal: 'Терминал',
    chatEmpty: 'Здесь пока ничего нет', chatInput: 'Сообщение для Claude', addAgent: 'Добавить агента',
    newRoom: 'Новая комната', roomName: 'Название комнаты', mode: 'Режим', checklist: 'Чек-лист', createRoom: 'Создать комнату',
    roomEmpty: 'Напишите ниже задачу для всех. Ведущий соберёт мнения и предложит вам решение.',
    proposed: 'Предложенный план', accept: 'Принять', plan: 'План', ready: 'Можно начать', evidence: 'Отметить выполненной',
  },
] as const;

for (const labels of cases) {
  test(`${labels.locale}: create workspace, session and room, read chat and accept a plan`, async () => {
    const testInfo = test.info();
    test.setTimeout(90_000);
    const home = await makeTempHome('locale-workflows');
    const projectPath = await makeTempProject('locale-workflows');
    let app: ElectronApplication | null = null;

    try {
      await seedTrust(home, projectPath);
      const ui = path.join(home, 'desktop');
      await mkdir(ui, { recursive: true });
      await writeFile(path.join(ui, 'ui.json'), JSON.stringify({ version: 1, locale: labels.locale, appearance: 'light' }));
      app = await electron.launch({
        args: [mainEntry],
        env: {
          ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: claude, PARLEY_CODEX_BIN: codex,
          PARLEY_GLM_BIN: path.join(home, 'no-glm'), PARLEY_SKIP_VERSION_PROBE: '', PARLEY_TERMINAL_RENDERER: 'dom',
        },
      });
      const window = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 780));
      await expect(window.locator('html')).toHaveAttribute('lang', labels.locale);
      await expect(window.getByTestId('landing')).toBeVisible();
      await call(window, 'wake.pause', {});
      await call(window, 'works.create', { projectPath, title: 'Seed', goal: '' });

      await window.getByRole('button', { name: labels.newWorkIn }).click();
      const workDialog = window.getByRole('dialog', { name: labels.newWork });
      const createWork = workDialog.getByRole('button', { name: labels.createWork, exact: true });
      await createWork.click();
      await expect(workDialog.getByText(labels.titleRequired, { exact: true })).toBeVisible();
      await workDialog.getByRole('textbox', { name: labels.title, exact: false }).fill(workTitle);
      await createWork.click();
      await expect(workDialog).toBeHidden({ timeout: 15_000 });

      const readWork = async () => {
        const { entries } = await call<{ entries: WorkEntry[] }>(window, 'works.list', {});
        return entries.find((entry) => entry.projectPath === projectPath && entry.map.work.title === workTitle)?.map;
      };
      await expect.poll(async () => (await readWork())?.work.id).toBeTruthy();
      const workId = (await readWork())!.work.id;
      await window.getByRole('treeitem').filter({ has: window.getByText(workTitle, { exact: true }) })
        .locator('[data-work-title]').click();

      await window.keyboard.press('Meta+T');
      const sessionDialog = window.getByRole('dialog', { name: labels.newSession });
      await sessionDialog.getByRole('textbox', { name: labels.sessionName }).fill(sessionName);
      await sessionDialog.getByRole('button', { name: labels.startSession, exact: true }).click();
      await expect(sessionDialog).toBeHidden({ timeout: 15_000 });
      await expect.poll(async () => (await readWork())?.sessions[0]?.label).toBe(sessionName);
      const sessionId = (await readWork())!.sessions[0]!.id;
      await window.locator(`[data-session-id="${sessionId}"]`).click();
      await window.getByRole('radio', { name: labels.chat, exact: true }).click();
      await expect(window.getByTestId('chat-view').getByText(labels.chatEmpty)).toBeVisible();
      await expect(window.getByRole('textbox', { name: labels.chatInput })).toBeVisible();
      await window.getByRole('radio', { name: labels.terminal, exact: true }).click();

      await window.keyboard.press('Meta+T');
      await window.getByRole('dialog').getByRole('button', { name: labels.addAgent }).click();
      const roomDialog = window.getByRole('dialog', { name: labels.newRoom });
      await roomDialog.getByRole('textbox', { name: labels.roomName }).fill(roomTitle);
      await roomDialog.getByRole('combobox', { name: labels.mode, exact: true }).click();
      await window.getByRole('option', { name: labels.checklist, exact: true }).click();
      await roomDialog.getByRole('button', { name: labels.createRoom, exact: true }).click();
      await expect(roomDialog).toBeHidden({ timeout: 20_000 });
      await expect.poll(async () => (await readWork())?.rooms[0]?.title).toBe(roomTitle);
      const room = (await readWork())!.rooms[0]!;
      expect(room.mode).toBe('checklist');
      expect(room.members).toHaveLength(2);
      expect(room.lead).toBeTruthy();
      const panel = window.locator('[data-room-panel]');
      await expect(panel.getByText(labels.roomEmpty)).toBeVisible();

      const ref = { projectPath, workId, sessionId: room.lead! };
      const plan = {
        mode: 'checklist', goal: 'Keep authored content as written',
        items: [{ id: 1, title: itemTitle, scope: 'Desktop only', owner: room.members.find((id) => id !== room.lead)! }],
      };
      const data = 'STUB_MCP propose_decision ' + JSON.stringify({ room: room.id, text: planText, plan }) + '\r';
      await window.evaluate(({ ref, data }) => {
        (globalThis as unknown as { parley: { notify(method: string, params: unknown): void } }).parley.notify('pty.input', { ref, data });
      }, { ref, data });

      const proposal = panel.locator('[data-proposal-id]');
      await expect(proposal.getByRole('heading', { name: labels.proposed, exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(proposal.getByText(`1. ${itemTitle}`, { exact: true })).toBeVisible();
      await expect(proposal.getByText(planText, { exact: true })).toBeVisible();
      await window.screenshot({ path: testInfo.outputPath(`plan-${labels.locale}.png`), animations: 'disabled' });
      await proposal.getByRole('button', { name: labels.accept, exact: true }).click();
      await expect(proposal).toBeHidden();
      await expect.poll(async () => (await readWork())?.plans?.[0]?.status).toBe('active');

      const planPanel = panel.locator('[data-plan-panel]');
      await expect(planPanel.getByRole('heading', { name: labels.plan, exact: true })).toBeVisible();
      await expect(planPanel.getByText(`1. ${itemTitle}`, { exact: true })).toBeVisible();
      await expect(planPanel.getByText(labels.ready, { exact: true })).toBeVisible();
      await expect(planPanel.getByRole('button', { name: labels.evidence, exact: true })).toBeVisible();
    } finally {
      await stopApp(app);
      await stopHost(home);
      await rm(home, { recursive: true, force: true });
      await rm(projectPath, { recursive: true, force: true });
    }
  });
}
