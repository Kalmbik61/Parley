import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverSession } from './discover.js';
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
  it('служебные записи после конца хода (итоги хуков, длительность, вложения) время работы не двигают', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'parley-index-'));
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 's2.jsonl');
    const line = (value: Record<string, unknown>): string => `${JSON.stringify({ sessionId: 's2', ...value })}\n`;
    await writeFile(
      file,
      line({ type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: 'привет' } }) +
        line({ type: 'assistant', timestamp: '2026-09-01T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ок' }] } }) +
        line({ type: 'attachment', timestamp: '2026-09-01T10:00:05.400Z', attachment: { type: 'hook_success' } }) +
        line({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-01T10:00:05.900Z' }) +
        line({ type: 'system', subtype: 'turn_duration', timestamp: '2026-09-01T10:00:05.901Z', durationMs: 5000 }),
    );

    const index = await indexSessionFile(file, root);

    // Конец сессии — по всем записям, а «страховке по логу» нужна последняя запись человека или ассистента: иначе
    // сессия, закончившая ход, числилась бы работающей ещё порог тишины.
    expect(index.endedAt).toBe('2026-09-01T10:00:05.901Z');
    expect(index.lastWorkRecordAt).toBe('2026-09-01T10:00:05.000Z');
    await rm(root, { recursive: true, force: true });
  });

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
    expect(index.lastWorkRecordAt).toBe('2026-09-01T10:02:30.000Z');
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

  it('usage: частичные записи одного ответа не теряют и не удваивают итог, полный вход — сумма трёх частей', async () => {
    // Первая запись ответа пришла до конца потока: выход ещё мал. Вторая — полный usage того же ответа.
    const block = (at: string, output: number) =>
      line({
        type: 'assistant',
        timestamp: at,
        message: {
          role: 'assistant',
          id: 'msg_01',
          usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 30, cache_creation_input_tokens: 8 },
        },
      });
    const file = await writeSession(
      '-Users-me-proj',
      'usage1',
      block('2026-10-04T12:00:01.000Z', 5) + block('2026-10-04T12:00:02.000Z', 240),
    );

    const index = await indexSessionFile(file, root);
    expect(index.usage).toEqual({
      input: 2,
      output: 240,
      cacheRead: 30,
      cacheWrite: 8,
      totalInput: 40,
      source: 'native-index',
      observedAt: '2026-10-04T12:00:02.000Z',
      stale: false,
      completeness: 'complete',
      coverage: 'conversation',
    });
    expect(index.tokens).toEqual({ input: 2, output: 240, cacheRead: 30, cacheWrite: 8 });
  });

  it('usage: запись без полей кеша даёт неизвестный кеш и полный вход, а показ получает нули', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      'usage-nocache',
      line({
        type: 'assistant',
        timestamp: '2026-10-04T12:00:01.000Z',
        message: { role: 'assistant', id: 'msg_a', usage: { input_tokens: 4, output_tokens: 9 } },
      }),
    );

    const index = await indexSessionFile(file, root);
    expect(index.usage).toMatchObject({
      input: 4,
      output: 9,
      cacheRead: null,
      cacheWrite: null,
      totalInput: null,
      completeness: 'complete',
    });
    // Для показа (`tokens`) неизвестное — ноль, решение потребителя; в `usage` оно осталось null.
    expect(index.tokens).toEqual({ input: 4, output: 9, cacheRead: 0, cacheWrite: 0 });
  });

  it('usage: явный ноль кеша — известный ноль, полный вход считается', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      'usage-zero',
      line({
        type: 'assistant',
        timestamp: '2026-10-04T12:00:01.000Z',
        message: {
          role: 'assistant',
          id: 'msg_a',
          usage: { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    );

    const index = await indexSessionFile(file, root);
    expect(index.usage).toMatchObject({ input: 4, cacheRead: 0, cacheWrite: 0, totalInput: 4, completeness: 'complete' });
  });

  it('usage: поле есть не у всех ответов — сумма неизвестна, итог неполный, известные поля суммируются', async () => {
    const answer = (id: string, usage: Record<string, number>) =>
      line({ type: 'assistant', timestamp: '2026-10-04T12:00:01.000Z', message: { role: 'assistant', id, usage } });
    const file = await writeSession(
      '-Users-me-proj',
      'usage-mixed',
      answer('msg_a', { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 8 }) +
        answer('msg_b', { input_tokens: 3, output_tokens: 20 }),
    );

    const index = await indexSessionFile(file, root);
    expect(index.usage).toMatchObject({
      input: 5,
      output: 30,
      cacheRead: null,
      cacheWrite: null,
      totalInput: null,
      completeness: 'partial',
    });
  });

  it('usage: в публичном итоге нет ни id ответа, ни пути лога', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      'usage2',
      line({
        type: 'assistant',
        message: { role: 'assistant', id: 'msg_secret', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    );
    const json = JSON.stringify((await indexSessionFile(file, root)).usage);
    expect(json).not.toContain('msg_secret');
    expect(json).not.toContain('usage2');
  });

  it('usage: без записей с usage итог неизвестен', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      'usage3',
      line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } }),
    );
    expect((await indexSessionFile(file, root)).usage).toMatchObject({
      input: null,
      cacheRead: null,
      completeness: 'unknown',
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

  it('служебные реплики слеш-команд и `!` — не запрос: заголовок по первому настоящему', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't7',
      line({
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content:
            '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>',
        },
      }) +
        line({
          type: 'user',
          message: {
            role: 'user',
            content:
              '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>',
          },
        }) +
        line({
          type: 'user',
          message: {
            role: 'user',
            content: '<local-command-stdout>Set model to Opus 5.5</local-command-stdout>',
          },
        }) +
        line({ type: 'user', message: { role: 'user', content: '<bash-input>ls</bash-input>' } }) +
        line({ type: 'user', message: { role: 'user', content: 'проверь снова репу' } }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBe('проверь снова репу');
    expect(index.titleSource).toBe('first-text');
  });

  it('last-prompt со слеш-командой, `!` или служебным текстом — не заголовок: берётся прежний', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't9',
      line({ type: 'last-prompt', lastPrompt: 'почини парсер' }) +
        line({ type: 'last-prompt', lastPrompt: '/model opus' }) +
        line({ type: 'last-prompt', lastPrompt: '!ls -la' }) +
        line({ type: 'last-prompt', lastPrompt: '<command-name>/effort</command-name>' }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBe('почини парсер');
    expect(index.titleSource).toBe('last-prompt');
  });

  it('путь в начале запроса — не слеш-команда', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't10',
      line({ type: 'last-prompt', lastPrompt: '/Users/me/app.ts падает на старте' }),
    );
    expect((await indexSessionFile(file, root)).title).toBe('/Users/me/app.ts падает на старте');
  });

  it('одни служебные реплики — заголовка нет; isMeta служебна и без тегов', async () => {
    const file = await writeSession(
      '-Users-me-proj',
      't8',
      line({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: 'вставка Claude Code' },
      }) +
        line({
          type: 'user',
          message: { role: 'user', content: '<command-name>/effort</command-name>' },
        }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.title).toBeNull();
    expect(index.titleSource).toBeNull();
  });

  it('первая реплика — указатель Parley на письма: firstPromptPointer; заголовок индекс выбирает как обычно', async () => {
    const pointer = 'New messages (1) in r-01 "Second". Call check_inbox.';
    const file = await writeSession(
      '-Users-me-proj',
      't11',
      line({ type: 'user', message: { role: 'user', content: pointer } }) +
        line({ type: 'last-prompt', lastPrompt: pointer }) +
        line({ type: 'ai-title', aiTitle: 'Проверка входящих сообщений' }),
    );
    const index = await indexSessionFile(file, root);
    expect(index.firstPromptPointer).toBe(true);
    // Решает автозаголовок (`autoTitleOf`), индекс остаётся общим.
    expect(index.title).toBe('Проверка входящих сообщений');
    expect(index.titleSource).toBe('ai');
  });

  it('указатель не первой репликой или служебная реплика перед ним — флаг по первой настоящей', async () => {
    const pointer = 'New messages (2). Call check_inbox.';
    const later = await writeSession(
      '-Users-me-proj',
      't12',
      line({ type: 'user', message: { role: 'user', content: 'почини парсер' } }) +
        line({ type: 'user', message: { role: 'user', content: pointer } }),
    );
    expect(await indexSessionFile(later, root)).not.toHaveProperty('firstPromptPointer');

    const afterMeta = await writeSession(
      '-Users-me-proj',
      't13',
      line({ type: 'user', isMeta: true, message: { role: 'user', content: 'вставка Claude Code' } }) +
        line({ type: 'user', message: { role: 'user', content: pointer } }),
    );
    expect((await indexSessionFile(afterMeta, root)).firstPromptPointer).toBe(true);
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

describe('indexSessionFile: токены подагентов (P36c)', () => {
  const assistant = (id: string | null, at: string, input: number, extra: Record<string, unknown> = {}) =>
    line({
      type: 'assistant',
      timestamp: at,
      ...extra,
      message: {
        role: 'assistant',
        ...(id === null ? {} : { id }),
        usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });

  async function withSubagents(
    id: string,
    parent: string,
    subagents: Record<string, string>,
  ): Promise<Awaited<ReturnType<typeof indexSessionFile>>> {
    const file = await writeSession('-Users-me-proj', id, parent);
    for (const [agentId, lines] of Object.entries(subagents)) {
      const dir = path.join(root, '-Users-me-proj', id, 'subagents');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `agent-${agentId}.jsonl`), lines);
    }
    const discovered = await discoverSession(file, root);
    return indexSessionFile(file, root, { subagents: discovered.subagents });
  }

  it('родитель плюс подагент: токены складываются, охват — с потомками, tokens остаётся собственным', async () => {
    const index = await withSubagents('sub-sum', assistant('msg_p', '2026-10-04T12:00:01.000Z', 100), {
      a1: assistant('msg_a', '2026-10-04T12:00:09.000Z', 40),
    });

    expect(index.usage).toMatchObject({
      input: 140,
      output: 2,
      coverage: 'conversation-and-descendants',
      completeness: 'complete',
      observedAt: '2026-10-04T12:00:09.000Z',
    });
    expect(index.tokens).toEqual({ input: 100, output: 1, cacheRead: 0, cacheWrite: 0 });
    expect(index.subsessionCount).toBe(1);
  });

  it('без файлов подагентов охват прежний — только разговор', async () => {
    const index = await withSubagents('sub-none', assistant('msg_p', '2026-10-04T12:00:01.000Z', 100), {});
    expect(index.usage).toMatchObject({ input: 100, coverage: 'conversation' });
  });

  it('тот же ответ в файле родителя (isSidechain) и в файле подагента — один раз', async () => {
    const index = await withSubagents(
      'sub-dup',
      assistant('msg_p', '2026-10-04T12:00:01.000Z', 100) +
        assistant('msg_a', '2026-10-04T12:00:02.000Z', 40, { isSidechain: true, agentId: 'a1' }),
      { a1: assistant('msg_a', '2026-10-04T12:00:02.000Z', 40) + assistant('msg_a2', '2026-10-04T12:00:03.000Z', 5) },
    );
    expect(index.usage).toMatchObject({ input: 145, completeness: 'complete', coverage: 'conversation-and-descendants' });
  });

  it('запись агента у родителя и в файле агента без общего id ответа: не учитывается дважды, итог неполный', async () => {
    const index = await withSubagents(
      'sub-overlap',
      assistant('msg_p', '2026-10-04T12:00:01.000Z', 100) +
        assistant(null, '2026-10-04T12:00:02.000Z', 40, { isSidechain: true, agentId: 'a1' }),
      { a1: assistant(null, '2026-10-04T12:00:02.000Z', 40) },
    );
    expect(index.usage).toMatchObject({ input: 140, completeness: 'partial' });
  });

  it('подагент без записей родителя с тем же агентом перекрытия не создаёт: записи без id считаются раздельно', async () => {
    const index = await withSubagents('sub-noids', assistant('msg_p', '2026-10-04T12:00:01.000Z', 100), {
      a1: assistant(null, '2026-10-04T12:00:02.000Z', 40) + assistant(null, '2026-10-04T12:00:03.000Z', 40),
    });
    expect(index.usage).toMatchObject({ input: 180, completeness: 'complete' });
  });

  it('в итоге нет нативных id агента и путей файлов', async () => {
    const index = await withSubagents('sub-secret', assistant('msg_p', '2026-10-04T12:00:01.000Z', 100), {
      'agent-secret': assistant(null, '2026-10-04T12:00:02.000Z', 40),
    });
    expect(JSON.stringify(index.usage)).not.toMatch(/agent-secret|\.jsonl|subagents/);
  });
});
