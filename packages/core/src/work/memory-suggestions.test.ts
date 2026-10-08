import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptMemorySuggestion, dismissMemorySuggestion, listMemorySuggestions, rememberProjectMemory } from './memory-suggestions.js';
import { addProjectMemory, readProjectMemory, undoProjectMemory, updateProjectMemory } from './project-memory.js';

vi.mock('node:fs/promises', async original => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, rename: vi.fn(actual.rename) }; });
let project = '';
beforeEach(async () => { vi.mocked(fs.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename); project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-remember-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });
const input = { kind: 'fact' as const, fact: 'Test with pnpm', why: 'Observed package scripts', workId: 'w-0001', sessionId: 's-01' };

describe('memory suggestions and claimed requests', () => {
  it('ordinary remember stays local pending and case-insensitive repeats do not append', async () => {
    expect(await rememberProjectMemory(project, input)).toMatchObject({ status: 'pending', id: 'ms-01' });
    expect((await readProjectMemory(project)).items).toEqual([]);
    expect(await rememberProjectMemory(project, { ...input, fact: 'TEST WITH PNPM' })).toMatchObject({ status: 'duplicate', id: 'ms-01' });
    expect(await listMemorySuggestions(project)).toHaveLength(1);
    await expect(readFile(path.join(project, '.parley', 'memory.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('human acceptance preserves agent origin, current source revision/evidence and explicit acceptance', async () => {
    await rememberProjectMemory(project, { ...input, sourceKind: 'agent-summary', taskRevision: 3, sourceRefs: ['room:r-01/rev:3'], evidenceRefs: ['test:123'], completeness: 'partial' });
    const accepted = await acceptMemorySuggestion(project, 'ms-01', { fact: 'Human edited accepted phrase', details: 'Private body' });
    expect(accepted).toMatchObject({ status: 'remembered', id: 'm-001' });
    const row = (await readProjectMemory(project)).items[0]!;
    expect(row.provenance).toMatchObject({ origin: 'agent', sourceKind: 'agent-summary', acceptedByHuman: true, amendedByHuman: true, factAmendedByHuman: true, taskRevision: 3, evidenceRefs: ['test:123'], completeness: 'partial' });
    expect(row.human).toBeUndefined(); expect(row.by).toBe('s-01'); expect(await listMemorySuggestions(project)).toEqual([]);
    expect(await acceptMemorySuggestion(project, 'ms-01')).toMatchObject({ id: 'm-001' });
  });
  it('claimed human request writes immediately but cannot turn itself into human authorship', async () => {
    const result = await rememberProjectMemory(project, { ...input, kind: 'agreement', onHumanRequest: true });
    expect(result).toMatchObject({ status: 'remembered', id: 'm-001', undoOperationId: 'remember:ms-01' });
    const row = (await readProjectMemory(project)).items[0]!;
    expect(row.onHumanRequest).toBe(true); expect(row.human).toBeUndefined();
    expect(row.provenance).toMatchObject({ origin: 'agent', claimedHumanRequest: true });
    await expect(rememberProjectMemory(project, { ...input, origin: 'human' } as never)).rejects.toMatchObject({ code: 'memory-suggestions-invalid' });
    await expect(rememberProjectMemory(project, { ...input, sourceKind: 'native-skill' } as never)).rejects.toMatchObject({ code: 'memory-invalid' });
    await expect(rememberProjectMemory(project, { ...input, fact: 'SKILL body\nparagraph' })).rejects.toMatchObject({ code: 'memory-invalid' });
  });
  it('Undo removes only the unchanged inserted row; another unrelated human edit is preserved', async () => {
    const result = await rememberProjectMemory(project, { ...input, onHumanRequest: true });
    await addProjectMemory(project, { kind: 'fact', fact: 'Unrelated human fact' });
    expect(await undoProjectMemory(project, result.undoOperationId!)).toEqual({ status: 'undone', id: 'm-001' });
    expect((await readProjectMemory(project)).items.map(row => row.fact)).toEqual(['Unrelated human fact']);
    expect(await undoProjectMemory(project, result.undoOperationId!)).toEqual({ status: 'missing', id: 'm-001' });
  });
  it('Undo refuses human changes to details/metadata/fact and refuses a stale observed version', async () => {
    const result = await rememberProjectMemory(project, { ...input, onHumanRequest: true });
    const before = await readProjectMemory(project); await updateProjectMemory(project, result.id, { details: 'Human amendment' });
    await expect(undoProjectMemory(project, result.undoOperationId!, { expectedVersion: before.version })).rejects.toMatchObject({ code: 'memory-conflict' });
    await expect(undoProjectMemory(project, result.undoOperationId!)).rejects.toMatchObject({ code: 'memory-conflict' });
    expect((await readProjectMemory(project)).items[0]?.details).toBe('Human amendment');
    expect((await readProjectMemory(project)).items[0]?.provenance?.origin).toBe('agent');
  });
  it('dismissed suggestions retain IDs without semantic dedup; existing facts dedup across kinds', async () => {
    await rememberProjectMemory(project, input); await dismissMemorySuggestion(project, 'ms-01');
    expect(await rememberProjectMemory(project, input)).toMatchObject({ status: 'pending', id: 'ms-02' });
    await acceptMemorySuggestion(project, 'ms-02');
    expect(await rememberProjectMemory(project, { ...input, kind: 'lesson', fact: 'test WITH pnpm' })).toMatchObject({ status: 'duplicate', id: 'm-001' });
  });
  it('a request cannot promote another caller pending suggestion', async () => {
    await rememberProjectMemory(project, input);
    expect(await rememberProjectMemory(project, { ...input, sessionId: 's-02', onHumanRequest: true })).toMatchObject({ status: 'duplicate', id: 'ms-01' });
    expect((await readProjectMemory(project)).items).toEqual([]);
  });
  it('recovers an interrupted claimed-request append without duplicating its reserved ID', async () => {
    const original = vi.mocked(fs.rename).getMockImplementation()!; let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('memory.md')) { failed = true; throw Object.assign(new Error('private'), { code: 'ENOSPC' }); }
      return original(from, to);
    });
    await expect(rememberProjectMemory(project, { ...input, onHumanRequest: true })).rejects.toMatchObject({ code: 'ENOSPC' });
    vi.restoreAllMocks();
    expect(await rememberProjectMemory(project, { ...input, onHumanRequest: true })).toMatchObject({ status: 'remembered', id: 'm-001' });
    expect((await readProjectMemory(project)).items).toHaveLength(1);
  });
  it('fails closed on malformed local envelopes and forged provenance rather than reinitializing IDs', async () => {
    await rememberProjectMemory(project, input);
    const file = path.join(project, '.parley', 'memory-suggestions.json'); const source = await readFile(file, 'utf8');
    const state = JSON.parse(source); state.suggestions[0].provenance.origin = 'human'; await writeFile(file, JSON.stringify(state));
    await expect(listMemorySuggestions(project)).rejects.toMatchObject({ code: 'memory-suggestions-invalid' });
    await writeFile(file, '{'); await expect(rememberProjectMemory(project, input)).rejects.toMatchObject({ code: 'memory-suggestions-invalid' });
  });
});

