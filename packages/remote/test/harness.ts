/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
// Общее для сквозного теста A17: стаб хоста с состоянием, клиент сокета управления, запуск моста процессом.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LineDecoder } from '@parley/protocol';
import { REMOTE_METHODS } from '@parley/protocol/remote';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MAIN = path.join(here, '..', 'dist', 'main.js');
export const SPY = pathToFileURL(path.join(here, 'listen-spy.mjs')).href;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function until<T>(probe: () => T | Promise<T | undefined | null | false> | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v as T;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

const P = '/p';
const ago = (s: number): string => new Date(Date.now() - s * 1000).toISOString();

/** Карточка разрешения в виде, который отдаёт хост в `feed.snapshot {scope:'attention'}`. */
export const permissionCard = (cardId: string, command: string): any => ({
  kind: 'permission', id: cardId, cardId, at: ago(1), state: 'pending', toolUseId: null, toolName: 'Bash', toolInput: { command }, suggestions: [], notified: true,
});

interface Room {
  id: string;
  proposal: { id: string; rev: number } | null;
}

/**
 * Хост со своей памятью, говорящий по протоколу `HostLink`: `hello` с признаком политики, `works.list`, `feed.snapshot`,
 * `feed.decide`, `rooms.resolveProposal` (устаревший `rev` → `conflict`) и события `works.changed`, `activity.changed`.
 */
export class HostSim {
  readonly conns = new Set<net.Socket>();
  readonly calls: Array<{ method: string; params: any; at: number }> = [];
  readonly cards = new Map<string, any[]>();
  readonly activity = new Map<string, any>();
  readonly sessions: string[] = [];
  readonly rooms: Room[] = [];
  revision = 1;
  #server!: net.Server;

  async start(socketPath: string, tokenPath: string): Promise<void> {
    mkdirSync(path.dirname(socketPath), { recursive: true });
    writeFileSync(tokenPath, 'host-token-e2e\n');
    this.#server = net.createServer((c) => {
      this.conns.add(c);
      c.on('close', () => this.conns.delete(c));
      c.on('error', () => {});
      const dec = new LineDecoder();
      c.on('data', (chunk) => {
        for (const m of dec.push(chunk) as Array<{ id: number; method: string; params: any }>) this.#answer(c, m);
      });
    });
    await new Promise<void>((r) => this.#server.listen(socketPath, r));
  }

  async close(): Promise<void> {
    for (const c of this.conns) c.destroy();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  callsOf(method: string): Array<{ params: any; at: number }> {
    return this.calls.filter((c) => c.method === method);
  }

  #answer(c: net.Socket, m: { id: number; method: string; params: any }): void {
    this.calls.push({ method: m.method, params: m.params, at: Date.now() });
    const ok = (result: unknown) => c.write(`${JSON.stringify({ id: m.id, result })}\n`);
    const err = (code: string, message: string) => c.write(`${JSON.stringify({ id: m.id, error: { code, message } })}\n`);
    switch (m.method) {
      case 'hello':
        return ok({ features: ['remote-policy-1', 'compact-works', 'rooms-mail'], methods: [...REMOTE_METHODS] });
      case 'works.list':
        return ok(this.snapshot());
      case 'feed.snapshot': {
        const items = this.cards.get(m.params?.ref?.sessionId) ?? [];
        return ok({ items, revision: 1, schemaVersion: 1, mode: null });
      }
      case 'feed.decide': {
        const list = this.cards.get(m.params.ref.sessionId) ?? [];
        const index = list.findIndex((x) => x.cardId === m.params.cardId);
        if (index < 0) return ok({ applied: false, state: 'allowed' });
        list.splice(index, 1);
        return ok({ applied: true, state: 'allowed' });
      }
      case 'rooms.resolveProposal': {
        const room = this.rooms.find((r) => r.id === m.params.roomId);
        if (!room || room.proposal === null || room.proposal.rev !== m.params.rev) return err('conflict', 'the proposal was revised');
        room.proposal = null;
        return ok({ messageId: 'm-1' });
      }
      default:
        return ok({ ok: true });
    }
  }

  snapshot(): any {
    return {
      revision: this.revision,
      branches: {},
      entries: [
        {
          projectPath: P,
          map: {
            work: { id: 'w-1', title: 'E2E', status: 'active', updatedAt: ago(5) },
            sessions: this.sessions.map((id) => ({
              id, provider: 'claude', label: id, task: 'SECRET TASK', parent: null, lifecycle: 'active', history: [], startedAt: ago(60),
            })),
            rooms: this.rooms.map((r) => ({ id: r.id, title: r.id, members: [], proposal: r.proposal ? { ...r.proposal, from: 's-1', text: 'go', at: ago(2) } : null })),
            messages: [],
            plans: [{ secret: 1 }],
          },
        },
      ],
    };
  }

  broadcast(event: string, data: unknown): void {
    for (const c of this.conns) c.write(`${JSON.stringify({ event, data })}\n`);
  }

  /** Новый снимок (revision растёт) и событие `works.changed`. */
  publish(): void {
    this.revision++;
    this.broadcast('works.changed', this.snapshot());
  }

  addSessions(...ids: string[]): void {
    this.sessions.push(...ids);
  }

  setActivity(sessionId: string, activity: string): void {
    const entry = { ref: { projectPath: P, workId: 'w-1', sessionId }, activity: { activity, need: null, subagents: 0, tasks: [], waitingFor: null, heldByBackground: false, turnEndedAt: null, turnBoundaryAt: null, lastEventAt: ago(0) }, metrics: null };
    this.activity.set(sessionId, entry);
    this.broadcast('activity.changed', entry);
  }

  /** Сессия ждёт: карточка и `blocked`. */
  block(sessionId: string, cards: any[] = []): void {
    this.cards.set(sessionId, cards);
    this.setActivity(sessionId, 'blocked');
  }

  /** «Ответили на Маке»: карточки сессии заменены, без события от хоста (в этапе A подписок нет). */
  replaceCards(sessionId: string, cards: any[]): void {
    this.cards.set(sessionId, cards);
  }

  setProposal(roomId: string, proposal: { id: string; rev: number } | null): void {
    const room = this.rooms.find((r) => r.id === roomId);
    if (room) room.proposal = proposal;
    else this.rooms.push({ id: roomId, proposal });
    this.publish();
  }
}

