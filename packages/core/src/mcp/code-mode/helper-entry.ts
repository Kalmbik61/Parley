// Code Mode helper process (plan T4a). Runs ONLY under /usr/bin/sandbox-exec with the rendered r4 profile, an empty
// environment and Node --permission, started by helper.ts. IPC is JSON lines on stdin/stdout; stderr is ignored.
//
// Phase 1, before any guest code exists in this process: the whole-profile self-test. Every probe result goes back as a
// plain error code; the PARENT judges them (this process may be compromised later, so its own verdict is not trusted).
// Phase 2, only if the parent sends `run`: one guest script through guest.ts, calls relayed as `rpc` lines.
// Must not import node:os (sysctl is denied by the profile) and nothing beyond node built-ins and guest.ts.

import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync, writeSync } from 'node:fs';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { type GuestLimits, type GuestReply, guestLimitsProblem, runGuest } from './guest.js';

const MAX_LINE = 1024 * 1024;
const METHOD = /^[a-z][a-z0-9_]{0,63}$/;
const LIMIT_KEYS = ['codeBytes', 'activeMs', 'wallMs', 'memoryBytes', 'stackBytes', 'maxRpcs', 'maxInFlight', 'argBytes', 'responseBytes', 'resultBytes'] as const;
const PROBE_KEYS = ['t', 'tcpPort', 'udpPort', 'tcp6Port', 'udp6Port', 'unixPath', 'secretFile'] as const;

type Msg =
  | { t: 'probe'; tcpPort: number; udpPort: number; tcp6Port: number; udp6Port: number; unixPath: string; secretFile: string }
  | { t: 'run'; code: string; methods: string[]; limits: GuestLimits }
  | { t: 'rpc-result'; rid: number; ok: boolean; value: string }
  | { t: 'cancel' };

/**
 * Every line goes out whole and in order before `send` returns: a synchronous write loop on fd 1, never `process.stdout`, whose
 * pipe writes can still be queued when write() returns and are dropped by process.exit (the parent then saw an 8 KiB prefix of
 * `done` on Node 22.16.0, 64 KiB on 22.23.3). So every exit below follows a line that is already written. fd 1 is blocking (the
 * spawn clears O_NONBLOCK on the child's stdio), so a parent that stops reading keeps this process blocked here until the parent's
 * run deadline kills it; were it ever non-blocking, EAGAIN would throw and the helper would end without `done`, never with half a line.
 */
const send = (msg: object): void => {
  const line = Buffer.from(`${JSON.stringify(msg)}\n`, 'utf8');
  for (let off = 0; off < line.length;) off += writeSync(1, line, off, line.length - off);
};
const fatal = (reason: string): never => { send({ t: 'fatal', reason }); process.exit(2); };
const isPlain = (o: unknown): o is Record<string, unknown> => typeof o === 'object' && o !== null && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const port = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) < 65536;

/** Parent → helper messages, validated field by field; anything else ends the helper. */
function parse(line: string): Msg | null {
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE) return null;
  let m: unknown;
  try { m = JSON.parse(line); } catch { return null; }
  if (!isPlain(m) || typeof m.t !== 'string') return null;
  if (m.t === 'probe') {
    if (!exactKeys(m, PROBE_KEYS) || ![m.tcpPort, m.udpPort, m.tcp6Port, m.udp6Port].every(port) || typeof m.unixPath !== 'string' || typeof m.secretFile !== 'string') return null;
    return m as Msg;
  }
  if (m.t === 'run') {
    if (!exactKeys(m, ['t', 'code', 'methods', 'limits']) || typeof m.code !== 'string' || !Array.isArray(m.methods) || !m.methods.every((x) => typeof x === 'string' && METHOD.test(x)) || !isPlain(m.limits)) return null;
    const L = m.limits;
    if (!exactKeys(L, LIMIT_KEYS) || !LIMIT_KEYS.every((k) => Number.isSafeInteger(L[k]) && (L[k] as number) > 0)) return null;
    // The physical maxima (48 MiB WASM, 128 KiB stack) are re-checked here, before any allocation.
    if (guestLimitsProblem(L) !== null) return null;
    return m as Msg;
  }
  if (m.t === 'rpc-result') {
    if (!exactKeys(m, ['t', 'rid', 'ok', 'value']) || !Number.isSafeInteger(m.rid) || typeof m.ok !== 'boolean' || typeof m.value !== 'string') return null;
    return m as Msg;
  }
  if (m.t === 'cancel') return exactKeys(m, ['t']) ? (m as Msg) : null;
  return null;
}

const inbox: Msg[] = [];
let waiter: (() => void) | null = null;
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const m = parse(line);
  if (m === null) fatal('malformed-ipc');
  if (m!.t === 'cancel') fatal('cancelled');
  inbox.push(m!);
  if (waiter) { const w = waiter; waiter = null; w(); }
});
rl.on('close', () => fatal('parent-closed'));
const next = (): Promise<Msg> => (inbox.length > 0 ? Promise.resolve(inbox.shift()!) : new Promise((r) => { waiter = () => r(inbox.shift()!); }));

