// The isolated run of Code Mode (plan T12b "bounded isolated launch", lead m-7346): one real Parley launch of a `claude` session in a throwaway
// home, with zero model turns, and a record of what that launch decided and met. It changes no product file and runs nothing paid.
//
//   pnpm exec tsx tools/code-mode-isolated-run.ts [--app <Parley.app>] [--out <report.json>] [--keep]
//
// What one run does:
//   1. refuses, by name, a home or project that is or lies under a real Parley home (~/.parley, ~/.harnas, the caller's PARLEY_HOME or
//      HARNAS_HOME) or outside the system temp directory; any option that names a live workspace; and any option or variable that would let a
//      provider start a turn;
//   2. makes a temporary PARLEY_HOME and a synthetic project, starts the host there (this tree's packages/host/dist, or the packaged one of
//      `--app` under its embedded node), creates a workspace and one `claude` session with an empty task through the host's own protocol;
//   3. first resolves the real `claude` the way the host would without the stub (PATH) and records `claude --version` (no turn); no claude, no run;
//   4. the host's real launch spawns tools/code-mode-isolated-run-stub.mjs in place of `claude`: it answers the host's version probe with that
//      version, records its argv, cwd and environment and waits. So the launch decision, the MCP config and the settings file are the product's
//      own for this claude, and no model is called;
//   5. records, read-only, the hooks and plugins of every settings source that launch would load (event names, counts and plugin names only),
//      the detector's verdict for the claude row, the launch decision the host wrote, and the session's Code Mode state from the host;
//   6. stops the session and the host, and removes the home unless `--keep`.
//
// What it does not isolate (s-296 N1, m-7494): the host runs with the caller's real HOME and PATH, because the settings and detector facts are
// the real ~/.claude's. Its provider probes run the installed binaries (claude and codex included) with no turn, and those write their own caches
// under HOME, for example ~/.codex/tmp. "Nothing left behind" holds for processes and the run's temporary directory, not for HOME.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STUB = path.join(ROOT, 'tools', 'code-mode-isolated-run-stub.mjs');

// ---------- refusals ----------

export class IsolatedRunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolatedRunRefused';
  }
}

/** Options that would start or resume a model turn, or hand the session a prompt. Named, so the refusal says which. */
export const PAID_TURN_OPTIONS = ['-p', '--print', '--prompt', '--task', '--message', '--resume', '--continue', '--real-claude'] as const;
/** Options that would point the run at a live workspace or home instead of the one it makes. */
export const LIVE_STORE_OPTIONS = ['--home', '--project', '--work', '--workspace', '--session'] as const;
/**
 * Variables that would put a real provider binary where the stub stands (the host spawns what they name), so a session could start a turn.
 * The run sets its own; one already in the caller's environment is refused rather than silently overridden.
 */
export const PAID_TURN_VARIABLES = ['PARLEY_CLAUDE_BIN', 'HARNAS_CLAUDE_BIN', 'PARLEY_CODEX_BIN', 'HARNAS_CODEX_BIN'] as const;

export interface RunOptions {
  readonly app: string | null;
  readonly out: string | null;
  readonly keep: boolean;
}

export function parseOptions(argv: readonly string[]): RunOptions {
  let app: string | null = null;
  let out: string | null = null;
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if ((PAID_TURN_OPTIONS as readonly string[]).includes(name)) throw new IsolatedRunRefused(`${name} would start a model turn: an isolated run makes none`);
    if ((LIVE_STORE_OPTIONS as readonly string[]).includes(name)) throw new IsolatedRunRefused(`${name} names a home or workspace: an isolated run makes its own and takes none`);
    const value = (): string => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) throw new IsolatedRunRefused(`${name} needs a value`);
      return v;
    };
    if (name === '--app') app = value();
    else if (name === '--out') out = value();
    else if (name === '--keep' && !a.includes('=')) keep = true;
    else throw new IsolatedRunRefused(`unknown option ${a}`);
  }
  return { app, out, keep };
}

