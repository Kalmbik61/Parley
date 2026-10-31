/* eslint-disable @typescript-eslint/no-explicit-any -- кадры хоста в тесте разбираются как JSON */
// A17: пограничный тест рамки (спека §2, §4, §15). Белый список против запретного списка; настоящий хост с ролью `remote`,
// к которому ходит тот же `HostLink`, что у моста; запуск с телефона за переключателем хоста; мост без TCP-слушателей.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  REMOTE_FORBIDDEN,
  REMOTE_STAGES,
  checkRemoteParams,
  isRemoteForbidden,
} from '@parley/protocol/remote';
// Хост берётся из сборки по пути: у пакета `@parley/host` в `exports` только корень и `main`, а корень тянет `node-pty`.
import { METHODS, NOTIFICATIONS } from '@parley/protocol';
import { LineDecoder, PROTOCOL_VERSION } from '@parley/protocol';
import { createHostServer } from '../../host/dist/server.js';
import { startBridge } from '../src/bridge.js';
import { HostCallError, createHostLink } from '../src/host-link.js';
import type { HostLink } from '../src/host-link.js';
import { createLog } from '../src/log.js';
import { until } from './harness.js';

const stages = Object.entries(REMOTE_STAGES);

describe('белый список против запретного списка', () => {
  it('ничего из списков этапов A, B и C не запрещено, и наоборот', () => {
    for (const [stage, lists] of stages) {
      for (const name of [...lists.methods, ...lists.notifications, ...lists.events]) {
        expect(isRemoteForbidden(name), `${stage}: ${name}`).toBe(false);
        expect(REMOTE_FORBIDDEN, `${stage}: ${name}`).not.toContain(name);
      }
    }
  });

  it('то, что телефону нельзя никогда, не лежит ни в одном этапе (в том числе `settings.set`)', () => {
    const mustBeForbidden = [
      'settings.set', 'settings.get', 'host.shutdown', 'wake.now', 'pty.input', 'pty.resize', 'works.create', 'works.delete',
      'sessions.delete', 'sessions.close', 'rooms.delete', 'rooms.archive', 'rooms.setMode', 'worktrees.merge', 'changes.commitProject',
      'providers.setKey', 'trust.grant', 'memory.write', 'backlog.add', 'plans.resumeAutonomous', 'assistant.send', 'browser.agentResult',
    ];
    for (const name of mustBeForbidden) {
      expect(isRemoteForbidden(name), name).toBe(true);
      for (const [stage, lists] of stages) expect([...lists.methods, ...lists.notifications] as string[], `${stage}: ${name}`).not.toContain(name);
    }
  });

  // Эти методы хоста пока не отнесены ни к этапам, ни к запретным: решение по ним впереди. Новый метод хоста сюда не попадёт сам —
  // тест ниже упадёт, пока кто-то не решит, куда он идёт (этап, REMOTE_FORBIDDEN или этот список с причиной в коммите).
  const NOT_DECIDED: readonly string[] = [
    'decisions.list', 'feed.progress', 'history.search', 'providers.authStatus', 'providers.cancelSignIn', 'providers.deleteCustom',
    'providers.saveCustom', 'providers.signIn', 'providers.signInInput', 'providers.signInResize', 'providers.signOut', 'recipes.list',
    'rooms.history.get', 'rooms.history.share', 'rooms.history.unshare', 'sessions.interrupted', 'sessions.switchAgent',
    'sessions.switchOptions', 'swarms.cancel', 'swarms.create', 'swarms.seen',
  ];
  /** Рукопожатие: хост принимает `hello` у любого клиента, это не метод белого списка. */
  const HANDSHAKE = new Set(['hello']);

  it('каждый метод и уведомление хоста отнесены: в списке этапа, в запретных или в явном списке «ещё не решено»', () => {
    const inStage = new Set<string>(stages.flatMap(([, l]) => [...l.methods, ...l.notifications]));
    const all = [...Object.keys(METHODS), ...Object.keys(NOTIFICATIONS)];
    const unclassified = all.filter((name) => !HANDSHAKE.has(name) && !inStage.has(name) && !isRemoteForbidden(name)).sort();
    // Новый метод хоста валит тест, пока для него нет решения.
    expect(unclassified).toEqual([...NOT_DECIDED].sort());
    // «Не решено» не значит «открыто»: этих методов нет ни в одном этапе и они не запрещены явно.
    for (const name of NOT_DECIDED) expect(inStage.has(name) || isRemoteForbidden(name), name).toBe(false);
    // Каждое имя этапа существует в протоколе хоста.
    for (const name of inStage) expect(all, name).toContain(name);
    expect(HANDSHAKE.has('hello') && all.includes('hello')).toBe(true);
  });

  it('этап C сверх B методов не добавляет; B содержит A; в этапе A есть запуск, а `rooms.create` не запрещён', () => {
    expect(REMOTE_STAGES.C.methods).toEqual(REMOTE_STAGES.B.methods);
    for (const m of REMOTE_STAGES.A.methods) expect(REMOTE_STAGES.B.methods).toContain(m);
    expect(REMOTE_STAGES.A.methods).toEqual(expect.arrayContaining(['sessions.create', 'rooms.create', 'rooms.send', 'providers.list', 'roles.list']));
  });

  it('правила параметров: запуск без лишнего (agent, effort, lean, autonomous, recipe, origin, чужая форма)', () => {
    const session = { projectPath: '/p', workId: 'w-1', provider: 'claude', label: 'x', task: 't', parent: null };
    const room = { projectPath: '/p', workId: 'w-1', title: 'T', members: ['s-1'] };
    expect(checkRemoteParams('sessions.create', session)).toBe(true);
    for (const extra of [{ agent: 'a' }, { effort: 'high' }, { lean: true }, { workId: null }, { parent: 's-1' }]) {
      expect(checkRemoteParams('sessions.create', { ...session, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(checkRemoteParams('rooms.create', room)).toBe(true);
    for (const extra of [{ mode: 'autonomous' }, { recipe: {} }, { origin: ['s-1', 's-2'] }, { members: [] }]) {
      expect(checkRemoteParams('rooms.create', { ...room, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(checkRemoteParams('rooms.send', { projectPath: '/p', workId: 'w-1', roomId: null, to: [], text: 'x', kind: 'note' })).toBe(false);
    expect(checkRemoteParams('rooms.send', { projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: [], text: 'x', kind: 'decision' })).toBe(false);
    expect(checkRemoteParams('feed.snapshot', { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-1' } })).toBe(false); // полная лента — этап B
  });
});

// ---- настоящий хост с ролью remote и HostLink моста ----
describe('хост с ролью remote (A2, A2b): граница на настоящем сервере', () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    // Сначала связь моста, потом сервер: закрытие сервера ждёт открытых соединений.
    for (const close of closers.splice(0).reverse()) await close();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function hostWith(policy: { enabled: boolean; open: boolean }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fb-'));
    dirs.push(dir);
    mkdirSync(path.join(dir, 'host'), { recursive: true });
    const socketPath = path.join(dir, 'host', 'h.sock');
    const tokenPath = path.join(dir, 'host', 'host.token');
    writeFileSync(tokenPath, 't\n');
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spies = {
      'works.list': vi.fn(async () => ({ entries: [], branches: {}, revision: 1 })),
      'sessions.create': vi.fn(async () => ({ ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-9' } })),
      'rooms.create': vi.fn(async () => ({ roomId: 'r-9' })),
      'rooms.send': vi.fn(async () => ({ messageId: 'm-9' })),
      'settings.set': vi.fn(async () => ({})),
      'works.create': vi.fn(async () => ({ workId: 'w-9' })),
      'sessions.delete': vi.fn(async () => ({ ok: true })),
      'host.info': vi.fn(async () => ({})),
    };
    const pty = { input: vi.fn(), resize: vi.fn() };
    const server = createHostServer({
      context: { version: 'test', log, liveSessions: () => 0 } as never,
      token: 't',
      helloTimeoutMs: 5000,
      methodHandlers: spies as never,
      notificationHandlers: { 'pty.input': pty.input, 'pty.resize': pty.resize } as never,
      registerClient: () => {},
      unregisterClient: () => {},
      remoteLaunch: {
        enabled: () => policy.enabled,
        workOpen: (projectPath) => policy.open && projectPath === '/p',
        roomAutonomous: () => false,
        projectKnown: (projectPath) => projectPath === '/p',
        workKnown: (projectPath) => projectPath === '/p',
      },
    });
    await new Promise<void>((r) => server.listen(socketPath, r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const link: HostLink = createHostLink({ socketPath, tokenPath, log: createLog({ file: path.join(dir, 'bridge.log') }), backoff: { initialMs: 10, maxMs: 40 } });
    link.start();
    closers.push(() => link.stop());
    await until(() => link.status === 'online');
    return { link, spies, pty, policy, socketPath };
  }

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof HostCallError ? e.code : String(e);
    }
  };
  const sessionParams = { projectPath: '/p', workId: 'w-1', provider: 'claude', label: 'x', task: 't', parent: null };
  const roomParams = { projectPath: '/p', workId: 'w-1', title: 'T', members: ['s-1'] };
  const sendParams = { projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: [], text: 'hi', kind: 'note' };

  it('методы, которых нет в белом списке, до обработчика не доходят', async () => {
    const h = await hostWith({ enabled: true, open: true });
    // Все методы хоста вне списка этапа A (в том числе «ещё не решено»), а не три вручную выбранных.
    const open = new Set<string>(REMOTE_STAGES.A.methods);
    const outside = Object.keys(METHODS).filter((name) => name !== 'hello' && !open.has(name));
    expect(outside.length).toBeGreaterThan(100);
    for (const method of outside) expect(await codeOf(h.link.call(method, {})), method).toBe('unknown_method');
    for (const name of ['settings.set', 'works.create', 'sessions.delete'] as const) expect(h.spies[name], name).not.toHaveBeenCalled();
  });

  it('уведомления pty.input и pty.resize от remote до обработчика не доходят', async () => {
    const h = await hostWith({ enabled: true, open: true });
    const socket = net.connect(h.socketPath);
    await new Promise<void>((r) => socket.once('connect', () => r()));
    const lines: any[] = [];
    const decoder = new LineDecoder();
    socket.on('data', (chunk) => lines.push(...(decoder.push(chunk) as any[])));
    const send = (frame: object) => socket.write(`${JSON.stringify(frame)}\n`);
    send({ id: 1, method: 'hello', params: { token: 't', protocol: PROTOCOL_VERSION, client: 'remote' } });
    await until(() => lines.some((l) => l.id === 1));
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
    send({ method: 'pty.input', params: { ref, data: 'rm -rf ~\r' } });
    send({ method: 'pty.resize', params: { ref, cols: 80, rows: 24 } });
    send({ id: 2, method: 'host.info', params: {} }); // ответ на него приходит после уведомлений: порядок соединения сохраняется
    await until(() => lines.some((l) => l.id === 2));
    expect(h.pty.input).not.toHaveBeenCalled();
    expect(h.pty.resize).not.toHaveBeenCalled();
    socket.destroy();
  });

  it('hello хоста для remote: методы ⊆ белый список этапа A', async () => {
    const h = await hostWith({ enabled: true, open: true });
    const allowed = new Set<string>(REMOTE_STAGES.A.methods);
    for (const m of h.link.methods ?? []) expect(allowed.has(m) || m === 'hello', m).toBe(true);
    expect(h.link.methods).toEqual(expect.arrayContaining(['works.list', 'sessions.create', 'rooms.create', 'rooms.send']));
  });

  it('переключатель выключен → sessions.create, rooms.create и rooms.send — unknown_method, в hello их нет', async () => {
    const h = await hostWith({ enabled: false, open: true });
    for (const m of ['sessions.create', 'rooms.create', 'rooms.send']) expect(h.link.methods).not.toContain(m);
    expect(await codeOf(h.link.call('sessions.create', sessionParams))).toBe('unknown_method');
    expect(await codeOf(h.link.call('rooms.create', roomParams))).toBe('unknown_method');
    expect(await codeOf(h.link.call('rooms.send', sendParams))).toBe('unknown_method');
    for (const m of ['sessions.create', 'rooms.create', 'rooms.send'] as const) expect(h.spies[m]).not.toHaveBeenCalled();
  });

  it('переключатель включён → сессия, комната и письмо создаются', async () => {
    const h = await hostWith({ enabled: true, open: true });
    expect(await h.link.call('sessions.create', sessionParams)).toEqual({ ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-9' } });
    expect(await h.link.call('rooms.create', roomParams)).toEqual({ roomId: 'r-9' });
    expect(await h.link.call('rooms.send', sendParams)).toEqual({ messageId: 'm-9' });
  });

  it('чужой projectPath и несуществующая работа → bad_request, обработчик не вызван', async () => {
    const h = await hostWith({ enabled: true, open: true });
    expect(await codeOf(h.link.call('sessions.create', { ...sessionParams, projectPath: '/etc' }))).toBe('bad_request');
    expect(await codeOf(h.link.call('rooms.create', { ...roomParams, projectPath: '/etc' }))).toBe('bad_request');
    expect(await codeOf(h.link.call('rooms.send', { ...sendParams, projectPath: '/etc' }))).toBe('bad_request');
    const closed = await hostWith({ enabled: true, open: false });
    expect(await codeOf(closed.link.call('sessions.create', sessionParams))).toBe('bad_request');
    for (const spies of [h.spies, closed.spies]) for (const m of ['sessions.create', 'rooms.create', 'rooms.send'] as const) expect(spies[m]).not.toHaveBeenCalled();
  });

  it('rooms.create с autonomous, рецептом или origin → bad_request, обработчик не вызван; agent и effort у sessions.create — тоже', async () => {
    const h = await hostWith({ enabled: true, open: true });
    expect(await codeOf(h.link.call('rooms.create', { ...roomParams, mode: 'autonomous' }))).toBe('bad_request');
    expect(await codeOf(h.link.call('rooms.create', { ...roomParams, recipe: {} }))).toBe('bad_request');
    expect(await codeOf(h.link.call('rooms.create', { ...roomParams, origin: ['s-1', 's-2'] }))).toBe('bad_request');
    expect(await codeOf(h.link.call('sessions.create', { ...sessionParams, agent: 'a' }))).toBe('bad_request');
    expect(await codeOf(h.link.call('sessions.create', { ...sessionParams, effort: 'high' }))).toBe('bad_request');
    expect(h.spies['rooms.create']).not.toHaveBeenCalled();
    expect(h.spies['sessions.create']).not.toHaveBeenCalled();
  });
});

// ---- мост не открывает TCP-слушателей ----
describe('мост в этапе A', () => {
  it('net.Server.prototype.listen — только unix-путь (сокет управления); к relay и шлюзу мост лишь подключается', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'fb-'));
    const calls: unknown[] = [];
    const original = net.Server.prototype.listen;
    net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
      calls.push(args[0]);
      return (original as (...a: unknown[]) => net.Server).apply(this, args);
    } as never;
    let bridge: Awaited<ReturnType<typeof startBridge>> | null = null;
    try {
      bridge = await startBridge({ home, host: { socketPath: path.join(home, 'host', 'h.sock'), tokenPath: path.join(home, 'host', 'h.token') } });
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      net.Server.prototype.listen = original;
      await bridge?.stop();
      rmSync(home, { recursive: true, force: true });
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const first of calls) expect(typeof first).toBe('string');
  });
});