it('retains Undo evidence when the shared write succeeded but local finalization failed', async () => {
  const original = vi.mocked(fs.rename).getMockImplementation()!; let failed = false;
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (!failed && String(to).endsWith('memory-suggestions.json') && (await readProjectMemory(project)).items.length > 0) {
      failed = true; throw Object.assign(new Error('private'), { code: 'ENOSPC' });
    }
    return original(from, to);
  });
  await expect(rememberProjectMemory(project, { ...input, onHumanRequest: true })).rejects.toMatchObject({ code: 'ENOSPC' });
  vi.restoreAllMocks();
  const retried = await rememberProjectMemory(project, { ...input, onHumanRequest: true });
  expect(retried).toMatchObject({ id: 'm-001', undoOperationId: 'remember:ms-01' });
  expect((await readProjectMemory(project)).items).toHaveLength(1);
  expect(await undoProjectMemory(project, retried.undoOperationId!)).toEqual({ status: 'undone', id: 'm-001' });
});

it('manual add settles a matching pending suggestion without two copies or lost agent provenance records', async () => {
  await rememberProjectMemory(project, input);
  const added = await addProjectMemory(project, { kind: 'fact', fact: 'TEST WITH PNPM' });
  expect(added.id).toBe('m-001'); expect((await readProjectMemory(project)).items).toHaveLength(1);
  expect((await readProjectMemory(project)).items[0]?.provenance?.origin).toBe('human');
  expect(await listMemorySuggestions(project)).toEqual([]);
  const local = JSON.parse(await readFile(path.join(project, '.parley', 'memory-suggestions.json'), 'utf8'));
  expect(local.suggestions[0].provenance.origin).toBe('agent'); expect(local.suggestions[0].memoryId).toBe(added.id);
});


