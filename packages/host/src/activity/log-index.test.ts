import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkSession } from '@parley/core';
import { createLogIndex } from './log-index.js';
import type { LogIndex } from './log-index.js';

let claudeRoot = '';
let codexRoot = '';
let indexes: LogIndex[] = [];

beforeEach(async () => {
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-codex-'));
});

afterEach(async () => {
  for (const index of indexes) index.stop();
  indexes = [];
  await Promise.all([claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

function index(): LogIndex {
  const created = createLogIndex({ claudeRoot, codexRoot });
  indexes.push(created);
  return created;
}

function session(over: Partial<WorkSession> = {}): WorkSession {
  return {
    id: 's-01',
    provider: 'claude',
    label: 'план',
    task: '',
    parent: null,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: '2026-09-05T09:00:00.000Z',
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: null,
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
    ...over,
  };
}

async function writeClaudeSession(id: string, lines: string): Promise<string> {
  const dir = path.join(claudeRoot, '-proj');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, lines);
  return file;
}

/**
 * `redo` повторяет запись раз в секунду: рекурсивный fs-наблюдатель включается не мгновенно, и запись сразу
 * после `start()` под нагрузкой уходила раньше него и терялась. Повторяется та же запись (тот же заголовок), так
 * что от повторов индекс не меняется — проверяется по-прежнему доставка через `watchSessions`, не опрос.
 */
const waitFor = async (
  check: () => boolean,
  timeoutMs = 5000,
  redo?: () => Promise<unknown>,
): Promise<void> => {
  const started = Date.now();
  let redoneAt = started;
  while (!check()) {
    const now = Date.now();
    if (now - started > timeoutMs) throw new Error('изменение не доехало до индекса');
    if (redo !== undefined && now - redoneAt >= 1000) {
      redoneAt = now;
      await redo();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('createLogIndex', () => {
  it('providerSessionId нет — index/log отдают undefined/null', async () => {
    const idx = index();
    await idx.start();
    expect(idx.index(session())).toBeUndefined();
    expect(idx.log(session())).toBeNull();
  });

  it('находит запись по providerSessionId после старта', async () => {
    await writeClaudeSession(
      's-01',
      `${JSON.stringify({
        type: 'user',
        sessionId: 's-01',
        timestamp: '2026-09-05T09:00:00.000Z',
        message: { role: 'user', content: 'привет' },
      })}\n${JSON.stringify({ type: 'custom-title', customTitle: 'заголовок', sessionId: 's-01' })}\n`,
    );

    const idx = index();
    await idx.start();

    const found = idx.index(session({ providerSessionId: 's-01' }));
    expect(found?.title).toBe('заголовок');
    expect(idx.log(session({ providerSessionId: 's-01' }))).toEqual({
      // Не `endedAt`: служебные записи после конца хода работой не считаются.
      lastRecordAt: found?.lastWorkRecordAt ?? null,
      lastUserRecordAt: found?.lastUserRecordAt ?? null,
    });
  });

  it('один и тот же нативный id у Claude и Codex друг друга не вытесняет: лог выбирает провайдер сессии', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    await writeClaudeSession(
      id,
      `${JSON.stringify({ type: 'assistant', sessionId: id, timestamp: '2026-10-04T12:00:00.000Z', message: { role: 'assistant' } })}\n`,
    );
    const dir = path.join(codexRoot, '2026', '10', '04');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `rollout-2026-10-04T12-00-01-${id}.jsonl`),
      `${JSON.stringify({ type: 'session_meta', timestamp: '2026-10-04T12:00:01.000Z', payload: { id, cwd: '/codex', source: 'cli' } })}\n`,
    );

    const idx = index();
    await idx.start();

    expect(idx.index(session({ provider: 'claude', providerSessionId: id }))?.provider).toBe('claude');
    expect(idx.index(session({ provider: 'codex', providerSessionId: id }))?.provider).toBe('codex');
    // GLM запускает Claude Code: его логи — логи Claude.
    expect(idx.index(session({ provider: 'glm', providerSessionId: id }))?.provider).toBe('claude');
  });

  it('без явных корней читает каталоги из PARLEY_CLAUDE_PROJECTS_DIR/PARLEY_CODEX_SESSIONS_DIR (lane-r3, п. 1)', async () => {
    // Так E2E окна уводят настоящий хост от истории человека: корни хосту не передать иначе.
    await writeClaudeSession(
      's-01',
      `${JSON.stringify({ type: 'custom-title', customTitle: 'из переменной', sessionId: 's-01' })}\n`,
    );
    process.env.PARLEY_CLAUDE_PROJECTS_DIR = claudeRoot;
    process.env.PARLEY_CODEX_SESSIONS_DIR = codexRoot;
    try {
      const created = createLogIndex();
      indexes.push(created);
      await created.start();
      expect(created.index(session({ providerSessionId: 's-01' }))?.title).toBe('из переменной');
    } finally {
      delete process.env.PARLEY_CLAUDE_PROJECTS_DIR;
      delete process.env.PARLEY_CODEX_SESSIONS_DIR;
    }
  });

  it('дописанный файл доезжает через watchSessions без опроса', async () => {
    await writeClaudeSession(
      's-01',
      `${JSON.stringify({ type: 'custom-title', customTitle: 'старое', sessionId: 's-01' })}\n`,
    );
    const idx = index();
    await idx.start();
    // Под общей сборкой пакетов файлы тестов идут параллельно — запас сверх
    // умолчания на случай задержки диска (works-service.test.ts знает эту же
    // болезнь у своего debounce-теста).
    await waitFor(() => idx.index(session({ providerSessionId: 's-01' }))?.title === 'старое', 15_000);

    const append = (): Promise<void> =>
      appendFile(
        path.join(claudeRoot, '-proj', 's-01.jsonl'),
        `${JSON.stringify({ type: 'custom-title', customTitle: 'новое', sessionId: 's-01' })}\n`,
      );
    await append();
    await waitFor(() => idx.index(session({ providerSessionId: 's-01' }))?.title === 'новое', 15_000, append);
  }, 40_000);

  it('onChange зовётся при изменении индекса', async () => {
    const idx = index();
    let calls = 0;
    idx.onChange(() => {
      calls += 1;
    });
    await idx.start();

    const write = (): Promise<string> =>
      writeClaudeSession(
        's-02',
        `${JSON.stringify({ type: 'custom-title', customTitle: 'новая', sessionId: 's-02' })}\n`,
      );
    await write();
    await waitFor(() => calls > 0, 15_000, write);
  }, 40_000);

  describe('usage: потомки (P36c)', () => {
    const THREAD = '22222222-2222-2222-2222-222222222222';
    const AT = '2026-10-04T12:00:00.000Z';

    /** Rollout Codex: тред `id`, необязательные признаки родства и накопленный итог (вход без кэша — `input`). */
    async function writeThread(
      id: string,
      input: number,
      payload: Record<string, unknown> = {},
      file = `rollout-2026-10-04T12-00-00-${id}.jsonl`,
    ): Promise<void> {
      const dir = path.join(codexRoot, '2026', '10', '04');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, file),
        [
          { type: 'session_meta', timestamp: AT, payload: { id, cwd: '/codex', source: 'cli', ...payload } },
          {
            type: 'event_msg',
            timestamp: AT,
            payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n'),
      );
    }

    const codex = (id: string) => session({ provider: 'codex', providerSessionId: id });

    it('Codex: потомки по цепочке parent_thread_id (дети и внуки) входят в итог родителя, у потомка — только его цепочка', async () => {
      await writeThread(THREAD, 100);
      await writeThread('child-1', 10, { parent_thread_id: THREAD });
      await writeThread('grandchild-1', 1, { parent_thread_id: 'child-1' });
      const idx = index();
      await idx.start();

      expect(idx.usage(codex(THREAD))).toMatchObject({ input: 111, coverage: 'conversation-and-descendants' });
      expect(idx.usage(codex('child-1'))).toMatchObject({ input: 11, coverage: 'conversation-and-descendants' });
      expect(idx.usage(codex('grandchild-1'))).toMatchObject({ input: 1, coverage: 'conversation' });
    });

    it('Codex: цикл в родстве не зацикливает обход, а потомок с двумя файлами одного треда считается один раз', async () => {
      await writeThread('loop-a', 100, { parent_thread_id: 'loop-b' });
      await writeThread('loop-b', 10, { parent_thread_id: 'loop-a' });
      await writeThread(THREAD, 100);
      await writeThread('child-2', 10, { parent_thread_id: THREAD });
      // Откатанный тред: второй rollout того же треда (`_<rollout>` в имени) с тем же session_meta.
      await writeThread('child-2', 10, { parent_thread_id: THREAD }, `rollout-2026-10-04T12-00-00-child-2_other.jsonl`);
      const idx = index();
      await idx.start();

      expect(idx.usage(codex('loop-a'))).toMatchObject({ input: 110, coverage: 'conversation-and-descendants' });
      expect(idx.usage(codex(THREAD))).toMatchObject({ input: 110 });
    });

    it('Codex: форк и потомок без наблюдений — итог неполный, их цифры не прибавлены', async () => {
      await writeThread(THREAD, 100);
      await writeThread('fork-1', 5000, { parent_thread_id: THREAD, forked_from_id: THREAD });
      await writeFile(
        path.join(codexRoot, '2026', '10', '04', 'rollout-2026-10-04T12-00-00-silent-1.jsonl'),
        `${JSON.stringify({ type: 'session_meta', timestamp: AT, payload: { id: 'silent-1', cwd: '/codex', source: 'cli', parent_thread_id: THREAD } })}\n`,
      );
      const idx = index();
      await idx.start();

      expect(idx.usage(codex(THREAD))).toMatchObject({ input: 100, completeness: 'partial', coverage: 'conversation' });
    });

    it('Claude: итог записи уже включает подагентов; лога нет — undefined', async () => {
      const id = 's-claude';
      const answer = (msg: string, input: number) =>
        `${JSON.stringify({ type: 'assistant', sessionId: id, timestamp: AT, message: { role: 'assistant', id: msg, usage: { input_tokens: input, output_tokens: 1 } } })}\n`;
      await writeClaudeSession(id, answer('msg_p', 100));
      await mkdir(path.join(claudeRoot, '-proj', id, 'subagents'), { recursive: true });
      await writeFile(path.join(claudeRoot, '-proj', id, 'subagents', 'agent-a1.jsonl'), answer('msg_a', 30));
      const idx = index();
      await idx.start();

      expect(idx.usage(session({ providerSessionId: id }))).toMatchObject({ input: 130, coverage: 'conversation-and-descendants' });
      expect(idx.usage(session({ providerSessionId: 'нет-такого' }))).toBeUndefined();
      expect(idx.usage(session())).toBeUndefined();
    });
  });
});
