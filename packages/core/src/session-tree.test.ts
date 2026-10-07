import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSessions } from './discover.js';
import { buildIndex, buildSessionTree } from './session-tree.js';

let root: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

async function put(relative: string, content: string): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

/** Раскладка, как её пишет Claude Code 2.1.x: сессия + субагенты + журнал workflow. */
async function fixture(): Promise<void> {
  await put(
    '-Users-me-proj/s1.jsonl',
    line({
      type: 'user',
      sessionId: 's1',
      cwd: '/Users/me/proj',
      timestamp: '2026-09-01T10:00:00.000Z',
      message: { role: 'user', content: 'сделай' },
    }) +
      line({ type: 'custom-title', customTitle: 'сессия один', sessionId: 's1' }) +
      line({
        type: 'assistant',
        timestamp: '2026-09-01T10:30:00.000Z',
        message: { role: 'assistant', model: 'claude-opus-5', content: [] },
      }),
  );

  // Обычный субагент: meta заполнена целиком.
  await put(
    '-Users-me-proj/s1/subagents/agent-a1.jsonl',
    line({
      type: 'user',
      sessionId: 's1',
      agentId: 'a1',
      isSidechain: true,
      timestamp: '2026-09-01T10:05:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'реплика агента' }] },
    }) +
      line({
        type: 'assistant',
        isSidechain: true,
        timestamp: '2026-09-01T10:07:00.000Z',
        message: { role: 'assistant', model: 'claude-sonnet-5', content: [] },
      }),
  );
  await put(
    '-Users-me-proj/s1/subagents/agent-a1.meta.json',
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'Починить парсер',
      name: 'fix-parser',
      toolUseId: 'toolu_1',
      spawnDepth: 1,
    }),
  );

  // Workflow-агент: meta почти пустая, задача берётся из первой реплики.
  await put(
    '-Users-me-proj/s1/subagents/workflows/wf_abc/agent-a2.jsonl',
    line({
      type: 'assistant',
      isSidechain: true,
      timestamp: '2026-09-01T10:20:00.000Z',
      message: {
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'text', text: '  задача\n  из реплики  ' }],
      },
    }),
  );
  await put(
    '-Users-me-proj/s1/subagents/workflows/wf_abc/agent-a2.meta.json',
    JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
  );

  // Журнал workflow — не подсессия.
  await put(
    '-Users-me-proj/s1/subagents/workflows/wf_abc/journal.jsonl',
    line({ type: 'started', key: 'v2:x', agentId: 'a2' }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-tree-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverSessions', () => {
  it('сессией считается только <project>/<id>.jsonl', async () => {
    await fixture();
    const sessions = await discoverSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('s1');
    expect(sessions[0]?.project).toBe('-Users-me-proj');
  });

  it('находит субагентов на всех уровнях и не считает journal подсессией', async () => {
    await fixture();
    const [session] = await discoverSessions(root);
    const ids = session?.subagents.map((s) => s.agentId).sort();
    expect(ids).toEqual(['a1', 'a2']);
    expect(session?.subagents.find((s) => s.agentId === 'a2')?.workflowRunId).toBe('wf_abc');
    expect(session?.subagents.find((s) => s.agentId === 'a1')?.workflowRunId).toBeNull();
  });

  it('пустой корень — пустой список, не ошибка', async () => {
    expect(await discoverSessions(root)).toEqual([]);
  });

  it('старый кэш sessions-index.json сессией не считается', async () => {
    // Формат v1 с полем summary: описывает давно удалённые сессии, см. spec.
    await put(
      '-Users-me-proj/sessions-index.json',
      JSON.stringify({ version: 1, entries: [{ sessionId: 'мёртвая', summary: 'старьё' }] }),
    );
    await put('-Users-me-proj/MEMORY.md', 'заметки');

    expect(await discoverSessions(root)).toEqual([]);
  });

  it('несуществующий корень — пустой список, не ошибка', async () => {
    expect(await discoverSessions(path.join(root, 'нет-такого'))).toEqual([]);
  });
});

describe('buildSessionTree', () => {
  it('собирает сессию с подсессиями по возрастанию времени', async () => {
    await fixture();
    const [discovered] = await discoverSessions(root);
    const tree = await buildSessionTree(discovered!, root);

    expect(tree.session.title).toBe('сессия один');
    expect(tree.session.subsessionCount).toBe(2);
    expect(tree.subsessions.map((s) => s.agentId)).toEqual(['a1', 'a2']);
  });

  it('задача обычного агента — description из meta', async () => {
    await fixture();
    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);
    const a1 = subsessions.find((s) => s.agentId === 'a1');

    expect(a1?.task).toBe('Починить парсер');
    expect(a1?.taskSource).toBe('meta');
    expect(a1?.agentType).toBe('general-purpose');
    expect(a1?.toolUseId).toBe('toolu_1');
    expect(a1?.models).toEqual(['claude-sonnet-5']);
    expect(a1?.durationMs).toBe(120_000);
  });

  it('у workflow-агента задача берётся из первой реплики', async () => {
    await fixture();
    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);
    const a2 = subsessions.find((s) => s.agentId === 'a2');

    expect(a2?.task).toBe('задача из реплики');
    expect(a2?.taskSource).toBe('first-text');
    expect(a2?.agentType).toBe('workflow-subagent');
    expect(a2?.workflowRunId).toBe('wf_abc');
    expect(a2?.models).toEqual(['claude-fable-5']);
  });

  it('субагент без meta.json не роняет сборку', async () => {
    await put(
      '-Users-me-proj/s2.jsonl',
      line({ type: 'user', sessionId: 's2', message: { role: 'user', content: 'привет' } }),
    );
    await put(
      '-Users-me-proj/s2/subagents/agent-a9.jsonl',
      line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', model: 'm' } }),
    );

    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);
    expect(subsessions[0]?.agentType).toBeNull();
    expect(subsessions[0]?.task).toBeNull();
    expect(subsessions[0]?.taskSource).toBeNull();
  });
});