/** Клиент сокета управления окна. */
export class Control {
  #sock!: net.Socket;
  #id = 0;
  readonly events: Array<{ event: string; data: any }> = [];
  readonly #waiting = new Map<number, (m: any) => void>();
  static async open(home: string): Promise<Control> {
    const c = new Control();
    const dir = path.join(home, 'remote');
    const token = readFileSync(path.join(dir, 'control.token'), 'utf8');
    c.#sock = net.connect(path.join(dir, 'control.sock'));
    const dec = new LineDecoder();
    c.#sock.on('data', (chunk) => {
      for (const m of dec.push(chunk) as any[]) {
        if (typeof m.id === 'number') c.#waiting.get(m.id)?.(m);
        else c.events.push(m);
      }
    });
    c.#sock.on('error', () => {});
    await new Promise<void>((r) => c.#sock.once('connect', () => r()));
    await c.call('hello', { token });
    return c;
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, (m) => (m.error ? reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : resolve(m.result)));
      this.#sock.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  close(): void {
    this.#sock.destroy();
  }
}

export interface BridgeProcess {
  home: string;
  host: HostSim;
  child: ChildProcess;
  exit: Promise<number | null>;
  control: Control;
  stderr: () => string;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** `host[:port]` relay, as it goes into remote.json. */
  relay: string;
  /** Адрес мока push-шлюза (`http://127.0.0.1:port`). */
  pushGatewayUrl?: string;
  loopback: boolean;
  spyFile?: string;
}

/** Мост настоящим процессом на свежем доме со своим стабом хоста; свежий дом даёт свой маршрут (`routeId`). */
export async function startBridgeProcess(options: StartOptions): Promise<BridgeProcess> {
  if (!existsSync(MAIN)) throw new Error('packages/remote/dist/main.js is missing: run `pnpm --filter @parley/remote build` first');
  const home = mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const host = new HostSim();
  await host.start(path.join(home, 'host', 'host.sock'), path.join(home, 'host', 'host.token'));
  mkdirSync(path.join(home, 'remote'), { recursive: true });
  writeFileSync(
    path.join(home, 'remote', 'remote.json'),
    JSON.stringify({ v: 1, relay: options.relay, ...(options.pushGatewayUrl ? { pushGatewayUrl: options.pushGatewayUrl } : {}) }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, PARLEY_HOME: home };
  if (options.loopback) env.PARLEY_REMOTE_DEV_LOOPBACK = '1';
  if (options.spyFile) env.LISTEN_SPY_FILE = options.spyFile;
  const args = options.spyFile ? ['--import', SPY, MAIN] : [MAIN];
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  await until(() => existsSync(path.join(home, 'remote', 'control.sock')) && existsSync(path.join(home, 'remote', 'control.token')));
  const control = await until(async () => Control.open(home).catch(() => null));
  await until(async () => {
    const s = await control.call('status');
    return s.host === 'online' && s.relay === 'connected';
  });
  return {
    home,
    host,
    child,
    exit,
    control,
    stderr: () => err,
    async stop() {
      control.close();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await exit;
        clearTimeout(killer);
      }
      await host.close();
    },
  };
}
