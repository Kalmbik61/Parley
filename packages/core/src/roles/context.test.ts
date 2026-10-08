import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { projectCodexRoleContext, readCodexRoleContext } from './context.js';
const layer = (type: string, config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ name: { type, file: '/config/config.toml', dotCodexFolder: '/project/.codex' }, version: 'v1', config, ...extra });
const project = (layers: unknown[], requirements: unknown = { requirements: null }) => projectCodexRoleContext({ layers }, requirements);
describe('native Codex role context', () => {
  it('reverses high-to-low native layers and trusts the supplied disabled decision', () => {
    expect(project([layer('project'), layer('project', { agents: { forbidden: {} } }, { disabledReason: 'untrusted' }), layer('user'), layer('system')])).toEqual({
      verified: true, diagnostics: [], layers: [{ configFolder: '/config', hasDeclaredRoles: false }, { configFolder: '/config', hasDeclaredRoles: false }, { configFolder: '/project/.codex', hasDeclaredRoles: false }],
    });
  });
  it.each([{}, { requirements: {} }, { requirements: { allowedSandboxModes: [] } }, { requirements: { allowedSandboxModes: null } }, null])('requires the exact requirements null boundary: %j', (requirements) => {
    expect(project([], requirements).verified).toBe(false);
  });
  it('inspects agents declarations in folderless active layers, including overwritten lower layers', () => {
    expect(project([layer('project'), layer('sessionFlags', { agents: { declared: {} } })]).diagnostics[0]?.code).toBe('unsupported-config');
    expect(project([layer('user'), layer('system', { agents: { declared: { description: false } } })]).diagnostics[0]?.code).toBe('context-unverified');
  });
  it('accepts only the exact tuning names and types, without confusing interrupt_message with a role', () => {
    const tuning = { enabled: false, max_threads: 1, max_depth: -1, default_subagent_model: '', default_subagent_reasoning_effort: 'future-native-value', job_max_runtime_seconds: 0, interrupt_message: true };
    expect(project([layer('user', { agents: tuning })]).verified).toBe(true);
    for (const agents of [{ interrupt_message: 'message' }, { max_threads: 0 }, { max_depth: 2147483648 }, { enabled: {} }, { max_threads: 1, max_concurrent_threads_per_session: 1 }, { max_concurrent_threads: {} }]) expect(project([layer('user', { agents })]).verified).toBe(false);
  });
  it('rejects unknown layer, malformed config and named profile', () => {
    expect(project([layer('future')]).verified).toBe(false);
    expect(project([{ ...layer('project'), config: [] }]).verified).toBe(false);
    expect(project([{ ...layer('user'), name: { type: 'user', file: '/config/config.toml', profile: 'named' } }]).verified).toBe(false);
  });
  const start = (mode: string, requests: string[]) => (_command: string, args: readonly string[], cwd: string) => {
    expect(args.slice(-2)).toEqual(['app-server', '--stdio']);
    expect(cwd).toBe('/tmp');
    const code = String.raw`let input=''; process.stdin.on('data', chunk => {input+=chunk;let i;while((i=input.indexOf('\n'))>=0){const line=input.slice(0,i);input=input.slice(i+1);const r=JSON.parse(line);if(!r.id)continue;if(${JSON.stringify(mode)}==='stall')continue;if(${JSON.stringify(mode)}==='bad'){process.stdout.write('not-json\n');continue;}if(${JSON.stringify(mode)}==='large'){process.stderr.write('x'.repeat(2000));continue;}const result=r.method==='config/read'?{layers:[{name:{type:'user',file:'/tmp/config.toml'},version:'v1',config:{}}]}:r.method==='configRequirements/read'?{requirements:null}:{};process.stdout.write(JSON.stringify({id:r.id,result})+'\n');}});`;
    requests.push(code);
    return spawn(process.execPath, ['-e', code], { stdio: 'pipe' });
  };
  it('performs only initialize/config/requirements calls and cleans up a read-only transport', async () => {
    const scripts: string[] = [];
    const result = await readCodexRoleContext({ cwd: '/tmp', start: start('ok', scripts), configArgs: ['-c', 'agents.enabled=false'] });
    expect(result.verified).toBe(true);
    expect(result.layers).toEqual([{ configFolder: '/tmp', hasDeclaredRoles: false }]);
    expect(scripts).toHaveLength(1);
  });
  it.each(['bad', 'large', 'stall'])('bounds malformed, output and deadline failures (%s)', async mode => {
    const result = await readCodexRoleContext({ cwd: '/tmp', start: start(mode, []), maxBytes: 1000, timeoutMs: 200 });
    expect(result).toEqual({ verified: false, layers: [], diagnostics: [{ source: 'codex', code: 'context-unverified' }] });
  });
  it('does not start a process for an unsupported named profile', async () => {
    let called = false;
    expect((await readCodexRoleContext({ cwd: '/tmp', profile: 'custom', start: () => { called = true; throw Error(); } })).verified).toBe(false);
    expect(called).toBe(false);
  });
});

describe('shared native transport', () => {
  it('adds exactly one bounded skills/list read when requested, with actual cwd and forceReload', async () => {
    const { readCodexNativeContext } = await import('./context.js');
    const code = String.raw`let input='',seen=[];process.stdin.on('data',chunk=>{input+=chunk;let i;while((i=input.indexOf('\n'))>=0){let r=JSON.parse(input.slice(0,i));input=input.slice(i+1);seen.push([r.method,r.params]);if(!r.id)continue;let result=r.method==='skills/list'?{seen}:{};process.stdout.write(JSON.stringify({id:r.id,result})+'\n')}});`;
    const result = await readCodexNativeContext({ cwd: '/tmp', start: (_command, args, cwd) => {
      expect(args).toEqual(['app-server', '--stdio']); expect(cwd).toBe('/tmp');
      return spawn(process.execPath, ['-e', code], { stdio: 'pipe' });
    } }, true);
    expect(result?.skills).toEqual({ seen: [
      ['initialize', { clientInfo: { name: 'parley_roles', version: '1' }, capabilities: { experimentalApi: true } }],
      ['initialized', undefined], ['config/read', { cwd: '/tmp', includeLayers: true }],
      ['configRequirements/read', {}], ['skills/list', { cwds: ['/tmp'], forceReload: true }],
    ].map(([method, params]) => [method, params ?? null]) });
  });
});