export function refusePaidTurnVariables(env: NodeJS.ProcessEnv): void {
  for (const name of PAID_TURN_VARIABLES) {
    if (env[name] !== undefined) throw new IsolatedRunRefused(`${name} is set: it would put a provider binary in the stub's place`);
  }
}

const real = (p: string): string => {
  // A path that does not exist yet is judged by its nearest existing ancestor.
  let at = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(at)) {
    rest.unshift(path.basename(at));
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return path.join(realpathSync(at), ...rest);
};
const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The homes a person's Parley uses: the defaults and whatever the caller's environment names. Each is a live store. */
export function liveHomes(env: NodeJS.ProcessEnv, home: string = homedir()): string[] {
  const out = [path.join(home, '.parley'), path.join(home, '.harnas')];
  for (const name of ['PARLEY_HOME', 'HARNAS_HOME']) {
    const v = env[name];
    if (v !== undefined && v !== '') out.push(v);
  }
  return out.map(real);
}

/**
 * A home or project directory the run may use: strictly inside the system temp directory, and neither equal to nor inside nor around any live
 * home. Anything else is refused by name.
 */
export function refuseLiveDirectory(kind: 'home' | 'project', dir: string, live: readonly string[], temp: string = tmpdir()): void {
  const d = real(dir);
  const t = real(temp);
  for (const h of live) {
    if (within(d, h)) throw new IsolatedRunRefused(`the ${kind} ${dir} is or lies under the live Parley home ${h}`);
    if (within(h, d)) throw new IsolatedRunRefused(`the ${kind} ${dir} contains the live Parley home ${h}`);
  }
  if (d === t || !within(d, t)) throw new IsolatedRunRefused(`the ${kind} ${dir} is not inside the temporary directory ${t}`);
}

// ---------- the host and its protocol ----------

interface HostRpc {
  call<T>(method: string, params: unknown): Promise<T>;
  close(): void;
}

