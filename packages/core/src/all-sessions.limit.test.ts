import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexReuse } from './index-reuse.js';
import type { SessionIndex } from './session-index.js';

/**
 * Подставной читатель со счётчиком (раунд lane-r3, п. 1): все файлы индекса читает
 * `createReadStream` из `jsonl.ts`. Чтение считается открытым от создания потока до
 * его конца — `end`, `close` или `error`, что раньше: fd закрывается уже после того,
 * как разбор файла вернулся, и по `close` счётчик ловил бы перекрытие соседей.
 * `onOpen` зовётся на каждом новом чтении — по нему тест останавливает индекс посреди работы.
 */
const reads = vi.hoisted(() => ({
  open: 0,
  max: 0,
  total: 0,
  onOpen: undefined as (() => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((...args: Parameters<typeof actual.createReadStream>) => {
    const stream = actual.createReadStream(...args);
    reads.open += 1;
    reads.total += 1;
    reads.max = Math.max(reads.max, reads.open);
    reads.onOpen?.();
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
const { appendFile } = await import('node:fs/promises');

let claudeRoot: string;
let codexRoot: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

beforeEach(async () => {
  reads.open = 0;
  reads.max = 0;
  reads.total = 0;
  reads.onOpen = undefined;
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-limit-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-limit-codex-'));
});
afterEach(async () => {
  await rm(claudeRoot, { recursive: true, force: true });
  await rm(codexRoot, { recursive: true, force: true });
});

/** По `count` сессий Claude и Codex, по одной записи в каждой. */
async function writeHistory(count: number): Promise<void> {
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
}

describe('buildAllSessions — параллельность чтения', () => {
  it('при 40 + 40 файлах одновременно читается не больше 8, список тот же', async () => {
    const count = 40;
    await writeHistory(count);

    const all = await buildAllSessions({ claudeRoot, codexRoot });

    expect(all).toHaveLength(count * 2);
    expect(reads.total).toBe(count * 2);
    expect(reads.max).toBeLessThanOrEqual(8);
    // Ограничение не выродилось в последовательное чтение.
    expect(reads.max).toBeGreaterThan(1);
  });
});

describe('buildAllSessions — остановка (2026-10-06)', () => {
  // Хост строит индекс в фоне и на остановке прерывает его: без этого чтение истории в гигабайты
  // держало процесс хоста живым минутами после «хост остановлен».
  it('сигнал прерван посреди чтения: новых чтений нет, начатые закрываются, отказ AbortError', async () => {
    await writeHistory(40);
    const controller = new AbortController();
    reads.onOpen = () => {
      if (reads.total === 3) controller.abort();
    };

    await expect(
      buildAllSessions({ claudeRoot, codexRoot, signal: controller.signal }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    // Третье чтение уже открылось, когда пришла остановка, — после неё не начинается ни одно.
    expect(reads.total).toBe(3);
    await vi.waitFor(() => expect(reads.open).toBe(0));
  });

  it('сигнал прерван до начала — ни одного чтения', async () => {
    await writeHistory(5);
    await expect(
      buildAllSessions({ claudeRoot, codexRoot, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(reads.total).toBe(0);
  });
});

/** Кэш в памяти: `old` — что видел прошлый запуск, `fresh` — что кладёт текущая сборка. */
function memoryReuse(old: Map<string, { key: string; index: SessionIndex }>) {
  const fresh = new Map<string, { key: string; index: SessionIndex }>();
  const reuse: IndexReuse = {
    get: (file, key) => (old.get(file)?.key === key ? old.get(file)?.index : undefined),
    put: (file, key, index) => void fresh.set(file, { key, index }),
  };
  return { reuse, fresh };
}

describe('buildAllSessions — reuse (кэш между запусками)', () => {
  it('reuse: файл с совпавшим ключом не открывается', async () => {
    await writeHistory(6);
    const first = memoryReuse(new Map());
    const built = await buildAllSessions({ claudeRoot, codexRoot, reuse: first.reuse });
    expect(reads.total).toBe(12);
    const before = reads.total;

    const second = memoryReuse(first.fresh);
    const again = await buildAllSessions({ claudeRoot, codexRoot, reuse: second.reuse });

    expect(reads.total - before).toBe(0);
    expect(again).toEqual(built);
    expect(second.fresh.size).toBe(12);
  });

  it('reuse: дописанный файл и новый подагент читаются заново, остальные — нет', async () => {
    await writeHistory(4);
    const first = memoryReuse(new Map());
    await buildAllSessions({ claudeRoot, codexRoot, reuse: first.reuse });
    const before = reads.total;

    await appendFile(path.join(claudeRoot, '-proj', 'c01.jsonl'), line({ type: 'user', sessionId: 'c01', timestamp: '2026-03-10T11:00:00.000Z', message: { role: 'user' } }));
    // Подагент у сессии, чей главный файл не менялся: ключ включает подагентов.
    await mkdir(path.join(claudeRoot, '-proj', 'c02', 'subagents'), { recursive: true });
    await writeFile(
      path.join(claudeRoot, '-proj', 'c02', 'subagents', 'agent-a1.jsonl'),
      line({ type: 'user', sessionId: 'c02', timestamp: '2026-03-10T11:00:00.000Z', message: { role: 'user' } }),
    );
    const second = memoryReuse(first.fresh);
    const again = await buildAllSessions({ claudeRoot, codexRoot, reuse: second.reuse });

    // c01: один файл; c02: главный файл и подагент.
    expect(reads.total - before).toBe(3);
    expect(again.find((session) => session.id === 'c01')?.records).toBe(2);
  });

  it('reuse: файл, дописанный во время чтения, при следующей сборке читается снова', async () => {
    // Одна сессия Claude: её чтение первое в сборке (Claude строится до Codex).
    await writeHistory(1);
    const target = path.join(claudeRoot, '-proj', 'c00.jsonl');
    const first = memoryReuse(new Map());
    let appending: Promise<void> | undefined;
    reads.onOpen = () => {
      // Ключ снимается до открытия потока: дозапись после него обязана сделать ключ устаревшим.
      appending ??= appendFile(target, line({ type: 'user', sessionId: 'c00', timestamp: '2026-03-10T12:00:00.000Z', message: { role: 'user' } }));
    };
    await buildAllSessions({ claudeRoot, codexRoot, reuse: first.reuse });
    reads.onOpen = undefined;
    await appending;
    const before = reads.total;

    const second = memoryReuse(first.fresh);
    await buildAllSessions({ claudeRoot, codexRoot, reuse: second.reuse });

    // Перечитан ровно дописанный файл; rollout Codex взят из кэша.
    expect(reads.total - before).toBe(1);
  });
});
