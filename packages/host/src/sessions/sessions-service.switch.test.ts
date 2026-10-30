/**
 * Замена агента сессии на месте (спека 2026-10-30, 5.2–5.3, 6, 7/host): оркестратор `switchAgent`, `switchOptions` и
 * снятие оборванной замены после перезапуска хоста. PTY — подмена: процесс «живёт», пока его не остановят, и выход
 * идёт обычным событием `exit`, как у настоящего менеджера.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRoom,
  addSession,
  createWork,
  customProviderDir,
  customProvidersFile,
  grantTrust,
  readLetters,
  readMap,
  updateMap,
  writeCustomProviders,
  type CustomProviderRecord,
  type SessionNeed,
  type WorkSession,
} from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { HostContext } from '../context.js';
import type { PtyManager } from '../pty/pty-manager.js';
import type { PtyLaunch } from '../pty/pty-process.js';
import type { WorksService } from '../works/works-service.js';
import { createHeldLaunchActions } from '../consents/held-launches.js';
import { createSessionsService, switchLetter, switchLine } from './sessions-service.js';
import type { SessionsFeedOptions } from './sessions-service.js';

const accountRecord: CustomProviderRecord = { kind: 'claude-account', id: 'custom-claude-2', label: '', link: false };

let home: string;
let project: string;
let workId: string;
let launches: Array<{ ref: SessionRef; launch: PtyLaunch }>;
let notices: Array<{ kind: string; text: string }>;
let events: string[];
const savedEnv = { ...process.env };

/** Подмена PTY: ручка живёт до `stop`, выход — событием `exit`, как у настоящего менеджера. */
function fakePty(): PtyManager {
  const live = new Map<string, { ref: SessionRef; pid: number; provider: string; hasDraft: () => boolean }>();
  const exits: Array<(ref: SessionRef, exit: { exitCode: number; signal?: number }) => void> = [];
  const key = (ref: SessionRef) => `${ref.projectPath}\0${ref.workId}\0${ref.sessionId}`;
  return {
    get: (ref: SessionRef) => live.get(key(ref)),
    on: (event: string, listener: (ref: SessionRef, exit: { exitCode: number }) => void) => {
      if (event === 'exit') exits.push(listener);
      return () => {};
    },
    start: (ref: SessionRef, launch: PtyLaunch) => {
      events.push(`start:${launch.provider}`);
      launches.push({ ref, launch });
      const handle = { ref, pid: process.pid, provider: launch.provider ?? 'claude', hasDraft: () => draft };
      live.set(key(ref), handle);
      return handle;
    },
    stop: async (ref: SessionRef) => {
      events.push('stop');
      live.delete(key(ref));
      for (const listener of exits) listener(ref, { exitCode: 0 });
      return { exitCode: 0 };
    },
    list: () => [...live.values()],
  } as unknown as PtyManager;
}

let draft = false;
let argMax = 1_000_000;
let activityState = 'idle';
let tasks: Array<{ background: boolean }> = [];

/** Расход по окнам лога: что спросили и что отдать. */
let sliced: Array<{ binding: string | null; windows: unknown }> = [];

function fakeActivity(): ActivityService {
  return {
    get: () => ({ activity: { activity: activityState, tasks }, metrics: null }),
    markSeen() {},
    watchClaudeRoot() {},
    usageResolver: () => ({
      whole: () => null,
      bounds: () => null,
      slice: async (session: WorkSession, windows: unknown) => {
        sliced.push({ binding: session.providerSessionId, windows });
        return {
          input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalInput: 100,
          source: 'log-index', observedAt: null, stale: false, completeness: 'complete', coverage: 'conversation',
        };
      },
    }),
  } as unknown as ActivityService;
}

/** Снимок работ из карты на диске: `clearStaleSwitches` идёт по нему. */
function fakeWorks(): WorksService {
  let snapshot: { entries: Array<{ projectPath: string; map: Awaited<ReturnType<typeof readMap>> }> } = { entries: [] };
  return {
    onChange: () => () => {},
    snapshot: () => snapshot,
    entry: () => undefined,
    refresh: async () => {
      snapshot = { entries: [{ projectPath: project, map: await readMap(project, workId) }] };
    },
  } as unknown as WorksService;
}

