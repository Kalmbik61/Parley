import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexCodexSession } from './index-session.js';

let root: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

async function writeRollout(lines: string): Promise<string> {
  const dir = path.join(root, '2026', '10', '04');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'rollout-2026-10-04T12-00-00-thread-secret.jsonl');
  await writeFile(file, lines);
  return file;
}

const meta = line({
  timestamp: '2026-10-04T12:00:00.000Z',
  type: 'session_meta',
  payload: { id: 'thread-secret', cwd: '/proj', source: 'cli' },
});

const tokenCount = (at: string, total: Record<string, number>) =>
  line({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-codex-usage-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('usage лога Codex', () => {
  it('ненаблюдаемая запись в кэш — null, а не измеренный ноль; вход без кэша и полный вход не удваиваются', async () => {
    const file = await writeRollout(
      meta +
        tokenCount('2026-10-04T12:00:01.000Z', { input_tokens: 100, cached_input_tokens: 20, output_tokens: 20 }) +
        tokenCount('2026-10-04T12:00:02.000Z', { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 200 }),
    );

    const index = await indexCodexSession(file);
    expect(index.usage).toEqual({
      input: 800,
      output: 200,
      cacheRead: 200,
      cacheWrite: null,
      totalInput: 1000,
      source: 'native-index',
      observedAt: '2026-10-04T12:00:02.000Z',
      stale: false,
      completeness: 'complete',
      coverage: 'conversation',
    });
    // Прежняя форма `tokens` не менялась: там запись в кэш по-прежнему 0.
    expect(index.tokens).toEqual({ input: 800, output: 200, cacheRead: 200, cacheWrite: 0 });
  });

  it('повтор той же записи итог не меняет', async () => {
    const same = tokenCount('2026-10-04T12:00:02.000Z', { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 200 });
    const index = await indexCodexSession(await writeRollout(meta + same + same));
    expect(index.usage).toMatchObject({ totalInput: 1000, output: 200, completeness: 'complete' });
  });

  it('спад накопителя без доказанного сброса: наибольшее значение и неполный итог, а не выдуманная сумма', async () => {
    const file = await writeRollout(
      meta +
        tokenCount('2026-10-04T12:00:01.000Z', { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 200 }) +
        tokenCount('2026-10-04T12:00:02.000Z', { input_tokens: 90, cached_input_tokens: 10, output_tokens: 15 }),
    );
    expect((await indexCodexSession(file)).usage).toMatchObject({
      totalInput: 1000,
      output: 200,
      completeness: 'partial',
    });
  });

  it('нет поля кэша в записи: вход без кэша неизвестен, полный вход известен', async () => {
    const file = await writeRollout(meta + tokenCount('2026-10-04T12:00:01.000Z', { input_tokens: 500, output_tokens: 7 }));
    expect((await indexCodexSession(file)).usage).toMatchObject({
      input: null,
      cacheRead: null,
      cacheWrite: null,
      totalInput: 500,
      output: 7,
    });
  });

  it('явный ноль кэша — измеренный ноль: вход без кэша равен полному входу', async () => {
    const file = await writeRollout(
      meta + tokenCount('2026-10-04T12:00:01.000Z', { input_tokens: 500, cached_input_tokens: 0, output_tokens: 7 }),
    );
    const index = await indexCodexSession(file);
    expect(index.usage).toMatchObject({ input: 500, cacheRead: 0, cacheWrite: null, totalInput: 500, completeness: 'complete' });
    expect(index.tokens).toEqual({ input: 500, output: 7, cacheRead: 0, cacheWrite: 0 });
  });

  it('нечисловое поле кэша — неизвестно, а не 0; легаси tokens не выдаёт полный вход за вход без кэша', async () => {
    const file = await writeRollout(
      meta +
        line({
          timestamp: '2026-10-04T12:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 'many', output_tokens: 7 } },
          },
        }),
    );
    const index = await indexCodexSession(file);
    expect(index.usage).toMatchObject({ input: null, cacheRead: null, totalInput: 500, output: 7 });
    // Для показа неизвестное — 0, но вход без кэша не равен 500: вычитать из него нечем.
    expect(index.tokens).toEqual({ input: 0, output: 7, cacheRead: 0, cacheWrite: 0 });
  });

  it('нет поля output: выход неизвестен, сумма не подменяется нулём', async () => {
    const file = await writeRollout(meta + tokenCount('2026-10-04T12:00:01.000Z', { input_tokens: 500, cached_input_tokens: 100 }));
    expect((await indexCodexSession(file)).usage).toMatchObject({ input: 400, output: null, totalInput: 500 });
  });

  it('без token_count итог неизвестен; нативного id нет в публичном итоге', async () => {
    const index = await indexCodexSession(await writeRollout(meta));
    expect(index.usage).toMatchObject({ input: null, completeness: 'unknown' });
    expect(JSON.stringify(index.usage)).not.toContain('thread-secret');
  });

  it('потомок по родным признакам: parent_thread_id или source.subagent.thread_spawn, форк — forked_from_id', async () => {
    const spawned = (payload: Record<string, unknown>) =>
      line({ timestamp: '2026-10-04T12:00:00.000Z', type: 'session_meta', payload: { id: 'thread-child', cwd: '/proj', ...payload } });

    const direct = await indexCodexSession(await writeRollout(spawned({ source: 'cli', parent_thread_id: 'parent-1' })));
    expect(direct).toMatchObject({ spawned: true, parentId: 'parent-1' });
    expect(direct.forkedFrom).toBeUndefined();

    const nested = await indexCodexSession(
      await writeRollout(
        spawned({ source: { subagent: { thread_spawn: { parent_thread_id: 'parent-2', depth: 1 } } }, forked_from_id: 'parent-2' }),
      ),
    );
    expect(nested).toMatchObject({ spawned: true, parentId: 'parent-2', forkedFrom: 'parent-2' });

    // Обычный тред родителя не имеет; догадок по времени и cwd нет.
    const plain = await indexCodexSession(await writeRollout(meta));
    expect(plain.parentId).toBeUndefined();
    expect(plain.forkedFrom).toBeUndefined();
  });
});