describe('buildIndex', () => {
  it('сортирует по свежести и проставляет subsessionCount', async () => {
    await fixture();
    await put(
      '-Users-me-other/s9.jsonl',
      line({
        type: 'user',
        sessionId: 's9',
        timestamp: '2026-09-02T10:00:00.000Z',
        message: { role: 'user', content: 'свежее' },
      }),
    );

    const index = await buildIndex(root);
    expect(index.map((s) => s.id)).toEqual(['s9', 's1']);
    expect(index[1]?.subsessionCount).toBe(2);
    expect(index[0]?.subsessionCount).toBe(0);
  });
});

describe('buildIndex: токены подагентов', () => {
  it('усыновляет usage подагентов, включая вложенные workflow, но не journal.jsonl', async () => {
    const answer = (id: string, input: number) =>
      line({
        type: 'assistant',
        timestamp: '2026-09-01T10:00:00.000Z',
        message: { role: 'assistant', id, usage: { input_tokens: input, output_tokens: 1 } },
      });
    await put('-Users-me-proj/s5.jsonl', answer('msg_p', 100));
    await put('-Users-me-proj/s5/subagents/agent-a1.jsonl', answer('msg_a1', 10));
    await put('-Users-me-proj/s5/subagents/workflows/wf_x/agent-a2.jsonl', answer('msg_a2', 1));
    await put('-Users-me-proj/s5/subagents/workflows/wf_x/journal.jsonl', answer('msg_journal', 1000));

    const [session] = await buildIndex(root);
    expect(session?.usage).toMatchObject({ input: 111, coverage: 'conversation-and-descendants' });
    expect(session?.subsessionCount).toBe(2);
  });
});

describe('задачи агентов одного workflow различимы', () => {
  /** Общее задание, которое Workflow копирует каждому агенту дословно. */
  const shared = [
    'Ты правишь контент курса. Аудитория — новички.',
    'Правила: не трогай чужие файлы, пиши коротко, проверяй ссылки.',
    'Формат ответа: список правок с обоснованием каждой.',
    'Дальше идёт твоя часть работы.',
  ].join('\n');

  async function workflowAgent(id: string, tail: string): Promise<void> {
    const dir = `-Users-me-proj/s1/subagents/workflows/wf_один/agent-${id}`;
    await put(
      `${dir}.jsonl`,
      line({
        type: 'user',
        isSidechain: true,
        timestamp: '2026-09-01T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `${shared}\n${tail}` }] },
      }),
    );
    await put(
      `${dir}.meta.json`,
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    );
  }

  beforeEach(async () => {
    await put('-Users-me-proj/s1.jsonl', line({ type: 'user', sessionId: 's1' }));
  });

  it('общий кусок отрезается, остаётся то, чем агенты отличаются', async () => {
    await workflowAgent('a1', 'Урок 3: посмотри вступление.');
    await workflowAgent('a2', 'Урок 7: посмотри домашку.');

    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);

    expect(subsessions.map((s) => s.task).sort()).toEqual([
      'Урок 3: посмотри вступление.',
      'Урок 7: посмотри домашку.',
    ]);
    expect(subsessions.every((s) => s.taskSource === 'workflow-tail')).toBe(true);
  });

  it('агент с другой ролью не мешает остальным', async () => {
    await workflowAgent('a1', 'Урок 3: посмотри вступление.');
    await workflowAgent('a2', 'Урок 7: посмотри домашку.');
    // Сводящий агент начинается совсем иначе — раньше он обнулял общий префикс.
    await put(
      '-Users-me-proj/s1/subagents/workflows/wf_один/agent-a3.jsonl',
      line({
        type: 'user',
        isSidechain: true,
        message: { role: 'user', content: [{ type: 'text', text: 'Собери итоги всех агентов.' }] },
      }),
    );
    await put(
      '-Users-me-proj/s1/subagents/workflows/wf_один/agent-a3.meta.json',
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }),
    );

    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);
    const tasks = subsessions.map((s) => s.task).sort();

    expect(tasks).toContain('Урок 3: посмотри вступление.');
    expect(tasks).toContain('Урок 7: посмотри домашку.');
    expect(tasks).toContain('Собери итоги всех агентов.');
  });

  it('одинокий агент workflow остаётся с полной репликой', async () => {
    await workflowAgent('a1', 'Урок 3: посмотри вступление.');

    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);

    expect(subsessions[0]?.taskSource).toBe('first-text');
    expect(subsessions[0]?.task?.startsWith('Ты правишь контент')).toBe(true);
  });

  it('сырой текст не утекает в выдачу', async () => {
    await workflowAgent('a1', 'Урок 3.');
    await workflowAgent('a2', 'Урок 7.');

    const [discovered] = await discoverSessions(root);
    const { subsessions } = await buildSessionTree(discovered!, root);
    expect(subsessions.every((s) => s.taskRaw === undefined)).toBe(true);
  });
});
