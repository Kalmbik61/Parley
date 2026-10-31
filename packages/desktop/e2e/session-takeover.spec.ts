import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { makeTempHome, makeTempProject } from './tmp.js';
import { readStoredMapE2E, replaceStoredMapE2E, withoutLettersE2E } from './stored-map.js';
import { seedTrust } from './trust-seed.js';

/**
 * Замена агента сессии на другого провайдера (спека 2026-10-30, разделы 5.7 и 7): ведущий комнаты с ребёнком (заглушка
 * Claude) упирается в лимит (хук `StopFailure` с `rate_limit`, как в `stuck-sessions.spec.ts`) — баннер «Out of … usage»
 * над полем ввода → «Continue on another provider…» → диалог → Codex-заглушка. Карта: та же сессия, те же комнаты и
 * ребёнок, одна запись `previousAgents`; новый процесс получил пакет передачи; ведущему ушло письмо `parley`
 * «… continues on …»; в ленте чата — разделитель «Continued on …».
 */

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubClaude = path.resolve(dirname, 'stub-echo-agent.mjs');
const stubCodex = path.resolve(dirname, 'stub-codex-agent.mjs');
const SESSION_LIMIT = "You've hit your session limit";

interface Ref {
  projectPath: string;
  workId: string;
  sessionId: string;
}

let project = '';
let home = '';

async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(
    ([m, p]) => (globalThis as unknown as { parley: { call: (m: string, p: unknown) => Promise<unknown> } }).parley.call(m, p),
    [method, params] as const,
  ) as Promise<T>;
}

async function typeLine(window: Page, ref: Ref, line: string): Promise<void> {
  await window.evaluate(
    ([target, data]) => (globalThis as unknown as { parley: { notify: (method: string, params: unknown) => void } }).parley.notify('pty.input', { ref: target, data }),
    [ref, `${line}\r`] as const,
  );
}

async function stubUp(workId: string, sessionId: string): Promise<boolean> {
  const journal = path.join(project, '.parley', 'works', workId, 'events', `${sessionId}.jsonl`);
  return (await readFile(journal, 'utf8').catch(() => '')).includes('StubReady');
}

const mapOf = (workId: string) => readStoredMapE2E(home, project, workId);

