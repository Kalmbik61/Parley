import { createProviderScheduler } from './scheduler.js';
import type { ProviderScheduler } from './scheduler.js';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { capabilityMcpAdd, capabilityMcpTarget } from '@parley/protocol';
import type { CapabilityActionResult, CapabilityMcpAdd, CapabilityMcpTarget, CapabilityProvider, CapabilityPresence } from '@parley/protocol';
import type { SafeCapabilitiesService, SnapshotContext } from './snapshot.js';
import type { NativeMcpTarget } from './native-targets.js';

export interface McpExecution { code: 'ok' | 'cli-error' | 'timeout' | 'output-limit' | 'not-installed' | 'shutdown'; exitCode?: number; stdout?: Buffer }
export type McpExecutor = (binary: string, args: readonly string[], context: SnapshotContext, signal: AbortSignal) => Promise<McpExecution>;
/** Secret output is consumed privately, including successful add/remove output. No logging. */
export const executeMcp: McpExecutor = (binary, args, context, signal) => new Promise(resolve => {
  let child: ReturnType<typeof execFile>;
  try {
    child = execFile(binary, [...args], { cwd: context.projectPath, env: context.env, encoding: 'buffer',
      timeout: 15_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', signal, windowsHide: true }, (error, stdout) => {
      if (signal.aborted) { resolve({ code: 'shutdown' }); return; }
      if (error) {
        const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
          : error.killed ? 'timeout' : error.code === 'ENOENT' ? 'not-installed' : 'cli-error';
        resolve({ code, ...(typeof error.code === 'number' && error.code >= 0 && error.code <= 255 ? { exitCode: error.code } : {}) });
      } else resolve({ code: 'ok', exitCode: 0, stdout });
    });
    child.stdin?.on('error', () => {}); child.stdin?.end();
  } catch { resolve({ code: signal.aborted ? 'shutdown' : 'cli-error' }); }
});

export function mcpAddArgv(request: CapabilityMcpAdd): string[] {
  const { provider, scope, name, input } = request;
  if (input.kind === 'json' && provider === 'claude') return ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(input.server)];
  const server = input.kind === 'json' ? input.server : input;
  if ('command' in server) {
    const flags = Object.entries(server.env ?? {}).flatMap(([key, value]) => [provider === 'claude' ? '-e' : '--env', `${key}=${value}`]);
    return ['mcp', 'add', ...(provider === 'claude' ? ['--scope', scope] : []), name, ...flags, '--', server.command, ...(server.args ?? [])];
  }
  if (provider === 'claude') return ['mcp', 'add', '--transport', 'http', '--scope', scope, name,
    ...Object.entries(server.headers ?? {}).flatMap(([key, value]) => ['--header', `${key}: ${value}`]), '--', server.url];
  const bearer = 'bearerTokenEnvVar' in server ? server.bearerTokenEnvVar : 'bearer_token_env_var' in server ? server.bearer_token_env_var : undefined;
  return ['mcp', 'add', name, '--url', server.url, ...(bearer ? ['--bearer-token-env-var', bearer] : [])];
}

/** P03 targeted get fixture only: exact native identity/scope, one known status line. */
export function parseClaudeMcpCheck(stdout: Buffer | undefined, target: NativeMcpTarget): CapabilityPresence['status'] | null {
  if (!stdout || stdout.length > 1024 * 1024) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(stdout); } catch { return null; }
  const lines = text.replaceAll('\r\n', '\n').split('\n').map(line => line.trim());
  if (lines[0] !== `${target.name}:`) return null;
  const scopes = lines.filter(line => line.startsWith('Scope:'));
  if (scopes.length !== 1 || !scopes[0]?.startsWith(`Scope: ${target.scope[0]!.toUpperCase()}${target.scope.slice(1)} config`)) return null;
  const statuses = lines.filter(line => line.startsWith('Status:'));
  if (statuses.length !== 1) return null;
  const status = statuses[0]!;
  if (/^Status: [✔✓] Connected$/.test(status)) return 'ok';
  if (/^Status: ⏸ Pending approval(?: |$)/.test(status)) return 'pending-approval';
  if (/^Status: ✘ Failed to connect(?: |$)/.test(status)) return 'failed';
  return null;
}