interface Rig {
  sessions: ReturnType<typeof createSessionsService>;
  pty: PtyManager;
  works: WorksService & { refresh(): Promise<void> };
  handover: ReturnType<typeof vi.fn>;
  endBySwitch: ReturnType<typeof vi.fn>;
  switched: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
}

function rig(options: Partial<SessionsFeedOptions> = {}, signedIn: (id: string) => boolean | null = () => true): Rig {
  const host = {
    log: { info() {}, warn() {}, error() {} },
    broadcast: (_: string, data: unknown) => notices.push(data as { kind: string; text: string }),
  } as unknown as HostContext;
  const pty = fakePty();
  const works = fakeWorks() as WorksService & { refresh(): Promise<void> };
  const handover = vi.fn(async (projectPath: string, work: string, sessionId: string) => {
    // Пакет собирается после остановки прежнего агента и до замены в карте: разговор ещё прежний.
    const session = (await readMap(projectPath, work)).sessions.find((candidate) => candidate.id === sessionId);
    events.push(`handover:${session?.provider}:${session?.lifecycle}:${session?.switching?.id ?? 'none'}`);
    return { text: 'HANDOVER-PACKAGE', tailFile: null };
  });
  const endBySwitch = vi.fn(async () => {
    events.push('endBySwitch');
  });
  const switched = vi.fn(() => {
    events.push('switched');
  });
  let token = 0;
  const register = vi.fn(() => `token-${(token += 1)}`);
  const unregister = vi.fn();
  const sessions = createSessionsService(host, works, pty, fakeActivity(), {
    providerVersions: { ready: Promise.resolve(), get: () => '2.1.314', fresh: async () => '2.1.314' },
    hooks: { url: () => 'http://127.0.0.1:1/hooks', register, unregister },
    signedIn,
    spawnLimits: async () => ({ argMax, pointerSize: 8 }),
    takeover: { handover: handover as never, stuck: { endBySwitch }, wake: () => ({ switched }) },
    ...options,
  });
  return { sessions, pty, works, handover, endBySwitch, switched, register, unregister };
}

const sessionOf = async (ref: SessionRef): Promise<WorkSession> =>
  (await readMap(ref.projectPath, ref.workId)).sessions.find((candidate) => candidate.id === ref.sessionId)!;

/** Живая сессия Claude в комнате с ведущим `s-lead` и письмом от него, на которое она ещё не ответила. */
async function liveClaude(r: Rig): Promise<{ ref: SessionRef; leadId: string; roomId: string }> {
  const ref = await r.sessions.create({ projectPath: project, workId, provider: 'claude', label: 'backend', task: 'do it', parent: null });
  let leadId = '';
  let roomId = '';
  await updateMap(project, workId, (map, letters) => {
    leadId = addSession(map, { provider: 'claude', label: 'lead', task: '' }).id;
    roomId = addRoom(map, { title: 'Room', creator: 'human', members: [leadId, ref.sessionId], lead: leadId }).id;
    letters.add({ roomId, from: leadId, to: [ref.sessionId], text: 'status?', kind: 'question' });
  });
  events.length = 0;
  return { ref, leadId, roomId };
}

const request = (provider: string, extra: Record<string, unknown> = {}) => ({
  requestId: '00000000-0000-4000-8000-000000000001',
  provider,
  ...extra,
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-switch-'));
  project = path.join(home, 'project');
  process.env.PARLEY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'user-claude');
  process.env.PARLEY_CLAUDE_PROJECTS_DIR = path.join(home, 'claude-projects');
  process.env.PARLEY_SKILL_NAVIGATOR = '0';
  const binary = path.join(home, 'agent');
  await writeFile(binary, '#!/bin/sh\necho "2.1.314 (Claude Code)"\n', { mode: 0o755 });
  process.env.PARLEY_CLAUDE_BIN = binary;
  process.env.PARLEY_CODEX_BIN = binary;
  await writeCustomProviders([accountRecord], customProvidersFile(home));
  workId = (await createWork(project, { title: 'test', goal: '' })).work.id;
  launches = [];
  notices = [];
  events = [];
  draft = false;
  sliced = [];
  argMax = 1_000_000;
  activityState = 'idle';
  tasks = [];
});

afterEach(async () => {
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  await rm(home, { recursive: true, force: true });
});