const code = (e: unknown): string => (typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'ERR');

/** Every probe returns an error code (or a success word). Targets: parent-owned listeners, TEST-NET-1 and 2001:db8::1. */
async function selfTest(p: Extract<Msg, { t: 'probe' }>): Promise<Record<string, string>> {
  const tcp = (portNo: number, host: string): Promise<string> => new Promise((res) => {
    const s = net.connect({ port: portNo, host });
    const t = setTimeout(() => { s.destroy(); res('TIMEOUT'); }, 1500);
    s.on('connect', () => { clearTimeout(t); s.destroy(); res('CONNECTED'); });
    s.on('error', (e) => { clearTimeout(t); res(code(e)); });
  });
  const unix = (file: string): Promise<string> => new Promise((res) => {
    const s = net.connect({ path: file });
    s.on('connect', () => { s.destroy(); res('CONNECTED'); });
    s.on('error', (e) => res(code(e)));
  });
  const udp = (portNo: number, host: string, type: 'udp4' | 'udp6'): Promise<string> => new Promise((res) => {
    const s = dgram.createSocket(type);
    s.on('error', (e) => { try { s.close(); } catch { /* closed */ } res(code(e)); });
    s.send(Buffer.from('probe'), portNo, host, (e) => { try { s.close(); } catch { /* closed */ } res(e ? code(e) : 'SENT'); });
  });
  // c-ares reports a denied send as ECONNREFUSED; the parent's verdict is that its resolver socket saw zero packets.
  const dnsQuery = (portNo: number): Promise<string> => new Promise((res) => {
    const r = new dns.Resolver({ timeout: 500, tries: 1 });
    r.setServers([`127.0.0.1:${portNo}`]);
    r.resolve4('probe.invalid', (e) => res(e ? code(e) : 'RESOLVED'));
  });
  const systemDns = (): Promise<string> => new Promise((res) => dns.lookup('localhost', (e) => res(e ? code(e) : 'RESOLVED')));
  // Node permission allows exactly this file and child processes, so these two reach the OS layer and test the profile.
  const fileRead = (): string => { try { readFileSync(p.secretFile); return 'READ'; } catch (e) { return code(e); } };
  const spawnProbe = (file: string, args: string[]): string => { const r = spawnSync(file, args, { env: {}, stdio: 'ignore' }); return r.error ? code(r.error) : `EXITED:${String(r.status)}`; };
  return {
    loopbackTcp: await tcp(p.tcpPort, '127.0.0.1'),
    outboundTcp: await tcp(9, '192.0.2.1'),
    loopbackUdp: await udp(p.udpPort, '127.0.0.1', 'udp4'),
    outboundUdp: await udp(53, '192.0.2.1', 'udp4'),
    loopbackTcp6: await tcp(p.tcp6Port, '::1'),
    loopbackUdp6: await udp(p.udp6Port, '::1', 'udp6'),
    outboundTcp6: await tcp(9, '2001:db8::1'),
    outboundUdp6: await udp(53, '2001:db8::1', 'udp6'),
    unixSocket: await unix(p.unixPath),
    dnsQuery: await dnsQuery(p.udpPort),
    systemDns: await systemDns(),
    fileRead: fileRead(),
    spawn: spawnProbe('/usr/bin/true', []),
    // The one binary the profile lets this process exec: a child Node must still be denied (fork/posix_spawn).
    spawnNode: spawnProbe(process.execPath, ['-e', '0']),
  };
}

const probe = await next();
if (probe.t !== 'probe') fatal('expected-probe');
send({ t: 'probed', probes: await selfTest(probe as Extract<Msg, { t: 'probe' }>) });

const run = await next();
if (run.t !== 'run') fatal('expected-run');
const { code: script, methods, limits } = run as Extract<Msg, { t: 'run' }>;
const replies: GuestReply[] = [];
let replyWaiter: ((r: GuestReply | null) => void) | null = null;
const pumpInbox = (): void => {
  while (inbox.length > 0) {
    const m = inbox.shift()!;
    if (m.t !== 'rpc-result') fatal('unexpected-message');
    const reply = { rid: (m as { rid: number }).rid, ok: (m as { ok: boolean }).ok, value: (m as { value: string }).value };
    if (replyWaiter) { const w = replyWaiter; replyWaiter = null; w(reply); } else replies.push(reply);
  }
};
waiter = null;
rl.on('line', () => pumpInbox());
const outcome = await runGuest(script, methods, limits, {
  send: (call) => send({ t: 'rpc', rid: call.rid, method: call.method, args: call.args }),
  next: (timeoutMs) => {
    pumpInbox();
    const ready = replies.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const t = setTimeout(() => { replyWaiter = null; resolve(null); }, timeoutMs);
      replyWaiter = (r) => { clearTimeout(t); resolve(r); };
    });
  },
});
send({ t: 'done', ...outcome });
process.exit(0);
