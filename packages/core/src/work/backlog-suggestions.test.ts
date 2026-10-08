import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptBacklogSuggestion, dismissBacklogSuggestion, listBacklogSuggestions, suggestBacklog } from './backlog-suggestions.js';
import { completeBacklogItem, readBacklog, removeBacklogItem } from './backlog.js';
import { setBacklogRule } from './project-preferences.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

let project = '';
const input = (kind: 'bug' | 'debt' | 'idea', title: string = kind) => ({ kind, title, why: 'Concrete finding', workId: 'w-0001', sessionId: 's-03' });
beforeEach(async () => { project = await realpath(await mkdtemp(path.join(tmpdir(), 'parley-suggestions-'))); });
afterEach(async () => { vi.restoreAllMocks(); await rm(project, { recursive: true, force: true }); });
describe('backlog suggestion rules and identity', () => {
  it.each(['ask', 'problems', 'everything'] as const)('routes all three kinds under %s', async rule => {
    await setBacklogRule(project, rule);
    for (const kind of ['bug', 'debt', 'idea'] as const) {
      const result = await suggestBacklog(project, input(kind));
      expect(result.status).toBe(rule === 'ask' || (rule === 'problems' && kind === 'idea') ? 'pending' : 'added');
    }
    const expected = rule === 'ask' ? 0 : rule === 'problems' ? 2 : 3;
    expect((await readBacklog(project)).items).toHaveLength(expected);
    expect(await listBacklogSuggestions(project)).toHaveLength(3 - expected);
  });
  it('defaults to problems and stamps the originating session in shared Markdown', async () => {
    const bug = await suggestBacklog(project, input('bug'));
    expect(bug).toMatchObject({ status: 'added', id: 'b-001' });
    expect((await readBacklog(project)).items[0]?.by).toBe('s-03');
    expect(await suggestBacklog(project, input('idea'))).toMatchObject({ status: 'pending', id: 'sg-02' });
  });
  it('deduplicates case-insensitive open items/pending suggestions under the lock', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => suggestBacklog(project, input('bug', 'Same title'))));
    expect(results.filter(row => row.status === 'added')).toHaveLength(1);
    expect(new Set(results.map(row => row.id))).toEqual(new Set(['b-001']));
    expect(await suggestBacklog(project, input('debt', 'sAmE tItLe'))).toMatchObject({ status: 'duplicate', id: 'b-001' });
    const idea = await suggestBacklog(project, input('idea', 'Pending'));
    expect(await suggestBacklog(project, input('idea', 'pENDING'))).toMatchObject({ status: 'duplicate', id: idea.id });
  });
  it('does not deduplicate done/dismissed/accepted history and never reuses terminal IDs', async () => {
    const first = await suggestBacklog(project, input('bug', 'Repeat'));
    await completeBacklogItem(project, first.id, '2026-10-05');
    expect(await suggestBacklog(project, input('bug', 'Repeat'))).toMatchObject({ status: 'added', id: 'b-002' });
    const pending = await suggestBacklog(project, input('idea', 'Old idea')); await dismissBacklogSuggestion(project, pending.id);
    expect(await suggestBacklog(project, input('idea', 'Old idea'))).toMatchObject({ status: 'pending', id: 'sg-04' });
    await removeBacklogItem(project, 'b-002');
    expect(await suggestBacklog(project, input('bug', 'Repeat'))).toMatchObject({ id: 'b-003' });
  });
  it('accepts/edit-adds once, preserves author provenance, and retains terminal IDs after dismissal', async () => {
    const pending = await suggestBacklog(project, input('idea', 'Original'));
    expect(await acceptBacklogSuggestion(project, pending.id, { title: 'Edited', details: 'Detail' })).toMatchObject({ status: 'added', id: 'b-001' });
    expect(await acceptBacklogSuggestion(project, pending.id)).toMatchObject({ id: 'b-001' });
    expect((await readBacklog(project)).items).toMatchObject([{ title: 'Edited', details: 'Detail', by: 's-03' }]);
    expect(await listBacklogSuggestions(project)).toEqual([]);
    const state = JSON.parse(await readFile(path.join(project, '.parley', 'backlog-suggestions.json'), 'utf8')) as { suggestions: { id: string; status: string }[] };
    expect(state.suggestions).toMatchObject([{ id: 'sg-01', status: 'accepted' }]);
  });
  it('allocates a handwritten duplicate ID on the next write instead of adding another item', async () => {
    await setBacklogRule(project, 'problems');
    await writeFile(path.join(project, '.parley', 'backlog.md'), '# Backlog\n- [ ] Human finding\n');
    expect(await suggestBacklog(project, input('bug', 'HUMAN FINDING'))).toMatchObject({ status: 'duplicate', id: 'b-001' });
    expect((await readBacklog(project)).items).toHaveLength(1);
  });
  it('recovers suggestion acceptance after shared success/local terminal failure without duplicate append', async () => {
    const pending = await suggestBacklog(project, input('idea', 'Once'));
    const originalRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename; let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(to).endsWith('backlog-suggestions.json') && await fs.stat(path.join(project, '.parley', 'backlog.md')).then(() => true, () => false)) {
        failed = true; throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
      }
      return originalRename(from, to);
    });
    await expect(acceptBacklogSuggestion(project, pending.id)).rejects.toMatchObject({ code: 'ENOSPC' });
    vi.restoreAllMocks(); expect(await acceptBacklogSuggestion(project, pending.id)).toMatchObject({ id: 'b-001' });
    expect((await readBacklog(project)).items).toHaveLength(1); expect(await listBacklogSuggestions(project)).toEqual([]);
    await removeBacklogItem(project, 'b-001');
    expect(await acceptBacklogSuggestion(project, pending.id)).toMatchObject({ id: 'b-001' });
    expect((await readBacklog(project)).items).toHaveLength(0); // A terminal retry never resurrects human deletion.
  });
  it('fails closed on malformed preference/local records and rejects invalid inputs before persistence', async () => {
    await setBacklogRule(project, 'ask');
    await writeFile(path.join(project, '.parley', 'preferences.json'), '{');
    await expect(suggestBacklog(project, input('bug'))).rejects.toMatchObject({ code: 'preferences-invalid' });
    await expect(suggestBacklog(project, { ...input('bug'), why: '' })).rejects.toMatchObject({ code: 'suggestions-invalid' });
    await writeFile(path.join(project, '.parley', 'backlog-suggestions.json'), '{"version":1,"backlogSeq":0,"suggestionSeq":0,"suggestions":[{"status":"pending"}],"operations":[]}');
    await expect(listBacklogSuggestions(project)).rejects.toMatchObject({ code: 'suggestions-invalid' });
  });
});