export interface CapabilitiesMcpActions {
  add(params: CapabilityMcpAdd): Promise<CapabilityActionResult>;
  remove(params: CapabilityMcpTarget): Promise<CapabilityActionResult>;
  check(params: CapabilityMcpTarget): Promise<CapabilityActionResult>;
  dispose(): void;
}
export function createCapabilitiesMcpActions(service: SafeCapabilitiesService, executor: McpExecutor = executeMcp, sharedScheduler?: ProviderScheduler): CapabilitiesMcpActions {
  const scheduler = sharedScheduler ?? createProviderScheduler();
  let disposed = false;
  const shutdown = (): CapabilityActionResult => ({ outcome: 'cancelled', code: 'shutdown' });
  const enqueue = (provider: CapabilityProvider, run: (signal: AbortSignal) => Promise<CapabilityActionResult>): Promise<CapabilityActionResult> => {
    if (disposed) return Promise.resolve(shutdown());
    return scheduler.run(provider, async signal => disposed ? shutdown() : run(signal))
      .catch(() => disposed ? shutdown() : { outcome: 'failed', code: 'cli-error' });
  };
  const action = (kind: 'add' | 'remove' | 'check', params: CapabilityMcpAdd | CapabilityMcpTarget): Promise<CapabilityActionResult> => {
    const parsed = (kind === 'add' ? capabilityMcpAdd : capabilityMcpTarget).safeParse(params);
    if (!parsed.success || !path.isAbsolute(params.projectPath)) return Promise.resolve({ outcome: 'denied', code: 'invalid-input' });
    return enqueue(params.provider, async signal => {
      const prepared = await service.prepareMcpAction(params);
      if (disposed || signal.aborted) return shutdown();
      if (!prepared.ok) return { outcome: 'denied', code: prepared.code };
      const target = prepared.target;
      const support = kind === 'add' ? prepared.inventory.add[(params as CapabilityMcpAdd).scope] : target?.[kind];
      if (!support?.allowed) return { outcome: 'unavailable', code: support?.reason ?? 'unverified',
        ...(support?.reason === 'native-only' ? { recovery: 'native-mcp' as const } : {}) };
      if (kind === 'add' && prepared.inventory.names.includes((params as CapabilityMcpAdd).name)) return { outcome: 'denied', code: 'conflict' };
      if (!prepared.isCurrent()) return { outcome: 'denied', code: 'stale' };
      const binary = prepared.context.binaries[params.provider];
      if (!binary) return { outcome: 'unavailable', code: 'not-installed' };
      const argv = kind === 'add' ? mcpAddArgv(params as CapabilityMcpAdd)
        : kind === 'remove' ? ['mcp', 'remove', ...(params.provider === 'claude' ? ['--scope', target!.scope] : []), target!.name]
        : ['mcp', 'get', target!.name];
      let executed: McpExecution;
      try { executed = await executor(binary, argv, prepared.context, signal); }
      catch { executed = { code: signal.aborted ? 'shutdown' : 'cli-error' }; }
      if (disposed || signal.aborted) return shutdown();
      let result: CapabilityActionResult = { outcome: executed.code === 'ok' ? 'ok' : 'failed', code: executed.code,
        ...(executed.exitCode === undefined ? {} : { exitCode: executed.exitCode }) };
      if (kind === 'check' && executed.code === 'ok') {
        const status = parseClaudeMcpCheck(executed.stdout, target!);
        if (status === null) result = { outcome: 'failed', code: 'invalid-output', status: 'unknown' };
        else result = service.recordMcpCheck(params.projectPath, params.provider, target!, status, prepared.checkProof)
          ? { outcome: 'ok', code: 'ok', status } : { outcome: 'denied', code: 'context-changed', status: 'unknown' };
      }
      service.refresh(params.projectPath);
      return result;
    });
  };
  return { add: params => action('add', params), remove: params => action('remove', params), check: params => action('check', params),
    dispose() {
      if (disposed) return; disposed = true;
      if (!sharedScheduler) scheduler.dispose();
    },
  };
}
