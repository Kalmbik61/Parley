import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandover, formatHandover, HANDOVER_BUDGET, type HandoverInput } from './handover.js';
import { createPendingSession } from './launch.js';
import { createWork, readMap, updateMap } from './store.js';
import type { WorkMap } from './types.js';

const runGit = promisify(execFile);
const size = (text: string): number => Buffer.byteLength(text, 'utf8');

const previous: HandoverInput['previous'] = {
  provider: 'claude',
  providerLabel: 'Claude Code 2',
  model: 'opus',
  reason: 'limit',
  endedAt: '2026-10-30T16:41:00.000Z',
  resetsAt: '2026-10-30T19:27:00.000Z',
};
const target = { providerLabel: 'Codex', model: 'gpt-6.1-sol' };

let project = '';
let home = '';
let logs = '';
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
  logs = await mkdtemp(path.join(tmpdir(), 'parley-logs-'));
  for (const [name, value] of [['PARLEY_HOME', home], ['PARLEY_CLAUDE_PROJECTS_DIR', logs]] as const) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await Promise.all([home, project, logs].map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Карта с одной сессией s-01, её детьми и комнатой, где она ведущая. */
function fixture(children: number): WorkMap {
  const base = {
    id: '', provider: 'claude', label: '', task: '', parent: null, contextFrom: [], lifecycle: 'active', result: null,
    resultAt: null, closedAt: null, history: [], startedAt: null, endedAt: null, pid: null, startedAtProcess: null,
    launchedBy: null, providerSessionId: null, metrics: null, summary: null, summarySource: null, artifacts: [],
    worktree: null,
  };
  const sessions = [
    {
      ...base, id: 's-01', label: 'lead', summary: 'Wired the thing. '.repeat(400), summarySource: 'agent',
      agentPlan: {
        items: Array.from({ length: 40 }, (_, i) => ({ id: String(i), subject: `step ${i} `.repeat(20), description: null, activeForm: null, status: 'pending' })),
        explanation: null, updatedAt: '2026-10-30T10:00:00.000Z', partial: false,
      },
    },
    ...Array.from({ length: children }, (_, i) => ({
      ...base, id: `s-${String(i + 2).padStart(2, '0')}`, label: `child ${i} ${'x'.repeat(100)}`, parent: 's-01',
    })),
  ];
  return {
    schemaVersion: 2,
    work: { id: 'w-0001', title: 't', goal: '' },
    sessions,
    rooms: [{
      id: 'r-01', title: 'room', creator: 'human', ownerId: null, members: ['s-01'], createdAt: '', lead: 's-01',
      proposal: { id: 'p-01', from: 's-01', text: 'x', rev: 0, at: '' },
    }],
    plans: [],
  } as unknown as WorkMap;
}

function input(over: Partial<HandoverInput> = {}): HandoverInput {
  return {
    map: fixture(2), sessionId: 's-01', previous, target,
    unread: [], worktree: { cwd: '/w', branch: 'b', status: [' M a.ts'], ahead: 1, behind: 0 }, tail: null, ...over,
  };
}

const mail = (n: number) => ({
  id: `m-${n}`, from: 's-09', roomId: n % 2 === 0 ? 'r-01' : null, kind: n % 3 === 0 ? 'question' : 'note',
  text: `letter ${n} ${'я'.repeat(500)}`, at: '2026-10-30T16:00:00.000Z',
});

describe('formatHandover', () => {
  it('states who stopped, when and why, and where the truth lives', () => {
    const text = formatHandover(input());
    expect(text).toContain('session s-01');
    expect(text).toContain('Claude Code 2, opus');
    expect(text).toContain('2026-10-30 16:41Z');
    expect(text).toContain('usage limit until 2026-10-30 19:27Z');
    expect(text).toContain('Same id, rooms, children, worktree and mail');
    expect(text).toContain('Check before redoing anything');
    expect(text).toContain('No transcript of the previous agent is available');
  });

  it('children: both parent and createdBy (create_session sets createdBy)', () => {
    const map = fixture(1);
    Object.assign(map.sessions[1]!, { parent: null, createdBy: 's-01' });
    expect(formatHandover(input({ map }))).toContain('- s-02 ');
  });

  it('rooms you lead: by the live lead — a closed lead hands the proposal to the next live member', () => {
    const map = fixture(0);
    const closed = { ...map.sessions[0]!, id: 's-09', lifecycle: 'closed' as const };
    map.sessions.push(closed);
    Object.assign(map.rooms[0]!, { members: ['s-09', 's-01'], lead: 's-09' });
    expect(formatHandover(input({ map }))).toContain('Rooms you lead with a waiting proposal:');
    // Ведущий жив и это не s-01: комната в обязательства s-01 не попадает.
    closed.lifecycle = 'active';
    expect(formatHandover(input({ map }))).not.toContain('Rooms you lead with a waiting proposal:');
  });

  it('keeps every part inside its budget and the total under 12 KB (50 letters, 30 children, long text)', () => {
    const noTail = formatHandover(
      input({ map: fixture(30), unread: Array.from({ length: 50 }, (_, i) => mail(i + 1)),
        worktree: { cwd: '/w', branch: 'b', status: Array.from({ length: 80 }, (_, i) => ` M ${'d/'.repeat(40)}f${i}.ts`), ahead: 3, behind: 2 } }),
    );
    const sections = noTail.split('\n\n');
    expect(size(sections[0]!)).toBeLessThanOrEqual(HANDOVER_BUDGET.header);
    for (const section of sections) {
      if (section.startsWith('## State')) expect(size(section)).toBeLessThanOrEqual(HANDOVER_BUDGET.state);
      if (section.startsWith('## Obligations')) expect(size(section)).toBeLessThanOrEqual(HANDOVER_BUDGET.duties);
      if (section.startsWith('## Working copy')) expect(size(section)).toBeLessThanOrEqual(HANDOVER_BUDGET.worktree);
    }
    const withTail = formatHandover(
      input({ map: fixture(30), unread: Array.from({ length: 50 }, (_, i) => mail(i + 1)),
        tail: { text: 'я'.repeat(50_000), file: '/p/handover/s-01-1.md' } }),
    );
    expect(size(withTail)).toBeLessThanOrEqual(HANDOVER_BUDGET.total);
    expect(withTail).toContain('/p/handover/s-01-1.md');
  });

  it('cuts the tail from the head and embeds about 4 KB', () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line-${i}`);
    const text = formatHandover(input({ tail: { text: lines.join('\n'), file: '/f.md' } }));
    expect(text).toContain('line-1999');
    expect(text).not.toContain('line-0\n');
    const tail = text.slice(text.indexOf('## Conversation tail'));
    expect(size(tail)).toBeLessThanOrEqual(HANDOVER_BUDGET.tail + 200);
    expect(tail).toMatch(/\nline-\d+\n/u);
  });

  it('shortens long lists to 10 rows and points to get_map', () => {
    const text = formatHandover(input({ map: fixture(30), unread: Array.from({ length: 50 }, (_, i) => ({ ...mail(i + 1), kind: 'question', roomId: null })) }));
    expect(text).toMatch(/… \d+ more: get_map/u);
    expect(text.match(/^- s-\d\d "child/gmu)!.length).toBeLessThanOrEqual(10);
  });

  it('lists waiting proposals and questions with 200 chars of text', () => {
    const text = formatHandover(input({ unread: [{ id: 'm-5', from: 's-09', roomId: 'r-01', kind: 'question', text: 'q'.repeat(500), at: '' }] }));
    expect(text).toContain('proposal p-01');
    expect(text).toContain(`m-5 from s-09 in r-01: ${'q'.repeat(200)}…`);
  });
});

describe('collectHandover', () => {
  it('writes the tail file, numbering files in sequence, and skips git when absent', async () => {
    const created = await createWork(project, { title: 'w' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, { provider: 'claude', label: 'a', task: 't' });
    await runGit('git', ['init', '-b', 'main', project]);
    await writeFile(path.join(project, 'dirty.txt'), 'x');
    const uuid = '11111111-1111-4111-8111-111111111111';
    await updateMap(project, workId, (map) => {
      map.sessions.find((s) => s.id === sessionId)!.providerSessionId = uuid;
    });
    const dir = path.join(logs, '-tmp-project');
    await mkdir(dir, { recursive: true });
    const say = (role: string, text: string) => JSON.stringify({ type: role, timestamp: '2026-10-30T10:00:00.000Z', message: { role, content: [{ type: 'text', text }] } });
    await writeFile(path.join(dir, `${uuid}.jsonl`), [say('user', 'fix the build'), say('assistant', 'on it')].join('\n'));

    const first = await collectHandover(project, workId, sessionId, previous, target);
    expect(first.tailFile).not.toBeNull();
    expect(first.tailFile).toMatch(new RegExp(`handover/${sessionId}-1\\.md$`, 'u'));
    expect(await readFile(first.tailFile!, 'utf8')).toContain('agent: on it');
    expect(first.text).toContain('?? dirty.txt');
    expect(first.text).toContain(first.tailFile!);

    const second = await collectHandover(project, workId, sessionId, previous, target);
    expect(second.tailFile).toMatch(new RegExp(`${sessionId}-2\\.md$`, 'u'));
    expect((await readMap(project, workId)).sessions).toHaveLength(1);
  });

  it('explicit conversation: the tail comes from the previous agent although the map no longer names it', async () => {
    const created = await createWork(project, { title: 'w' });
    const workId = created.work.id;
    const sessionId = await createPendingSession(project, workId, { provider: 'claude', label: 'a', task: 't' });
    const uuid = '22222222-2222-4222-8222-222222222222';
    const dir = path.join(logs, '-tmp-project');
    await mkdir(dir, { recursive: true });
    const say = (role: string, text: string) => JSON.stringify({ type: role, timestamp: '2026-10-30T10:00:00.000Z', message: { role, content: [{ type: 'text', text }] } });
    await writeFile(path.join(dir, `${uuid}.jsonl`), [say('user', 'ship it'), say('assistant', 'shipping')].join('\n'));

    expect((await collectHandover(project, workId, sessionId, previous, target)).tailFile).toBeNull();
    const result = await collectHandover(project, workId, sessionId, previous, target, uuid);
    expect(await readFile(result.tailFile!, 'utf8')).toContain('agent: shipping');
  });

  it('assembles the package without a transcript or a git repository', async () => {
    const created = await createWork(project, { title: 'w' });
    const sessionId = await createPendingSession(project, created.work.id, { provider: 'claude', label: 'a', task: 't' });
    const result = await collectHandover(project, created.work.id, sessionId, previous, target);
    expect(result.tailFile).toBeNull();
    expect(result.text).toContain('No transcript');
    expect(result.text).toContain('git could not be read');
  });
});