describe('switchAgent: замена агента на месте (спека 5.3)', () => {
  it('порядок: switching → stop → эпизод → пакет → замена → запуск → снятие; id, комнаты и письма на месте', async () => {
    const r = rig();
    const { ref, leadId, roomId } = await liveClaude(r);
    const before = await sessionOf(ref);

    expect(await r.sessions.switchAgent(ref, request('custom-claude-2'))).toEqual({ outcome: 'started', carried: 'handover' });

    expect(events).toEqual([
      'stop',
      'endBySwitch',
      'handover:claude:sleeping:00000000-0000-4000-8000-000000000001',
      'start:custom-claude-2',
      'switched',
    ]);
    const after = await sessionOf(ref);
    expect(after).toMatchObject({ id: ref.sessionId, provider: 'custom-claude-2', lifecycle: 'active', switching: null, stuck: null });
    expect(after.agentRevision).toEqual(expect.any(String));
    expect(after.providerSessionId).not.toBe(before.providerSessionId);
    expect(after.previousAgents).toEqual([
      expect.objectContaining({
        provider: 'claude',
        providerSessionId: before.providerSessionId,
        reason: 'manual',
        requestedBy: 'human',
        carried: 'handover',
        startedAt: before.startedAt,
      }),
    ]);
    // Новый процесс — в папке аккаунта цели, с пакетом передачи первым сообщением.
    const launch = launches.at(-1)!.launch;
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(customProviderDir('custom-claude-2', home));
    expect(launch.args.join('\n')).toContain('HANDOVER-PACKAGE');
    // Токен хуков прежнего запуска снят выходом процесса, у нового — свой.
    expect(r.unregister).toHaveBeenCalledWith(ref);
    expect(r.register).toHaveBeenCalledTimes(2);
    expect(r.register.mock.results.map((result) => result.value)).toEqual(['token-1', 'token-2']);

    const feed = readLetters(project, workId, { roomId, limit: 50 });
    expect(feed.some((message) => message.text === switchLine(ref.sessionId, 'Claude Code 2', null, 'Claude Code', 'manual'))).toBe(true);
    const letter = feed.find((message) => message.from === 'parley' && message.to.includes(leadId));
    expect(letter?.text).toBe(switchLetter(ref.sessionId, 'Claude Code 2', null, 'Claude Code', 'manual'));
    // Привязки сессии не тронуты: та же комната, тот же ведущий.
    const map = await readMap(project, workId);
    expect(map.rooms.find((room) => room.id === roomId)).toMatchObject({ members: [leadId, ref.sessionId], lead: leadId });
  });

  it('цель не готова — отказ до любых изменений: прежний агент жив, карта та же', async () => {
    const r = rig({}, (id) => id !== 'custom-claude-2');
    const { ref } = await liveClaude(r);
    const before = await sessionOf(ref);

    await expect(r.sessions.switchAgent(ref, request('custom-claude-2'))).rejects.toThrow(/is not signed in/);
    await expect(r.sessions.switchAgent(ref, request('nope'))).rejects.toThrow(/unknown provider/);

    expect(events).toEqual([]);
    expect(r.pty.get(ref)).toBeDefined();
    expect(await sessionOf(ref)).toEqual(before);
  });

  it('занятый агент — busy без force; с force — замена; застрявший в лимите — без force', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    activityState = 'working';
    await expect(r.sessions.switchAgent(ref, request('custom-claude-2'))).rejects.toMatchObject({
      code: 'conflict',
      data: { reason: 'busy' },
    });
    activityState = 'idle';
    draft = true;
    await expect(r.sessions.switchAgent(ref, request('custom-claude-2'))).rejects.toThrow(/unsent text/);
    expect((await sessionOf(ref)).switching ?? null).toBeNull();
    // Тот же requestId после отказа — новая попытка, а не запомненный отказ (диалог повторяет его с force).
    expect(await r.sessions.switchAgent(ref, request('custom-claude-2', { force: true }))).toMatchObject({ outcome: 'started' });

    const second = await r.sessions.create({ projectPath: project, workId, provider: 'claude', label: '', task: 'x', parent: null });
    const limit: SessionNeed = { kind: 'limit', since: new Date().toISOString(), detail: null, resetsAt: '2026-10-31T19:27:00.000Z', window: null, account: null } as SessionNeed;
    await updateMap(project, workId, (map) => {
      map.sessions.find((candidate) => candidate.id === second.sessionId)!.stuck = limit;
    });
    activityState = 'working';
    expect(await r.sessions.switchAgent(second, { ...request('custom-claude-2'), requestId: '00000000-0000-4000-8000-000000000002' })).toMatchObject({ outcome: 'started' });
    expect((await sessionOf(second)).previousAgents?.[0]?.reason).toBe('limit');
  });

  it('carry: transcript — понятный отказ «not available yet», ничего не тронуто', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    const before = await sessionOf(ref);
    await expect(r.sessions.switchAgent(ref, request('custom-claude-2', { carry: 'transcript' }))).rejects.toThrow(/not available yet/);
    expect(await sessionOf(ref)).toEqual(before);
    expect(r.pty.get(ref)).toBeDefined();
  });

  it('та же цель, закрытая сессия — отказ блокировками', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    await expect(r.sessions.switchAgent(ref, request('claude'))).rejects.toThrow(/current provider/);
    expect(events).toEqual([]);
  });

  it('повтор requestId идемпотентен: одновременный — тот же исход и один запуск, после успеха — тот же ответ; другой id — busy', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    const first = r.sessions.switchAgent(ref, request('custom-claude-2'));
    const twin = r.sessions.switchAgent(ref, request('custom-claude-2'));
    const other = r.sessions.switchAgent(ref, { ...request('codex'), requestId: '00000000-0000-4000-8000-000000000009' });
    await expect(other).rejects.toMatchObject({ data: { reason: 'busy' } });
    expect(await first).toEqual({ outcome: 'started', carried: 'handover' });
    expect(await twin).toEqual({ outcome: 'started', carried: 'handover' });
    expect(await r.sessions.switchAgent(ref, request('custom-claude-2'))).toEqual({ outcome: 'started', carried: 'handover' });
    expect(launches.filter((entry) => entry.launch.provider === 'custom-claude-2')).toHaveLength(1);
  });

  it('отказ запуска: карта уже с новым провайдером, сессия спит, switching снят, уведомление с Retry и «назад»', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    // Готовность цели прошла, а сам запуск отказал: аргументы процесса не влезают в предел системы.
    argMax = 10;
    await expect(r.sessions.switchAgent(ref, request('codex'))).rejects.toThrow(/spawn/);

    const after = await sessionOf(ref);
    expect(after).toMatchObject({ provider: 'codex', lifecycle: 'sleeping', switching: null, providerSessionId: null });
    expect(after.previousAgents).toHaveLength(1);
    const notice = notices.find((candidate) => candidate.kind === 'launch-failed' && candidate.text.includes('Resume to retry'));
    expect(notice?.text).toContain('continue it on Claude Code again');
    expect(r.switched).not.toHaveBeenCalled();

    // Retry (Resume): новый агент поднимается новым разговором с пакетом, собранным заново, и замена кончается.
    argMax = 1_000_000;
    await r.sessions.launch(ref, 'resume');
    expect(launches.at(-1)?.launch.provider).toBe('codex');
    expect(launches.at(-1)?.launch.args.join('\n')).toContain('HANDOVER-PACKAGE');
  });

  it('Codex ждёт согласия на папку: held, switching остаётся; согласие поднимает с пакетом и снимает, письма ждавшим', async () => {
    const consent = vi.fn();
    const r = rig({ consents: { request: consent } as never });
    const { ref, leadId } = await liveClaude(r);

    expect(await r.sessions.switchAgent(ref, request('codex'))).toEqual({ outcome: 'held', carried: 'handover' });
    expect(consent).toHaveBeenCalledWith(expect.anything(), { ref, mode: 'launch', by: 'human' });
    expect(await sessionOf(ref)).toMatchObject({
      provider: 'codex',
      lifecycle: 'sleeping',
      switching: { id: request('codex').requestId, to: 'codex' },
    });
    expect(r.switched).not.toHaveBeenCalled();
    // Повтор того же запроса — тот же ответ, без второй замены.
    expect(await r.sessions.switchAgent(ref, request('codex'))).toEqual({ outcome: 'held', carried: 'handover' });
    expect((await sessionOf(ref)).previousAgents).toHaveLength(1);

    // Согласие: папка доверена, удержанный запуск продолжается обычным путём (`held-launches` → `launch`).
    await grantTrust(project, 'window');
    const actions = createHeldLaunchActions({
      launch: (target, mode, choice) => r.sessions.launch(target, mode, choice),
      close: (target) => r.sessions.close(target),
      retry: () => {},
    });
    await actions.continueLaunch({ ref, mode: 'launch', by: 'human' });
    const launch = launches.at(-1)!.launch;
    expect(launch.provider).toBe('codex');
    expect(launch.args.join('\n')).toContain('HANDOVER-PACKAGE');
    expect(await sessionOf(ref)).toMatchObject({ provider: 'codex', lifecycle: 'active', switching: null });
    expect(r.switched).toHaveBeenCalledWith(ref);
    const letters = readLetters(project, workId, { from: 'parley', limit: 50 });
    expect(letters.some((message) => message.to.includes(leadId) && message.text.includes('continues on Codex'))).toBe(true);
  });

  it('отказ в согласии на папку не закрывает заменённую сессию: она спит с новым провайдером, switching снят', async () => {
    const r = rig({ consents: { request: vi.fn() } as never });
    const { ref } = await liveClaude(r);
    expect(await r.sessions.switchAgent(ref, request('codex'))).toMatchObject({ outcome: 'held' });
    const close = vi.fn(async () => {});
    const actions = createHeldLaunchActions({ launch: r.sessions.launch, close, retry: () => {} });
    await actions.refuseLaunch({ ref, mode: 'launch', by: 'human' });
    expect(close).not.toHaveBeenCalled();
    expect(await sessionOf(ref)).toMatchObject({ provider: 'codex', lifecycle: 'sleeping', switching: null, result: null });
  });

  it('сессия удалённого провайдера переходит на другой: прежний агент — provider-missing', async () => {
    const r = rig();
    const ref = await r.sessions.create({ projectPath: project, workId, provider: 'custom-claude-2', label: '', task: 'x', parent: null });
    await r.sessions.stop(ref);
    await writeCustomProviders([], customProvidersFile(home));
    events.length = 0;

    expect(await r.sessions.switchAgent(ref, request('claude'))).toMatchObject({ outcome: 'started' });
    const after = await sessionOf(ref);
    expect(after).toMatchObject({ provider: 'claude', lifecycle: 'active', switching: null });
    expect(after.previousAgents?.[0]).toMatchObject({ provider: 'custom-claude-2', reason: 'provider-missing' });
    expect(events).not.toContain('stop');
  });

  it('агент вне Parley (active без нашего PTY): только с force', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    // Хост перезапущен: процесс жив у CLI, нашего PTY нет.
    const other = rig();
    await expect(other.sessions.switchAgent(ref, request('custom-claude-2'))).rejects.toThrow(/outside Parley/);
    expect(await other.sessions.switchAgent(ref, request('custom-claude-2', { force: true }))).toMatchObject({ outcome: 'started' });
    expect(r.pty.get(ref)).toBeDefined();
  });
});

