import { describe, expect, it } from 'vitest';
import { addSession, addMessage } from './map.js';
import { addRoom } from './rooms.js';
import { HUMAN } from './types.js';
import type { Proposal } from './types.js';
import { captureDecisionJournal, validDecisionJournalIntent } from './decision-journal.js';
import type { DecisionJournalMap } from './decision-journal.js';
const at = '2026-10-04T12:00:00.000Z';
function fixture() {
  const map: DecisionJournalMap = { schemaVersion: 2, work: { id: 'w-0001', title: 'Journal', goal: '', status: 'active', createdAt: at, updatedAt: at }, sessions: [], rooms: [], messages: [] };
  addSession(map, { provider: 'claude', label: 'Lead', task: 'Bounded', role: { source: 'builtin', name: 'reviewer' } });
  const room = addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01'], lead: 's-01' });
  return { map, room };
}
const proposal = (rev = 0): Proposal => ({ id: 'p-01', from: 's-01', rev, text: `Accepted version ${rev}\nFull text`, at });
function accepted(map: DecisionJournalMap, roomId: string, p: Proposal, when = at) {
  return addMessage(map, { from: p.from, to: [], roomId, kind: 'decision', text: p.text }, when).id;
}
describe('captured accepted decision journal', () => {
  it('captures exact version, roles, human note and timestamp once, independently of later mutable text', () => {
    const { map, room } = fixture(); const p = proposal(2); const letter = accepted(map, room.id, p);
    const intent = captureDecisionJournal(map, room, p, 'accept', letter, 'Human remark')!;
    expect(intent.file).toBe('2026-10-04-w-0001-r-01-p-01-rev-02.md');
    expect(intent.content).toContain('builtin:"reviewer"'); expect(intent.content).toContain('Human remark');
    expect(intent.content).toContain(p.text); expect(intent.acceptedAt).toBe(at);
    expect(captureDecisionJournal(map, room, p, 'accept', letter)).toBe(intent);
    p.text = 'Later proposal'; room.title = 'Later room'; map.sessions[0]!.label = 'Later lead';
    expect(intent.content).not.toMatch(/Later/); expect(validDecisionJournalIntent(intent)).toBe(true);
  });
  it('keeps separate files for accepted revisions and never journals Return', () => {
    const { map, room } = fixture();
    for (const rev of [0, 1]) { const p = proposal(rev); captureDecisionJournal(map, room, p, 'accept', accepted(map, room.id, p)); }
    expect(map.decisionExports?.map(row => row.file)).toEqual(['2026-10-04-w-0001-r-01-p-01-rev-00.md', '2026-10-04-w-0001-r-01-p-01-rev-01.md']);
    expect(captureDecisionJournal(map, room, proposal(2), 'return', 'm-99')).toBeNull(); expect(map.decisionExports).toHaveLength(2);
  });
  it('refuses a fabricated accepted letter or traversal while leaving legacy maps without an empty collection', () => {
    const { map, room } = fixture();
    expect(() => captureDecisionJournal(map, room, proposal(), 'accept', 'm-99')).toThrow('journal-invalid');
    expect(map).not.toHaveProperty('decisionExports');
    const p = proposal(); const intent = captureDecisionJournal(map, room, p, 'accept', accepted(map, room.id, p))!;
    expect(validDecisionJournalIntent({ ...intent, file: '../foreign.md' })).toBe(false);
    expect(validDecisionJournalIntent({ ...intent, content: '\ud800' })).toBe(false);
    expect(validDecisionJournalIntent({ ...intent, content: 'x'.repeat(1024 * 1024 + 1) })).toBe(false);
  });
});

it('accepted legacy text/note retains escaped lone units without rolling back Accept or replacing valid emoji/BOM/CRLF', () => {
  const { map, room } = fixture();
  const p = { ...proposal(), text: '\uFEFFLegacy\r\nEmoji 😀\nLone \uD800 and \0\u0001' };
  const intent = captureDecisionJournal(map, room, p, 'accept', accepted(map, room.id, p), 'Human \uDC00 remark')!;
  expect(intent.content).toContain('generated representation');
  expect(intent.content).toContain('\uFEFFLegacy\r\nEmoji 😀');
  expect(intent.content).toContain('\\ud800'); expect(intent.content).toContain('\\u0000'); expect(intent.content).toContain('\\u0001'); expect(intent.content).toContain('\\udc00');
  expect(Buffer.from(intent.content).toString()).toBe(intent.content); expect(intent.content).not.toContain('�');
});

