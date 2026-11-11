// `sessions.codeMode` (plan T12a-indicator): the window's Code Mode label, read from Parley's own files in the work directory of the
// session's `ref`. Display only: it reads, never writes, never takes a path from the caller, and a bad file is `unknown`, not an error.
import { chmodSync, mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPendingSession, createWork, workPaths } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { RequestInfo } from '../context.js';
import { createSessionHandlers } from './sessions.js';
import type { SessionMethodDeps } from './sessions.js';
import type { SessionsService } from '../sessions/sessions-service.js';

const request = { client: {}, host: {} } as unknown as RequestInfo;
const { sessionsCodeMode } = createSessionHandlers({
  sessions: {} as unknown as SessionsService,
  pty: {} as unknown as SessionMethodDeps['pty'],
  activity: {} as unknown as SessionMethodDeps['activity'],
  wake: {} as unknown as SessionMethodDeps['wake'],
});

const NONCE = 'c'.repeat(32);
let project = '';
let other = '';
let ref: SessionRef;
let dir = '';

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-code-mode-'));
  other = await mkdtemp(path.join(tmpdir(), 'parley-code-mode-other-'));
  const workId = (await createWork(project, { title: 'W', goal: '' })).work.id;
  const sessionId = await createPendingSession(project, workId, { provider: 'claude', label: '', task: 'x' });
  ref = { projectPath: project, workId, sessionId };
  dir = workPaths(project, workId).dir;
});
afterEach(async () => {
  for (const base of [dir]) { try { chmodSync(path.join(base, 'code-mode'), 0o700); } catch { /* none */ } }
  await Promise.all([project, other].map((p) => rm(p, { recursive: true, force: true })));
});

const file = (kind: 'launch' | 'exposure', text: string, sessionId = ref.sessionId): string => {
  mkdirSync(path.join(dir, 'code-mode'), { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'code-mode', `${sessionId}.${kind}.json`);
  writeFileSync(target, text, { mode: 0o600 });
  return target;
};
const decision = (over: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, nonce: NONCE, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: '2026-11-09T00:00:00.000Z', ...over });
const record = (over: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, effective: 'replacement', reason: null, migrated: [], residual: [], registryRevision: 'r', residualSchemaSha256: null, launchId: 'l', nonce: NONCE, ...over });
const snapshot = (): string[] => { try { return readdirSync(path.join(dir, 'code-mode')).sort(); } catch { return []; } };

describe('sessions.codeMode', () => {
  it('no files: unknown', async () => {
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
  });

  it('classic with its reason', async () => {
    file('launch', decision({ nonce: null, effective: 'classic', reason: 'not-requested' }));
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'classic', reason: 'not-requested' });
  });

  it('moves with the files: unknown, unconfirmed after the decision, code-mode after this launch\'s record', async () => {
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
    file('launch', decision());
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: 'unconfirmed' });
    file('exposure', record());
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'code-mode', reason: null });
  });

  it('failed and another launch\'s record are never code-mode', async () => {
    file('launch', decision());
    file('exposure', record({ effective: 'failed', reason: 'partition' }));
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: 'failed' });
    file('exposure', record({ nonce: 'd'.repeat(32) }));
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: 'unconfirmed' });
  });

  it('a torn file, a loose directory and a symlink are unknown, and never throw', async () => {
    file('launch', '{"v":1');
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
    const real = file('launch', decision({ nonce: null, effective: 'classic', reason: 'not-requested' }));
    chmodSync(path.join(dir, 'code-mode'), 0o755);
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
    chmodSync(path.join(dir, 'code-mode'), 0o700);
    const elsewhere = path.join(other, 'elsewhere.json');
    writeFileSync(elsewhere, decision({ nonce: null, effective: 'classic', reason: 'not-requested' }));
    await rm(real);
    symlinkSync(elsewhere, real);
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
  });

  it('a reason this build does not list is unknown, never raw text', async () => {
    file('launch', decision({ nonce: null, effective: 'classic', reason: 'The client said no.' }));
    await expect(sessionsCodeMode({ ref }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
  });

  it('reads only: the code-mode directory is byte-for-byte as it was (names, sizes, times)', async () => {
    file('launch', decision());
    file('exposure', record());
    const stat = () => snapshot().map((name) => { const s = statSync(path.join(dir, 'code-mode', name)); return [name, s.size, s.mtimeMs, s.ino]; });
    const before = stat();
    await sessionsCodeMode({ ref }, request);
    expect(stat()).toEqual(before);
  });

  it('a missing workspace, an unknown session and a ref into another work are refused, not guessed', async () => {
    await expect(sessionsCodeMode({ ref: { ...ref, workId: 'w-9999' } }, request)).rejects.toMatchObject({ code: 'not_found' });
    await expect(sessionsCodeMode({ ref: { ...ref, projectPath: other } }, request)).rejects.toMatchObject({ code: 'not_found' });
    await expect(sessionsCodeMode({ ref: { ...ref, sessionId: 's-99' } }, request)).rejects.toMatchObject({ code: 'not_found' });
    // A decision file planted for a session that is not in the map is not read either.
    file('launch', decision({ nonce: null, effective: 'classic', reason: 'not-requested' }), 's-99');
    await expect(sessionsCodeMode({ ref: { ...ref, sessionId: 's-99' } }, request)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a session of another work does not read this work\'s file even with the same session id', async () => {
    const second = (await createWork(project, { title: 'W2', goal: '' })).work.id;
    const sid = await createPendingSession(project, second, { provider: 'claude', label: '', task: 'y' });
    expect(sid).toBe(ref.sessionId);
    file('launch', decision({ nonce: null, effective: 'classic', reason: 'not-requested' }));
    await expect(sessionsCodeMode({ ref: { projectPath: project, workId: second, sessionId: sid } }, request)).resolves.toEqual({ mode: 'unknown', reason: null });
  });

  it('answers only mode and reason', async () => {
    file('launch', decision({ nonce: null, effective: 'classic', reason: 'not-requested' }));
    expect(Object.keys(await sessionsCodeMode({ ref }, request)).sort()).toEqual(['mode', 'reason']);
  });
});
