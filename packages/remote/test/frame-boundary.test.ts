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

const REF_ONLY = ['feed.interrupt', 'sessions.stop', 'sessions.close', 'sessions.switchOptions'] as const;
const MENU = [...REF_ONLY, 'sessions.switchAgent'] as const;

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
      'sessions.delete', 'sessions.rename', 'rooms.reopen', 'rooms.setMode', 'worktrees.merge', 'changes.commitProject',
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
    'rooms.history.get', 'rooms.history.share', 'rooms.history.unshare', 'sessions.interrupted',
    'swarms.cancel', 'swarms.create', 'swarms.seen',
    // Из master после слияния 2026-11-01 (лимиты агентов, сон, закрытие готовых сессий): телефону не открыты.
    'capacity.get', 'sessions.setKeepAwake', 'works.setCloseFinished',
    // Постраничная синхронизация окна (PR #164): её берёт клиент с признаком `works-sync` в hello, телефон пока живёт на
    // `works.list` и `works.changed`.
    'works.mailState', 'works.sync',
    // Из ветки s-209 (обновление CLI провайдера из Parley): действие на Маке, телефону не открыто.
    'providers.update', 'providers.skipUpdate',
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

  it('A38a: меню сессии — этап A, sessions.close не в запретном перечне; удаление, переименование, модель, режим — закрыты', () => {
    for (const m of MENU) {
      expect(REMOTE_STAGES.A.methods, m).toContain(m);
      expect(isRemoteForbidden(m), m).toBe(false);
    }
    for (const m of ['sessions.delete', 'sessions.rename', 'sessions.setModel', 'sessions.setMode', 'sessions.compact', 'sessions.setKeepAwake']) {
      expect(REMOTE_STAGES.A.methods as readonly string[], m).not.toContain(m);
    }
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
    for (const m of REF_ONLY) {
      expect(checkRemoteParams(m, { ref }), m).toBe(true);
      for (const params of [{ ref, extra: 1 }, { ref: { ...ref, x: 1 } }, {}, { ref: { ...ref, sessionId: '' } }, { ref: { projectPath: '/p', workId: 'w-1' } }]) {
        expect(checkRemoteParams(m, params), `${m} ${JSON.stringify(params)}`).toBe(false);
      }
    }
    const sw = { ref, requestId: '0b6e5d3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f', provider: 'codex' };
    expect(checkRemoteParams('sessions.switchAgent', sw)).toBe(true);
    expect(checkRemoteParams('sessions.switchAgent', { ...sw, model: 'gpt-6', effort: 'high', carry: 'transcript' })).toBe(true);
    expect(checkRemoteParams('sessions.switchAgent', { ...sw, model: null, effort: null, carry: 'handover' })).toBe(true);
    for (const extra of [
      { force: true },
      { force: false },
      { requestId: 'not-a-uuid' },
      { requestId: undefined },
      { provider: '' },
      { provider: 'x'.repeat(65) },
      { model: 'm'.repeat(201) },
      { model: 7 },
      { effort: 'High!' },
      { carry: 'everything' },
      { ref: { ...ref, workId: '' } },
      { label: 'x' },
    ]) {
      expect(checkRemoteParams('sessions.switchAgent', { ...sw, ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });

  it('A41a: меню комнаты — этап A, не в запретном перечне; правила параметров строгие', () => {
    for (const m of ['rooms.archive', 'rooms.delete']) {
      expect(REMOTE_STAGES.A.methods as readonly string[], m).toContain(m);
      expect(isRemoteForbidden(m), m).toBe(false);
    }
    for (const m of ['rooms.reopen', 'rooms.rename', 'rooms.setMode', 'rooms.addMember']) expect(isRemoteForbidden(m), m).toBe(true);
    const room = { projectPath: '/p', workId: 'w-1', roomId: 'r-1' };
    expect(checkRemoteParams('rooms.archive', { ...room, stopSessions: true })).toBe(true);
    expect(checkRemoteParams('rooms.archive', { ...room, stopSessions: false })).toBe(true);
    expect(checkRemoteParams('rooms.delete', room)).toBe(true);
    for (const bad of [{}, room, { ...room, stopSessions: 'yes' }, { ...room, stopSessions: 1 }, { ...room, stopSessions: undefined }, { ...room, stopSessions: true, extra: 1 }, { ...room, stopSessions: true, roomId: '' }, { ...room, stopSessions: true, workId: '' }, { ...room, stopSessions: true, projectPath: '' }, { ...room, stopSessions: true, roomId: 5 }]) {
      expect(checkRemoteParams('rooms.archive', bad), `archive ${JSON.stringify(bad)}`).toBe(false);
    }
    for (const bad of [{}, { ...room, stopSessions: true }, { ...room, force: true }, { ...room, roomId: '' }, { ...room, workId: '' }, { ...room, projectPath: '' }, { projectPath: '/p', workId: 'w-1' }, { ...room, roomId: 7 }]) {
      expect(checkRemoteParams('rooms.delete', bad), `delete ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('A37a: sessions.resume — этап A; правило: ключ только ref со строгими projectPath, workId, sessionId', () => {
    expect(REMOTE_STAGES.A.methods).toContain('sessions.resume');
    expect(isRemoteForbidden('sessions.resume')).toBe(false);
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
    expect(checkRemoteParams('sessions.resume', { ref })).toBe(true);
    for (const params of [
      { ref, extra: 1 },
      { ref: { ...ref, extra: 'x' } },
      {},
      null,
      { ref: 's-1' },
      { ref: { projectPath: '/p', workId: 'w-1' } },
      { ref: { ...ref, projectPath: '' } },
      { ref: { ...ref, workId: '' } },
      { ref: { ...ref, sessionId: '' } },
      { ref: { ...ref, sessionId: 1 } },
    ]) {
      expect(checkRemoteParams('sessions.resume', params), JSON.stringify(params)).toBe(false);
    }
  });

  it('правила параметров: запуск без лишнего (agent, effort, lean, autonomous, recipe, origin, чужая форма)', () => {
    const session = { projectPath: '/p', workId: 'w-1', provider: 'claude', label: 'x', task: 't', parent: null };
    const room = { projectPath: '/p', workId: 'w-1', title: 'T', members: ['s-1'] };
    expect(checkRemoteParams('sessions.create', session)).toBe(true);
    for (const extra of [{ agent: 'a' }, { effort: 'high' }, { lean: true }, { parent: 's-1' }]) {
      expect(checkRemoteParams('sessions.create', { ...session, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(checkRemoteParams('rooms.create', room)).toBe(true);
    for (const extra of [{ mode: 'autonomous' }, { recipe: {} }, { origin: ['s-1', 's-2'] }, { members: [] }]) {
      expect(checkRemoteParams('rooms.create', { ...room, ...extra }), JSON.stringify(extra)).toBe(false);
    }
    expect(checkRemoteParams('rooms.send', { projectPath: '/p', workId: 'w-1', roomId: null, to: [], text: 'x', kind: 'note' })).toBe(false);
    expect(checkRemoteParams('rooms.send', { projectPath: '/p', workId: 'w-1', roomId: 'r-1', to: [], text: 'x', kind: 'decision' })).toBe(false);
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
      'sessions.resume': vi.fn(async () => ({ ok: true })),
      'feed.interrupt': vi.fn(async () => ({ ok: true })),
      'sessions.stop': vi.fn(async () => ({ ok: true })),
      'sessions.close': vi.fn(async () => ({ ok: true })),
      'sessions.switchOptions': vi.fn(async () => ({ current: { provider: 'claude', available: true, reason: null }, targets: [], suggested: null, keeps: { rooms: 0, leads: [], owns: [], children: 0, unread: 0, worktree: null }, blockers: [] })),
      'rooms.archive': vi.fn(async () => ({ ok: true })),
      'rooms.delete': vi.fn(async () => ({ ok: true })),
      'sessions.switchAgent': vi.fn(async () => ({ outcome: 'started', carried: 'handover' })),
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
        workKnown: (projectPath, workId) => projectPath === '/p' && workId === 'w-1',
        roomState: async (_projectPath, _workId, roomId) => (roomId === 'r-1' ? { workArchived: false, autonomous: false } : null),
        membersState: async () => ({ workArchived: false, autonomous: false }),
        sessionState: async () => ({ workArchived: false, lifecycle: 'sleeping', live: true, engine: false }),
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

  it('A38a: меню сессии за переключателем; известная работа; force у switchAgent — bad_request до обработчика', async () => {
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
    const sw = { ref, requestId: '0b6e5d3c-1a2b-4c3d-8e9f-0a1b2c3d4e5f', provider: 'codex' };
    const paramsOf = (m: string): Record<string, unknown> => (m === 'sessions.switchAgent' ? sw : { ref });
    const off = await hostWith({ enabled: false, open: true });
    for (const m of MENU) {
      expect(off.link.methods, m).not.toContain(m);
      expect(await codeOf(off.link.call(m, paramsOf(m))), m).toBe('unknown_method');
      expect(off.spies[m], m).not.toHaveBeenCalled();
    }
    const h = await hostWith({ enabled: true, open: true });
    for (const m of MENU) {
      expect(h.link.methods, m).toContain(m);
      expect(await codeOf(h.link.call(m, paramsOf(m))), m).toBe('ok');
      expect(await codeOf(h.link.call(m, { ...paramsOf(m), ref: { ...ref, projectPath: '/etc' } })), m).toBe('bad_request');
      expect(await codeOf(h.link.call(m, { ...paramsOf(m), ref: { ...ref, workId: 'w-9' } })), m).toBe('bad_request');
      expect(await codeOf(h.link.call(m, { ...paramsOf(m), extra: 1 })), m).toBe('bad_request');
      expect(h.spies[m], m).toHaveBeenCalledTimes(1);
    }
    expect(await codeOf(h.link.call('sessions.switchAgent', { ...sw, force: true }))).toBe('bad_request');
    expect(h.spies['sessions.switchAgent']).toHaveBeenCalledTimes(1);
    // Удаление с телефона по-прежнему закрыто.
    expect(await codeOf(h.link.call('sessions.delete', { ref }))).toBe('unknown_method');
  });

  it('A41a: меню комнаты за переключателем; известная работа и комната; лишний ключ и нет stopSessions — bad_request до обработчика', async () => {
    const room = { projectPath: '/p', workId: 'w-1', roomId: 'r-1' };
    const archive = { ...room, stopSessions: false };
    const cases = [['rooms.archive', archive], ['rooms.delete', room]] as const;
    const off = await hostWith({ enabled: false, open: true });
    for (const [m, params] of cases) {
      expect(off.link.methods, m).not.toContain(m);
      expect(await codeOf(off.link.call(m, params)), m).toBe('unknown_method');
      expect(off.spies[m], m).not.toHaveBeenCalled();
    }
    const h = await hostWith({ enabled: true, open: true });
    for (const [m, params] of cases) {
      expect(h.link.methods, m).toContain(m);
      expect(await codeOf(h.link.call(m, params)), m).toBe('ok');
      expect(await codeOf(h.link.call(m, { ...params, projectPath: '/etc' })), m).toBe('bad_request');
      expect(await codeOf(h.link.call(m, { ...params, workId: 'w-9' })), m).toBe('bad_request');
      expect(await codeOf(h.link.call(m, { ...params, roomId: 'r-9' })), m).toBe('bad_request');
      expect(await codeOf(h.link.call(m, { ...params, extra: 1 })), m).toBe('bad_request');
      expect(h.spies[m], m).toHaveBeenCalledTimes(1);
    }
    expect(await codeOf(h.link.call('rooms.archive', room))).toBe('bad_request');
    expect(await codeOf(h.link.call('rooms.archive', { ...archive, stopSessions: 'no' }))).toBe('bad_request');
    expect(h.spies['rooms.archive']).toHaveBeenCalledTimes(1);
    // Прочее меню комнаты по-прежнему закрыто.
    expect(await codeOf(h.link.call('rooms.rename', { ...room, title: 'x' }))).toBe('unknown_method');
  });

  it('A37a: sessions.resume за переключателем; известная работа; лишний ключ — bad_request до обработчика', async () => {
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-1' };
    const off = await hostWith({ enabled: false, open: true });
    expect(off.link.methods).not.toContain('sessions.resume');
    expect(await codeOf(off.link.call('sessions.resume', { ref }))).toBe('unknown_method');
    expect(off.spies['sessions.resume']).not.toHaveBeenCalled();
    const h = await hostWith({ enabled: true, open: true });
    expect(h.link.methods).toContain('sessions.resume');
    expect(await h.link.call('sessions.resume', { ref })).toEqual({ ok: true });
    expect(await codeOf(h.link.call('sessions.resume', { ref: { ...ref, projectPath: '/etc' } }))).toBe('bad_request');
    expect(await codeOf(h.link.call('sessions.resume', { ref: { ...ref, workId: 'w-9' } }))).toBe('bad_request');
    expect(await codeOf(h.link.call('sessions.resume', { ref, extra: 1 }))).toBe('bad_request');
    expect(h.spies['sessions.resume']).toHaveBeenCalledTimes(1);
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
