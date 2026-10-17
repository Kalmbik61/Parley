import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAllSessions } from './all-sessions.js';
import { assistantCwd } from './discover.js';

let claudeRoot: string;
let codexRoot: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

beforeEach(async () => {
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-all-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-all-codex-'));
});
afterEach(async () => {
  await rm(claudeRoot, { recursive: true, force: true });
  await rm(codexRoot, { recursive: true, force: true });
});

async function claudeSession(id: string, at: string, title: string): Promise<void> {
  await mkdir(path.join(claudeRoot, '-proj'), { recursive: true });
  await writeFile(
    path.join(claudeRoot, '-proj', `${id}.jsonl`),
    line({ type: 'user', sessionId: id, timestamp: at, message: { role: 'user' } }) +
      line({ type: 'custom-title', customTitle: title, sessionId: id }),
  );
}

async function codexSession(
  id: string,
  at: string,
  title: string,
  cwd: string = '/tmp/проект',
): Promise<void> {
  const dir = path.join(codexRoot, '2026', '03', '12');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `rollout-2026-03-12T10-00-00-${id}.jsonl`),
    line({ timestamp: at, type: 'session_meta', payload: { id, cwd } }) +
      line({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: title } }),
  );
}

describe('buildAllSessions', () => {
  it('сливает провайдеров в один список по свежести', async () => {
    await claudeSession('c1', '2026-03-10T10:00:00.000Z', 'клод старый');
    await codexSession('x1', '2026-03-12T10:00:00.000Z', 'кодекс свежий');
    await claudeSession('c2', '2026-03-11T10:00:00.000Z', 'клод средний');

    const all = await buildAllSessions({ claudeRoot, codexRoot });

    expect(all.map((s) => s.title)).toEqual(['кодекс свежий', 'клод средний', 'клод старый']);
    expect(all.map((s) => s.provider)).toEqual(['codex', 'claude', 'claude']);
  });

  it('отсутствие каталога провайдера не мешает остальным', async () => {
    await claudeSession('c1', '2026-03-10T10:00:00.000Z', 'только клод');

    const all = await buildAllSessions({
      claudeRoot,
      codexRoot: path.join(codexRoot, 'нет-такого'),
    });

    expect(all).toHaveLength(1);
    expect(all[0]?.provider).toBe('claude');
  });

  it('оба каталога пусты — пустой список, не ошибка', async () => {
    expect(await buildAllSessions({ claudeRoot, codexRoot })).toEqual([]);
  });

  it('роллаут Codex из папки помощника не попадает в список (спека 2026-10-14, 15.6)', async () => {
    const saved = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = path.join(claudeRoot, 'parley-home');
    try {
      await codexSession('own', '2026-03-12T10:00:00.000Z', 'ход помощника', assistantCwd());
      await codexSession('x1', '2026-03-11T10:00:00.000Z', 'обычная сессия');

      const all = await buildAllSessions({ claudeRoot, codexRoot });

      expect(all.map((s) => s.title)).toEqual(['обычная сессия']);
    } finally {
      if (saved === undefined) delete process.env.PARLEY_HOME;
      else process.env.PARLEY_HOME = saved;
    }
  });
});
