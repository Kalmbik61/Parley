import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { createCodexLogPoller } from './codex-log-poll.js';

const ref = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w-01', sessionId });
const handle = (sessionId: string, provider: string | null) => ({ ref: ref(sessionId), provider });

/** Подставные зависимости: файлы и их подписи задаёт тест, часы — тоже. */
function setup(initial: Record<string, { size: number; mtimeMs: number } | null> = {}) {
  const files = new Map(Object.entries(initial));
  const reindexed: string[] = [];
  let clock = 1_000_000;
  let handles = [handle('s-01', 'codex')];
  let filesBySession: Record<string, string[]> = { 's-01': ['/log/a.jsonl'] };
  let gate: Promise<void> | null = null;
  const poller = createCodexLogPoller({
    pty: { list: () => handles as never },
    activity: {
      codexLogFiles: (r: SessionRef) => filesBySession[r.sessionId] ?? [],
      reindexLog: async (file: string) => {
        reindexed.push(file);
        if (gate !== null) await gate;
      },
    },
    stat: async (file) => files.get(file) ?? null,
    now: () => clock,
    intervalMs: 2_000,
    quietMs: 2_000,
    maxStaleMs: 30_000,
  });
  return {
    poller,
    reindexed,
    files,
    advance: (ms: number) => (clock += ms),
    setHandles: (value: ReturnType<typeof handle>[]) => (handles = value),
    setFiles: (value: Record<string, string[]>) => (filesBySession = value),
    hold: (promise: Promise<void>) => (gate = promise),
  };
}

describe('codex-log-poll', () => {
  it('неизменный файл после первого перечитывания больше не перечитывается', async () => {
    const t = setup({ '/log/a.jsonl': { size: 10, mtimeMs: 1 } });
    await t.poller.tick(); // знакомство: изменение, ждём затишья
    expect(t.reindexed).toEqual([]);
    t.advance(2_000);
    await t.poller.tick();
    expect(t.reindexed).toEqual(['/log/a.jsonl']);
    t.advance(60_000);
    await t.poller.tick();
    await t.poller.tick();
    expect(t.reindexed).toHaveLength(1);
  });

  it('изменившийся файл перечитывается только после затишья', async () => {
    const t = setup({ '/log/a.jsonl': { size: 10, mtimeMs: 1 } });
    await t.poller.tick();
    t.advance(2_000);
    await t.poller.tick();
    expect(t.reindexed).toHaveLength(1);

    t.files.set('/log/a.jsonl', { size: 20, mtimeMs: 2 });
    t.advance(500);
    await t.poller.tick(); // только что изменился
    expect(t.reindexed).toHaveLength(1);
    t.advance(1_000);
    await t.poller.tick(); // тишина 1000 < 2000
    expect(t.reindexed).toHaveLength(1);
    t.advance(1_000);
    await t.poller.tick(); // тишина 2000
    expect(t.reindexed).toHaveLength(2);
  });

  it('непрерывно растущий файл перечитывается не чаще maxStaleMs', async () => {
    const t = setup({ '/log/a.jsonl': { size: 1, mtimeMs: 1 } });
    await t.poller.tick();
    t.advance(2_000);
    await t.poller.tick();
    expect(t.reindexed).toHaveLength(1);

    let size = 1;
    for (let i = 0; i < 14; i += 1) {
      size += 1;
      t.files.set('/log/a.jsonl', { size, mtimeMs: size });
      t.advance(2_000 - 1); // между проходами файл успевает смениться: затишья нет
      await t.poller.tick();
    }
    // Прошло ~28 с с последнего перечитывания: ещё рано.
    expect(t.reindexed).toHaveLength(1);
    size += 1;
    t.files.set('/log/a.jsonl', { size, mtimeMs: size });
    t.advance(3_000);
    await t.poller.tick();
    expect(t.reindexed).toHaveLength(2);
  });

  it('ручки не Codex игнорируются', async () => {
    const t = setup({ '/log/a.jsonl': { size: 10, mtimeMs: 1 } });
    t.setHandles([handle('s-01', 'claude'), handle('s-02', null)]);
    await t.poller.tick();
    t.advance(5_000);
    await t.poller.tick();
    expect(t.reindexed).toEqual([]);
  });

  it('файлы субагентов опрашиваются тоже', async () => {
    const t = setup({ '/log/a.jsonl': { size: 1, mtimeMs: 1 }, '/log/child.jsonl': { size: 1, mtimeMs: 1 } });
    t.setFiles({ 's-01': ['/log/a.jsonl', '/log/child.jsonl'] });
    await t.poller.tick();
    t.advance(2_000);
    await t.poller.tick();
    expect(t.reindexed.sort()).toEqual(['/log/a.jsonl', '/log/child.jsonl']);
  });

  it('проходы не накладываются: пока идёт перечитывание, следующий проход пропускается', async () => {
    const t = setup({ '/log/a.jsonl': { size: 1, mtimeMs: 1 } });
    await t.poller.tick();
    t.advance(2_000);
    let release!: () => void;
    t.hold(new Promise<void>((resolve) => (release = resolve)));
    const first = t.poller.tick();
    await t.poller.tick(); // пропущен
    expect(t.reindexed).toHaveLength(1);
    release();
    await first;
    expect(t.reindexed).toHaveLength(1);
  });

  it('пропавший файл забывается: вернувшись, он снова знакомится заново', async () => {
    const t = setup({ '/log/a.jsonl': { size: 1, mtimeMs: 1 } });
    await t.poller.tick();
    t.advance(2_000);
    await t.poller.tick();
    expect(t.reindexed).toHaveLength(1);
    t.setFiles({ 's-01': [] });
    await t.poller.tick();
    t.setFiles({ 's-01': ['/log/a.jsonl'] });
    await t.poller.tick(); // знакомство
    t.advance(2_000);
    await t.poller.tick();
    expect(t.reindexed).toHaveLength(2);
  });
});
