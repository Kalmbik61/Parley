import { describe, expect, expectTypeOf, it } from 'vitest';
import { capabilityMcpAdd, capabilityMcpTarget, capabilityActionResult } from './capability-actions.js';
import type { CapabilityActionResult } from './capability-actions.js';
import { METHODS } from './methods.js';
import type { Result } from './methods.js';

const base = { projectPath: '/project', provider: 'claude', revision: 3, scope: 'user', name: 'example' };
const stdio = { kind: 'stdio', command: 'node', args: ['server.js', 'argument with spaces'], env: { API_KEY: 'INPUT_SECRET' } };
const http = { kind: 'http', url: 'https://example.test/private?token=INPUT_SECRET', headers: { Authorization: 'INPUT_SECRET' } };

describe('MCP action request wire', () => {
  it('retains explicitly supplied stdio/HTTP values only in validated write requests', () => {
    for (const input of [stdio, http]) expect(capabilityMcpAdd.parse({ ...base, input })).toEqual({ ...base, input });
    for (const scope of ['user', 'project', 'local']) expect(capabilityMcpAdd.safeParse({ ...base, scope, input: stdio }).success).toBe(true);
  });
  it('accepts one strict JSON server and supported Codex conversion fields', () => {
    for (const server of [{ command: 'node', args: ['server.js'], env: { KEY: 'VALUE' } }, { type: 'http', url: 'https://example.test', headers: { Authorization: 'VALUE' } }])
      expect(capabilityMcpAdd.safeParse({ ...base, input: { kind: 'json', server } }).success).toBe(true);
    expect(capabilityMcpAdd.safeParse({ ...base, provider: 'codex', input: { kind: 'http', url: 'https://example.test', bearerTokenEnvVar: 'MCP_TOKEN' } }).success).toBe(true);
    expect(capabilityMcpAdd.safeParse({ ...base, provider: 'codex', input: { kind: 'json', server: { type: 'http', url: 'https://example.test', bearer_token_env_var: 'MCP_TOKEN' } } }).success).toBe(true);
  });
  it.each([
    { provider: 'codex', scope: 'project', input: stdio },
    { provider: 'codex', scope: 'local', input: stdio },
    { provider: 'codex', input: http },
    { provider: 'codex', input: { kind: 'json', server: { type: 'http', url: 'https://example.test', headers: {} } } },
    { input: { kind: 'http', url: 'https://example.test', bearerTokenEnvVar: 'TOKEN' } },
    { input: { kind: 'json', server: { type: 'http', url: 'https://example.test', bearer_token_env_var: 'TOKEN' } } },
    { input: { kind: 'http', url: 'file:///private/secret' } },
    { input: { kind: 'json', server: { type: 'sse', url: 'https://example.test' } } },
    { input: { kind: 'json', server: { mcpServers: { example: { command: 'node' } } } } },
    { input: { kind: 'json', server: { command: 'node', cwd: '/secret' } } },
    { input: { ...stdio, env: { 'INVALID=KEY': 'VALUE' } } },
    { input: { ...http, headers: { Authorization: 'VALUE\r\nInjected: HEADER' } } },
    { input: { ...stdio, args: ['VALUE\0VALUE'] } },
    { name: '../escape', input: stdio },
    { scope: 'system', input: stdio },
    { revision: -1, input: stdio },
    { revision: Number.MAX_SAFE_INTEGER + 1, input: stdio },
    { input: { ...stdio, args: Array.from({ length: 513 }, () => 'x') } },
    { input: { ...stdio, args: Array.from({ length: 20 }, () => 'x'.repeat(4000)) } },
  ])('rejects unsupported/unsafe request without silently losing fields: %j', patch => {
    expect(capabilityMcpAdd.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it('remove/check accept only an opaque presence id, project, provider and revision', () => {
    const target = { projectPath: '/project', provider: 'claude', presenceId: 'opaque-native-presence', revision: 4 };
    expect(capabilityMcpTarget.parse(target)).toEqual(target);
    for (const field of ['name', 'scope', 'nativeName', 'config', 'args', 'stdout', 'stderr'])
      expect(capabilityMcpTarget.safeParse({ ...target, [field]: 'INPUT_SECRET' }).success).toBe(false);
    for (const method of ['capabilities.mcp.remove', 'capabilities.mcp.check'] as const) expect(METHODS[method].parse(target)).toEqual(target);
    expect(METHODS['capabilities.mcp.add'].parse({ ...base, input: stdio })).toEqual({ ...base, input: stdio });
  });
});

describe('MCP action result privacy', () => {
  it('allows safe outcomes, whitelist health and native recovery without request echo', () => {
    const value = { outcome: 'unavailable', code: 'native-only', recovery: 'native-mcp' };
    expect(capabilityActionResult.parse(value)).toEqual(value);
    expect(capabilityActionResult.parse({ outcome: 'ok', code: 'ok', status: 'pending-approval', exitCode: 0 })).toEqual({ outcome: 'ok', code: 'ok', status: 'pending-approval', exitCode: 0 });
    expectTypeOf<Result<'capabilities.mcp.add'>>().toEqualTypeOf<CapabilityActionResult>();
    expectTypeOf<Result<'capabilities.mcp.remove'>>().toEqualTypeOf<CapabilityActionResult>();
    expectTypeOf<Result<'capabilities.mcp.check'>>().toEqualTypeOf<CapabilityActionResult>();
  });
  it('rejects sensitive output even on success and rejects unknown status/code', () => {
    const value = { outcome: 'ok', code: 'ok' };
    for (const field of ['name', 'nativeName', 'config', 'argv', 'stdout', 'stderr', 'message', 'env', 'headers', 'url', 'error', 'input'])
      expect(capabilityActionResult.safeParse({ ...value, [field]: 'OUTPUT_SECRET' }).success).toBe(false);
    for (const patch of [{ code: 'OUTPUT_SECRET' }, { status: 'Connected OUTPUT_SECRET' }, { exitCode: 'OUTPUT_SECRET' }, { recovery: '/private/secret' }])
      expect(capabilityActionResult.safeParse({ ...value, ...patch }).success).toBe(false);
  });
});
