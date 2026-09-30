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

const waitFor = async (check: () => boolean, timeoutMs = 5000): Promise<void> => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('изменение не доехало до индекса');
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
      lastRecordAt: found?.endedAt ?? null,
      lastUserRecordAt: found?.lastUserRecordAt ?? null,
    });
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

    await appendFile(
      path.join(claudeRoot, '-proj', 's-01.jsonl'),
      `${JSON.stringify({ type: 'custom-title', customTitle: 'новое', sessionId: 's-01' })}\n`,
    );
    await waitFor(() => idx.index(session({ providerSessionId: 's-01' }))?.title === 'новое', 15_000);
  }, 40_000);

  it('onChange зовётся при изменении индекса', async () => {
    const idx = index();
    let calls = 0;
    idx.onChange(() => {
      calls += 1;
    });
    await idx.start();

    await writeClaudeSession(
      's-02',
      `${JSON.stringify({ type: 'custom-title', customTitle: 'новая', sessionId: 's-02' })}\n`,
    );
    await waitFor(() => calls > 0, 15_000);
  }, 40_000);
});
