import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LiveTask } from '@parley/protocol';
import type { IslandActivityEntry } from '../../shared/island.js';
import { projectIslandActivity } from './activity-projection.js';

function source(tasks?: LiveTask[]): IslandActivityEntry {
  return { ref: { projectPath: '/p', workId: 'w-1', sessionId: 's-01' },
    activity: { activity: 'idle', subagents: 12, tasks: [], waitingFor: null, heldByBackground: false,
      turnEndedAt: null, lastEventAt: null, source: 'hooks', hooksMissing: false, need: null },
    metrics: { tokensIn: 1, tokensOut: 2, durationMs: null, unread: 0, subagents: 5, model: 'RAW-MODEL',
      ...(tasks === undefined ? {} : { tasks }) } };
}
const task = (id: string): LiveTask => ({ id, agentType: 'general-purpose', description: 'Review tests', background: true });
const hash = (id: string) => createHash('sha256').update(id).digest('hex');

describe('island activity projection', () => {
  it('hashes every ID, caps8 unique tasks and computes total before the cap without source mutation', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => task(`tiny-canary-${i}`));
    const entry = source([...tasks, tasks[0]!, task(''), { ...task('invalid'), id: 2 } as unknown as LiveTask]);
    const before = JSON.stringify(entry);
    const projected = projectIslandActivity(entry);
    expect(projected.islandTasksTotal).toBe(12);
    expect(projected.metrics?.tasks).toHaveLength(8);
    expect(projected.metrics?.subagents).toBe(5);
    expect(projected.metrics?.tasks?.map((t) => t.id)).toEqual(tasks.slice(0, 8).map((t) => hash(t.id)));
    expect(JSON.stringify(projected)).not.toContain('tiny-canary');
    expect(JSON.stringify(entry)).toBe(before);
  });

  it('unknown, known empty and mismatched reported count stay distinct', () => {
    expect(projectIslandActivity(source())).not.toHaveProperty('islandTasksTotal');
    expect(projectIslandActivity(source([]))).toMatchObject({ islandTasksTotal: 0, metrics: { tasks: [], subagents: 5 } });
    const entry = source([task('a'), task('b'), task('c')]); entry.metrics!.subagents = 12;
    expect(projectIslandActivity(entry)).toMatchObject({ islandTasksTotal: 3, metrics: { subagents: 12 } });
    entry.metrics = null; expect(projectIslandActivity(entry)).not.toHaveProperty('islandTasksTotal');
  });

  it('removes raw alternate task paths, plan and other unused free-text metrics', () => {
    const entry = source([task('RAW-ID')]);
    entry.activity.tasks = [{ ...task('RAW-ID'), transcriptPath: '/SECRET-transcript' }];
    entry.activity.waitingFor = 'RAW-ID';
    Object.assign(entry.ref, { unused: 'SECRET-ref-metadata' });
    Object.assign(entry.metrics!, { plan: { secret: 'SECRET-plan' }, waitingFor: 'SECRET-wait', context: { raw: 'SECRET-context' } });
    entry.activity.need = { kind: 'approval', since: '2026-10-27T00:00:00.000Z', detail: 'SECRET-command', resetsAt: null, window: null, account: null };
    const projected = projectIslandActivity(entry);
    expect(projected.activity.tasks).toEqual([]);
    expect(projected.activity.need?.kind).toBe('approval');
    expect(projected.metrics).not.toHaveProperty('plan');
    expect(JSON.stringify(projected)).not.toMatch(/SECRET|RAW-ID|RAW-MODEL/);
  });

  it('strips controls and masks known credentials before bounding labels', () => {
    const entry = source([{ ...task('safe-id'), agentType: `type\n\u0000${'a'.repeat(80)}`,
      description: 'https://URL_USER_CANARY:URL_PASS_CANARY@host/x?token=TOKEN_CANARY API_KEY="KEY_CANARY" Bearer BEARER_CANARY ghp_GITHUB_CANARY sk-OPENAI_CANARY' }]);
    const projected = projectIslandActivity(entry).metrics!.tasks![0]!;
    expect(projected.agentType!.length).toBeLessThanOrEqual(48); expect(projected.description!.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(projected)).not.toMatch(/URL_USER_CANARY|URL_PASS_CANARY|TOKEN_CANARY|KEY_CANARY|BEARER_CANARY|GITHUB_CANARY|OPENAI_CANARY/);
    expect(projected.agentType).not.toMatch(/[\n\r]/);
    expect(projected.description).toContain('[redacted]');
  });

  it('uses generic labels on sanitizer failure and keeps identity stable under reordering', () => {
    const bad = task('one'); Object.defineProperty(bad, 'description', { get: () => { throw new Error('SECRET'); } });
    const result = projectIslandActivity(source([bad]));
    expect(result.metrics?.tasks?.[0]).toMatchObject({ id: hash('one'), description: null });
    const a = projectIslandActivity(source([task('a'), task('b')])).metrics!.tasks!;
    const b = projectIslandActivity(source([task('b'), task('a')])).metrics!.tasks!;
    expect(a.map((t) => t.id).sort()).toEqual(b.map((t) => t.id).sort());
  });

  it('bounds UTF16 label length without splitting emoji', () => {
    const projected = projectIslandActivity(source([{ ...task('emoji'), agentType: '😀'.repeat(49), description: '😀'.repeat(161) }])).metrics!.tasks![0]!;
    expect(projected.agentType).toBe('😀'.repeat(24));
    expect(projected.description).toBe('😀'.repeat(80));
  });

  it('masks authorization headers and quoted credential keys before truncation', () => {
    const projected = projectIslandActivity(source([{ ...task('auth'), description:
      'Authorization: Bearer AUTH_CANARY "api_key": "JSON_CANARY" password=PASS_CANARY' }])).metrics!.tasks![0]!;
    expect(projected.description).not.toMatch(/AUTH_CANARY|JSON_CANARY|PASS_CANARY/);
  });

  it('strips Unicode control, format and line separator characters from task labels', () => {
    const projected = projectIslandActivity(source([{ ...task('controls'), agentType: 'wo\u061c\u00adrker',
      description: 'one\u2028\u2029\ud800two' }])).metrics!.tasks![0]!;
    expect(projected.agentType).toBe('worker');
    expect(projected.description).toBe('onetwo');
  });
});