describe('расход закрываемого отрезка (спека 5.9, 6.14)', () => {
  it('снимок — только окно [начало отрезка, замена), второй отрезок начинается концом первого', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    const first = await sessionOf(ref);
    await r.sessions.switchAgent(ref, request('custom-claude-2'));
    const second = await sessionOf(ref);
    const one = second.previousAgents![0]!;
    expect(sliced[0]).toEqual({ binding: first.providerSessionId, windows: [{ from: first.startedAt, to: one.endedAt }] });
    expect(one.usage).toMatchObject({ input: 100, output: 50, binding: first.providerSessionId, closed: true, source: 'frozen-snapshot' });

    await r.sessions.switchAgent(ref, { ...request('claude'), requestId: '00000000-0000-4000-8000-000000000003' });
    const two = (await sessionOf(ref)).previousAgents![1]!;
    expect(two.startedAt).toBe(one.endedAt);
    expect(sliced[1]).toEqual({ binding: second.providerSessionId, windows: [{ from: one.endedAt, to: two.endedAt }] });
  });
});

describe('clearStaleSwitches: замена, оборванная прежним хостом (спека 6, восстановление)', () => {
  it('снимает switching у всех; заменённому агенту — уведомление, а Resume поднимает нового с пакетом', async () => {
    const r = rig();
    const { ref } = await liveClaude(r);
    const plain = await r.sessions.create({ projectPath: project, workId, provider: 'claude', label: '', task: 'y', parent: null });
    await r.sessions.stop(plain);
    await r.sessions.stop(ref);
    // Прежний хост упал: у `plain` — до замены в карте, у `ref` — после неё, но до запуска.
    await updateMap(project, workId, (map) => {
      const since = new Date().toISOString();
      const a = map.sessions.find((candidate) => candidate.id === plain.sessionId)!;
      a.switching = { id: 'old-1', to: 'codex', since };
      const b = map.sessions.find((candidate) => candidate.id === ref.sessionId)!;
      b.switching = { id: 'old-2', to: 'codex', since };
      b.previousAgents = [{
        provider: 'claude', model: null, effort: null, providerSessionId: b.providerSessionId, startedAt: b.startedAt,
        endedAt: since, reason: 'limit', requestedBy: 'human', carried: 'handover',
      }];
      b.provider = 'codex';
      b.providerSessionId = null;
    });
    notices.length = 0;
    const restarted = rig();
    await restarted.works.refresh();
    await restarted.sessions.clearStaleSwitches();

    expect((await sessionOf(plain)).switching).toBeNull();
    expect((await sessionOf(plain)).provider).toBe('claude');
    expect((await sessionOf(ref)).switching).toBeNull();
    expect(notices).toEqual([expect.objectContaining({ kind: 'launch-failed', text: expect.stringContaining('Resume starts it') })]);

    await restarted.sessions.launch(ref, 'resume');
    expect(launches.at(-1)?.launch.provider).toBe('codex');
    expect(launches.at(-1)?.launch.args.join('\n')).toContain('HANDOVER-PACKAGE');
    expect(restarted.handover).toHaveBeenCalled();
  });
});

