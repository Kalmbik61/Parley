import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extendCodexSessionIndex, indexCodexSession, type CodexIndexState } from './codex/index-session.js';
import type { DiscoveredSubagent } from './discover.js';
import { extendClaudeSessionIndex, indexSessionFile, type ClaudeIndexState } from './session-index.js';

// Счётчики вызовов: сколько наблюдений ушло в ledger и сколько раз историю проигрывали заново.
const counts = vi.hoisted(() => ({ observe: 0, replay: 0 }));

vi.mock('./work/usage-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work/usage-ledger.js')>();
  return {
    ...actual,
    createUsageLedger: (...args: Parameters<typeof actual.createUsageLedger>) => {
      const ledger = actual.createUsageLedger(...args);
      const observe = ledger.observe.bind(ledger);
      ledger.observe = (observation) => {
        counts.observe++;
        observe(observation);
      };
      return ledger;
    },
  };
});

vi.mock('./work/usage-observations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./work/usage-observations.js')>();
  return {
    ...actual,
    replayClaudeUsage: (...args: Parameters<typeof actual.replayClaudeUsage>) => {
      counts.replay++;
      return actual.replayClaudeUsage(...args);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-session-index-incremental-'));
  counts.observe = 0;
  counts.replay = 0;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const stamp = (n: number): string => `2026-10-01T10:${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}.000Z`;

/** Ответ модели; `usage` задаёт счётчики, `extra` — поля записи верхнего уровня (isSidechain, agentId). */
const reply = (id: string | null, n: number, usage: Record<string, number>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    timestamp: stamp(n),
    ...extra,
    message: {
      role: 'assistant',
      ...(id === null ? {} : { id }),
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'готово, ещё «ёлочки» и ✓' }],
      usage,
    },
  });

const prompt = (n: number, text: string): string =>
  JSON.stringify({ type: 'user', sessionId: 's1', cwd: '/Users/me/proj', timestamp: stamp(n), message: { role: 'user', content: text } });

const subagentOf = (file: string, agentId = 'a1'): DiscoveredSubagent => ({ file, metaFile: `${file}.meta.json`, agentId, workflowRunId: null });

const jsonl = (lines: string[]): string => lines.map((line) => `${line}\n`).join('');

