import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extendCodexSessionIndex, indexCodexSession, type CodexIndexState } from './codex/index-session.js';
import type { DiscoveredSubagent } from './discover.js';
import { DEFAULT_TIMELINE_READER, type TimelineReader } from './jsonl-tail.js';
import { extendClaudeSessionIndex, indexSessionFile, type SessionIndex } from './session-index.js';
import { createSessionIndexer } from './session-indexer.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-session-indexer-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jsonl = (records: unknown[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join('');

/** Читатель-счётчик поверх настоящего: открытия по файлам и сколько байт отдано. */
function countingReader(): {
  reader: TimelineReader;
  opens: Array<{ file: string; start: number }>;
  bytes: () => number;
  failNext(error: Error): void;
} {
  const opens: Array<{ file: string; start: number }> = [];
  let bytes = 0;
  let failure: Error | null = null;
  return {
    opens,
    bytes: () => bytes,
    failNext: (error) => {
      failure = error;
    },
    reader: {
      stat: async (file) => {
        if (failure !== null) {
          const error = failure;
          failure = null;
          throw error;
        }
        return DEFAULT_TIMELINE_READER.stat(file);
      },
      open: (file, start) => {
        opens.push({ file, start });
        const inner = DEFAULT_TIMELINE_READER.open(file, start);
        return Readable.from(
          (async function* () {
            for await (const chunk of inner) {
              bytes += (chunk as Buffer).length;
              yield chunk;
            }
          })(),
        );
      },
    },
  };
}

const claudeLines = (): string[] => [
  JSON.stringify({ type: 'last-prompt', sessionId: 's1', lastPrompt: '/model opus' }),
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    isMeta: true,
    timestamp: '2026-10-01T10:00:00.000Z',
    message: { role: 'user', content: '<local-command-caveat>служебное</local-command-caveat>' },
  }),
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    cwd: '/Users/me/proj',
    gitBranch: 'main',
    version: '2.1.250',
    timestamp: '2026-10-01T10:00:01.000Z',
    message: { role: 'user', content: '/model opus' },
  }),
  '',
  JSON.stringify({
    type: 'user',
    sessionId: 's1',
    timestamp: '2026-10-01T10:00:02.000Z',
    message: { role: 'user', content: 'почини сборку, пожалуйста' },
  }),
  '{"type":"assistant","broken',
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-10-01T10:00:05.000Z',
    message: {
      role: 'assistant',
      id: 'm1',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', name: 'Bash', input: {} }],
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 },
    },
  }),
  JSON.stringify({ type: 'custom-title', customTitle: 'Моё имя' }),
  '[1,2]',
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-10-01T10:00:06.000Z',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'ок' }], usage: { input_tokens: 3, output_tokens: 1 } },
  }),
  JSON.stringify({ type: 'ai-title', aiTitle: 'Починка сборки' }),
  JSON.stringify({ type: 'last-prompt', lastPrompt: 'настоящий запрос' }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    isSidechain: true,
    agentId: 'a1',
    timestamp: '2026-10-01T10:00:07.000Z',
    message: { role: 'assistant', id: 'side1', model: 'claude-opus-5', content: [{ type: 'text', text: 'бок' }], usage: { input_tokens: 4, output_tokens: 1 } },
  }),
  '42',
  JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5000 }),
];

const subagentLines = (): string[] => [
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    isSidechain: true,
    agentId: 'a1',
    timestamp: '2026-10-01T10:00:07.000Z',
    message: { role: 'assistant', id: 'side1', content: [{ type: 'text', text: 'бок' }], usage: { input_tokens: 4, output_tokens: 1 } },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    isSidechain: true,
    agentId: 'a1',
    timestamp: '2026-10-01T10:00:08.000Z',
    message: { role: 'assistant', id: 'side2', content: [{ type: 'text', text: 'ещё' }], usage: { input_tokens: 6, output_tokens: 2 } },
  }),
];

