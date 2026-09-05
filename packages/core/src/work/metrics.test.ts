import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROVIDERS } from '../providers.js';
import { addSession, transitionSession } from './map.js';
import { finishSession, linkProviderSession, readSessionMetrics, silenceMs } from './metrics.js';
import { createWork, readMap, updateMap } from './store.js';

/** Фикстуры Claude — реальные сессии из ~/.claude/projects, обезличенные. */
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'projects',
);

/** Числа фикстуры `session-1`: посчитаны индексом, проверены в fixtures.test.ts. */
const SESSION_1 = {
  durationMs: 1_034_246,
  tokens: { input: 18, output: 8258, cacheRead: 813_692, cacheWrite: 73_416 },
  toolCalls: { Bash: 4, Agent: 1, ToolSearch: 1, SendMessage: 1 },
  lastRecordAt: '2026-08-26T13:07:35.508Z',
};

let home = '';
let project = '';
let codexRoot = '';
let claudeRoot = '';

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'harnas-codex-'));
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'harnas-claude-'));
  process.env.HARNAS_HOME = home;
});

afterEach(async () => {
  delete process.env.HARNAS_HOME;
  await Promise.all(
    [home, project, codexRoot, claudeRoot].map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

/** Кладёт rollout-лог в <root>/<Y>/<M>/<D>/, как это делает Codex. */
async function writeRollout(
  day: string,
  id: string,
  { cwd, at, tools = [] }: { cwd: string; at: string; tools?: string[] },
): Promise<void> {
  const dir = path.join(codexRoot, ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const lines = [
    line({
      timestamp: at,
      type: 'session_meta',
      payload: { id, timestamp: at, cwd, cli_version: '0.80.0' },
    }),
    line({
      timestamp: at,
      type: 'turn_context',
      payload: { type: 'turn_context', cwd, model: 'gpt-5.1-codex' },
    }),
    ...tools.map((name) =>
      line({
        timestamp: at,
        type: 'response_item',
        payload: { type: 'function_call', name, call_id: 'call_1', arguments: '{}' },
      }),
    ),
    line({
      timestamp: '2026-03-12T10:20:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 1000,
            output_tokens: 340,
          },
        },
      },
    }),
  ].join('');
  await writeFile(path.join(dir, `rollout-${day}T10-00-00-${id}.jsonl`), lines);
}

/** Лог Claude в раскладке ~/.claude/projects/<slug>/<uuid>.jsonl. */
async function writeClaudeLog(slug: string, id: string, lines: string): Promise<void> {
  await mkdir(path.join(claudeRoot, slug), { recursive: true });
  await writeFile(path.join(claudeRoot, slug, `${id}.jsonl`), lines);
}

describe('readSessionMetrics', () => {
  it('считает метрики сессии Claude по id её лога', async () => {
    const found = await readSessionMetrics('claude', 'session-1', { claudeRoot: FIXTURES });

    expect(found).not.toBeNull();
    expect(found?.metrics.durationMs).toBe(SESSION_1.durationMs);
    expect(found?.metrics.tokens).toEqual(SESSION_1.tokens);
    expect(found?.metrics.toolCalls).toEqual(SESSION_1.toolCalls);
    // Время последней записи нужно панели ДЕТАЛИ: «молчит 14м» (дизайн TUI, раздел 3).
    expect(found?.lastRecordAt).toBe(SESSION_1.lastRecordAt);
  });

  it('считает метрики сессии Codex через её адаптер', async () => {
    await writeRollout('2026-03-12', '019ce3d5-584a-7be2-922e-b8185a8d7c19', {
      cwd: '/Users/dev/проект',
      at: '2026-03-12T10:00:00.000Z',
      tools: ['shell', 'shell', 'apply_patch'],
    });

    const found = await readSessionMetrics('codex', '019ce3d5-584a-7be2-922e-b8185a8d7c19', {
      codexRoot,
    });

    expect(found?.metrics.toolCalls).toEqual({ shell: 2, apply_patch: 1 });
    // У Codex input включает кэш — адаптер его вычитает, cacheWrite там нет.
    expect(found?.metrics.tokens).toEqual({
      input: 200,
      output: 340,
      cacheRead: 1000,
      cacheWrite: 0,
    });
    expect(found?.metrics.durationMs).toBe(20 * 60 * 1000);
    expect(found?.lastRecordAt).toBe('2026-03-12T10:20:00.000Z');
  });

  it('лога с таким id нет — null, а не нулевые метрики', async () => {
    expect(await readSessionMetrics('claude', 'нет-такой', { claudeRoot: FIXTURES })).toBeNull();
  });

  it('провайдер без истории (glm) — null: читать нечего', async () => {
    expect(await readSessionMetrics('glm', 'что-угодно', { claudeRoot: FIXTURES })).toBeNull();
  });

  it('в логе нет ни одной записи с usage — токены null, а не нули', async () => {
    await writeClaudeLog(
      '-Users-dev-пусто',
      'пустая',
      line({
        type: 'user',
        timestamp: '2026-09-02T10:00:00.000Z',
        message: { role: 'user', content: 'привет' },
      }) +
        line({
          type: 'user',
          timestamp: '2026-09-02T10:00:30.000Z',
          message: { role: 'user', content: 'ещё раз' },
        }),
    );

    const found = await readSessionMetrics('claude', 'пустая', { claudeRoot });

    expect(found?.metrics.tokens).toBeNull();
    expect(found?.metrics.durationMs).toBe(30_000);
    expect(found?.metrics.toolCalls).toEqual({});
  });
});

describe('linkProviderSession', () => {
  const START = '2026-03-12T09:59:59.000Z';

  it('находит сессию Codex по cwd и времени запуска', async () => {
    await writeRollout('2026-03-12', 'чужой-каталог', {
      cwd: '/Users/dev/другой',
      at: '2026-03-12T10:00:01.000Z',
    });
    await writeRollout('2026-03-12', 'наша-сессия', {
      cwd: '/Users/dev/проект',
      at: '2026-03-12T10:00:02.000Z',
    });

    const id = await linkProviderSession(
      PROVIDERS.codex,
      { cwd: '/Users/dev/проект', startedAt: START },
      { codexRoot },
    );

    expect(id).toBe('наша-сессия');
  });

  it('сессия того же каталога, начавшаяся до запуска, — не наша', async () => {
    await writeRollout('2026-03-12', 'старая', {
      cwd: '/Users/dev/проект',
      at: '2026-03-12T09:00:00.000Z',
    });

    const id = await linkProviderSession(
      PROVIDERS.codex,
      { cwd: '/Users/dev/проект', startedAt: START },
      { codexRoot },
    );

    expect(id).toBeNull();
  });

  it('из нескольких подходящих берёт ближайшую к запуску', async () => {
    await writeRollout('2026-03-12', 'вторая', {
      cwd: '/Users/dev/проект',
      at: '2026-03-12T10:05:00.000Z',
    });
    await writeRollout('2026-03-12', 'первая', {
      cwd: '/Users/dev/проект',
      at: '2026-03-12T10:00:03.000Z',
    });

    const id = await linkProviderSession(
      PROVIDERS.codex,
      { cwd: '/Users/dev/проект', startedAt: START },
      { codexRoot },
    );

    expect(id).toBe('первая');
  });

  it('провайдер задаёт id снаружи (claude) — привязка не нужна, null', async () => {
    const id = await linkProviderSession(
      PROVIDERS.claude,
      { cwd: '/Users/dev/project', startedAt: '2026-08-26T12:00:00.000Z' },
      { claudeRoot: FIXTURES },
    );

    expect(id).toBeNull();
  });

  it('файл, не тронутый после запуска, кандидатом не считается', async () => {
    await writeRollout('2026-03-12', 'подделка', {
      cwd: '/Users/dev/проект',
      at: '2026-03-12T10:00:02.000Z',
    });
    // Логи провайдера читаются десятками мегабайт: разбирать те, что не менялись
    // после запуска процесса, незачем — сессия дописывает свой файл всегда.
    const file = path.join(
      codexRoot,
      '2026',
      '03',
      '12',
      'rollout-2026-03-12T10-00-00-подделка.jsonl',
    );
    await utimes(file, new Date('2026-03-11T00:00:00.000Z'), new Date('2026-03-11T00:00:00.000Z'));

    const id = await linkProviderSession(
      PROVIDERS.codex,
      { cwd: '/Users/dev/проект', startedAt: START },
      { codexRoot },
    );

    expect(id).toBeNull();
  });

  it('провайдер без истории (glm) — null', async () => {
    const id = await linkProviderSession(
      PROVIDERS.glm,
      { cwd: '/Users/dev/проект', startedAt: START },
      { codexRoot },
    );

    expect(id).toBeNull();
  });
});

describe('молчание лога', () => {
  const NOW = Date.parse('2026-09-02T12:00:00.000Z');

  it('время простоя считается от последней записи лога', () => {
    expect(silenceMs('2026-09-02T11:46:00.000Z', NOW)).toBe(14 * 60 * 1000);
  });

  it('записей нет — простой не от чего считать', () => {
    expect(silenceMs(null, NOW)).toBeNull();
  });

  it('битая дата — тоже нечего считать', () => {
    expect(silenceMs('позавчера', NOW)).toBeNull();
  });
});

/** Заводит работу с одной запущенной сессией, привязанной к логу. */
async function workWithActiveSession(providerSessionId: string | null): Promise<string> {
  const map = await createWork(project, { title: 'Авторизация' });
  await updateMap(project, map.work.id, (current) => {
    const session = addSession(current, {
      provider: 'claude',
      label: 'план',
      task: 'Составить план',
    });
    transitionSession(current, session.id, 'active', { at: '2026-08-26T12:50:00.000Z' });
    session.providerSessionId = providerSessionId;
  });
  return map.work.id;
}

describe('finishSession', () => {
  it('фиксирует метрики в карте при переходе в exited', async () => {
    const workId = await workWithActiveSession('session-1');

    await finishSession(project, workId, 's-01', 'exited', {
      claudeRoot: FIXTURES,
      at: '2026-08-26T13:10:00.000Z',
      exitCode: 0,
    });

    const [session] = (await readMap(project, workId)).sessions;
    expect(session?.status).toBe('exited');
    expect(session?.endedAt).toBe('2026-08-26T13:10:00.000Z');
    expect(session?.metrics).toEqual({
      durationMs: SESSION_1.durationMs,
      tokens: SESSION_1.tokens,
      toolCalls: SESSION_1.toolCalls,
    });
    expect(session?.history.at(-1)).toEqual({
      status: 'exited',
      at: '2026-08-26T13:10:00.000Z',
      exitCode: 0,
    });
  });

  it('фиксирует метрики и при отчёте агента (done)', async () => {
    const workId = await workWithActiveSession('session-1');

    await finishSession(project, workId, 's-01', 'done', { claudeRoot: FIXTURES });

    const [session] = (await readMap(project, workId)).sessions;
    expect(session?.status).toBe('done');
    expect(session?.metrics?.tokens).toEqual(SESSION_1.tokens);
  });

  it('сессия не привязана к логу — статус меняется, метрики остаются null', async () => {
    const workId = await workWithActiveSession(null);

    await finishSession(project, workId, 's-01', 'exited', { claudeRoot: FIXTURES });

    const [session] = (await readMap(project, workId)).sessions;
    expect(session?.status).toBe('exited');
    expect(session?.metrics).toBeNull();
  });

  it('лог провайдера уже почистили — статус меняется, метрики остаются null', async () => {
    const workId = await workWithActiveSession('никакого-лога-нет');

    await finishSession(project, workId, 's-01', 'exited', { claudeRoot: FIXTURES });

    const [session] = (await readMap(project, workId)).sessions;
    expect(session?.status).toBe('exited');
    expect(session?.metrics).toBeNull();
  });

  it('недопустимый переход — карта на диске не меняется', async () => {
    const map = await createWork(project, { title: 'Авторизация' });
    await updateMap(project, map.work.id, (current) => {
      addSession(current, { provider: 'claude', label: 'план', task: 'Составить план' });
    });
    const before = await readFile(
      path.join(project, '.harnas', 'works', map.work.id, 'map.json'),
      'utf8',
    );

    // pending → exited в таблице переходов раздела 6 нет: процесс ещё не запускали.
    await expect(finishSession(project, map.work.id, 's-01', 'exited')).rejects.toThrow(
      /недопустимый переход/,
    );
    expect(
      await readFile(path.join(project, '.harnas', 'works', map.work.id, 'map.json'), 'utf8'),
    ).toBe(before);
  });

  it('сессии с таким id нет — ошибка', async () => {
    const workId = await workWithActiveSession('session-1');

    await expect(finishSession(project, workId, 's-99', 'done')).rejects.toThrow(/s-99/);
  });
});
