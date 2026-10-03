import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import type { SkillCatalog } from '@parley/core';
import type { CapabilityDiagnostic, CapabilityPresence, CapabilityRow } from '@parley/protocol';

export interface SnapshotEntry { kind: CapabilityRow['kind']; name: string; rowId?: string; presence: CapabilityPresence }
export const nativeIdentity = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const rowIdentity = (kind: CapabilityRow['kind'], name: string, provider?: string): string => nativeIdentity(kind, name, kind === 'plugin' ? provider : null);
export type JsonRead = { status: 'valid'; data: unknown } | { status: 'missing' } | { status: 'invalid'; code: CapabilityDiagnostic['code'] };
export interface NativeReadContext { projectPath: string; env?: NodeJS.ProcessEnv }
export type NativeJsonReader = (binary: string | null, args: readonly string[], context: NativeReadContext) => Promise<JsonRead>;
export const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const decoder = (): TextDecoder => new TextDecoder('utf-8', { fatal: true });

/** Descriptor-first nonblocking read prevents FIFO/TOCTOU hangs; raw errors never escape. */
export async function readJsonFile(file: string, ceiling = 32 * 1024 * 1024): Promise<JsonRead> {
  const max = Number.isSafeInteger(ceiling) && ceiling > 0 ? Math.min(ceiling, 32 * 1024 * 1024) : 32 * 1024 * 1024;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { status: 'invalid', code: 'unreadable' };
      if (info.size > max) return { status: 'invalid', code: 'output-limit' };
      const buffer = Buffer.alloc(Math.min(info.size + 1, max + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > max || length === buffer.length && length !== 0)
        return { status: 'invalid', code: 'output-limit' };
      try { return { status: 'valid', data: JSON.parse(decoder().decode(buffer.subarray(0, length)).replace(/^\uFEFF/, '')) as unknown }; }
      catch { return { status: 'invalid', code: 'invalid-config' }; }
    } finally { await handle.close(); }
  } catch (error) {
    return object(error)?.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid', code: 'unreadable' };
  }
}

