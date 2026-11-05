import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoom, addSession, createWork, deleteWorkFiles, renameWork, resolveProposal, setProposal, submitPlanItem, updateMap, updatePlanItem } from '@parley/core';
import type { PlanDraft } from '@parley/core';
import { needsYouItems, needsYouWorkOfMap } from '@parley/core/attention';
import { COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE } from '@parley/protocol';
import type { WorksSnapshot } from '@parley/protocol';
import { projectWorksSnapshot } from '@parley/protocol/remote';
import type { Client } from '../client.js';
import type { HostContext, RequestInfo } from '../context.js';
import { worksList } from '../methods/works.js';
import { createWorksService } from './works-service.js';
import type { WorksService, WorksServiceOptions } from './works-service.js';

let home = '';
let project = '';
let services: WorksService[] = [];
let clients: FakeClient[] = [];
let warnings: Array<{ message: string; details: unknown }> = [];

interface FakeClient extends Client {
  sent: Array<{ event?: string; data?: unknown }>;
}

function fakeClient(features: string[], role?: 'remote'): FakeClient {
  const sent: FakeClient['sent'] = [];
  const client: FakeClient = {
    id: randomUUID(),
    name: role ?? 'window',
    features: new Set(features),
    ...(role === undefined ? {} : { role }),
    sent,
    send(message) {
      sent.push(message as { event?: string; data?: unknown });
      return true;
    },
    writableLength: () => 0,
    close() {},
  };
  clients.push(client);
  return client;
}

function fakeHost(): HostContext {
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: () => {}, warn: (message, details) => warnings.push({ message, details }), error: () => {} },
    clients: () => clients,
    liveSessions: () => 0,
    broadcast: (event, data, only) => {
      for (const client of clients.filter((candidate) => only === undefined || only(candidate))) client.send({ event, data });
    },
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

function service(options: WorksServiceOptions = {}): WorksService {
  const created = createWorksService(fakeHost(), { debounceMs: 5, ...options });
  services.push(created);
  return created;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  process.env.PARLEY_HOME = home;
  clients = [];
  warnings = [];
});