describe('switchOptions (спека 5.2, 6.10)', () => {
  it('цели, перенос транскрипта только между аккаунтами Claude, подсказка по запасу, что остаётся при сессии', async () => {
    const limits = { fiveHour: { usedPercent: 20, resetsAt: null }, week: null, at: new Date().toISOString() };
    const r = rig({}, () => true);
    const options = createSessionsService(
      { log: { info() {}, warn() {}, error() {} }, broadcast() {} } as unknown as HostContext,
      fakeWorks(),
      fakePty(),
      fakeActivity(),
      {
        providerVersions: { ready: Promise.resolve(), get: () => '2.1.314', fresh: async () => '2.1.314' },
        signedIn: () => true,
        spawnLimits: async () => ({ argMax: 1_000_000, pointerSize: 8 }),
        takeover: {
          alternatives: async () => [{ id: 'custom-claude-2', label: 'Claude Code 2', limits }],
          limits: (id) => (id === 'custom-claude-2' ? limits : null),
        },
      },
    );
    const { ref, leadId, roomId } = await liveClaude(r);
    await updateMap(project, workId, (map) => {
      const child = addSession(map, { provider: 'claude', label: 'child', task: '' });
      child.parent = ref.sessionId;
      map.rooms.find((room) => room.id === roomId)!.ownerId = ref.sessionId;
      map.sessions.find((candidate) => candidate.id === ref.sessionId)!.stuck = {
        kind: 'limit', since: new Date().toISOString(), detail: null, resetsAt: null, window: null, account: null,
      } as SessionNeed;
    });

    const result = await options.switchOptions(ref);
    expect(result.current).toEqual({ provider: 'claude', available: false, reason: 'limit' });
    const byId = new Map(result.targets.map((target) => [target.id, target]));
    expect(byId.has('claude')).toBe(false);
    expect(byId.get('custom-claude-2')).toMatchObject({ available: true, transcript: true, limits, family: 'claude' });
    expect(byId.get('codex')).toMatchObject({ transcript: false });
    expect(byId.get('glm')).toMatchObject({ transcript: false });
    expect(result.suggested).toBe('custom-claude-2');
    expect(result.keeps).toMatchObject({ rooms: 1, leads: [], owns: [roomId], children: 1, unread: 1, worktree: null });
    expect(result.blockers).toEqual([]);
    expect(leadId).toBeDefined();
  });

  it('удалённый провайдер — provider-missing; закрытая сессия — блокировка', async () => {
    const r = rig();
    const ref = await r.sessions.create({ projectPath: project, workId, provider: 'custom-claude-2', label: '', task: 'x', parent: null });
    await r.sessions.stop(ref);
    await writeCustomProviders([], customProvidersFile(home));
    expect((await r.sessions.switchOptions(ref)).current).toEqual({ provider: 'custom-claude-2', available: false, reason: 'provider-missing' });
    await r.sessions.close(ref);
    expect((await r.sessions.switchOptions(ref)).blockers).toContain('session is closed');
  });
});
