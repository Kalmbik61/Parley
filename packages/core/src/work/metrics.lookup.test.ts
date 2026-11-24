import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Каждый `readdir` под наблюдением: тесты считают, сколько каталогов истории обошёл поиск лога. */
const readdirs = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = ((...args: Parameters<typeof actual.readdir>) => {
    readdirs.paths.push(String(args[0]));
    return actual.readdir(...args);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

const { readSessionMetrics } = await import('./metrics.js');

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
  'projects',
);
const SESSION_1_FILE = path.join(FIXTURES, '-Users-dev-project-1', 'session-1.jsonl');
const SESSION_2_FILE = path.join(FIXTURES, '-Users-dev-project-2', 'session-2.jsonl');
/** Числа фикстуры `session-1`: те же, что в metrics.test.ts. */
const SESSION_1_DURATION_MS = 1_034_246;

const THREAD = '019ce3d5-584a-7be2-922e-b8185a8d7c19';

let claudeRoot = '';
let codexRoot = '';

beforeEach(async () => {
  readdirs.paths = [];
  claudeRoot = await mkdtemp(path.join(tmpdir(), 'parley-lookup-claude-'));
  codexRoot = await mkdtemp(path.join(tmpdir(), 'parley-lookup-codex-'));
});

afterEach(async () => {
  await Promise.all([claudeRoot, codexRoot].map((dir) => rm(dir, { recursive: true, force: true })));
});

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

/** История Claude: `others` чужих сессий с папками подагентов и одна целевая (копия `session-1`). */
async function claudeHistory(others: number): Promise<void> {
  for (let i = 0; i < others; i += 1) {
    const dir = path.join(claudeRoot, `-p-${String(i).padStart(3, '0')}`);
    await mkdir(path.join(dir, `other-${i}`, 'subagents'), { recursive: true });
    await writeFile(path.join(dir, `other-${i}.jsonl`), '');
  }
  const target = path.join(claudeRoot, '-zzz-target');
  await mkdir(path.join(target, 'session-1', 'subagents'), { recursive: true });
  await copyFile(SESSION_1_FILE, path.join(target, 'session-1.jsonl'));
}

async function codexRollout(day: string, id: string): Promise<string> {
  const dir = path.join(codexRoot, ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${day}T10-00-00-${id}.jsonl`);
  await writeFile(
    file,
    line({ timestamp: '2026-03-12T10:00:00.000Z', type: 'session_meta', payload: { id, timestamp: '2026-03-12T10:00:00.000Z', cwd: '/x', cli_version: '0.80.0' } }) +
      line({ timestamp: '2026-03-12T10:20:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 340 } } } }),
  );
  return file;
}

const readdirsOfClaudeRoot = (): number => readdirs.paths.filter((dir) => dir === claudeRoot).length;

describe('поиск лога сессии без известного пути', () => {
  it('Claude: число readdir поиска не растёт с историей', async () => {
    await claudeHistory(1);
    const small = await readSessionMetrics('claude', 'session-1', { claudeRoot });
    const smallReaddirs = readdirs.paths.length;

    readdirs.paths = [];
    await rm(claudeRoot, { recursive: true, force: true });
    await mkdir(claudeRoot, { recursive: true });
    await claudeHistory(40);
    const large = await readSessionMetrics('claude', 'session-1', { claudeRoot });

    expect(small?.metrics.durationMs).toBe(SESSION_1_DURATION_MS);
    expect(large?.metrics.durationMs).toBe(SESSION_1_DURATION_MS);
    expect(readdirs.paths.length).toBe(smallReaddirs);
    // Корень истории читается один раз; подагенты — только у найденного файла.
    expect(readdirsOfClaudeRoot()).toBe(1);
  });

  it('Claude: лога с таким id нет — null, и без обхода подагентов чужих файлов', async () => {
    await claudeHistory(10);

    expect(await readSessionMetrics('claude', 'нет-такой', { claudeRoot })).toBeNull();
    expect(readdirs.paths).toEqual([claudeRoot]);
  });
});

describe('известный путь лога', () => {
  it('Claude: корень истории не читается', async () => {
    await claudeHistory(20);
    const known = path.join(claudeRoot, '-zzz-target', 'session-1.jsonl');

    const found = await readSessionMetrics('claude', 'session-1', { claudeRoot }, known);

    expect(found?.metrics.durationMs).toBe(SESSION_1_DURATION_MS);
    expect(readdirsOfClaudeRoot()).toBe(0);
  });

  it('Claude: лог, который CLI перенёс в другой каталог проекта, берётся по известному пути', async () => {
    const moved = path.join(claudeRoot, '-moved-project');
    await mkdir(moved, { recursive: true });
    await copyFile(SESSION_1_FILE, path.join(moved, 'session-1.jsonl'));

    // Корень, где его искал бы старый поиск, пуст: найти файл можно только по известному пути.
    const empty = await mkdtemp(path.join(tmpdir(), 'parley-lookup-empty-'));
    try {
      const found = await readSessionMetrics('claude', 'session-1', { claudeRoot: empty }, path.join(moved, 'session-1.jsonl'));
      expect(found?.metrics.durationMs).toBe(SESSION_1_DURATION_MS);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('Claude: путь чужой сессии не берётся — метрики своего файла (возобновление под новым id)', async () => {
    const found = await readSessionMetrics('claude', 'session-1', { claudeRoot: FIXTURES }, SESSION_2_FILE);

    expect(found?.metrics.durationMs).toBe(SESSION_1_DURATION_MS);
  });

  it('Claude: известного файла уже нет — поиск по истории, как раньше', async () => {
    await claudeHistory(3);

    const found = await readSessionMetrics('claude', 'session-1', { claudeRoot }, path.join(claudeRoot, 'нет', 'session-1.jsonl'));

    expect(found?.metrics.durationMs).toBe(SESSION_1_DURATION_MS);
    expect(readdirsOfClaudeRoot()).toBe(1);
  });

  it('Codex: известный путь — без обхода каталогов дней', async () => {
    for (let day = 1; day <= 30; day += 1) await codexRollout(`2026-02-${String(day).padStart(2, '0')}`, `00000000-0000-4000-8000-${String(day).padStart(12, '0')}`);
    const known = await codexRollout('2026-03-12', THREAD);
    readdirs.paths = [];

    const found = await readSessionMetrics('codex', THREAD, { codexRoot }, known);

    expect(found?.lastRecordAt).toBe('2026-03-12T10:20:00.000Z');
    expect(readdirs.paths).toEqual([]);
  });

  it('Codex: откатанный тред (суффикс _rollout в имени) узнаётся по id треда', async () => {
    const known = await codexRollout('2026-03-12', THREAD);
    const renamed = path.join(path.dirname(known), `rollout-2026-03-12T10-00-00-${THREAD}_11111111-1111-4111-8111-111111111111.jsonl`);
    await copyFile(known, renamed);
    readdirs.paths = [];

    const found = await readSessionMetrics('codex', THREAD, { codexRoot }, renamed);

    expect(found?.lastRecordAt).toBe('2026-03-12T10:20:00.000Z');
    expect(readdirs.paths).toEqual([]);
  });

  it('Codex: путь чужого треда не берётся — прежний обход дней', async () => {
    const other = await codexRollout('2026-03-11', '00000000-0000-4000-8000-000000000001');
    await codexRollout('2026-03-12', THREAD);

    const found = await readSessionMetrics('codex', THREAD, { codexRoot }, other);

    expect(found?.lastRecordAt).toBe('2026-03-12T10:20:00.000Z');
    expect(readdirs.paths.length).toBeGreaterThan(0);
  });
});