afterEach(async () => {
  await Promise.all(services.map((s) => s.stop()));
  services = [];
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const CAP = 5 * 1024 * 1024;
const AT = '2026-11-05T10:00:00.000Z';
const long = (seed: string, size: number): string => `${seed} `.padEnd(size, 'ж');

const draft = (owners: string[]): PlanDraft => ({
  mode: 'checklist',
  goal: long('цель плана', 2_000),
  items: owners.map((owner, at) => ({ id: at + 1, title: `пункт ${at + 1}`, owner, scope: long('scope', 1_000) })),
});

/**
 * Работа, как у живого лида: сессии с длинной задачей, сводкой, историей и артефактами; принятый план с журналом и
 * доказательствами; второе решение с планом внутри, которого человек ещё не принял; прямое письмо человеку.
 */
async function seedHeavyWork(title: string, sessionCount: number): Promise<string> {
  const map = await createWork(project, { title, goal: long('цель работы', 8_000) });
  await updateMap(project, map.work.id, (current, letters) => {
    for (let i = 0; i < sessionCount; i += 1) {
      const session = addSession(current, { provider: 'claude', label: `агент ${i}`, task: long(`задача ${i}`, 12_000) }, AT);
      session.summary = long(`сводка ${i}`, 12_000);
      session.history = Array.from({ length: 150 }, (_, n) => ({ event: n % 2 === 0 ? 'active' : 'pending', at: AT }));
      session.artifacts = Array.from({ length: 60 }, (_, n) => ({ kind: 'report', path: `docs/reports/${i}/${n}-${'x'.repeat(80)}.md` }));
      session.contextFrom = current.sessions.slice(0, -1).map((other) => other.id);
    }
    const owners = current.sessions.slice(1, 6).map((session) => session.id);
    const members = current.sessions.map((session) => session.id);
    addRoom(current, { title: 'План', creator: 'human', members, lead: 's-01', mode: 'checklist' }, AT);
    addRoom(current, { title: 'Второй план', creator: 'human', members, lead: 's-01', mode: 'checklist' }, AT);
    const proposal = setProposal(current, 'r-01', 's-01', 'Решение', AT, { plan: draft(owners) });
    const plan = current.rooms[0]!.proposal!.plan!;
    resolveProposal(current, letters, 'r-01', proposal.proposalId, 'accept', { rev: proposal.rev, planId: plan.id, planRev: plan.rev }, AT);
    owners.forEach((owner, at) => {
      updatePlanItem(current, plan.id, 0, at + 1, owner, 'in_progress', long(`заметка ${at}`, 3_000), AT);
      submitPlanItem(current, letters, plan.id, 0, at + 1, owner, { text: long(`доказательство ${at}`, 3_000), artifacts: [] }, AT);
    });
    setProposal(current, 'r-02', 's-01', 'Ещё решение', AT, { plan: draft(owners) });
    letters.add({ kind: 'note', from: 's-01', to: ['human'], roomId: null, text: 'письмо человеку' });
  });
  return map.work.id;
}

const labels = (snapshot: WorksSnapshot) =>
  snapshot.entries.map((entry) => ({
    sessions: entry.map.sessions.map((session) => session.label),
    rooms: entry.map.rooms.map((room) => room.title),
  }));

const needsYou = (snapshot: WorksSnapshot) =>
  needsYouItems(snapshot.entries.map((entry) => needsYouWorkOfMap(entry.projectPath, entry.map)), () => null);

describe('снимок для моста телефона (b-024)', () => {
  it('большая карта: телефон видит то же, что из снимка без писем, а кадр в разы меньше', async () => {
    for (const title of ['А', 'Б', 'В', 'Г']) await seedHeavyWork(title, 12);
    const s = service();
    await s.start();

    const mail = s.mailSnapshot() as WorksSnapshot;
    const remote = s.remoteSnapshot() as WorksSnapshot;
    expect(mail).not.toBeNull();
    expect(remote).not.toBeNull();

    // Все три читателя моста получают из ужатого снимка ровно то же, что из снимка без писем.
    expect(projectWorksSnapshot(remote)).toEqual(projectWorksSnapshot(mail));
    expect(needsYou(remote)).toEqual(needsYou(mail));
    expect(needsYou(mail).length).toBeGreaterThan(0);
    expect(labels(remote)).toEqual(labels(mail));
    // Решение с планом внутри: проекция читает личность плана, и она та же.
    expect(projectWorksSnapshot(remote).works[0]?.rooms[1]?.proposal).toMatchObject({ planId: 'pl-02', planRev: 0 });
    expect(remote.entries[0]?.map.rooms[1]?.proposal).not.toHaveProperty('plan');
    // Версии работ и номер рассылки — как у снимка без писем: по ним мост сверяет события rooms.mail.
    expect(remote.revision).toBe(mail.revision);
    expect(remote.entries.map((entry) => entry.version)).toEqual(mail.entries.map((entry) => entry.version));

    const before = bytes(mail);
    const after = bytes(remote);
    console.info(`b-024 synthetic map: mail ${before} B, remote ${after} B (${((after / before) * 100).toFixed(1)} %)`);
    expect(after).toBeLessThanOrEqual(before * 0.25);
    expect(after).toBeLessThan(CAP * 0.5);
  });

  it('мост получает ужатый снимок в works.changed и works.list, окно с rooms-mail — прежний снимок без писем', async () => {
    await seedHeavyWork('А', 3);
    const bridge = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE], 'remote');
    const window = fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE]);
    const s = service();
    await s.start();

    const changed = (client: FakeClient) => client.sent.filter((message) => message.event === 'works.changed').at(-1)?.data as WorksSnapshot;
    await vi.waitFor(() => expect(changed(bridge)).toBeDefined());
    await vi.waitFor(() => expect(changed(window)).toBeDefined());

    expect(changed(bridge)).toEqual(s.remoteSnapshot());
    expect(changed(bridge).entries[0]?.map.sessions[0]?.task).toBe('');
    expect(changed(window)).toEqual(s.mailSnapshot());
    expect(changed(window).entries[0]?.map.sessions[0]?.task).not.toBe('');
    expect(changed(window).entries[0]?.map.plans).toHaveLength(1);

    const list = worksList(s);
    const request = (client: Client) => ({ client, host: fakeHost() }) as RequestInfo;
    expect(await list({}, request(bridge))).toEqual(s.remoteSnapshot());
    expect(await list({}, request(window))).toEqual(s.mailSnapshot());

    // Снимок без писем окну — байт в байт тот же, что у хоста без моста.
    clients = [];
    const alone = service();
    await alone.start();
    expect(JSON.stringify(alone.mailSnapshot()?.entries)).toBe(JSON.stringify(changed(window).entries));
  });

  it('у потолка: предупреждение в журнал один раз на пересечение порога', async () => {
    const first = await seedHeavyWork('А', 2);
    fakeClient([COMPACT_WORKS_FEATURE, ROOMS_MAIL_FEATURE], 'remote');
    const probe = service();
    await probe.start();
    const base = bytes(probe.remoteSnapshot());
    await probe.stop();

    const s = service({ remoteWarnBytes: base + 4_000 });
    await s.start();
    const near = () => warnings.filter((warning) => warning.message.includes('снимок для моста'));
    const works = () => s.remoteSnapshot()?.entries.length;
    expect(near()).toHaveLength(0);
    // Наблюдатель базы оживает не мгновенно: запись сразу после старта он мог бы не заметить.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await seedHeavyWork('Б', 12);
    await vi.waitFor(() => expect(works()).toBe(2), { timeout: 10_000, interval: 10 });
    expect(near()).toHaveLength(1);
    expect(near()[0]?.details).toMatchObject({ cap: CAP, bytes: expect.any(Number), percent: expect.any(Number) });

    // Выше порога и дальше — без нового предупреждения.
    await renameWork(project, first, 'А2');
    await vi.waitFor(() => expect(s.remoteSnapshot()?.entries.find((entry) => entry.map.work.id === first)?.map.work.title).toBe('А2'), { timeout: 10_000, interval: 10 });
    expect(near()).toHaveLength(1);

    // Ниже порога, потом снова выше — второе предупреждение.
    await deleteWorkFiles(project, second);
    await vi.waitFor(() => expect(works()).toBe(1), { timeout: 10_000, interval: 10 });
    expect(near()).toHaveLength(1);
    await seedHeavyWork('В', 12);
    await vi.waitFor(() => expect(works()).toBe(2), { timeout: 10_000, interval: 10 });
    expect(near()).toHaveLength(2);
  });
});