it('a human details amendment cannot promote an old agent summary into human authority', async () => {
  const remembered = await rememberProjectMemory(project, { ...input, sourceKind: 'agent-summary', taskRevision: 2, onHumanRequest: true });
  await updateProjectMemory(project, remembered.id, { details: 'Current human annotation' });
  const row = (await readProjectMemory(project)).items[0]!;
  expect(row.provenance).toMatchObject({ origin: 'agent', sourceKind: 'agent-summary', taskRevision: 2, amendedByHuman: true });
  const { formatMemoryFactBlock } = await import('./session-layer.js');
  expect(formatMemoryFactBlock([row]).text).toContain('unverified agent claim');
  expect(formatMemoryFactBlock([row]).text).not.toContain('human-authored');
  expect(formatMemoryFactBlock([row]).text).not.toContain('Current human annotation');
});

it('a changed fact is a current human amendment while original agent origin and evidence remain', async () => {
  const result = await rememberProjectMemory(project, { ...input, sourceKind: 'agent-summary', taskRevision: 2, evidenceRefs: ['test:old'], onHumanRequest: true });
  await updateProjectMemory(project, result.id, { fact: 'The current human replacement', state: 'current' });
  const row = (await readProjectMemory(project)).items[0]!;
  expect(row.provenance).toMatchObject({ origin: 'agent', sourceKind: 'agent-summary', taskRevision: 2, evidenceRefs: ['test:old'], amendedByHuman: true, factAmendedByHuman: true });
  const { formatMemoryFactBlock } = await import('./session-layer.js');
  const block = formatMemoryFactBlock([row]).text;
  expect(block).toContain('current human fact amendment'); expect(block).toContain('The current human replacement');
  expect(block).toContain('Current human instructions and task constraints take precedence');
  await updateProjectMemory(project, result.id, { state: 'superseded' });
  expect(formatMemoryFactBlock((await readProjectMemory(project)).items).text).toBe('');
});

it('an external human amendment during Undo is preserved by the final content/version comparison', async () => {
  const result = await rememberProjectMemory(project, { ...input, onHumanRequest: true });
  const file = path.join(project, '.parley', 'memory.md'); const source = await readFile(file, 'utf8');
  await expect(undoProjectMemory(project, result.undoOperationId!, { beforeCommit: async () => {
    await writeFile(file, source.replace(input.fact, 'Human changed during Undo'));
  } })).rejects.toMatchObject({ code: 'memory-conflict' });
  expect((await readProjectMemory(project)).items[0]?.fact).toBe('Human changed during Undo');
});

it('rejects non-scalar why/refs and remembered text before writes while preserving paired Unicode', async () => {
  const bad = String.fromCharCode(0xdc00);
  for (const patch of [{ fact: bad }, { details: bad }, { why: bad }, { sourceRefs: [bad] }, { evidenceRefs: [bad] }]) {
    await expect(rememberProjectMemory(project, { ...input, ...patch })).rejects.toHaveProperty('code');
    expect(await fs.readdir(project)).toEqual([]);
  }
  const fact = 'Paired 😀 fact\u2028with\u2029separators';
  const details = 'Paired 😀 details\u2028with\u2029separators';
  await rememberProjectMemory(project, { ...input, fact, details, why: 'Observed 😀\u2028reason', sourceRefs: ['source:😀\u2029ref'] });
  expect((await listMemorySuggestions(project))[0]).toMatchObject({ fact, details, why: 'Observed 😀\u2028reason', provenance: { sourceRefs: ['source:😀\u2029ref'] } });
  const file = path.join(project, '.parley', 'memory-suggestions.json'); const before = await readFile(file);
  await expect(acceptMemorySuggestion(project, 'ms-01', { details: bad })).rejects.toMatchObject({ code: 'memory-invalid' });
  expect(await readFile(file)).toEqual(before);
});
