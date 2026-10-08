import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityActionResult, capabilityMcpAdd } from '@parley/protocol';
import type { CapabilityMcpAdd, CapabilityMcpTarget } from '@parley/protocol';
import { createCapabilitiesMcpActions, executeMcp, mcpAddArgv, parseClaudeMcpCheck } from './actions.js';
import type { McpExecution, McpExecutor } from './actions.js';
import { allow, deny } from './native-targets.js';
import type { NativeMcpTarget } from './native-targets.js';
import type { SafeCapabilitiesService, SnapshotContext } from './snapshot.js';
let root: string; let context: SnapshotContext;
beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-p17-actions-'))); context = { projectPath: root, homeDir: root, env: { ...process.env, HOME: root }, binaries: { claude: '/fixture/claude', codex: '/fixture/codex' } }; });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const target = (provider: 'claude' | 'codex' = 'claude'): NativeMcpTarget => ({ id: 'OPAQUE_ID', provider, name: 'native-example', scope: 'user', fingerprint: 'fingerprint', remove: allow(), check: provider === 'claude' ? allow() : deny('native-only') });
const targetParams = (provider: 'claude' | 'codex' = 'claude'): CapabilityMcpTarget => ({ projectPath: root, provider, presenceId: 'OPAQUE_ID', revision: 3 });
const addParams = (provider: 'claude' | 'codex' = 'claude'): CapabilityMcpAdd => capabilityMcpAdd.parse({ projectPath: root, provider, scope: 'user', name: 'new-example', revision: 3, input: { kind: 'stdio', command: 'node', args: ['server.js', 'SECRET with spaces'], env: { TOKEN: 'SECRET' } } });
const prepared = (provider: 'claude' | 'codex' = 'claude') => ({ ok: true as const, context, target: target(provider), inventory: {
 contextFingerprint: 'context', signature: 'signature', names: ['native-example'], targets: [target(provider)], add: { user: allow(), project: provider === 'claude' ? allow() : deny('unsupported-scope'), local: provider === 'claude' ? allow() : deny('unsupported-scope') },
}, checkProof: 'captured-check-proof', isCurrent: () => true });
function service() {
 return { get: vi.fn(), refresh: vi.fn(), recordMcpCheck: vi.fn(() => true), dispose: vi.fn(), preparePluginAction: vi.fn<SafeCapabilitiesService['preparePluginAction']>(async () => ({ ok: false, code: 'unverified' })), prepareMcpAction: vi.fn<SafeCapabilitiesService['prepareMcpAction']>(async params => prepared(params.provider)) } satisfies SafeCapabilitiesService;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('confirmed native MCP argv', () => {
 it('preserves argv boundaries, explicit Claude scopes and repeated stdio env', () => {
  for (const scope of ['user', 'project', 'local'] as const) expect(mcpAddArgv({ ...addParams(), scope })).toEqual(['mcp', 'add', '--scope', scope, 'new-example', '-e', 'TOKEN=SECRET', '--', 'node', 'server.js', 'SECRET with spaces']);
  expect(mcpAddArgv(addParams('codex'))).toEqual(['mcp', 'add', 'new-example', '--env', 'TOKEN=SECRET', '--', 'node', 'server.js', 'SECRET with spaces']);
 });
 it('uses provider-specific HTTP flags and JSON conversion without dropping fields', () => {
  const claude = capabilityMcpAdd.parse({ ...addParams(), input: { kind: 'http', url: 'https://example.test/SECRET', headers: { Authorization: 'SECRET' } } });
  expect(mcpAddArgv(claude)).toEqual(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'new-example', '--header', 'Authorization: SECRET', '--', 'https://example.test/SECRET']);
  const codex = capabilityMcpAdd.parse({ ...addParams('codex'), input: { kind: 'json', server: { type: 'http', url: 'https://example.test/SECRET', bearer_token_env_var: 'TOKEN' } } });
  expect(mcpAddArgv(codex)).toEqual(['mcp', 'add', 'new-example', '--url', 'https://example.test/SECRET', '--bearer-token-env-var', 'TOKEN']);
  const json = capabilityMcpAdd.parse({ ...addParams(), input: { kind: 'json', server: { command: 'node', args: ['SECRET'], env: { KEY: 'SECRET' } } } });
  expect(mcpAddArgv(json)).toEqual(['mcp', 'add-json', '--scope', 'user', 'new-example', JSON.stringify(json.input.kind === 'json' ? json.input.server : {})]);
 });
});