const codexLines = (): string[] => {
  const at = (n: number): string => `2026-10-02T09:00:${String(n).padStart(2, '0')}.000Z`;
  const item = (n: number, payload: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: at(n), type: 'response_item', payload });
  const event = (n: number, payload: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: at(n), type: 'event_msg', payload });
  const tokens = (n: number, input: number): string =>
    event(n, { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: 3 } } });
  return [
    JSON.stringify({
      timestamp: at(0),
      type: 'session_meta',
      payload: {
        id: 'c1',
        cwd: '/Users/me/codex-proj',
        cli_version: '0.50.0',
        git: { branch: 'dev' },
        parent_thread_id: 'parent-1',
        forked_from_id: 'fork-1',
        source: { subagent: { thread_spawn: { parent_thread_id: 'parent-1' } } },
      },
    }),
    JSON.stringify({ timestamp: at(1), type: 'turn_context', payload: { model: 'gpt-5', cwd: '/Users/me/codex-proj' } }),
    event(2, { type: 'task_started' }),
    event(3, { type: 'user_message', message: 'сделай это\nи то' }),
    item(4, { type: 'message', role: 'user' }),
    item(5, { type: 'custom_tool_call', name: 'exec', call_id: 'e1', input: '// @exec: {"yield_time_ms": 500}\nlet x = 1' }),
    item(6, { type: 'custom_tool_call_output', call_id: 'e1', output: 'ok' }),
    item(7, { type: 'function_call', name: 'wait', call_id: 'w1', arguments: '{"yield_time_ms": 1000}' }),
    '',
    tokens(8, 100),
    item(9, { type: 'function_call_output', call_id: 'w1', output: 'done' }),
    '{"type": "event_msg", "payload": ',
    event(10, { type: 'task_complete' }),
    JSON.stringify({ timestamp: at(11), type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
    event(12, { type: 'task_started' }),
    item(13, { type: 'custom_tool_call', name: 'exec', call_id: 'e2', input: 'plain' }),
    item(14, { type: 'function_call', name: 'wait', call_id: 'w2', arguments: 'не json' }),
    tokens(15, 250),
    event(16, { type: 'turn_aborted' }),
    item(17, { type: 'custom_tool_call', name: 'exec', call_id: 'e3', input: '// @exec: {"yield_time_ms": 7}' }),
    '7',
  ];
};

/** Границы всех строк и несколько точек посреди каждой (в том числе внутри многобайтового символа). */
function cutPoints(text: Buffer): number[] {
  const points = new Set<number>([0, text.length]);
  let start = 0;
  for (let end = text.indexOf(0x0a); end !== -1; end = text.indexOf(0x0a, start)) {
    const length = end - start;
    for (const point of [start, start + 1, start + Math.floor(length / 3), start + Math.floor(length / 2), start + Math.floor((2 * length) / 3), end - 1, end, end + 1]) {
      if (point >= 0 && point <= text.length) points.add(point);
    }
    start = end + 1;
  }
  return [...points].sort((a, b) => a - b);
}

const subagentOf = (file: string): DiscoveredSubagent => ({ file, metaFile: `${file}.meta.json`, agentId: 'a1', workflowRunId: null });

describe('паритет с полным чтением', () => {
  it('Claude: на каждой границе строки и посреди строки префикс → остаток совпадает с indexSessionFile', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(path.join(dir, 's1', 'subagents'), { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    const subFile = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    await writeFile(subFile, jsonl(subagentLines().map((l) => JSON.parse(l))));
    const subagents = [subagentOf(subFile)];
    const text = Buffer.from(claudeLines().join('\n') + '\n');

    for (const cut of cutPoints(text)) {
      await writeFile(file, text.subarray(0, cut));
      const first = await extendClaudeSessionIndex(null, file, root, { subagents });
      expect(first.index, `префикс ${cut}`).toEqual(await indexSessionFile(file, root, { subagents }));

      await writeFile(file, text);
      const second = await extendClaudeSessionIndex(first.state, file, root, { subagents });
      expect(second.index, `остаток после ${cut}`).toEqual(await indexSessionFile(file, root, { subagents }));
      // Прежнее состояние не изменилось: тот же шаг из него даёт тот же результат.
      const again = await extendClaudeSessionIndex(first.state, file, root, { subagents });
      expect(again.index).toEqual(second.index);
    }
  });

  it('Claude: полный результат — тот, что ожидается (заголовок, usage, подагент, битые строки)', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(path.join(dir, 's1', 'subagents'), { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    const subFile = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    await writeFile(subFile, subagentLines().join('\n') + '\n');
    await writeFile(file, claudeLines().join('\n') + '\n');
    const { index } = await extendClaudeSessionIndex(null, file, root, { subagents: [subagentOf(subFile)] });
    // Побеждает последний заголовок: ai-title записан позже custom-title.
    expect(index.title).toBe('Починка сборки');
    expect(index.titleSource).toBe('ai');
    expect(index.malformedLines).toBe(3);
    expect(index.subsessionCount).toBe(1);
    expect(index.usage).toBeDefined();
  });

  it.each([['\n'], ['\r\n']])('Codex: на каждой границе строки и посреди строки префикс → остаток совпадает с indexCodexSession (конец строки %j)', async (eol) => {
    const file = path.join(root, 'rollout.jsonl');
    const text = Buffer.from(codexLines().join(eol) + eol);

    for (const cut of cutPoints(text)) {
      await writeFile(file, text.subarray(0, cut));
      const first = await extendCodexSessionIndex(null, file);
      expect(first.index, `префикс ${cut}`).toEqual(await indexCodexSession(file));

      await writeFile(file, text);
      const second = await extendCodexSessionIndex(first.state, file);
      expect(second.index, `остаток после ${cut}`).toEqual(await indexCodexSession(file));
      const again = await extendCodexSessionIndex(first.state, file);
      expect(again.index).toEqual(second.index);
    }
    const final = await indexCodexSession(file);
    expect(final.records).toBe(18);
    expect(final.spawned).toBe(true);
    expect(final.parentId).toBe('parent-1');
    expect(final.openCodeCall?.name).toBe('exec');
    expect(final.lastTurnEvent?.type).toBe('turn_aborted');
  });

  it('оборванная последняя строка: offset не сдвигается, а malformedLines уже как у полного чтения', async () => {
    const file = path.join(root, 'rollout.jsonl');
    const whole = codexLines().slice(0, 3);
    await writeFile(file, whole.join('\n') + '\n{"type":"event_msg","pay');
    const { state, index } = await extendCodexSessionIndex(null, file);
    expect(state.cursor.offset).toBe(Buffer.byteLength(whole.join('\n') + '\n'));
    expect(index.malformedLines).toBe(1);
    expect(index).toEqual(await indexCodexSession(file));
  });
});

describe('что читается', () => {
  it('после дописывания читаются только новые байты, без новых байт файл не открывается', async () => {
    const file = path.join(root, 'rollout.jsonl');
    const lines = codexLines();
    const head = lines.slice(0, 6).join('\n') + '\n';
    await writeFile(file, head);
    const counting = countingReader();
    let state: CodexIndexState | null = null;
    const step = async (): Promise<SessionIndex> => {
      const next = await extendCodexSessionIndex(state, file, { reader: counting.reader });
      state = next.state;
      return next.index;
    };
    await step();
    expect(counting.bytes()).toBe(Buffer.byteLength(head));

    const tail = lines.slice(6, 10).join('\n') + '\n';
    await appendFile(file, tail);
    const before = counting.bytes();
    expect(await step()).toEqual(await indexCodexSession(file));
    expect(counting.bytes() - before).toBe(Buffer.byteLength(tail));

    const opens = counting.opens.length;
    await step();
    expect(counting.opens.length).toBe(opens);
  });

  it('усечение файла: чтение с нуля, результат равен полному', async () => {
    const file = path.join(root, 's1.jsonl');
    const lines = claudeLines();
    await writeFile(file, lines.join('\n') + '\n');
    const first = await extendClaudeSessionIndex(null, file, root);
    await writeFile(file, lines.slice(0, 5).join('\n') + '\n');
    const second = await extendClaudeSessionIndex(first.state, file, root);
    expect(second.index).toEqual(await indexSessionFile(file, root));
  });

  it('подмена файла (другой ino): чтение с нуля', async () => {
    const file = path.join(root, 'rollout.jsonl');
    const lines = codexLines();
    await writeFile(file, lines.join('\n') + '\n');
    const first = await extendCodexSessionIndex(null, file);
    // Ino подменяется читателем: размер у «нового» файла больше прежнего, но это уже другой файл.
    const swapped: TimelineReader = {
      stat: async (f) => ({ ...(await DEFAULT_TIMELINE_READER.stat(f)), ino: first.state.cursor.ino + 1 }),
      open: DEFAULT_TIMELINE_READER.open,
    };
    await writeFile(file, lines.slice(0, 4).join('\n') + '\n' + lines.join('\n') + '\n');
    const second = await extendCodexSessionIndex(first.state, file, { reader: swapped });
    expect(second.index).toEqual(await indexCodexSession(file));
    expect(second.state.cursor.offset).toBe((await DEFAULT_TIMELINE_READER.stat(file)).size);
  });

  it('дописался только подагент: usage обновился, главный файл заново не читался', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(path.join(dir, 's1', 'subagents'), { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    const subFile = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    const subagents = [subagentOf(subFile)];
    await writeFile(file, claudeLines().join('\n') + '\n');
    await writeFile(subFile, subagentLines()[0] + '\n');
    const counting = countingReader();
    const first = await extendClaudeSessionIndex(null, file, root, { subagents, reader: counting.reader });
    counting.opens.length = 0;

    await appendFile(subFile, subagentLines()[1] + '\n');
    const second = await extendClaudeSessionIndex(first.state, file, root, { subagents, reader: counting.reader });
    expect(counting.opens).toEqual([{ file: subFile, start: Buffer.byteLength(subagentLines()[0] + '\n') }]);
    expect(second.index).toEqual(await indexSessionFile(file, root, { subagents }));
    expect(second.index.usage).not.toEqual(first.index.usage);
  });

  it('пропавший из списка подагент выпадает из состояния и из usage', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(path.join(dir, 's1', 'subagents'), { recursive: true });
    const file = path.join(dir, 's1.jsonl');
    const subFile = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    await writeFile(file, claudeLines().join('\n') + '\n');
    await writeFile(subFile, subagentLines().join('\n') + '\n');
    const first = await extendClaudeSessionIndex(null, file, root, { subagents: [subagentOf(subFile)] });
    const second = await extendClaudeSessionIndex(first.state, file, root, { subagents: [] });
    expect(second.state.subagents.size).toBe(0);
    expect(second.index).toEqual(await indexSessionFile(file, root));
  });
});

describe('createSessionIndexer', () => {
  it('два одновременных вызова по одному файлу — одно чтение', async () => {
    const file = path.join(root, 'rollout.jsonl');
    await writeFile(file, codexLines().join('\n') + '\n');
    const counting = countingReader();
    const indexer = createSessionIndexer({ reader: counting.reader });
    const [a, b, c] = await Promise.all([indexer.codex(file), indexer.codex(file), indexer.codex(file)]);
    // Второй и третий ждут первое чтение и дочитывают одним повтором; новых байт нет — файл не открывается.
    expect(counting.opens).toHaveLength(1);
    expect(b).toBe(c);
    expect(b).toEqual(a);
    expect(a).toEqual(await indexCodexSession(file));
  });

  it('вызов во время чтения получает и то, что дописано, пока чтение шло', async () => {
    const file = path.join(root, 'rollout.jsonl');
    const lines = codexLines();
    await writeFile(file, lines.slice(0, 8).join('\n') + '\n');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    let first = true;
    const reader: TimelineReader = {
      stat: (target) => DEFAULT_TIMELINE_READER.stat(target),
      open: (target, start) => {
        if (!first) return DEFAULT_TIMELINE_READER.open(target, start);
        first = false;
        // Первое чтение видит файл, каким он был при открытии, а отдаёт его только после `release`.
        const content = readFileSync(target).subarray(start);
        markOpened();
        return Readable.from(
          (async function* () {
            await gate;
            yield content;
          })(),
        );
      },
    };
    const indexer = createSessionIndexer({ reader });
    const before = indexer.codex(file);
    await opened;
    await appendFile(file, lines.slice(8).join('\n') + '\n');
    const after = indexer.codex(file);
    release();
    const full = await indexCodexSession(file);
    expect((await before).records).toBeLessThan(full.records);
    expect(await after).toEqual(full);
  });

  it('следующий вызов дочитывает хвост, Claude и Codex', async () => {
    const dir = path.join(root, '-Users-me-proj');
    await mkdir(dir, { recursive: true });
    const claudeFile = path.join(dir, 's1.jsonl');
    const codexFile = path.join(root, 'rollout.jsonl');
    const claude = claudeLines();
    const codex = codexLines();
    await writeFile(claudeFile, claude.slice(0, 8).join('\n') + '\n');
    await writeFile(codexFile, codex.slice(0, 8).join('\n') + '\n');
    const counting = countingReader();
    const indexer = createSessionIndexer({ reader: counting.reader });
    await indexer.claude(claudeFile, root);
    await indexer.codex(codexFile);
    await appendFile(claudeFile, claude.slice(8).join('\n') + '\n');
    await appendFile(codexFile, codex.slice(8).join('\n') + '\n');
    expect(await indexer.claude(claudeFile, root)).toEqual(await indexSessionFile(claudeFile, root));
    expect(await indexer.codex(codexFile)).toEqual(await indexCodexSession(codexFile));
    expect(counting.opens.map((o) => o.start).filter((start) => start === 0)).toHaveLength(2);
  });

  it('ошибка чтения не остаётся «в полёте» и не портит состояние: следующий вызов читает заново', async () => {
    const file = path.join(root, 'rollout.jsonl');
    const lines = codexLines();
    await writeFile(file, lines.slice(0, 5).join('\n') + '\n');
    const counting = countingReader();
    const indexer = createSessionIndexer({ reader: counting.reader });
    await indexer.codex(file);
    await appendFile(file, lines.slice(5, 9).join('\n') + '\n');

    counting.failNext(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(indexer.codex(file)).rejects.toThrow('EIO');
    expect(await indexer.codex(file)).toEqual(await indexCodexSession(file));
    // Сохранённое состояние не потеряно: читалось с места, а не с нуля.
    expect(counting.opens.map((o) => o.start)).toEqual([0, Buffer.byteLength(lines.slice(0, 5).join('\n') + '\n')]);
  });

  it('файла нет — ENOENT, как у полного чтения, и состояние забыто', async () => {
    const file = path.join(root, 'rollout.jsonl');
    await writeFile(file, codexLines().join('\n') + '\n');
    const counting = countingReader();
    const indexer = createSessionIndexer({ reader: counting.reader });
    await indexer.codex(file);
    await rm(file);
    await expect(indexer.codex(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(file, codexLines().slice(0, 3).join('\n') + '\n');
    expect(await indexer.codex(file)).toEqual(await indexCodexSession(file));
  });

  it('LRU вытесняет самый старый файл', async () => {
    const files = ['a', 'b', 'c'].map((name) => path.join(root, `${name}.jsonl`));
    for (const file of files) await writeFile(file, codexLines().slice(0, 3).join('\n') + '\n');
    const counting = countingReader();
    const indexer = createSessionIndexer({ maxFiles: 2, reader: counting.reader });
    for (const file of files) await indexer.codex(file);
    for (const file of files) await appendFile(file, codexLines().slice(3, 5).join('\n') + '\n');
    counting.opens.length = 0;
    for (const file of [files[2]!, files[1]!, files[0]!]) await indexer.codex(file);
    const startOf = (file: string): number | undefined => counting.opens.find((o) => o.file === file)?.start;
    // a вытеснен — читается с нуля; b и c продолжены с места.
    expect(startOf(files[0]!)).toBe(0);
    expect(startOf(files[1]!)).toBeGreaterThan(0);
    expect(startOf(files[2]!)).toBeGreaterThan(0);
  });
});
