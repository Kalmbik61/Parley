import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeContextMatches, projectNativeSkillConfigArgs, readNativeContext, stampNativeContext, writeNativeContext, type NativeContextDescriptor } from './native-context.js';
let project: string;
let descriptor: NativeContextDescriptor;
const work = 'w-0001'; const session = 's-01';
const file = () => path.join(project, '.parley/local/native-context', work, `${session}.json`);
beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-bound-context-')));
  descriptor = { version: 1, revision: randomUUID(), provider: 'codex', cwd: project, verified: true,
    command: process.execPath, configArgs: [], roots: { homeDir: project } };
});
afterEach(async () => { await rm(project, { recursive: true, force: true }); });
describe('local participant context descriptor', () => {
  it('writes bounded private data and verifies the own launch revision', async () => {
    expect(await writeNativeContext(project, work, session, descriptor)).toBe(true);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    const read = await readNativeContext(project, work, session);
    expect(read).toEqual(descriptor);
    expect(await nativeContextMatches(read!, 'codex', project, descriptor.revision)).toBe(true);
    expect(await nativeContextMatches(read!, 'codex', project, randomUUID())).toBe(false);
    expect(await nativeContextMatches(read!, 'claude', project, descriptor.revision)).toBe(false);
  });
  it('does not bind a stale unbound file without the actual spawned revision', async () => {
    await writeNativeContext(project, work, session, descriptor);
    const started = { pid: 42, startedAtProcess: 'launch-1' };
    await stampNativeContext(project, work, session, started);
    await stampNativeContext(project, work, session, started, randomUUID());
    expect((await readNativeContext(project, work, session))?.process).toBeUndefined();
    await stampNativeContext(project, work, session, started, descriptor.revision);
    expect(await nativeContextMatches((await readNativeContext(project, work, session))!, 'codex', project, undefined, started)).toBe(true);
    await stampNativeContext(project, work, session, { pid: 43, startedAtProcess: 'launch-2' }, descriptor.revision);
    expect((await readNativeContext(project, work, session))?.process).toEqual(started);
  });
  it('permits known last closed context with cleared PID and refuses a changed start stamp', async () => {
    await writeNativeContext(project, work, session, descriptor);
    await stampNativeContext(project, work, session, { pid: 42, startedAtProcess: 'launch-1' }, descriptor.revision);
    const bound = (await readNativeContext(project, work, session))!;
    expect(await nativeContextMatches(bound, 'codex', project, undefined, { pid: null, startedAtProcess: 'launch-1', lifecycle: 'closed' })).toBe(true);
    expect(await nativeContextMatches(bound, 'codex', project, undefined, { pid: null, startedAtProcess: 'launch-2', lifecycle: 'closed' })).toBe(false);
    expect(await nativeContextMatches(bound, 'codex', project, undefined, { pid: null, startedAtProcess: 'launch-1', lifecycle: 'active' })).toBe(false);
  });
  it('failed new write cannot stamp or confirm a previous descriptor for the new process', async () => {
    await writeNativeContext(project, work, session, descriptor);
    const revision = randomUUID();
    expect(await writeNativeContext(project, work, session, { ...descriptor, revision, configArgs: ['SECRET'] })).toBe(false);
    await stampNativeContext(project, work, session, { pid: 99, startedAtProcess: 'new' }, revision);
    const old = (await readNativeContext(project, work, session))!;
    expect(old.process).toBeUndefined();
    expect(await nativeContextMatches(old, 'codex', project, revision)).toBe(false);
    expect(await nativeContextMatches(old, 'codex', project, undefined, { pid: 99, startedAtProcess: 'new' })).toBe(false);
  });
  it('rejects symlink parents and never creates directories through their target', async () => {
    await mkdir(path.join(project, '.parley'));
    const outside = path.join(project, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(project, '.parley/local'));
    expect(await writeNativeContext(project, work, session, descriptor)).toBe(false);
    await expect(stat(path.join(outside, 'native-context'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects broad permissions, extra data, public permissions, oversized content and path traversal', async () => {
    expect(await writeNativeContext(project, work, '../w-0001', descriptor)).toBe(false);
    expect(await writeNativeContext(project, work, session, { ...descriptor, configArgs: ['-c', 'sandbox_mode="danger-full-access"'] })).toBe(false);
    expect(await writeNativeContext(project, work, session, { ...descriptor, secret: 'DO_NOT_STORE' } as NativeContextDescriptor)).toBe(false);
    await writeNativeContext(project, work, session, descriptor);
    await chmod(file(), 0o644);
    expect(await readNativeContext(project, work, session)).toBeNull();
    await chmod(file(), 0o600);
    await writeFile(file(), JSON.stringify(descriptor) + ' '.repeat(32769));
    expect(await readNativeContext(project, work, session)).toBeNull();
  });
  it('serializes only validated human selector fields, excluding raw comments and unknown fields', async () => {
    const args = projectNativeSkillConfigArgs(['-c', 'skills.config=[{name="review",enabled=false}] # SECRET', '-c', 'project_root_markers=[".git"]']);
    expect(args).toEqual(['-c', 'skills.config=[{name="review",enabled=false}]', '-c', 'project_root_markers=[".git"]']);
    expect(projectNativeSkillConfigArgs(['-c', 'skills.config=[{name="review",enabled=false,secret="SECRET"}]'])).toBeNull();
    expect(projectNativeSkillConfigArgs(['-c', 'skills.config=[{name="review",path="/tmp/a",enabled=false}]'])).toBeNull();
    expect(projectNativeSkillConfigArgs(['-c', 'project_root_markers=["../escape"]'])).toBeNull();
    await writeNativeContext(project, work, session, { ...descriptor, configArgs: args! });
    expect(await readFile(file(), 'utf8')).not.toContain('SECRET');
  });
});