describe('private selectors and result boundaries', () => {
 it('removes exact native identity, never opaque/redacted display identity, and refreshes after success', async () => {
  const state = service(); const execute = vi.fn<McpExecutor>(async (): Promise<McpExecution> => ({ code: 'ok', exitCode: 0, stdout: Buffer.from('OUTPUT_SECRET') }));
  const actions = createCapabilitiesMcpActions(state, execute);
  const result = await actions.remove(targetParams());
  expect(execute.mock.calls[0]?.[1]).toEqual(['mcp', 'remove', '--scope', 'user', 'native-example']);
  expect(state.refresh).toHaveBeenCalledWith(root); expect(result).toEqual({ outcome: 'ok', code: 'ok', exitCode: 0 });
  expect(capabilityActionResult.safeParse(result).success).toBe(true); expect(JSON.stringify(result)).not.toContain('SECRET'); actions.dispose();
 });
 it('provides positive Codex user removal with no guessed scope flag', async () => {
  const execute = vi.fn<McpExecutor>(async (): Promise<McpExecution> => ({ code: 'ok' })); const actions = createCapabilitiesMcpActions(service(), execute);
  await actions.remove(targetParams('codex'));
  expect(execute.mock.calls[0]?.[1]).toEqual(['mcp', 'remove', 'native-example']); actions.dispose();
 });
 it('denies stale/context-changed/unknown/builtin targets and never dispatches their name', async () => {
  for (const code of ['stale', 'context-changed', 'unverified', 'builtin'] as const) {
    const state = service(); state.prepareMcpAction.mockResolvedValue({ ok: false, code });
    const execute = vi.fn(); const actions = createCapabilitiesMcpActions(state, execute);
    expect(await actions.remove(targetParams())).toEqual({ outcome: 'denied', code }); expect(execute).not.toHaveBeenCalled(); actions.dispose();
  }
 });
 it('rejects duplicate adds, unsupported input and final generation changes before spawn', async () => {
  const state = service(); const execute = vi.fn(); const actions = createCapabilitiesMcpActions(state, execute);
  expect((await actions.add({ ...addParams(), name: 'native-example' })).code).toBe('conflict');
  expect((await actions.add({ ...addParams('codex'), scope: 'project' })).code).toBe('invalid-input');
  state.prepareMcpAction.mockResolvedValue({ ...prepared(), isCurrent: () => false });
  expect((await actions.remove(targetParams())).code).toBe('stale'); expect(execute).not.toHaveBeenCalled(); actions.dispose();
 });
 it('returns safe codes for raw exceptions and failure output, refreshing after attempted execution', async () => {
  const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error'); const state = service();
  const actions = createCapabilitiesMcpActions(state, async () => { throw new Error('OUTPUT_SECRET'); });
  expect(await actions.add(addParams())).toEqual({ outcome: 'failed', code: 'cli-error' });
  expect(state.refresh).toHaveBeenCalledTimes(1); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); actions.dispose();
 });
});

describe('global per-provider queue and shutdown', () => {
 it('serializes across projects while the other provider can proceed', async () => {
  const first = deferred<McpExecution>(); const starts: string[] = [];
  const execute = vi.fn(async (binary: string) => { starts.push(binary); return binary.includes('claude') && starts.filter(item => item.includes('claude')).length === 1 ? first.promise : { code: 'ok' as const }; });
  const state = service(); const actions = createCapabilitiesMcpActions(state, execute);
  const a = actions.add(addParams()); const b = actions.add({ ...addParams(), projectPath: '/other-project' }); const c = actions.add(addParams('codex'));
  await vi.waitFor(() => expect(starts).toEqual(['/fixture/claude', '/fixture/codex'])); await c;
  first.resolve({ code: 'ok' }); await Promise.all([a, b]); expect(starts).toEqual(['/fixture/claude', '/fixture/codex', '/fixture/claude']); actions.dispose();
 });
 it('revalidates queued work only when its provider slot is available', async () => {
  const first = deferred<McpExecution>(); const state = service(); const execute = vi.fn(async () => first.promise); const actions = createCapabilitiesMcpActions(state, execute);
  const a = actions.add(addParams()); const b = actions.remove(targetParams());
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1)); expect(state.prepareMcpAction).toHaveBeenCalledTimes(1);
  state.prepareMcpAction.mockResolvedValue({ ok: false, code: 'stale' });
  first.resolve({ code: 'ok' }); await a; expect(await b).toEqual({ outcome: 'denied', code: 'stale' }); expect(execute).toHaveBeenCalledTimes(1); actions.dispose();
 });
 it('cancels queued work, aborts active work and suppresses late refresh after shutdown', async () => {
  const first = deferred<McpExecution>(); let signal: AbortSignal | undefined;
  const state = service(); const actions = createCapabilitiesMcpActions(state, async (_binary, _args, _context, value) => { signal = value; return first.promise; });
  const a = actions.add(addParams()); const b = actions.remove(targetParams()); await vi.waitFor(() => expect(signal).toBeDefined());
  actions.dispose(); expect(signal?.aborted).toBe(true); expect(await a).toEqual({ outcome: 'cancelled', code: 'shutdown' }); expect(await b).toEqual({ outcome: 'cancelled', code: 'shutdown' });
  first.resolve({ code: 'ok', stdout: Buffer.from('LATE_SECRET') }); await new Promise(resolve => setTimeout(resolve, 10)); expect(state.refresh).not.toHaveBeenCalled();
 });
});

