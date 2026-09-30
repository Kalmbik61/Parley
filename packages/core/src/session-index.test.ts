import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexSessionFile } from './session-index.js';

let root: string;

const line = (record: unknown) => `${JSON.stringify(record)}\n`;

/** Кладёт файл сессии в <root>/<slug>/<id>.jsonl, как это делает Claude Code. */
async function writeSession(slug: string, id: string, lines: string): Promise<string> {
  await mkdir(path.join(root, slug), { recursive: true });
  const file = path.join(root, slug, `${id}.jsonl`);
  await writeFile(file, lines);
  return file;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-index-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('indexSessionFile', () => {
  it('собирает мету, длительность и счётчики', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      's1',
      line({
        type: 'user',
        sessionId: 's1',
        cwd: '/Users/me/proj',
        gitBranch: 'main',
        version: '2.1.247',
        timestamp: '2026-09-01T10:00:00.000Z',
        message: { role: 'user', content: 'сделай' },
      }) +
        line({
          type: 'assistant',
          timestamp: '2026-09-01T10:02:30.000Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'tool_use', name: 'Bash' }],
          },
        }) +
        line({ type: 'custom-title', customTitle: 'заголовок', sessionId: 's1' }),
    );

    const index = await indexSessionFile(file, root);

    expect(index.id).toBe('s1');
    expect(index.project).toBe('-Users-me-proj');
    expect(index.projectPath).toBe('/Users/me/proj');
    expect(index.gitBranch).toBe('main');
    expect(index.version).toBe('2.1.247');
    expect(index.startedAt).toBe('2026-09-01T10:00:00.000Z');
    expect(index.endedAt).toBe('2026-09-01T10:02:30.000Z');
    // Ось записей пользователя отдельно от общей: последняя запись здесь —
    // ответ модели, и страховке 4.3 она `blocked` не снимает.
    expect(index.lastUserRecordAt).toBe('2026-09-01T10:00:00.000Z');
    expect(index.durationMs).toBe(150_000);
    expect(index.records).toBe(3);
    expect(index.models).toEqual({ 'claude-opus-5': 1 });
    expect(index.tools).toEqual({ Bash: 1 });
    expect(index.roles).toEqual({ user: 1, assistant: 1 });
    expect(index.recordTypes).toEqual({ user: 1, assistant: 1, 'custom-title': 1 });
    expect(index.provider).toBe('claude');
  });

  it('primaryModel — самая частая модель, <synthetic> не в счёт', async () => {
    const assistant = (model: string) =>
      line({ type: 'assistant', message: { role: 'assistant', model } });
    const file = await writeSession(
      '-Users-me-proj',
      's2',
      assistant('<synthetic>') +
        assistant('<synthetic>') +
        assistant('<synthetic>') +
        assistant('claude-sonnet-5') +
        assistant('claude-opus-5') +
        assistant('claude-opus-5'),
    );

    const index = await indexSessionFile(file, root);
    expect(index.primaryModel).toBe('claude-opus-5');
    expect(index.models['<synthetic>']).toBe(3);
  });

  it('без моделей primaryModel = null', async () => {
    const file = await writeSession('-Users-me-proj', 's3', line({ type: 'user' }));
    const index = await indexSessionFile(file, root);
    expect(index.primaryModel).toBeNull();
  });

  it('без таймстемпов длительность = null, id падает на имя файла', async () => {
    const file = await writeSession('-Users-me-proj', 's4', line({ type: 'custom-title' }));
    const index = await indexSessionFile(file, root);
    expect(index.id).toBe('s4');
    expect(index.startedAt).toBeNull();
    expect(index.durationMs).toBeNull();
  });

  it('оборванная последняя строка учитывается, но не мешает индексу', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      's5',
      line({ type: 'user', sessionId: 's5', timestamp: '2026-09-01T10:00:00.000Z' }) +
        '{"type":"ass',
    );
    const index = await indexSessionFile(file, root);
    expect(index.id).toBe('s5');
    expect(index.records).toBe(1);
    expect(index.malformedLines).toBe(1);
  });

  it('токены суммируются по четырём счётчикам записей ассистента', async () => {
    const assistant = (usage: Record<string, number>) =>
      line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', usage } });
    const file = await writeSession(
      '-Users-me-proj',
      'tok1',
      assistant({
        input_tokens: 2,
        output_tokens: 87,
        cache_read_input_tokens: 38_011,
        cache_creation_input_tokens: 48_061,
      }) +
        assistant({
          input_tokens: 3,
          output_tokens: 13,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 57,
        }) +
        // Реплика человека своего usage не приносит, даже если поле есть.
        line({ type: 'user', message: { role: 'user', usage: { input_tokens: 999 } } }),
    );

    const index = await indexSessionFile(file, root);
    expect(index.tokens).toEqual({
      input: 5,
      output: 100,
      cacheRead: 39_011,
      cacheWrite: 48_118,
    });
  });

  it('один ответ модели, разложенный по записям на блок, считается один раз', async () => {
    // Claude Code пишет thinking / text / tool_use отдельными записями с ОДНИМ
    // message.id, и каждая несёт полный usage ответа. Суммировать их нельзя.
    const usage = {
      input_tokens: 2,
      output_tokens: 240,
      cache_read_input_tokens: 34_763,
      cache_creation_input_tokens: 51_229,
    };
    const block = (id: string, content: unknown) =>
      line({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-opus-5', id, content, usage },
      });
    const file = await writeSession(
      '-Users-me-proj',
      'tok3',
      block('msg_01', [{ type: 'thinking', thinking: '…' }]) +
        block('msg_01', [{ type: 'text', text: 'делаю' }]) +
        block('msg_01', [{ type: 'tool_use', name: 'Bash' }]) +
        block('msg_02', [{ type: 'text', text: 'готово' }]),
    );

    const index = await indexSessionFile(file, root);
    // Два ответа, не четыре: 2×usage, а не 4×.
    expect(index.tokens).toEqual({
      input: 4,
      output: 480,
      cacheRead: 69_526,
      cacheWrite: 102_458,
    });
    // Инструменты и модели по-прежнему считаются по каждой записи.
    expect(index.tools).toEqual({ Bash: 1 });
  });

  it('записи без message.id считаются каждая — склеивать их не по чему', async () => {
    const usage = { input_tokens: 1, output_tokens: 10 };
    const assistant = () =>
      line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5', usage } });
    const file = await writeSession('-Users-me-proj', 'tok4', assistant() + assistant());

    expect((await indexSessionFile(file, root)).tokens).toEqual({
      input: 2,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it('без записей с usage токенов нет', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      'tok2',
      line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } }),
    );
    expect((await indexSessionFile(file, root)).tokens).toBeNull();
  });

  it('пустой файл даёт валидный индекс', async () => {
    const file = await writeSession('-Users-me-proj', 's6', '');
    const index = await indexSessionFile(file, root);
    expect(index.records).toBe(0);
    expect(index.models).toEqual({});
    expect(index.durationMs).toBeNull();
  });
});