/** No shell, stdin EOF and bounded timeout/output. CLI output and exceptions stay local. */
export const readNativeJson = (binary: string | null, args: readonly string[], context: NativeReadContext,
  limits: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<JsonRead> => {
  if (binary === null) return Promise.resolve({ status: 'invalid', code: 'unavailable' });
  return new Promise(resolve => {
    const child = execFile(binary, [...args], { cwd: context.projectPath,
      ...(context.env ? { env: context.env } : {}), encoding: 'buffer',
      timeout: Math.max(1, Math.min(limits.timeoutMs ?? 15_000, 15_000)), maxBuffer: Math.max(1, Math.min(limits.maxBuffer ?? 4 * 1024 * 1024, 4 * 1024 * 1024)), killSignal: 'SIGKILL', windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        const code = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit'
          : error.killed ? 'timeout' : error.code === 'ENOENT' ? 'unavailable' : 'invalid-output';
        resolve({ status: 'invalid', code });
        return;
      }
      try { resolve({ status: 'valid', data: JSON.parse(decoder().decode(stdout)) as unknown }); }
      catch { resolve({ status: 'invalid', code: 'invalid-output' }); }
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
};

const REDACTION_OVERFLOW = '\u0000redaction-overflow';
export function secretValues(value: unknown): string[] {
  const values = new Set<string>();
  let left = 100_000;
  const collect = (item: unknown, sensitive: boolean, depth: number): void => {
    if (--left < 0 || depth > 12 || values.size > 256) { values.add(REDACTION_OVERFLOW); return; }
    if (typeof item === 'string') {
      if (sensitive && item !== '') {
        values.add(item);
        const credential = /^(?:Bearer|Basic)\s+(\S+)$/i.exec(item)?.[1];
        const assignment = /^(?:--?[^=\s]+|[A-Za-z_][A-Za-z0-9_]*)=(.+)$/.exec(item)?.[1];
        if (credential) values.add(credential); if (assignment) values.add(assignment);
        try {
          const url = new URL(item);
          for (const part of [url.username, url.password, ...url.searchParams.values(), ...url.pathname.split('/')])
            if (part) values.add(decodeURIComponent(part));
        } catch { /* Non-URL values remain opaque secrets. */ }
      }
      return;
    }
    if (Array.isArray(item)) { for (const entry of item) { collect(entry, sensitive, depth + 1); if (values.has(REDACTION_OVERFLOW)) break; } return; }
    const data = object(item);
    if (data) for (const [key, entry] of Object.entries(data)) {
      if (values.has(REDACTION_OVERFLOW)) break;
      if (key.endsWith('_env_var') || key === 'env_vars' || key === 'env_http_headers') continue;
      collect(entry, sensitive || /^(env|args|headers|http_headers|url)$|token|password|secret|api.?key/i.test(key), depth + 1);
    }
  };
  collect(value, false, 0);
  if (values.size > 256) values.add(REDACTION_OVERFLOW);
  return [...values].sort((a, b) => b.length - a.length);
}
export function safeText(value: unknown, secrets: readonly string[] = []): string | null {
  if (typeof value !== 'string' || secrets.includes(REDACTION_OVERFLOW)) return null;
  let result = Array.from(value.slice(0, 65_536)).filter(character => { const code = character.codePointAt(0)!; return code >= 32 && code !== 127 || character === '\n' || character === '\r' || character === '\t'; }).join('');
  result = result.replace(/(?:https?|file):\/\/[^\s<>]+/gi, text => {
    try { const url = new URL(text); return url.protocol === 'file:' ? '[redacted URL]' : `${url.protocol}//${url.host}`; }
    catch { return '[redacted URL]'; }
  });
  for (const secret of secrets) if (secret !== '') result = result.split(secret).join('[redacted]');
  return result === '' ? null : result;
}

export function mcpSummary(value: unknown): string | null {
  const data = object(value); if (!data) return null;
  const secrets = secretValues(value);
  if (secrets.includes(REDACTION_OVERFLOW)) return null;
  if (typeof data.url === 'string') {
    try {
      const url = new URL(data.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const envHeaders = object(data.env_http_headers);
      const names = [data.bearer_token_env_var, ...(Array.isArray(data.env_vars) ? data.env_vars : []), ...Object.values(envHeaders ?? {})]
        .filter((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      return safeText(`${url.protocol.slice(0, -1)} · ${url.host}${names.length ? ` · env: ${[...new Set(names)].sort().join(', ')}` : ''}`, secrets);
    } catch { return null; }
  }
  if (typeof data.command !== 'string') return null;
  const command = data.command.split(/[\\/]/).at(-1) ?? '';
  const args = Array.isArray(data.args) ? data.args : [];
  let summary = `${command} · ${args.length} args`;
  const index = command === 'pnpm' && args[0] === 'dlx' ? 1 : 0;
  if (['npx', 'bunx', 'uvx', 'pipx'].includes(command) || command === 'pnpm' && index === 1) {
    const candidate = args[index];
    if (typeof candidate === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.^~*-]+)?$/.test(candidate))
      summary = `${command}${index === 1 ? ' dlx' : ''} ${candidate} · +${Math.max(0, args.length - index - 1)} args`;
  }
  const env = object(data.env);
  const names = [...(env ? Object.keys(env) : []), ...(Array.isArray(data.env_vars) ? data.env_vars : [])]
    .filter((name): name is string => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (names.length) summary += ` · env: ${[...new Set(names)].sort().join(', ')}`;
  // Arguments are not projected; a permitted package identifier is metadata, not a raw arg summary.
  return safeText(summary, secretValues({ ...data, args: [] }));
}

export function projectSkills(catalog: SkillCatalog): SnapshotEntry[] {
  return catalog.skills.map(skill => {
    const reason = skill.unavailableReason;
    const unknown = reason === 'availability-unverified' || reason === 'load-tool-unavailable' || reason === 'invalid-metadata';
    const disabled = reason === 'human-disabled' || reason === 'plugin-disabled' || reason === 'shadowed';
    return { kind: 'skill', name: skill.name, rowId: rowIdentity('skill', skill.name), presence: {
      id: JSON.stringify([skill.provider, 'skill', skill.path]), scope: skill.source,
      source: skill.path, documentPath: skill.path, description: safeText(skill.description), installed: true,
      enabled: unknown ? null : !disabled, status: unknown ? 'unknown' : reason ? 'off' : 'ok',
      summary: null, modelAvailable: skill.modelAvailable, unavailableReason: reason,
    } };
  });
}
