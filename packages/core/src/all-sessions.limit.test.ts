import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Подставной читатель со счётчиком (раунд lane-r3, п. 1): все файлы индекса читает
 * `createReadStream` из `jsonl.ts`. Чтение считается открытым от создания потока до
 * его конца — `end`, `close` или `error`, что раньше: fd закрывается уже после того,
 * как разбор файла вернулся, и по `close` счётчик ловил бы перекрытие соседей.
 */
const reads = vi.hoisted(() => ({ open: 0, max: 0, total: 0 }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    reads.open += 1;
    reads.total += 1;
    reads.max = Math.max(reads.max, reads.open);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      reads.open -= 1;
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
    return stream;
  }) as typeof actual.createReadStream;
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});

const { buildAllSessions } = await import('./all-sessions.js');

let claudeRoot: string;
let codexRoot: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

beforeEach(async () => {
  reads.open = 0;
  reads.max = 0;
  reads.total = 0;
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'harnas-limit-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'harnas-limit-codex-'));
});
afterEach(async () => {
  await rm(claudeRoot, { recursive: true, force: true });
  await rm(codexRoot, { recursive: true, force: true });
});

describe('buildAllSessions — параллельность чтения', () => {
  it('при 40 + 40 файлах одновременно читается не больше 8, список тот же', async () => {
    const count = 40;
    await mkdir(path.join(claudeRoot, '-proj'), { recursive: true });
    const codexDir = path.join(codexRoot, '2026', '03', '12');
    await mkdir(codexDir, { recursive: true });
    for (let i = 0; i < count; i += 1) {
      const n = String(i).padStart(2, '0');
      const at = `2026-03-10T10:${n}:00.000Z`;
      await writeFile(
        path.join(claudeRoot, '-proj', `c${n}.jsonl`),
        line({ type: 'user', sessionId: `c${n}`, timestamp: at, message: { role: 'user' } }),
      );
      await writeFile(
        path.join(codexDir, `rollout-2026-03-12T10-00-00-x${n}.jsonl`),
        line({ timestamp: at, type: 'session_meta', payload: { id: `x${n}`, cwd: '/tmp/p' } }),
      );
    }

    const all = await buildAllSessions({ claudeRoot, codexRoot });

    expect(all).toHaveLength(count * 2);
    expect(reads.total).toBe(count * 2);
    expect(reads.max).toBeLessThanOrEqual(8);
    // Ограничение не выродилось в последовательное чтение.
    expect(reads.max).toBeGreaterThan(1);
  });
});
