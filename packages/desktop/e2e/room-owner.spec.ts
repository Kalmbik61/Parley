import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stop-app.js';
import { stopHost } from './stop-host.js';
import { readStoredMapE2E } from './stored-map.js';
import { makeTempHome, makeTempProject } from './tmp.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.resolve(dirname, '../out/main/index.js');
const stubAgent = path.resolve(dirname, 'stub-echo-agent.mjs');
async function call<T>(window: Page, method: string, params: unknown): Promise<T> {
  return window.evaluate(([m, p]) => (globalThis as unknown as {
    parley: { call(m: string, p: unknown): Promise<unknown> };
  }).parley.call(m, p), [method, params] as const) as Promise<T>;
}

test('room owners persist across restart and preserve rooms, leads and working membership', async () => {
  test.setTimeout(120_000);
  const home = await makeTempHome('room-owner');
  const project = await makeTempProject('room-owner');
  let app: ElectronApplication | null = null;
  const launch = async (): Promise<Page> => {
    app = await electron.launch({ args: [mainEntry], env: {
      ...process.env, PARLEY_HOME: home, PARLEY_CLAUDE_BIN: stubAgent, PARLEY_TERMINAL_RENDERER: 'dom',
    } });
    return app.firstWindow();
  };
  try {
    let window = await launch();
    await expect(window.getByTestId('landing')).toBeVisible();
    const { workId } = await call<{ workId: string }>(window, 'works.create', { projectPath: project, title: 'Room ownership test', goal: '' });
    const ids: string[] = [];
    for (const label of ['Coordinator', 'Builder A', 'Builder B', 'Builder C']) {
      const { ref } = await call<{ ref: { sessionId: string } }>(window, 'sessions.create', {
        projectPath: project, workId, provider: 'claude', label, task: '', parent: null,
      });
      ids.push(ref.sessionId);
    }
    const roomIds: string[] = [];
    for (const [index, title] of ['room1', 'room4', 'Подготовка'].entries()) {
      const { roomId } = await call<{ roomId: string }>(window, 'rooms.create', {
        projectPath: project, workId, title, members: [ids[index + 1]], lead: ids[index + 1], quiet: true,
      });
      roomIds.push(roomId);
      const row = window.locator(`[data-room-row="${roomId}"]`);
      await expect(row).toHaveCount(1);
      await row.click({ button: 'right' });
      await window.locator('[data-room-action="owner"]').hover();
      await window.locator(`[data-room-owner="${ids[0]}"]`).click();
      await expect(row.locator('[data-tree-guide="elbow"]')).toHaveCount(1);
    }
    await window.screenshot({ path: test.info().outputPath('room-owners.png') });
    const mapOf = async () => readStoredMapE2E(home, project, workId);
    await expect.poll(async () => (await mapOf()).rooms.map((room) => room.ownerId)).toEqual([ids[0], ids[0], ids[0]]);
    const before = await mapOf();
    expect(before.rooms.map((room) => room.members)).toEqual([[ids[1]], [ids[2]], [ids[3]]]);
    expect(before.rooms.map((room) => room.lead)).toEqual([ids[1], ids[2], ids[3]]);
    await stopApp(app);
    app = null;
    await stopHost(home);
    window = await launch();
    for (const roomId of roomIds) {
      const row = window.locator(`[data-room-row="${roomId}"]`);
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-tree-guide="elbow"]')).toHaveCount(1);
    }
    expect(await mapOf()).toMatchObject({ rooms: before.rooms, messages: before.messages });
    const first = window.locator(`[data-room-row="${roomIds[0]}"]`);
    await first.click({ button: 'right' });
    await window.locator('[data-room-action="owner"]').hover();
    await window.locator('[data-room-owner="clear"]').click();
    await expect(first.locator('[data-tree-guide="elbow"]')).toHaveCount(0);
    await expect.poll(async () => (await mapOf()).rooms[0]?.ownerId).toBeNull();
  } finally {
    await stopApp(app);
    await stopHost(home);
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