test.describe('замена агента сессии (спека 2026-10-30, раздел 7)', () => {
  test.beforeEach(async () => {
    home = await makeTempHome('session-takeover');
    project = await makeTempProject('session-takeover');
  });

  test.afterEach(async () => {
    await stopApp(null);
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  test('лимит ведущего → баннер → диалог → Codex: пакет передачи, те же комнаты и ребёнок, письмо, разделитель', async () => {
    test.setTimeout(150_000);
    const codexRoot = path.join(home, 'codex-sessions');
    await mkdir(codexRoot, { recursive: true });
    await seedTrust(home, project);
    const app = await electron.launch({
      args: [mainEntry],
      env: {
        ...process.env,
        PARLEY_HOME: home,
        PARLEY_CLAUDE_BIN: stubClaude,
        PARLEY_CODEX_BIN: stubCodex,
        PARLEY_GLM_BIN: path.join(home, 'no-glm'),
        PARLEY_SKIP_VERSION_PROBE: '',
        PARLEY_TERMINAL_RENDERER: 'dom',
        PARLEY_NOTIFICATIONS: 'log',
        PARLEY_CODEX_SESSIONS_DIR: codexRoot,
        STUB_CODEX_SESSIONS: codexRoot,
        STUB_CODEX_VERSION: '0.160.0',
        STUB_BRACKETED: '1',
        STUB_MCP_LOG: path.join(home, 'mcp.jsonl'),
        PARLEY_STUCK_REPORT_MS: '1000',
        PARLEY_LIMIT_RETRY_MS: '600000',
        STUB_ARGV_LOG: path.join(home, 'argv.jsonl'),
      },
    });
    try {
      const window = await app.firstWindow();
      const errors: string[] = [];
      window.on('pageerror', (error) => errors.push(error.message));
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1400, height: 900 }));
      await expect(window.getByTestId('landing')).toBeVisible();

      const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'Takeover work', goal: '' });
      const create = async (label: string): Promise<string> =>
        (await call<{ ref: { sessionId: string } }>(window, 'sessions.create', { projectPath: project, workId, provider: 'claude', label, task: '', parent: null })).ref.sessionId;
      const leadId = await create('Release lead');
      const peerId = await create('Peer');
      const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
        projectPath: project, workId, title: 'Takeover room', members: [peerId, leadId], lead: peerId, quiet: true,
      });
      const lead: Ref = { projectPath: project, workId, sessionId: leadId };
      await expect.poll(() => stubUp(workId, leadId), { timeout: 30_000 }).toBe(true);

      // Ребёнка создаёт сам ведущий (`create_session`): у окна родителя нет.
      await typeLine(window, lead, `STUB_MCP create_session ${JSON.stringify({ provider: 'claude', label: 'Lead child', task: 'wait' })}`);
      await expect
        .poll(async () => mapOf(workId).sessions.find((s) => s.createdBy === leadId)?.id ?? null, { timeout: 30_000 })
        .not.toBeNull();
      const childId = mapOf(workId).sessions.find((s) => s.createdBy === leadId)!.id;
      // `create_session` ребёнка не делает (`createdBy`, не `parent`), а у окна родителя нет: ребёнком его назначает запись в базу.
      const seeded = mapOf(workId);
      seeded.sessions.find((s) => s.id === childId)!.parent = leadId;
      replaceStoredMapE2E(home, project, workId, withoutLettersE2E(seeded));

      // Лимит: хук от имени ведущего.
      await typeLine(window, lead, `STUB_HOOK ${JSON.stringify({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: SESSION_LIMIT })}`);

      // Вкладка ведущего открыта чатом (проба версий включена) — над полем ввода баннер лимита.
      await app.evaluate(({ BrowserWindow }, target) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('app:focus-target', target);
      }, { kind: 'session', ref: lead });
      const banner = window.getByTestId('chat-switch-banner');
      await expect(banner).toContainText(/^Out of .* usage/, { timeout: 20_000 });
      await window.getByTestId('chat-switch-open').click();

      const dialog = window.getByRole('dialog', { name: 'Continue on another provider', exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-switch-keeps]')).toContainText('1 child session');
      await dialog.getByRole('radio', { name: /Codex/ }).click();
      await expect(dialog.getByRole('radio', { name: /Codex/ })).toHaveAttribute('aria-checked', 'true');
      await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      // Карта: та же сессия, другой провайдер, комнаты и ребёнок на месте, одна запись previousAgents.
      await expect
        .poll(async () => mapOf(workId).sessions.find((s) => s.id === leadId)?.provider, { timeout: 30_000 })
        .toBe('codex');
      const map = await mapOf(workId);
      const switched = map.sessions.find((s) => s.id === leadId)!;
      expect(switched.previousAgents).toHaveLength(1);
      expect(map.sessions.find((s) => s.id === childId)?.parent).toBe(leadId);
      const room = map.rooms.find((r) => r.id === roomId)!;
      expect(room.lead ?? room.members[0]).toBe(peerId);
      expect(room.members).toContain(leadId);
      // Письмо Parley ведущему комнаты (соседу) и строка ленты о продолжении.
      await expect
        .poll(() => mapOf(workId).messages.some((m) => m.from === 'parley' && m.to.includes(peerId) && /continues on/.test(m.text)))
        .toBe(true);

      // Новый процесс (Codex) получил пакет передачи первым сообщением: последний аргумент запуска.
      const handoverOf = async (): Promise<string | null> => {
        const lines = (await readFile(path.join(home, 'argv.jsonl'), 'utf8').catch(() => '')).split('\n').filter((l) => l !== '');
        const launches = lines.map((l) => JSON.parse(l) as { argv: string[]; env: Record<string, string> });
        const codex = launches.filter((l) => Object.values(l.env).includes(leadId) && l.argv.includes('--no-daemon'));
        return codex.at(-1)?.argv.at(-1) ?? null;
      };
      await expect.poll(handoverOf, { timeout: 30_000 }).toContain(`You continue session ${leadId}`);
      expect(await handoverOf()).toContain('previous agent (Claude Code)');

      // Разделитель в ленте чата.
      await expect(window.getByTestId('chat-switch-divider').first()).toContainText(/^Continued on /, { timeout: 20_000 });
      // Лимит прежнего агента к новому не переходит: журнал хуков общий у сессии, но его строки — прошлого процесса.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const settled = await mapOf(workId);
      expect(settled.sessions.find((s) => s.id === leadId)?.stuck ?? null).toBeNull();
      expect(settled.messages.some((m) => /hit its Codex usage limit/.test(m.text))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await stopApp(app);
    }
  });
});