/** Главный лог: повтор id с растущим usage, поле кэша из «нет» в число, запись подагента у родителя, битая строка. */
const parentLines = (): string[] => [
  prompt(1, 'почини сборку'),
  reply('m1', 2, { input_tokens: 10, output_tokens: 1 }),
  reply('m1', 3, { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }),
  '{"type":"assistant","broken',
  reply('m2', 4, { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }),
  reply('side1', 5, { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { isSidechain: true, agentId: 'a1' }),
  JSON.stringify({ type: 'custom-title', customTitle: 'Моё имя' }),
  reply(null, 6, { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
  reply('m3', 7, { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 }),
  prompt(8, 'ещё'),
];

/** Лог подагента: общий id с записью родителя, свой id и запись без id (её с записью родителя не склеить). */
const subLines = (): string[] => [
  reply('side1', 5, { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { isSidechain: true, agentId: 'a1' }),
  reply('side2', 6, { input_tokens: 6, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { isSidechain: true, agentId: 'a1' }),
  reply(null, 7, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, { isSidechain: true, agentId: 'a1' }),
];

describe('Claude: расход по новым записям', () => {
  it('дописаны 3 ответа без подагентов — ни одного проигрыша, наблюдений не больше трёх, итог равен полному чтению', async () => {
    const file = path.join(root, '-Users-me-proj', 's1.jsonl');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, jsonl(parentLines()));
    const cold = await extendClaudeSessionIndex(null, file, root);
    expect(cold.index).toEqual(await indexSessionFile(file, root));

    await appendFile(file, jsonl([reply('n1', 20, { input_tokens: 1, output_tokens: 1 }), reply('n2', 21, { input_tokens: 2, output_tokens: 2 }), reply('n3', 22, { input_tokens: 3, output_tokens: 3 })]));
    counts.observe = 0;
    counts.replay = 0;
    const next = await extendClaudeSessionIndex(cold.state, file, root);
    expect(counts.replay).toBe(0);
    expect(counts.observe).toBeLessThanOrEqual(3);
    expect(next.index).toEqual(await indexSessionFile(file, root));
  });

  it('с одним подагентом — не больше шести наблюдений; дописанный подагент дочитывается без проигрыша', async () => {
    const dir = path.join(root, '-Users-me-proj');
    const file = path.join(dir, 's1.jsonl');
    const subFile = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    await mkdir(path.dirname(subFile), { recursive: true });
    const subagents = [subagentOf(subFile)];
    await writeFile(file, jsonl(parentLines()));
    await writeFile(subFile, jsonl(subLines().slice(0, 2)));
    const cold = await extendClaudeSessionIndex(null, file, root, { subagents });
    expect(cold.index).toEqual(await indexSessionFile(file, root, { subagents }));

    await appendFile(file, jsonl([reply('n1', 20, { input_tokens: 1, output_tokens: 1 }), reply('n2', 21, { input_tokens: 2, output_tokens: 2 }), reply('n3', 22, { input_tokens: 3, output_tokens: 3 })]));
    counts.observe = 0;
    counts.replay = 0;
    const parentOnly = await extendClaudeSessionIndex(cold.state, file, root, { subagents });
    expect(counts.replay).toBe(0);
    expect(counts.observe).toBeLessThanOrEqual(6);
    expect(parentOnly.index).toEqual(await indexSessionFile(file, root, { subagents }));

    await appendFile(subFile, jsonl([subLines()[2]!]));
    counts.observe = 0;
    counts.replay = 0;
    const withChild = await extendClaudeSessionIndex(parentOnly.state, file, root, { subagents });
    expect(counts.replay).toBe(0);
    // Запись подагента без id ответа при sidechain у родителя не учитывается (итог неполный), поэтому наблюдений не больше одного.
    expect(counts.observe).toBeLessThanOrEqual(1);
    expect(withChild.index).toEqual(await indexSessionFile(file, root, { subagents }));
  });

  it('подагент пропал из списка — один проигрыш, итог равен полному чтению', async () => {
    const dir = path.join(root, '-Users-me-proj');
    const file = path.join(dir, 's1.jsonl');
    const first = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    const second = path.join(dir, 's1', 'subagents', 'agent-a2.jsonl');
    await mkdir(path.dirname(first), { recursive: true });
    await writeFile(file, jsonl(parentLines()));
    await writeFile(first, jsonl(subLines()));
    await writeFile(second, jsonl(subLines().slice(0, 2).map((line) => line.replace('"a1"', '"a2"').replace('side', 'other'))));
    const both = [subagentOf(first), subagentOf(second, 'a2')];
    const cold = await extendClaudeSessionIndex(null, file, root, { subagents: both });
    expect(cold.index).toEqual(await indexSessionFile(file, root, { subagents: both }));

    counts.replay = 0;
    const one = [subagentOf(first)];
    const dropped = await extendClaudeSessionIndex(cold.state, file, root, { subagents: one });
    expect(counts.replay).toBe(1);
    expect(dropped.index).toEqual(await indexSessionFile(file, root, { subagents: one }));

    // Пока список не меняется, проигрыша нет.
    counts.replay = 0;
    const again = await extendClaudeSessionIndex(dropped.state, file, root, { subagents: one });
    expect(counts.replay).toBe(0);
    expect(again.index).toEqual(dropped.index);
  });
});

/** Расписание дочитываний: `[байт главного лога, байт лога подагента]`; в середине файлы усекаются и растут снова. */
function schedule(mainLength: number, subLength: number, step: number): Array<[number, number]> {
  const grow = (stride: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let at = 0; at < mainLength; at += stride) out.push([at, Math.floor((at * subLength) / mainLength)]);
    out.push([mainLength, subLength]);
    return out;
  };
  return [...grow(step), [Math.floor(mainLength / 3), Math.floor(subLength / 4)], ...grow(step * 5)];
}

describe('Claude: разбиение записи дописывания не меняет результат', () => {
  const mainText = Buffer.from(jsonl(parentLines()));
  const subText = Buffer.from(jsonl(subLines()));
  const lineEnds = (text: Buffer): number[] => {
    const ends: number[] = [];
    for (let at = text.indexOf(0x0a); at !== -1; at = text.indexOf(0x0a, at + 1)) ends.push(at + 1);
    return ends;
  };

  it.each([
    ['целиком', mainText.length + 1],
    ['по строке', 0],
    ['по 13 байт (внутри строки и многобайтового символа)', 13],
    ['по 1 байту в первой трети', 1],
  ])('%s: каждый шаг равен индексу с нуля, включая шкалу расхода', async (_name, step) => {
    const dir = path.join(root, '-Users-me-proj');
    const file = path.join(dir, 's1.jsonl');
    const subFile = path.join(dir, 's1', 'subagents', 'agent-a1.jsonl');
    await mkdir(path.dirname(subFile), { recursive: true });
    const subagents = [subagentOf(subFile)];

    let steps: Array<[number, number]>;
    if (step === 0) {
      const ends = lineEnds(mainText);
      const subEnds = lineEnds(subText);
      steps = ends.map((end, n) => [end, subEnds[Math.min(subEnds.length - 1, Math.floor((n * subEnds.length) / ends.length))]!]);
      steps.push([Math.floor(mainText.length / 3), 0], [mainText.length, subText.length]);
    } else if (step === 1) {
      steps = schedule(Math.floor(mainText.length / 3), Math.floor(subText.length / 3), 1);
      steps.push([mainText.length, subText.length]);
    } else {
      steps = schedule(mainText.length, subText.length, step);
    }

    let state: ClaudeIndexState | null = null;
    for (const [mainBytes, subBytes] of steps) {
      await writeFile(file, mainText.subarray(0, mainBytes));
      await writeFile(subFile, subText.subarray(0, subBytes));
      const next = await extendClaudeSessionIndex(state, file, root, { subagents });
      state = next.state;
      expect(next.index, `главный ${mainBytes}, подагент ${subBytes}`).toEqual(await indexSessionFile(file, root, { subagents }));
    }
  });
});

const codexAt = (n: number): string => `2026-10-02T09:00:${String(n).padStart(2, '0')}.000Z`;
const codexEvent = (n: number, payload: Record<string, unknown>): string => JSON.stringify({ timestamp: codexAt(n), type: 'event_msg', payload });
const codexTokens = (n: number, input: number, output: number): string =>
  codexEvent(n, { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 40, output_tokens: output } } });

const codexLines = (): string[] => [
  JSON.stringify({ timestamp: codexAt(0), type: 'session_meta', payload: { id: 'c1', cwd: '/Users/me/codex-proj', cli_version: '0.50.0' } }),
  codexEvent(1, { type: 'task_started' }),
  codexEvent(2, { type: 'user_message', message: 'сделай это ✓' }),
  codexTokens(3, 100, 3),
  '{"type": "event_msg", "payload": ',
  codexTokens(4, 250, 9),
  // Накопитель начался заново: значение упало без признака сброса — итог неполный.
  codexTokens(5, 90, 2),
  codexEvent(6, { type: 'task_complete' }),
];

describe('Codex: расход по новым записям', () => {
  it('дописаны 3 token_count — наблюдений не больше трёх, итог равен полному чтению', async () => {
    const file = path.join(root, 'rollout.jsonl');
    await writeFile(file, jsonl(codexLines()));
    const cold = await extendCodexSessionIndex(null, file);
    expect(cold.index).toEqual(await indexCodexSession(file));

    await appendFile(file, jsonl([codexTokens(10, 300, 11), codexTokens(11, 400, 12), codexTokens(12, 500, 13)]));
    counts.observe = 0;
    const next = await extendCodexSessionIndex(cold.state, file);
    expect(counts.observe).toBeLessThanOrEqual(3);
    expect(next.index).toEqual(await indexCodexSession(file));
  });

  it.each([
    ['по строке', 0],
    ['по 11 байт (внутри строки и многобайтового символа)', 11],
  ])('%s: каждый шаг равен индексу с нуля', async (_name, step) => {
    const file = path.join(root, 'rollout.jsonl');
    const text = Buffer.from(jsonl(codexLines()));
    const cuts: number[] = [];
    if (step === 0) {
      for (let at = text.indexOf(0x0a); at !== -1; at = text.indexOf(0x0a, at + 1)) cuts.push(at + 1);
    } else {
      for (let at = 0; at < text.length; at += step) cuts.push(at);
    }
    cuts.push(Math.floor(text.length / 2), text.length);

    let state: CodexIndexState | null = null;
    for (const cut of cuts) {
      await writeFile(file, text.subarray(0, cut));
      const next = await extendCodexSessionIndex(state, file);
      state = next.state;
      expect(next.index, `срез ${cut}`).toEqual(await indexCodexSession(file));
    }
  });
});