describe('explicit native Check', () => {
 it('records only exact whitelisted name/scope health and preserves safe unknown on unknown output', async () => {
  const output = Buffer.from('native-example:\n  Scope: User config (available in all projects)\n  Status: ✔ Connected\n  Environment: SECRET\n');
  const state = service(); const actions = createCapabilitiesMcpActions(state, async () => ({ code: 'ok', stdout: output }));
  expect(await actions.check(targetParams())).toEqual({ outcome: 'ok', code: 'ok', status: 'ok' });
  expect(state.recordMcpCheck).toHaveBeenCalledWith(root, 'claude', target(), 'ok', 'captured-check-proof'); actions.dispose();
  expect(parseClaudeMcpCheck(Buffer.from('different:\n Scope: User config\n Status: ✔ Connected'), target())).toBeNull();
  expect(parseClaudeMcpCheck(Buffer.from('native-example:\n Scope: Project config\n Status: ✔ Connected'), target())).toBeNull();
  expect(parseClaudeMcpCheck(Buffer.from('native-example:\n Scope: User config\n Status: future SECRET'), target())).toBeNull();
 });
 it('never invokes guessed Codex health command or ambiguous Claude scope', async () => {
  const execute = vi.fn(); const state = service(); const actions = createCapabilitiesMcpActions(state, execute);
  expect(await actions.check(targetParams('codex'))).toEqual({ outcome: 'unavailable', code: 'native-only', recovery: 'native-mcp' });
  state.prepareMcpAction.mockResolvedValue({ ...prepared(), target: { ...target(), check: deny('ambiguous') } });
  expect(await actions.check(targetParams())).toEqual({ outcome: 'unavailable', code: 'ambiguous' }); expect(execute).not.toHaveBeenCalled(); actions.dispose();
 });
});

it('executes a real isolated stub without shell and drops success/failure secrets from the action response', async () => {
 const script = path.join(root, 'native stub.cjs');
 await writeFile(script, "process.stdout.write('OUTPUT_SECRET'); process.stderr.write('ERROR_SECRET'); process.exit(process.argv.includes('failure')?7:0)");
 const result = await executeMcp(process.execPath, [script, 'arg with spaces'], context, new AbortController().signal);
 expect(result.code).toBe('ok'); expect(result.stdout?.toString()).toBe('OUTPUT_SECRET');
 const failure = await executeMcp(process.execPath, [script, 'failure'], context, new AbortController().signal);
 expect(failure).toEqual({ code: 'cli-error', exitCode: 7 }); expect(JSON.stringify(failure)).not.toContain('SECRET');
});


it('bounds real child output and aborts a running native stub without exposing output', async () => {
 const script = path.join(root, 'bounded-native.cjs');
 await writeFile(script, "if(process.argv[2]==='large'){process.stdout.write('OUTPUT_SECRET'.repeat(180000));}else{process.stdout.write('OUTPUT_SECRET');setInterval(()=>{},1000);}");
 const warn = vi.spyOn(console, 'warn'); const error = vi.spyOn(console, 'error');
 expect(await executeMcp(process.execPath, [script, 'large'], context, new AbortController().signal)).toEqual({ code: 'output-limit' });
 const controller = new AbortController();
 const pending = executeMcp(process.execPath, [script, 'wait'], context, controller.signal);
 controller.abort();
 expect(await pending).toEqual({ code: 'shutdown' });
 expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
