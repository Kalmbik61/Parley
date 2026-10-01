import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAllSessions } from './all-sessions.js';

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

async function codexSession(id: string, at: string, title: string): Promise<void> {
  const dir = path.join(codexRoot, '2026', '03', '12');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `rollout-2026-03-12T10-00-00-${id}.jsonl`),
    line({ timestamp: at, type: 'session_meta', payload: { id, cwd: '/tmp/проект' } }) +
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
});
