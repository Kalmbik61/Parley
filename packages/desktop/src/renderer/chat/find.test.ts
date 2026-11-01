/** Поиск по модели ленты (план 2026-11-01, задача 9): чистая функция, без React и DOM. */

import { describe, expect, it } from 'vitest';
import type { FeedItem } from '@parley/core';
import { FIND_LIMIT, searchFeed } from './find.js';

let seq = 0;
const base = (): { id: string; at: string } => ({ id: `i${(seq += 1)}`, at: '2026-11-01T00:00:00Z' });
const prompt = (text: string): FeedItem => ({ ...base(), kind: 'prompt', text, images: 0 });
const text = (value: string): FeedItem => ({ ...base(), kind: 'text', messageId: null, text: value, streaming: false });
const tool = (name: string, input: Record<string, unknown>, output?: string, patch?: string): FeedItem =>
  ({
    ...base(),
    kind: 'tool',
    toolUseId: 't',
    name,
    input,
    status: 'done',
    ...(output === undefined ? {} : { response: { text: output, size: output.length, truncated: false } }),
    ...(patch === undefined ? {} : { patch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`+${patch}`] }] }),
  }) as FeedItem;
const agent = (fields: Record<string, unknown>): FeedItem =>
  ({
    ...base(),
    kind: 'agent',
    toolUseId: 'a',
    agentId: null,
    agentType: null,
    description: null,
    prompt: null,
    model: null,
    background: false,
    status: 'done',
    toolCount: 0,
    children: [],
    ...fields,
  }) as FeedItem;
const turn = (): FeedItem => ({ ...base(), kind: 'turn', durationMs: 1 });
const notice = (): FeedItem => ({ ...base(), kind: 'notice', notice: { type: 'session-end', reason: 'needle' } });
const failure = (message: string): FeedItem => ({ ...base(), kind: 'error', error: 'api_error', message });

describe('searchFeed', () => {
  it('пустой запрос и пробелы не находят ничего', () => {
    const items = [prompt('needle'), text('needle')];
    expect(searchFeed(items, '')).toEqual({ matches: [], capped: false });
    expect(searchFeed(items, '   ')).toEqual({ matches: [], capped: false });
  });

  it('регистр не важен; ищет в промпте, тексте, входе и выводе инструмента, результате агента, карточке и ошибке', () => {
    const items: FeedItem[] = [
      prompt('Find the NEEDLE'),
      text('a needle in text'),
      tool('Bash', { command: 'echo needle' }, 'out: needle'),
      agent({ result: 'agent found Needle' }),
      { ...base(), kind: 'plan', cardId: 'c', state: 'pending', toolUseId: null, toolName: 'ExitPlanMode', toolInput: {}, plan: 'plan with needle', planFilePath: null } as FeedItem,
      failure('overloaded needle'),
    ];
    const parts = searchFeed(items, 'needle').matches.map((match) => match.part);
    expect(parts).toEqual(['prompt', 'text', 'tool-input', 'tool-output', 'agent', 'card', 'error']);
  });

  it('вход инструмента ищется по тексту, который печатает ToolItem (JSON с отступом)', () => {
    const items = [tool('Edit', { file_path: '/a/b.ts', new_string: 'wanted' })];
    expect(searchFeed(items, 'wanted').matches).toHaveLength(1);
    expect(searchFeed(items, '"file_path"').matches).toHaveLength(1);
  });

  it('вывод инструмента и внутренности субагента находятся независимо от свёртки хода', () => {
    const child = tool('Read', { file_path: 'x' }, 'deep needle') as Extract<FeedItem, { kind: 'tool' }>;
    const items = [prompt('go'), tool('Bash', {}, 'folded needle'), agent({ children: [child], prompt: 'agent needle' }), turn()];
    expect(searchFeed(items, 'needle').matches.map((match) => match.part)).toEqual(['tool-output', 'agent', 'agent']);
  });

  it('заплатки диффа не ищутся', () => {
    expect(searchFeed([tool('Edit', {}, undefined, 'patchword')], 'patchword').matches).toEqual([]);
  });

  it('turn и notice никогда не совпадают', () => {
    expect(searchFeed([turn(), notice()], 'needle').matches).toEqual([]);
  });

  it('считает непересекающиеся вхождения в одной части: aaa/aa даёт 1', () => {
    expect(searchFeed([text('aaa')], 'aa').matches).toHaveLength(1);
    const two = searchFeed([text('abab ab')], 'ab').matches;
    expect(two.map((match) => match.nth)).toEqual([0, 1, 2]);
  });

  it('порядок — порядок ленты, у каждого совпадения itemId и номер в части', () => {
    const items = [text('x needle needle'), prompt('needle')];
    const { matches } = searchFeed(items, 'needle');
    expect(matches).toEqual([
      { itemId: items[0]!.id, part: 'text', nth: 0 },
      { itemId: items[0]!.id, part: 'text', nth: 1 },
      { itemId: items[1]!.id, part: 'prompt', nth: 0 },
    ]);
  });

  it('рост стримящегося текста не меняет порядок и номера прежних совпадений', () => {
    const was = searchFeed([prompt('needle'), text('a needle')], 'needle').matches;
    const grown = searchFeed([prompt('needle'), text('a needle and then another needle')], 'needle').matches;
    expect(grown.slice(0, was.length).map((match) => `${match.part}:${match.nth}`)).toEqual(was.map((match) => `${match.part}:${match.nth}`));
    expect(grown).toHaveLength(was.length + 1);
  });

  it(`обрезает на ${FIND_LIMIT} и говорит об этом`, () => {
    const result = searchFeed([text('a '.repeat(FIND_LIMIT + 50))], 'a');
    expect(result.matches).toHaveLength(FIND_LIMIT);
    expect(result.capped).toBe(true);
    expect(searchFeed([text('a '.repeat(FIND_LIMIT))], 'a').capped).toBe(false);
  });
});
