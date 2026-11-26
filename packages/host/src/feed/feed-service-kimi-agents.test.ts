import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { feedItem } from '@parley/protocol';
import { REF, fakeClient, fakeFeedDeps } from '../../test/feed-fakes.js';
import { workspaceKey } from '../kimi/date-provenance.js';
import { projectKimiWire, type WireRow } from '../kimi/native-wire.js';
import { createFeedService } from './feed-service.js';

const source = 'session_00000000-0000-4000-8000-000000000002';
const time = 1790000000000;
const first = 'agent-0';
const second = 'agent-1';
const nested = 'agent-2';
const iso = (delta: number) => new Date(time + delta).toISOString();
const header = { type: 'metadata', protocol_version: '1.5', min_protocol_version: '1.5' };
const wire = (...rows: WireRow[]) => [header, ...rows].map(row => JSON.stringify(row) + '\n').join('');
const spawn = (id: string, delta: number, parentAgentId = 'main'): WireRow => ({
  type: 'subagent.spawned', subagentId: id, subagentName: 'explore',
  parentAgentId, callerAgentId: parentAgentId, parentToolCallId: 'call-' + id,
  description: 'Inspect ' + id, model: 'fixture-model', runInBackground: true, time: time + delta,
});
const lifecycle = (phase: string, id: string, delta: number, extra?: Record<string, unknown>): WireRow => ({
  type: 'subagent.' + phase, subagentId: id, time: time + delta, ...extra,
});
const completed = lifecycle('completed', first, 3000, { resultSummary: 'Finished first inspection' });
const failed = lifecycle('failed', second, 4000, { error: 'Fixture failure' });
const shell = { type: 'task.started', agentId: 'main', time, info: { kind: 'bash', taskId: 'shell-1' } };
const agentTask = { ...shell, info: { kind: 'agent', taskId: 'task-1', agentId: first } };

it('updates independent native agent cards in subscribed deltas across parent turns and replays', async () => {
  const service = createFeedService(fakeFeedDeps([{ ref: REF, provider: 'kimi' }]).deps);
  const client = fakeClient();
  service.subscribe(REF, client);
  const emit = (row: WireRow, historical = false) => {
    const event = projectKimiWire(row);
    if (event !== undefined) service.kimiNativeEvent(REF, source, event, historical);
  };
  const agents = async () => (await service.snapshot(REF)).items.filter(row => row.kind === 'agent');
  try {
    service.kimiNativeEvent(REF, source, { kind: 'prompt', id: 'msg_parent', text: 'First parent turn', at: time });
    emit(shell);
    emit(spawn(first, 100));
    emit(lifecycle('started', first, 110));
    emit(agentTask);
    emit(spawn(second, 200));
    emit(lifecycle('started', second, 210));
    service.kimiNativeEvent(REF, source, { kind: 'end', reason: 'completed', at: time + 1000 });
    service.kimiNativeEvent(REF, source, { kind: 'prompt', id: 'msg_next', text: 'Second parent turn', at: time + 2000 });
    const running = await agents();
    expect(running).toMatchObject([
      { agentId: first, agentType: 'explore', description: 'Inspect agent-0', model: 'fixture-model', background: true, status: 'running', at: iso(100) },
      { agentId: second, status: 'running', at: iso(200) },
    ]);
    expect(running[0]!.id).not.toBe(running[1]!.id);
    expect(running.every(card => feedItem.safeParse(card).success)).toBe(true);

    client.sent.length = 0;
    emit(completed);
    expect(await agents()).toMatchObject([
      { id: running[0]!.id, status: 'done', at: iso(100), endedAt: iso(3000), durationMs: 2900, result: 'Finished first inspection' },
      { id: running[1]!.id, status: 'running' },
    ]);
    expect(client.sent).toContainEqual(expect.objectContaining({
      event: 'feed.changed', data: expect.objectContaining({
        upsert: [expect.objectContaining({ id: running[0]!.id, status: 'done' })],
      }),
    }));

    client.sent.length = 0;
    emit(spawn(first, 100), true);
    emit(lifecycle('started', first, 110), true);
    emit(completed, true);
    emit(failed);
    emit(lifecycle('cancelled', 'agent-cancelled', 4100));
    expect(await agents()).toMatchObject([
      { id: running[0]!.id, status: 'done' },
      { id: running[1]!.id, status: 'failed', endedAt: iso(4000), result: 'Fixture failure' },
      { agentId: 'agent-cancelled', status: 'failed', endedAt: iso(4100) },
    ]);
    emit(spawn(first, 5000));
    emit(lifecycle('started', first, 5100));
    emit(completed, true);
    expect(await agents()).toMatchObject([
      { id: running[0]!.id, status: 'running', at: iso(5000) },
      { id: running[1]!.id, status: 'failed' },
      { agentId: 'agent-cancelled', status: 'failed' },
    ]);
    expect((await agents())[0]).not.toHaveProperty('result');
  } finally {
    await service.stop();
  }
});

it('reopens a native wire past 8 MiB and finds nested lifecycle only in proven child wires', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'parley-kimi-agents-'));
  const cwd = '/private/tmp/fixture';
  const dir = path.join(home, 'sessions', workspaceKey(cwd), source, 'agents');
  const fake = fakeFeedDeps([{ ref: REF, provider: 'kimi', providerSessionId: source }]);
  const entry = fake.deps.works.entry;
  fake.deps.works.entry = (...args) => {
    const work = entry(...args);
    const session = work?.map.sessions[0];
    if (session !== undefined) session.kimiNativeBinding = { home, cwd };
    return work;
  };
  const service = createFeedService(fake.deps);
  try {
    await Promise.all(['main', first, 'agent-unrelated'].map(id => mkdir(path.join(dir, id), { recursive: true })));
    const padding = JSON.stringify({ type: 'fixture.padding', value: 'x'.repeat(256 * 1024) }) + '\n';
    await writeFile(path.join(dir, 'main', 'wire.jsonl'),
      wire(spawn(first, 100), lifecycle('started', first, 110)) + padding.repeat(32) +
      wire(spawn(second, 200), completed, completed, failed).split('\n').slice(1).join('\n'));
    await writeFile(path.join(dir, first, 'wire.jsonl'), wire(
      spawn(nested, 250, first),
      lifecycle('started', nested, 260),
      lifecycle('completed', second, 270, { resultSummary: 'Wrong branch' }),
      { type: 'context.append_loop_event', agentId: first, time: time + 270,
        event: { type: 'content.part', uuid: 'private', part: { type: 'text', text: 'Only in the child' } } },
      lifecycle('cancelled', nested, 3500),
    ));
    await writeFile(path.join(dir, 'agent-unrelated', 'wire.jsonl'), wire(spawn('agent-stray', 250, 'agent-unrelated')));
    const snapshot = await service.snapshot(REF);
    expect(snapshot.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'agent', agentId: first, status: 'done', result: 'Finished first inspection' }),
      expect.objectContaining({ kind: 'agent', agentId: second, status: 'failed', result: 'Fixture failure' }),
      expect.objectContaining({ kind: 'agent', agentId: nested, status: 'failed', endedAt: iso(3500) }),
    ]));
    expect(snapshot.items).toHaveLength(3);
    expect(await service.snapshot(REF)).toEqual(snapshot);
  } finally {
    await service.stop();
    await rm(home, { recursive: true, force: true });
  }
});