describe('заголовок сессии', () => {
  it('побеждает последняя запись custom-title', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't1',
      line({ type: 'custom-title', customTitle: 'старый' }) +
        line({ type: 'ai-title', aiTitle: 'сгенерённый' }) +
        line({ type: 'custom-title', customTitle: 'новый' }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBe('новый');
    expect(index.titleSource).toBe('custom');
  });

  it('ai-title используется, когда своего заголовка нет', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't2',
      line({ type: 'ai-title', aiTitle: 'от модели' }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBe('от модели');
    expect(index.titleSource).toBe('ai');
  });

  it('без заголовка берётся last-prompt, схлопнутый в строку', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't3',
      line({ type: 'user', message: { role: 'user', content: 'первая реплика' } }) +
        line({ type: 'last-prompt', leafUuid: 'u1', lastPrompt: '  почини\n\n  парсер  ' }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBe('почини парсер');
    expect(index.titleSource).toBe('last-prompt');
  });

  it('последний fallback — первая реплика пользователя', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't4',
      line({ type: 'user', message: { role: 'user', content: 'первая реплика' } }) +
        line({ type: 'user', message: { role: 'user', content: 'вторая' } }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBe('первая реплика');
    expect(index.titleSource).toBe('first-text');
  });

  it('длинная реплика обрезается', async () => {
    const long = 'я'.repeat(300);
    const file = await writeSession(
      '-Users-me-proj',
      't5',
      line({ type: 'user', message: { role: 'user', content: long } }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toHaveLength(201);
    expect(index.title?.endsWith('…')).toBe(true);
  });

  it('совсем пустой файл — заголовка нет', async () => {
    const file = await writeSession('-Users-me-proj', 't6', '');
    const index = await indexSessionFile(file, root);
    expect(index.title).toBeNull();
    expect(index.titleSource).toBeNull();
  });
});