async function connectHost(socket: string, token: string): Promise<HostRpc> {
  const { PROTOCOL_VERSION } = (await import('../packages/protocol/dist/index.js')) as { PROTOCOL_VERSION: number };
  const s = createConnection(socket);
  await new Promise<void>((resolve, reject) => { s.once('connect', resolve); s.once('error', reject); });
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let carry = '';
  s.on('data', (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    for (let at = carry.indexOf('\n'); at >= 0; at = carry.indexOf('\n')) {
      const line = carry.slice(0, at);
      carry = carry.slice(at + 1);
      if (line === '') continue;
      const m = JSON.parse(line) as { id?: number; result?: unknown; error?: { code?: string; message?: string } };
      if (m.id === undefined) continue;
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(`${m.error.code ?? 'error'}: ${m.error.message ?? ''}`));
      else w?.resolve(m.result);
    }
  });
  let id = 0;
  const call = <T>(method: string, params: unknown): Promise<T> => new Promise<T>((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { waiting.delete(n); reject(new Error(`${method}: no answer in 30 s`)); }, 30_000);
    waiting.set(n, { resolve: (v) => { clearTimeout(timer); resolve(v as T); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    s.write(`${JSON.stringify({ id: n, method, params })}\n`);
  });
  await call('hello', { token, protocol: PROTOCOL_VERSION, client: 'code-mode-isolated-run' });
  return { call, close: () => s.destroy() };
}

const until = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ---------- records ----------

interface SettingsFacts {
  readonly file: string;
  readonly exists: boolean;
  readonly hooks: Readonly<Record<string, number>>;
  readonly plugins: readonly string[];
  readonly unreadable?: true;
}

/** Hook event names with their entry counts and enabled plugin names: never commands, environments or other values. */
export function settingsFacts(file: string): SettingsFacts {
  if (!existsSync(file)) return { file, exists: false, hooks: {}, plugins: [] };
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as { hooks?: Record<string, unknown>; enabledPlugins?: Record<string, unknown> };
    const hooks = Object.fromEntries(Object.entries(s.hooks ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
    const plugins = Object.entries(s.enabledPlugins ?? {}).filter(([, on]) => on === true).map(([k]) => k).sort();
    return { file, exists: true, hooks, plugins };
  } catch {
    return { file, exists: true, hooks: {}, plugins: [], unreadable: true };
  }
}

/** The value after `flag` in an argv, or null. */
const argAfter = (argv: readonly string[], flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
};

// ---------- one run ----------

export interface IsolatedRunReport {
  readonly at: string;
  readonly host: { readonly kind: 'dev' | 'packaged'; readonly node: string; readonly entry: string };
  readonly claude: { readonly path: string; readonly version: string; readonly turns: 0 };
  readonly launch: { readonly versionProbes: number; readonly argv: readonly string[]; readonly cwd: string; readonly mcpServers: readonly string[]; readonly codeModeLaunch: boolean };
  readonly decision: unknown;
  readonly codeMode: unknown;
  readonly detector: unknown;
  readonly settings: readonly SettingsFacts[];
  readonly home: string | null;
}

export async function isolatedRun(options: RunOptions, env: NodeJS.ProcessEnv = process.env): Promise<IsolatedRunReport> {
  refusePaidTurnVariables(env);
  const live = liveHomes(env);
  const host = options.app === null
    ? { kind: 'dev' as const, node: process.execPath, entry: path.join(ROOT, 'packages', 'host', 'dist', 'main.js') }
    : { kind: 'packaged' as const, node: path.join(options.app, 'Contents', 'Resources', 'node', 'bin', 'node'), entry: path.join(options.app, 'Contents', 'Resources', 'host', 'dist', 'main.js') };
  if (!existsSync(host.entry)) throw new Error(`no host at ${host.entry}: build it first`);

  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-isolated-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  try {
    refuseLiveDirectory('home', home, live);
    refuseLiveDirectory('project', project, live);
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(project);
  const recordFile = path.join(root, 'launch.json');

  // The real claude, as PATH resolves it with no stub, and its version, which makes no turn. The stub answers the host's own version probe with
  // it, so the host plans the launch it would plan for this claude. No claude: no run.
  const { findBinary } = (await import(path.join(ROOT, 'packages', 'core', 'dist', 'work', 'find-binary.js'))) as { findBinary: (b: string, e: NodeJS.ProcessEnv) => Promise<string> };
  let claudePath: string;
  let version: string;
  try {
    claudePath = await findBinary('claude', { PATH: env['PATH'] ?? '' });
    version = execFileSync(claudePath, ['--version'], { encoding: 'utf8', env: { PATH: env['PATH'] ?? '', HOME: env['HOME'] ?? homedir() }, timeout: 20_000 }).trim();
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`no usable claude on PATH: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Only what a host needs; nothing of the caller's Parley environment crosses.
  const hostEnvironment: Record<string, string> = {
    PATH: env['PATH'] ?? '/usr/bin:/bin',
    HOME: env['HOME'] ?? homedir(),
    PARLEY_HOME: home,
    PARLEY_CLAUDE_BIN: STUB,
    PARLEY_ISOLATED_RECORD: recordFile,
    PARLEY_ISOLATED_CLAUDE_VERSION: version,
    ...(env['TMPDIR'] === undefined ? {} : { TMPDIR: env['TMPDIR'] }),
  };
  let child: ChildProcess | null = null;
  let rpc: HostRpc | null = null;
  try {
    child = spawn(host.node, [host.entry], { env: hostEnvironment, stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const socket = path.join(home, 'host', 'host.sock');
    const tokenFile = path.join(home, 'host', 'host.token');
    await until(() => existsSync(socket) && existsSync(tokenFile), 30_000, `the host socket (stderr: ${stderr.slice(-400)})`);
    rpc = await connectHost(socket, readFileSync(tokenFile, 'utf8').trim());

    const { workId } = await rpc.call<{ workId: string }>('works.create', { projectPath: project, title: `isolated ${randomUUID().slice(0, 8)}`, goal: '' });
    const { ref } = await rpc.call<{ ref: { projectPath: string; workId: string; sessionId: string } }>('sessions.create', { projectPath: project, workId, provider: 'claude', label: 'isolated', task: '', parent: null });
    type Start = { argv: string[]; cwd: string; env: Record<string, string> };
    const starts = (): Start[] => (existsSync(recordFile) ? readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Start) : []);
    const isProbe = (s: Start): boolean => s.argv.includes('--version');
    await until(() => starts().some((s) => !isProbe(s)), 30_000, 'the stub to be launched');
    const all = starts();
    const launched = all.find((s) => !isProbe(s))!;
    const probes = all.filter(isProbe).length;

    const core = (rel: string): Promise<unknown> => import(path.join(ROOT, 'packages', 'core', 'dist', rel));
    const { workPaths } = (await core('work/store.js')) as { workPaths: (p: string, w: string) => { dir: string } };
    const { readLaunchDecision } = (await core('mcp/code-mode/launch-decision.js')) as { readLaunchDecision: (d: string, s: string) => unknown };
    const { providerSourceClasses } = (await core('mcp/code-mode/provider-rows.js')) as { providerSourceClasses: (p: string, c: { cwd: string }) => unknown[] | null };
    const { createDetector } = (await core('mcp/code-mode/detector.js')) as { createDetector: (o: { classes: unknown[] | null; configFile: string }) => { scan(): unknown } };
    const decision = readLaunchDecision(workPaths(project, workId).dir, ref.sessionId);
    const codeMode = await rpc.call('sessions.codeMode', { ref });
    const detector = createDetector({ classes: providerSourceClasses('claude', { cwd: launched.cwd }), configFile: path.join(home, 'config.json') }).scan();

    // The MCP config and settings the launch passed, as the host wrote them.
    const mcpArg = argAfter(launched.argv, '--mcp-config');
    let mcpServers: string[] = [];
    let codeModeLaunch = false;
    if (mcpArg !== null) {
      const text = mcpArg.trimStart().startsWith('{') ? mcpArg : readFileSync(mcpArg, 'utf8');
      const servers = (JSON.parse(text) as { mcpServers?: Record<string, { env?: Record<string, string> }> }).mcpServers ?? {};
      mcpServers = Object.keys(servers).sort();
      codeModeLaunch = Object.values(servers).some((s) => s.env?.['PARLEY_CODE_MODE_LAUNCH'] !== undefined);
    }
    const settingsArg = argAfter(launched.argv, '--settings');
    const configRoot = env['CLAUDE_CONFIG_DIR'] ?? path.join(env['HOME'] ?? homedir(), '.claude');
    const settingsFiles = [
      path.join(configRoot, 'settings.json'),
      path.join(launched.cwd, '.claude', 'settings.json'),
      path.join(launched.cwd, '.claude', 'settings.local.json'),
      ...(settingsArg !== null && !settingsArg.trimStart().startsWith('{') ? [settingsArg] : []),
    ];

    await rpc.call('sessions.stop', { ref }).catch(() => undefined);
    return {
      at: new Date().toISOString(),
      host: { kind: host.kind, node: host.node, entry: host.entry },
      claude: { path: claudePath, version, turns: 0 },
      launch: { versionProbes: probes, argv: launched.argv.map((a) => (a.length > 300 ? `${a.slice(0, 300)}…` : a)), cwd: launched.cwd, mcpServers, codeModeLaunch },
      decision,
      codeMode,
      detector,
      settings: settingsFiles.map(settingsFacts),
      home: options.keep ? root : null,
    };
  } finally {
    rpc?.close();
    if (child !== null && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => { const t = setTimeout(r, 5_000); child!.once('exit', () => { clearTimeout(t); r(undefined); }); });
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    if (!options.keep) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// ---------- main ----------

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    const report = await isolatedRun(options);
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out === null) process.stdout.write(text);
    else {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(options.out, text);
    }
  } catch (e) {
    process.stderr.write(`code-mode-isolated-run: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof IsolatedRunRefused ? 2 : 1;
  }
}