it('disk retry uses captured accepted bytes and snapshot link after later plan revisions, without undoing Accept', async () => {
  const fs = await import('node:fs/promises'); const path = (await import('node:path')).default;
  const store = await import('./store.js'); const { setProposal, resolveProposal } = await import('./proposals.js');
  const { flushPlanSnapshots } = await import('./plan-snapshots.js'); const { flushDecisionJournal } = await import('./decision-journal.js');
  const root = await fs.realpath(await fs.mkdtemp('/private/tmp/parley-journal-disk-')); const project = path.join(root, 'project');
  const oldHome = process.env.PARLEY_HOME; process.env.PARLEY_HOME = path.join(root, 'home');
  try {
    await fs.mkdir(project); await fs.mkdir(path.join(root, 'home'));
    const workId = (await store.createWork(project, { title: 'Disk' })).work.id;
    await store.updateMap(project, workId, map => {
      addSession(map, { provider: 'codex', label: 'Lead', task: 'Bounded' });
      addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01'], lead: 's-01', mode: 'checklist' });
      const p = setProposal(map, 'r-01', 's-01', 'Version zero', at, { plan: { mode: 'checklist', goal: 'Original goal', items: [{ id: 1, title: 'Original work', owner: 's-01', scope: 'src/old' }] } });
      resolveProposal(map, 'r-01', p.proposalId, 'accept', { rev: p.rev, planId: 'pl-01', planRev: 0, note: 'Exact remark' }, at);
    });
    const intent = (await store.readMap(project, workId)).decisionExports![0]!;
    expect(intent.snapshot).toBe(`${workId}-r-01-pl-01-rev-0-accepted.md`);
    expect((await flushDecisionJournal(project, workId)).failed[0]?.code).toBe('journal-unavailable');
    expect((await store.readMap(project, workId)).rooms[0]!.proposal).toBeNull();
    await flushPlanSnapshots(project, workId);
    expect((await flushDecisionJournal(project, workId, { beforeCommit: async () => { throw new Error('Synthetic disk failure'); } })).failed).toHaveLength(1);
    await store.updateMap(project, workId, map => {
      const p = setProposal(map, 'r-01', 's-01', 'Version one', at, { plan: { id: 'pl-01', rev: 0, mode: 'checklist', goal: 'Later goal', items: [{ id: 1, title: 'Later work', owner: 's-01', scope: 'src/new' }] } });
      resolveProposal(map, 'r-01', p.proposalId, 'accept', { rev: p.rev, planId: 'pl-01', planRev: 1 }, at);
    });
    await flushPlanSnapshots(project, workId); const result = await flushDecisionJournal(project, workId);
    expect(result.failed).toEqual([]); expect(result.written).toHaveLength(2);
    const file = path.join(project, '.parley', 'decisions', intent.file);
    expect(await fs.readFile(file, 'utf8')).toBe(intent.content); expect(intent.content).not.toContain('Later goal');
    expect((await flushDecisionJournal(project, workId)).written).toEqual([]);
    await fs.writeFile(file, 'Human changed immutable journal');
    await store.updateMap(project, workId, map => { map.decisionExports![0]!.status = 'pending'; }, { touch: false });
    expect((await flushDecisionJournal(project, workId)).failed[0]?.code).toBe('journal-conflict');
    expect(await fs.readFile(file, 'utf8')).toBe('Human changed immutable journal');
  } finally {
    if (oldHome === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('verified completion journals its exact completed snapshot, while a returned completion stays out', async () => {
  const { setProposal, resolveProposal, proposeCompletion } = await import('./proposals.js');
  const { submitPlanItem, verifyPlanItem } = await import('./plans.js');
  const { map, room } = fixture(); room.mode = 'verified';
  addSession(map, { provider: 'codex', label: 'Verifier', task: 'Independent proof' }); room.members.push('s-02');
  const p = setProposal(map, room.id, 's-01', 'Accepted plan', at, { plan: { mode: 'verified', goal: 'Goal', items: [{ id: 1, title: 'Work', owner: 's-01', scope: 'src/a', criteria: ['Measured'], verifier: 's-02' }], backlog: ['b-001'] } });
  resolveProposal(map, room.id, p.proposalId, 'accept', { rev: p.rev, planId: 'pl-01', planRev: 0 }, at);
  submitPlanItem(map, 'pl-01', 0, 1, 's-01', { text: 'Measured evidence', artifacts: ['src/a'] }, at);
  verifyPlanItem(map, 'pl-01', 0, 1, 's-02', 'verified', 'Independent result', at);
  const returned = proposeCompletion(map, room.id, 's-01', 'pl-01', 0, 'Returned summary', at);
  resolveProposal(map, room.id, returned.proposalId, 'return', { rev: returned.rev, planId: 'pl-01', planRev: 0, note: 'Human rework' }, at);
  expect(map.decisionExports).toHaveLength(1);
  const completion = proposeCompletion(map, room.id, 's-01', 'pl-01', 0, 'Final truthful summary', at);
  resolveProposal(map, room.id, completion.proposalId, 'accept', { rev: completion.rev, planId: 'pl-01', planRev: 0 }, at);
  const intent = map.decisionExports![1]!;
  expect(intent.kind).toBe('completion'); expect(intent.snapshot).toBe('w-0001-r-01-pl-01-rev-0-completed.md');
  expect(intent.content).toContain('Final truthful summary'); expect(intent.content).toContain('b-001'); expect(intent.content).not.toContain('Returned summary');
});

describe('read-only journal listing (P28)', () => {
  async function disk() {
    const fs = await import('node:fs/promises'); const path = (await import('node:path')).default;
    const store = await import('./store.js'); const { setProposal, resolveProposal } = await import('./proposals.js');
    const root = await fs.realpath(await fs.mkdtemp('/private/tmp/parley-journal-list-')); const project = path.join(root, 'project');
    const oldHome = process.env.PARLEY_HOME; process.env.PARLEY_HOME = path.join(root, 'home');
    await fs.mkdir(project); await fs.mkdir(path.join(root, 'home'));
    const workId = (await store.createWork(project, { title: 'List' })).work.id;
    await store.updateMap(project, workId, map => {
      addSession(map, { provider: 'codex', label: 'Lead', task: 'Bounded' });
      addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01'], lead: 's-01' });
      for (const rev of [0, 1]) {
        const p = setProposal(map, 'r-01', 's-01', `Version ${rev}\nBody`, at);
        resolveProposal(map, 'r-01', p.proposalId, 'accept', { rev: p.rev }, at);
      }
    });
    const { flushDecisionJournal } = await import('./decision-journal.js');
    await flushDecisionJournal(project, workId);
    return { fs, path, store, root, project, workId, dir: path.join(project, '.parley', 'decisions'),
      done: async () => { if (oldHome === undefined) delete process.env.PARLEY_HOME; else process.env.PARLEY_HOME = oldHome; await fs.rm(root, { recursive: true, force: true }); } };
  }
  it('lists accepted files newest first, classifies them against the map and creates nothing', async () => {
    const { readDecisionJournalFiles, classifyDecisionFile } = await import('./decision-journal.js');
    const t = await disk();
    try {
      const before = (await t.fs.readdir(t.path.join(t.project, '.parley'), { recursive: true })).sort();
      const listing = await readDecisionJournalFiles(t.project);
      expect(listing.files.map(row => row.file)).toEqual((await t.store.readMap(t.project, t.workId)).decisionExports!.map(row => row.file).sort().reverse());
      expect(listing).toMatchObject({ unreadable: 0, unrecognized: 0, truncated: false });
      expect(listing.files[0]).toMatchObject({ workId: t.workId, roomId: 'r-01', kind: 'decision', headerAgrees: true });
      const map = await t.store.readMap(t.project, t.workId);
      expect(listing.files.map(row => classifyDecisionFile(row, map))).toEqual(['accepted', 'accepted']);
      expect(listing.files.map(row => classifyDecisionFile(row, null))).toEqual(['retained', 'retained']);
      expect(listing.files.map(row => classifyDecisionFile(row, undefined))).toEqual(['unverified', 'unverified']);
      expect((await t.fs.readdir(t.path.join(t.project, '.parley'), { recursive: true })).sort()).toEqual(before);
    } finally { await t.done(); }
  });
  it('an edited file is not accepted, and a foreign header never becomes retained', async () => {
    const { readDecisionJournalFiles, classifyDecisionFile } = await import('./decision-journal.js');
    const t = await disk();
    try {
      const map = await t.store.readMap(t.project, t.workId);
      const [first, second] = map.decisionExports!;
      await t.fs.writeFile(t.path.join(t.dir, first!.file), `${first!.content}\nHuman note`);
      await t.fs.writeFile(t.path.join(t.dir, second!.file), 'Not a journal header');
      const listing = await readDecisionJournalFiles(t.project);
      const byFile = Object.fromEntries(listing.files.map(row => [row.file, row]));
      expect(classifyDecisionFile(byFile[first!.file]!, map)).toBe('edited');
      expect(classifyDecisionFile(byFile[second!.file]!, map)).toBe('edited');
      expect(byFile[second!.file]!.headerAgrees).toBe(false);
      expect(classifyDecisionFile(byFile[second!.file]!, null)).toBe('unverified');
      const foreign = { ...map, decisionExports: [] };
      expect(classifyDecisionFile(byFile[first!.file]!, foreign)).toBe('unverified');
    } finally { await t.done(); }
  });
  it('does not read symlinked, directory or unknown-name entries and counts them', async () => {
    const { readDecisionJournalFiles } = await import('./decision-journal.js');
    const t = await disk();
    try {
      const outside = t.path.join(t.root, 'outside.md'); await t.fs.writeFile(outside, 'Outside text');
      await t.fs.symlink(outside, t.path.join(t.dir, '2026-10-05-w-0009-r-01-p-01-rev-00.md'));
      await t.fs.mkdir(t.path.join(t.dir, '2026-10-05-w-0009-r-01-p-02-rev-00.md'));
      await t.fs.writeFile(t.path.join(t.dir, 'notes.md'), 'Unknown'); await t.fs.writeFile(t.path.join(t.dir, 'readme.txt'), 'Ignored');
      await t.fs.writeFile(t.path.join(t.dir, '2026-10-05-w-0009-r-01-p-03-rev-00.md'), Buffer.from([0xff, 0xfe, 0xfd]));
      const listing = await readDecisionJournalFiles(t.project);
      expect(listing.files).toHaveLength(2); expect(listing).toMatchObject({ unreadable: 3, unrecognized: 1 });
      expect(JSON.stringify(listing)).not.toContain('Outside text');
    } finally { await t.done(); }
  });
  it('bounds the number of files read and refuses a symlinked decisions folder', async () => {
    const { readDecisionJournalFiles, DECISION_LIST_MAX_FILES } = await import('./decision-journal.js');
    const t = await disk();
    try {
      for (let index = 0; index < DECISION_LIST_MAX_FILES; index++)
        await t.fs.writeFile(t.path.join(t.dir, `2027-01-01-w-0100-r-01-p-${String(index).padStart(3, '0')}-rev-00.md`), '# T\n');
      const listing = await readDecisionJournalFiles(t.project);
      expect(listing.files).toHaveLength(DECISION_LIST_MAX_FILES); expect(listing.truncated).toBe(true);
      await t.fs.rm(t.dir, { recursive: true }); await t.fs.symlink(t.root, t.dir);
      await expect(readDecisionJournalFiles(t.project)).rejects.toMatchObject({ code: 'journal-unavailable' });
    } finally { await t.done(); }
  });
  it('a missing decisions folder is an empty journal', async () => {
    const { readDecisionJournalFiles } = await import('./decision-journal.js');
    const t = await disk();
    try {
      await t.fs.rm(t.dir, { recursive: true });
      expect(await readDecisionJournalFiles(t.project)).toEqual({ files: [], unreadable: 0, unrecognized: 0, truncated: false });
    } finally { await t.done(); }
  });
});
