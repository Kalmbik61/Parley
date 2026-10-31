/* eslint-disable @typescript-eslint/no-explicit-any -- кадры в тестах разбираются как JSON */
// Общее для сквозного теста A17: стаб хоста с состоянием, клиент сокета управления, запуск моста процессом.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LineDecoder } from '@parley/protocol';
import { REMOTE_METHODS, b64urlEncode } from '@parley/protocol/remote';
import { newBridgeKeys, writeBridgeKeys } from '../src/keys.js';

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

/**
 * Маршрут теста во внешнем relay. Relay пускает не больше 5 новых маршрутов в сутки с адреса (`newRoute`), поэтому прогон
 * не создаёт маршрут каждый раз: `routeId` и `routeSecret` выводятся из одной основы (`PARLEY_E2E_ROUTE_BASE`, 32 байта
 * base64url; нет — создаётся один раз и лежит в `<tmp>/parley-e2e-route-base`) по номеру места: места 0 и 1 — два моста
 * теста «второй хост». Одна основа — одни и те же маршруты от прогона к прогону. Основу не публикуют: секрет маршрута —
 * это право слать на него.
 */
export function routeFor(slot: number): { routeId: string; routeSecret: string } {
  const file = path.join(os.tmpdir(), 'parley-e2e-route-base');
  let base = process.env.PARLEY_E2E_ROUTE_BASE;
  if (base === undefined) {
    if (!existsSync(file)) writeFileSync(file, b64urlEncode(new Uint8Array(randomBytes(32))), { mode: 0o600 });
    base = readFileSync(file, 'utf8').trim();
  }
  const derive = (label: string, bytes: number): string => b64urlEncode(new Uint8Array(createHmac('sha256', base!).update(`${label}:${slot}`).digest().subarray(0, bytes)));
  return { routeId: derive('route-id', 16), routeSecret: derive('route-secret', 32) };
}

export interface StartOptions {
  /** Фиксированный маршрут (внешний relay): без него мост заводит свой, новый на каждый запуск. */
  route?: { routeId: string; routeSecret: string };
  /** `host[:port]` relay, as it goes into remote.json. */
  relay: string;
  /** Адрес мока push-шлюза (`http://127.0.0.1:port`). */
  pushGatewayUrl?: string;
  loopback: boolean;
  spyFile?: string;
}

/** Мост настоящим процессом на свежем доме со своим стабом хоста. Сбой запуска убирает процесс, стаб и дом. */
export async function startBridgeProcess(options: StartOptions): Promise<BridgeProcess> {
  if (!existsSync(MAIN)) throw new Error('packages/remote/dist/main.js is missing: run `pnpm --filter @parley/remote build` first');
  const home = mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const host = new HostSim();
  let child: ChildProcess | null = null;
  let err = '';
  const logTail = (): string => {
    try {
      return readFileSync(path.join(home, 'remote', 'bridge.log'), 'utf8').trim().split('\n').slice(-6).join('\n');
    } catch {
      return '(no bridge.log)';
    }
  };
  try {
    await host.start(path.join(home, 'host', 'host.sock'), path.join(home, 'host', 'host.token'));
    mkdirSync(path.join(home, 'remote'), { recursive: true });
    writeFileSync(
      path.join(home, 'remote', 'remote.json'),
      JSON.stringify({ v: 1, relay: options.relay, ...(options.pushGatewayUrl ? { pushGatewayUrl: options.pushGatewayUrl } : {}) }),
    );
    if (options.route) await writeBridgeKeys(path.join(home, 'remote', 'keys.json'), { ...newBridgeKeys(), ...options.route });
    const env: NodeJS.ProcessEnv = { ...process.env, PARLEY_HOME: home };
    if (options.loopback) env.PARLEY_REMOTE_DEV_LOOPBACK = '1';
    if (options.spyFile) env.LISTEN_SPY_FILE = options.spyFile;
    const args = options.spyFile ? ['--import', SPY, MAIN] : [MAIN];
    const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    child = proc;
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
    await until(() => existsSync(path.join(home, 'remote', 'control.sock')) && existsSync(path.join(home, 'remote', 'control.token')));
    const control = await until(async () => Control.open(home).catch(() => null));
    try {
      await until(async () => {
        // Отказ relay виден в логе моста сразу: ждать десять секунд ради него незачем.
        if (/relay\.(refused|error)[^\n]*rate_limited/.test(logTail())) throw new Error('the relay refused the bridge');
        const s = await control.call('status');
        return s.host === 'online' && s.relay === 'connected';
      });
    } catch (error) {
      control.close();
      throw error;
    }
    return {
      home,
      host,
      child: proc,
      exit,
      control,
      stderr: () => err,
      async stop() {
        control.close();
        if (proc.exitCode === null) {
          proc.kill('SIGTERM');
          const killer = setTimeout(() => proc.kill('SIGKILL'), 5000);
          await exit;
          clearTimeout(killer);
        }
        await host.close();
      },
    };
  } catch (error) {
    // Ни процесса моста с ppid=1, ни стаба, ни дома не остаётся; причина — в тексте ошибки.
    if (child !== null && child.exitCode === null) child.kill('SIGKILL');
    await host.close().catch(() => undefined);
    const tail = logTail();
    rmSync(home, { recursive: true, force: true });
    const limited = /rate_limited/.test(tail)
      ? '\nrelay: rate_limited — the relay allows 5 new routes per day per address. A local relay in the test has no such limit; against an external one reuse the test route (PARLEY_E2E_ROUTE_BASE).'
      : '';
    throw new Error(`the bridge did not come up: ${error instanceof Error ? error.message : String(error)}${limited}\nstderr: ${err.trim() || '(empty)'}\nbridge.log:\n${tail}`);
  }
}
