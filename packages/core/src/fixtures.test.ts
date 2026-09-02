import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverSessions } from './discover.js';
import { buildIndex, buildSessionTree } from './session-tree.js';
import type { TokenTotals } from './counters.js';

/**
 * Фикстуры — реальные сессии, прогнанные через tools/make-fixtures.mjs: структура
 * записей сохранена целиком, содержимое заменено заглушками. Пересобрать:
 * `node tools/make-fixtures.mjs <session-id> ...`
 */
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'projects',
);

/**
 * Независимый от индекса подсчёт usage по файлу: наивно (по каждой записи) и
 * правильно (по одному разу на message.id). Нужен, чтобы тест видел разницу,
 * а не просто «число не ноль».
 */
async function sumUsage(
  file: string,
): Promise<{ perRecord: TokenTotals; perMessage: TokenTotals }> {
  const zero = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const perRecord = zero();
  const perMessage = zero();
  const seen = new Set<string>();

  for (const raw of (await readFile(file, 'utf8')).split('\n')) {
    if (raw.trim() === '') continue;
    const record = JSON.parse(raw) as {
      message?: { role?: string; id?: string; usage?: Record<string, number> };
    };
    const message = record.message;
    if (message?.role !== 'assistant' || !message.usage) continue;

    const usage = message.usage;
    const add = (into: TokenTotals) => {
      into.input += usage['input_tokens'] ?? 0;
      into.output += usage['output_tokens'] ?? 0;
      into.cacheRead += usage['cache_read_input_tokens'] ?? 0;
      into.cacheWrite += usage['cache_creation_input_tokens'] ?? 0;
    };

    add(perRecord);
    const id = message.id;
    if (id !== undefined && seen.has(id)) continue;
    if (id !== undefined) seen.add(id);
    add(perMessage);
  }

  return { perRecord, perMessage };
}

describe('реальные сессии (анонимизированные фикстуры)', () => {
  it('находит ровно три сессии, журнал workflow сессией не считается', async () => {
    const sessions = await discoverSessions(FIXTURES);
    expect(sessions).toHaveLength(3);
    expect(sessions.map((s) => s.subagents.length).sort()).toEqual([0, 1, 4]);
  });

  it('индекс отсортирован по свежести и полностью заполнен', async () => {
    const index = await buildIndex(FIXTURES);

    expect(index).toHaveLength(3);
    for (const session of index) {
      expect(session.title).not.toBeNull();
      expect(session.titleSource).not.toBeNull();
      expect(session.primaryModel).not.toBeNull();
      expect(session.records).toBeGreaterThan(100);
      expect(session.durationMs).toBeGreaterThan(0);
      expect(session.cwd).toBe('/Users/dev/project');
      expect(session.version).toMatch(/^2\.1\./);
      expect(session.malformedLines).toBe(0);
      expect(session.provider).toBe('claude');
      // Все четыре счётчика приходят из message.usage реальных записей.
      expect(session.tokens).not.toBeNull();
      expect(session.tokens!.output).toBeGreaterThan(0);
      expect(session.tokens!.cacheRead).toBeGreaterThan(0);
      expect(session.tokens!.cacheWrite).toBeGreaterThan(0);
    }

    const ends = index.map((s) => s.endedAt ?? '');
    expect([...ends].sort().reverse()).toEqual(ends);
  });

  it('токены считаются по ответам модели, а не по записям файла', async () => {
    const index = await buildIndex(FIXTURES);

    for (const session of index) {
      const { perRecord, perMessage } = await sumUsage(session.file);
      expect(session.tokens).toEqual(perMessage);
      // В каждом настоящем логе ответ разложен на записи по блокам content
      // с одним message.id — сумма по записям заведомо больше правильной.
      expect(perRecord.output).toBeGreaterThan(perMessage.output);
      expect(perRecord.cacheRead).toBeGreaterThan(perMessage.cacheRead);
    }
  });

  it('сессия с обычным субагентом: задача и тип берутся из meta.json', async () => {
    const sessions = await discoverSessions(FIXTURES);
    const found = sessions.find((s) => s.subagents.length === 1);
    const { session, subsessions } = await buildSessionTree(found!, FIXTURES);

    expect(session.subsessionCount).toBe(1);
    expect(subsessions[0]?.agentType).toBe('devops');
    expect(subsessions[0]?.taskSource).toBe('meta');
    expect(subsessions[0]?.workflowRunId).toBeNull();
    expect(subsessions[0]?.models).toContain('claude-opus-5');
    expect(subsessions[0]?.records).toBeGreaterThan(0);
  });

  it('сессия с workflow: четыре агента, journal.jsonl в подсессии не попал', async () => {
    const sessions = await discoverSessions(FIXTURES);
    const found = sessions.find((s) => s.subagents.length === 4);
    const { subsessions } = await buildSessionTree(found!, FIXTURES);

    expect(subsessions).toHaveLength(4);
    for (const subsession of subsessions) {
      expect(subsession.agentType).toBe('workflow-subagent');
      // У workflow-агентов meta пустая, поэтому задача — первая реплика.
      expect(subsession.taskSource).toBe('first-text');
      expect(subsession.workflowRunId).toMatch(/^wf_/);
    }
    expect(subsessions.every((s) => !s.file.endsWith('journal.jsonl'))).toBe(true);
  });

  it('сессия без субагентов даёт пустое дерево', async () => {
    const sessions = await discoverSessions(FIXTURES);
    const found = sessions.find((s) => s.subagents.length === 0);
    const { session, subsessions } = await buildSessionTree(found!, FIXTURES);

    expect(subsessions).toEqual([]);
    expect(session.subsessionCount).toBe(0);
    expect(session.titleSource).toBe('ai');
  });
});

describe('пограничные случаи раскладки', () => {
  it('каталог subagents без файла сессии игнорируется целиком', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harnas-orphan-'));
    try {
      const dir = path.join(root, '-Users-dev-proj', 'сирота', 'subagents');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'agent-a1.jsonl'), '{"type":"user","isSidechain":true}\n');

      expect(await discoverSessions(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
