import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { agentEnv } from '../providers.js';
import type { CodexRoleLayer } from './codex.js';
import type { RoleDiagnostic } from './types.js';

export interface CodexRoleContext {
  layers: CodexRoleLayer[];
  diagnostics: RoleDiagnostic[];
  verified: boolean;
}
export interface CodexContextOptions {
  cwd: string;
  command?: string;
  /** Only the actual runner's literal -c/--config overrides; never generated layer placeholders. */
  configArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** A named profile is unsupported by the pinned app-server interface. */
  profile?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Internal transport injection for isolated fixtures; never exposed in protocol input. */
  start?: typeof startServer;
}
function startServer(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { cwd, env, stdio: 'pipe', windowsHide: true });
}
const mapping = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const failed = (code: RoleDiagnostic['code'] = 'context-unverified'): CodexRoleContext => ({
  layers: [], diagnostics: [{ source: 'codex', code }], verified: false,
});

// rust-v0.156.1 config/src/config_toml.rs AgentsToml: all other keys are flattened role declarations.
// https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/config_toml.rs
const tunings = new Set(['enabled', 'max_concurrent_threads_per_session', 'max_threads', 'max_depth',
  'default_subagent_model', 'default_subagent_reasoning_effort', 'job_max_runtime_seconds', 'interrupt_message']);
function declaredRoles(config: Record<string, unknown>): boolean | null {
  if (!Object.hasOwn(config, 'agents')) return false;
  if (!mapping(config.agents)) return null;
  let declared = false;
  for (const [key, value] of Object.entries(config.agents)) {
    if (!tunings.has(key)) {
      if (!mapping(value) ||
        (value.description !== undefined && typeof value.description !== 'string') ||
        (value.config_file !== undefined && typeof value.config_file !== 'string') ||
        (value.nickname_candidates !== undefined && (!Array.isArray(value.nickname_candidates) || !value.nickname_candidates.every(item => typeof item === 'string')))) return null;
      declared = true;
    } else if (key === 'enabled' || key === 'interrupt_message') {
      if (typeof value !== 'boolean') return null;
    } else if (key === 'default_subagent_model' || key === 'default_subagent_reasoning_effort') {
      if (typeof value !== 'string' || (key === 'default_subagent_reasoning_effort' && value === '')) return null;
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      (key === 'max_depth' ? value < -2147483648 || value > 2147483647 : value < 0) ||
      ((key === 'max_threads' || key === 'max_concurrent_threads_per_session') && value === 0)) return null;
  }
  if (Object.hasOwn(config.agents, 'max_threads') && Object.hasOwn(config.agents, 'max_concurrent_threads_per_session')) return null;
  return declared;
}

/** Whitelist projection only. Unknown requirements/layers never masquerade as an empty policy. */
export function projectCodexRoleContext(configResult: unknown, requirementsResult: unknown): CodexRoleContext {
  if (!mapping(configResult) || !Array.isArray(configResult.layers) || configResult.layers.length > 128 ||
    !mapping(requirementsResult) || !Object.hasOwn(requirementsResult, 'requirements') || requirementsResult.requirements !== null)
    return failed();
  const layers: CodexRoleLayer[] = [];
  for (const layer of [...configResult.layers].reverse()) {
    if (!mapping(layer) || !mapping(layer.name)) return failed();
    if (layer.disabledReason !== undefined && layer.disabledReason !== null) {
      if (typeof layer.disabledReason !== 'string') return failed();
      continue;
    }
    if (typeof layer.version !== 'string' || !mapping(layer.config)) return failed();
    const declared = declaredRoles(layer.config);
    if (declared === null) return failed();
    if (declared) return failed('unsupported-config');
    const type = layer.name.type;
    let folder: string | undefined;
    if (type === 'user' || type === 'system') {
      if (typeof layer.name.file !== 'string' || !path.isAbsolute(layer.name.file)) return failed();
      if (type === 'user' && layer.name.profile !== undefined && layer.name.profile !== null) return failed();
      folder = path.dirname(layer.name.file);
    } else if (type === 'project') {
      if (typeof layer.name.dotCodexFolder !== 'string' || !path.isAbsolute(layer.name.dotCodexFolder)) return failed();
      folder = layer.name.dotCodexFolder;
    } else if (!['packagedDefaults', 'mdm', 'enterpriseManaged', 'sessionFlags', 'legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm'].includes(String(type))) return failed();
    if (folder !== undefined) layers.push({ configFolder: folder, hasDeclaredRoles: false });
  }
  return { layers, diagnostics: [], verified: true };
}

/** Native config read only: no thread/model turn, shell, raw output logs or manual trust merge. */
export async function readCodexRoleContext(options: CodexContextOptions): Promise<CodexRoleContext> {
  if (options.profile !== undefined || !path.isAbsolute(options.cwd)) return failed();
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? 4194304;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4194304) return failed();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (options.start ?? startServer)(options.command ?? 'codex', [...(options.configArgs ?? []), 'app-server', '--stdio'],
      options.cwd, agentEnv(options.env ?? process.env));
  } catch { return failed(); }
  let buffer = Buffer.alloc(0);
  let bytes = 0;
  const responses = new Map<number, { resolve: (value: unknown) => void; reject: () => void }>();
  let failedTransport = false;
  const abort = (): void => {
    failedTransport = true;
    for (const waiting of responses.values()) waiting.reject();
    responses.clear();
  };
  const timer = setTimeout(abort, timeoutMs);
  child.on('error', abort);
  child.on('exit', abort);
  child.stdin.on('error', abort);
  child.stdout.on('error', abort);
  child.stderr.on('error', abort);
  child.stderr.on('data', (data: Buffer) => {
    bytes += data.length;
    if (bytes > maxBytes) abort();
  });
  child.stdout.on('data', (data: Buffer) => {
    bytes += data.length;
    if (bytes > maxBytes) { abort(); return; }
    buffer = Buffer.concat([buffer, data]);
    let newline: number;
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        if (!mapping(value)) { abort(); return; }
        const response = typeof value.id === 'number' ? responses.get(value.id) : undefined;
        if (response) {
          responses.delete(value.id as number);
          if (Object.hasOwn(value, 'error') || !Object.hasOwn(value, 'result')) response.reject();
          else response.resolve(value.result);
        }
      } catch { abort(); return; }
    }
  });
  const request = (id: number, method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (failedTransport) { reject(new Error('context-unverified')); return; }
    responses.set(id, { resolve, reject: () => reject(new Error('context-unverified')) });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => { if (error) abort(); });
  });
  try {
    await request(1, 'initialize', { clientInfo: { name: 'parley_roles', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    const config = await request(2, 'config/read', { cwd: options.cwd, includeLayers: true });
    const requirements = await request(3, 'configRequirements/read', {});
    return projectCodexRoleContext(config, requirements);
  } catch { return failed(); }
  finally {
    clearTimeout(timer);
    abort();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const kill = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
        child.once('exit', () => { clearTimeout(kill); resolve(); });
      });
    }
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
