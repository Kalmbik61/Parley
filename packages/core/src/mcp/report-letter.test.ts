import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../config.js';
import { addSession } from '../work/map.js';
import { addRoom } from '../work/rooms.js';
import { createWork, updateMap, workPaths } from '../work/store.js';
import { unreadLetters, writeLetters } from '../work/letter-store.js';
import { createToolRunner, type ToolRunner } from './tools.js';

let home: string;
let project: string;
let workId: string;
const runner = (sessionId: string): ToolRunner => createToolRunner({
  projectPath: project, workId, workDir: workPaths(project, workId).dir,
  sessionId, channel: false, messageRate: DEFAULT_CONFIG.messageRate, pollMs: 10,
});
const body = (answer: Awaited<ReturnType<ToolRunner['call']>>): Record<string, unknown> =>
  JSON.parse((answer.content[0] as { text: string }).text) as Record<string, unknown>;
const report = (summary = 'Finished\nDetails', status = 'done') => runner('s-02').call('report', { status, summary }, undefined);
const inbox = (id = 's-01') => unreadLetters(project, workId, id);
const letter = (from: string, kind: 'note' | 'question' = 'note') => writeLetters(project, workId, (letters) => {
  letters.add({ roomId: null, from, to: ['s-02'], kind, text: 'Task' });
});

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'report-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'report-project-'));
  process.env.PARLEY_HOME = home;
  workId = (await createWork(project, { title: 'Report letters', goal: '' })).work.id;
  await updateMap(project, workId, (map) => {
    addSession(map, { provider: 'claude', label: 'giver', task: '' });
    addSession(map, { provider: 'claude', label: 'worker', task: '', createdBy: 's-01' });
    addSession(map, { provider: 'claude', label: 'other', task: '' });
  });
});
afterEach(async () => {
  delete process.env.PARLEY_HOME;
  await Promise.all([home, project].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('report letters', () => {
  it('mails the create_session caller and wakes an inbox wait immediately', async () => {
    const waiting = runner('s-01').call('wait_for', { target: 'inbox', timeoutSec: 1 }, undefined);
    await report('\nFinished\nDetails');
    const answer = body(await waiting);
    expect(answer['state']).toBe('message');
    expect(answer['messages']).toEqual([expect.objectContaining({ from: 'system', room: null,
      text: 's-02 reported done: Finished. Full summary: get_map {session: "s-02", field: "summary"}' })]);
    expect(inbox()).toHaveLength(0);
  });

  it('sends another letter after a completed worker receives a new task', async () => {
    await report();
    await runner('s-01').call('check_inbox', {}, undefined);
    await runner('s-01').call('send_message', { to: 's-02', text: 'Another task' }, undefined);
    await report('Second result');
    expect(inbox()).toEqual([expect.objectContaining({ text: expect.stringContaining('Second result') })]);
  });

  it('uses the newest task sender', async () => {
    letter('s-01');
    letter('s-03');
    await report();
    expect(inbox()).toHaveLength(0);
    expect(inbox('s-03')).toHaveLength(1);
  });

  it('skips questions, system letters, outgoing letters and child reports across pages', async () => {
    letter('s-03');
    await updateMap(project, workId, (map) => {
      addSession(map, { provider: 'claude', label: 'child', task: '', createdBy: 's-02' });
    });
    for (let i = 0; i < 55; i++) letter('s-04');
    letter('system');
    letter('parley');
    letter('s-03', 'question');
    writeLetters(project, workId, (letters) => { letters.add({ roomId: null, from: 's-02', to: ['s-03'], kind: 'note', text: 'outgoing' }); });
    await report();
    expect(inbox()).toHaveLength(0);
    expect(inbox('s-03')).toHaveLength(2); // Its outgoing task and the worker's report.
    expect(inbox('s-03').filter((message) => message.from === 'system')).toHaveLength(1);
  });

  it('a question from another agent leaves the task giver unchanged', async () => {
    letter('s-01');
    letter('s-03', 'question');
    await report();
    expect(inbox()).toHaveLength(1);
    expect(inbox('s-03')).toHaveLength(0);
  });

  it.each(['direct', 'creator'])('does not notify for a human %s task', async (mode) => {
    if (mode === 'direct') letter('human');
    else await updateMap(project, workId, (map) => { map.sessions[1]!.createdBy = 'human'; });
    await report();
    expect(inbox()).toHaveLength(0);
  });

  it('progress sends nothing and failed reports its status', async () => {
    await report('Working', 'progress');
    expect(inbox()).toHaveLength(0);
    await report('Blocked', 'failed');
    expect(inbox()[0]?.text).toContain('s-02 reported failed: Blocked');
  });

  it('replaces older unread report letters while preserving unrelated letters', async () => {
    writeLetters(project, workId, (letters) => { letters.add({ roomId: null, from: 'system', to: ['s-01'], kind: 'note', text: 'Other notice' }); });
    await report('First');
    await report('Second');
    expect(inbox().map((m) => m.text)).toEqual(['Other notice', expect.stringContaining('Second')]);
  });

  it.each(['during', 'after'])('consumes the report letter when waiting by id %s reporting', async (when) => {
    const a = runner('s-01');
    if (when === 'after') {
      await report();
      expect(inbox()).toEqual([expect.objectContaining({ from: 'system', roomId: null, to: ['s-01'] })]);
    }
    const waiting = a.call('wait_for', { target: 's-02', timeoutSec: 1 }, undefined);
    if (when === 'during') await report();
    expect(body(await waiting)).toMatchObject({ state: 'done', summary: 'Finished\nDetails' });
    expect(inbox()).toHaveLength(0);
  });

  it.each(['room', 'closed', 'missing', 'self'])('does not notify with %s exclusion', async (reason) => {
    await updateMap(project, workId, (map) => {
      if (reason === 'room') addRoom(map, { title: 'Room', creator: 's-01', members: ['s-01', 's-02'] });
      if (reason === 'closed') map.sessions[0]!.lifecycle = 'closed';
      if (reason === 'missing') map.sessions[1]!.createdBy = 's-99';
      if (reason === 'self') map.sessions[1]!.createdBy = 's-02';
    });
    await report();
    expect(inbox()).toHaveLength(0);
    expect(inbox('s-02')).toHaveLength(0);
  });

  it('notifies a sleeping giver and permits reports from an archived room', async () => {
    await updateMap(project, workId, (map) => {
      map.sessions[0]!.lifecycle = 'sleeping';
      addRoom(map, { title: 'Old room', creator: 's-01', members: ['s-01', 's-02'] }).archivedAt = new Date().toISOString();
    });
    await report();
    expect(inbox()).toHaveLength(1);
  });
});
