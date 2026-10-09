/**
 * Что хост отдаёт обходу картинок (план 2026-10-09, Task 3, решения контролёра 1, 2 и 7): только
 * поддеревья результатов инструментов, а не записи и тела целиком; не больше `FEED_IMAGES_PER_CALL`
 * сохранений на вызов помощника; исходник не меняется, поэтому одну и ту же сырую запись можно провести
 * дважды и ссылка будет оба раза.
 */

import { describe, expect, it } from 'vitest';
import { FEED_IMAGES_PER_CALL } from '@parley/core';
import type { FeedImageRef, RawRecord, RolloutRecord } from '@parley/core';
import { stashClaudeRecord, stashCodexRecord, stashHookBody } from './stash.js';

/** `save`, который помнит вызовы и отдаёт ссылки подряд; `refuse` — номера вызовов (с 1), которым вернуть `null`. */
function fakeSave(refuse: readonly number[] = []) {
  const calls: Array<[string, string]> = [];
  const save = (base64: string, mime: string): FeedImageRef | null => {
    calls.push([base64, mime]);
    return refuse.includes(calls.length)
      ? null
      : { path: `/img/${calls.length}.png`, mime, bytes: base64.length };
  };
  return { calls, save };
}

const anthropic = (data: string, mime = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type: mime, data },
});
const mcp = (data: string, mime = 'image/png') => ({ type: 'image', data, mimeType: mime });
const text = (value: string) => ({ type: 'text', text: value });
const ref = (n: number, bytes = 4) => ({
  type: 'image',
  parleyImage: { path: `/img/${n}.png`, mime: 'image/png', bytes },
});
const omitted = { type: 'image', parleyImageOmitted: true };
/** `n` разных картинок Anthropic: `D0`, `D1` … */
const many = (n: number) => Array.from({ length: n }, (_, i) => anthropic(`D${i}`));

describe('stashHookBody — только tool_response', () => {
  const body = (response: unknown): Record<string, unknown> => ({
    hook_event_name: 'PostToolUse',
    session_id: 'c-1',
    tool_name: 'mcp__chrome-devtools__take_screenshot',
    tool_use_id: 'toolu_1',
    tool_input: {},
    tool_response: response,
  });

  it('массив «текст + картинка» — картинка уходит в save, остальные поля тела на месте, исходник цел', () => {
    const source = body([text('Took a screenshot'), anthropic('QUJD')]);
    const before = structuredClone(source);
    const { calls, save } = fakeSave();

    const stashed = stashHookBody(source, save);

    expect(calls).toEqual([['QUJD', 'image/png']]);
    expect(stashed).toEqual(body([text('Took a screenshot'), ref(1)]));
    expect(source).toEqual(before);
  });

  it('тела без tool_response (PreToolUse, Stop) — то же самое тело, save не зовётся', () => {
    const { calls, save } = fakeSave();
    const pre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };

    expect(stashHookBody(pre, save)).toBe(pre);
    expect(calls).toEqual([]);
  });

  it('картинок в результате нет — то же самое тело; картинки вне tool_response обход не видит', () => {
    const { calls, save } = fakeSave();
    const source = {
      ...body({ stdout: 'a', stderr: '' }),
      tool_input: { content: [anthropic('INPUT')] },
      prompt: [anthropic('PROMPT')],
    };

    expect(stashHookBody(source, save)).toBe(source);
    expect(calls).toEqual([]);
  });

  it('Read у Claude: объект-картинка прямо в tool_response', () => {
    const { calls, save } = fakeSave();
    const read = { type: 'image', file: { base64: 'QUJD', type: 'image/jpeg', originalSize: 3 } };

    const stashed = stashHookBody(body(read), save);

    expect(calls).toEqual([['QUJD', 'image/jpeg']]);
    expect(stashed['tool_response']).toEqual({
      type: 'image',
      parleyImage: { path: '/img/1.png', mime: 'image/jpeg', bytes: 4 },
    });
  });

  it('больше FEED_IMAGES_PER_CALL картинок: лишние до save не доходят и стоят пометкой', () => {
    const { calls, save } = fakeSave();

    const stashed = stashHookBody(body(many(FEED_IMAGES_PER_CALL + 2)), save);

    expect(calls).toHaveLength(FEED_IMAGES_PER_CALL);
    const blocks = stashed['tool_response'] as unknown[];
    expect(blocks.slice(0, FEED_IMAGES_PER_CALL)).toEqual(
      Array.from({ length: FEED_IMAGES_PER_CALL }, (_, i) => ref(i + 1, 2)),
    );
    expect(blocks.slice(FEED_IMAGES_PER_CALL)).toEqual([omitted, omitted]);
  });

  it('предел считает удачные сохранения: отказанная картинка место не занимает', () => {
    const { calls, save } = fakeSave([1]);

    const stashed = stashHookBody(body(many(FEED_IMAGES_PER_CALL + 1)), save);

    expect(calls).toHaveLength(FEED_IMAGES_PER_CALL + 1);
    const blocks = stashed['tool_response'] as unknown[];
    expect(blocks[0]).toEqual(omitted);
    expect(blocks.slice(1)).toEqual(
      Array.from({ length: FEED_IMAGES_PER_CALL }, (_, i) => ref(i + 2, 2)),
    );
  });

  it('у каждого вызова свой счётчик', () => {
    const { calls, save } = fakeSave();

    const first = stashHookBody(body(many(FEED_IMAGES_PER_CALL)), save);
    const second = stashHookBody(body(many(FEED_IMAGES_PER_CALL)), save);

    expect(calls).toHaveLength(FEED_IMAGES_PER_CALL * 2);
    expect(JSON.stringify(first)).not.toContain('parleyImageOmitted');
    expect(JSON.stringify(second)).not.toContain('parleyImageOmitted');
  });

  it('одно и то же сырое тело можно провести дважды: ссылка есть оба раза', () => {
    const source = body([anthropic('QUJD')]);
    const { save } = fakeSave();

    const first = stashHookBody(source, save);
    const second = stashHookBody(source, save);

    expect((first['tool_response'] as unknown[])[0]).toMatchObject({
      parleyImage: { path: '/img/1.png' },
    });
    expect((second['tool_response'] as unknown[])[0]).toMatchObject({
      parleyImage: { path: '/img/2.png' },
    });
  });
});

describe('stashClaudeRecord — toolUseResult и содержимое tool_result', () => {
  const result = (...blocks: unknown[]) => ({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-10-09T10:00:00.000Z',
    sessionId: 's',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: blocks }],
    },
    toolUseResult: blocks,
  });

  it('картинка в обоих местах записи — обе заменены, остальные поля и поля блока tool_result на месте, исходник цел', () => {
    const source: RawRecord = result(text('Took a screenshot'), anthropic('QUJD'));
    const before = structuredClone(source);
    const { calls, save } = fakeSave();

    const stashed = stashClaudeRecord(source, save);

    expect(calls).toEqual([
      ['QUJD', 'image/png'],
      ['QUJD', 'image/png'],
    ]);
    expect(stashed).toEqual({
      ...before,
      toolUseResult: [text('Took a screenshot'), ref(1)],
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            is_error: false,
            content: [text('Took a screenshot'), ref(2)],
          },
        ],
      },
    });
    expect(source).toEqual(before);
  });

  it('Read: toolUseResult — объект-картинка {file: {base64, type}}', () => {
    const { calls, save } = fakeSave();
    const source: RawRecord = {
      ...result(anthropic('QUJD')),
      toolUseResult: {
        type: 'image',
        file: { base64: 'QUJD', type: 'image/png', originalSize: 3 },
      },
    };

    const stashed = stashClaudeRecord(source, save);

    expect(calls[0]).toEqual(['QUJD', 'image/png']);
    expect(stashed['toolUseResult']).toEqual(ref(1));
  });

  it('картинка промпта — прямой блок message.content, не tool_result: на диск не идёт', () => {
    const { calls, save } = fakeSave();
    const prompt: RawRecord = {
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: [text('look at this'), anthropic('PROMPT')] },
    };

    expect(stashClaudeRecord(prompt, save)).toBe(prompt);
    expect(calls).toEqual([]);
  });

  it('результат строкой или без картинок — та же запись; чужие блоки сообщения остаются теми же объектами', () => {
    const { calls, save } = fakeSave();
    const plain: RawRecord = { ...result(), toolUseResult: 'ok' };
    (plain['message'] as { content: unknown[] }).content = [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
    ];
    expect(stashClaudeRecord(plain, save)).toBe(plain);

    const sibling = text('between');
    const mixed: RawRecord = result(text('a'), anthropic('QUJD'));
    (mixed['message'] as { content: unknown[] }).content.unshift(sibling);
    const stashed = stashClaudeRecord(mixed, save);
    expect((stashed['message'] as { content: unknown[] }).content[0]).toBe(sibling);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('предел FEED_IMAGES_PER_CALL — на запись целиком, обе её половины делят счётчик', () => {
    const { calls, save } = fakeSave();

    const stashed = stashClaudeRecord(result(...many(FEED_IMAGES_PER_CALL)), save);

    // Шесть ушли в toolUseResult, для копии в tool_result места не осталось.
    expect(calls).toHaveLength(FEED_IMAGES_PER_CALL);
    expect(
      (stashed['toolUseResult'] as unknown[]).map((block) =>
        JSON.stringify(block).includes('parleyImage"'),
      ),
    ).toEqual(Array.from({ length: FEED_IMAGES_PER_CALL }, () => true));
    const content = (stashed['message'] as { content: Array<{ content: unknown[] }> }).content[0]
      ?.content;
    expect(content).toEqual(Array.from({ length: FEED_IMAGES_PER_CALL }, () => omitted));
  });

  it('одну и ту же сырую запись можно провести дважды: ссылка есть оба раза, а источник нетронут', () => {
    const source: RawRecord = result(anthropic('QUJD'));
    const before = structuredClone(source);
    const { save } = fakeSave();

    const first = stashClaudeRecord(source, save);
    const second = stashClaudeRecord(source, save);

    expect(JSON.stringify(first)).toContain('"parleyImage"');
    expect(JSON.stringify(second)).toContain('"parleyImage"');
    expect(JSON.stringify(second)).not.toContain('parleyImageOmitted');
    expect(source).toEqual(before);
  });
});

describe('stashCodexRecord — result вызова McpToolCall', () => {
  const completed = (
    item: Record<string, unknown>,
    payload: Record<string, unknown> = {},
  ): RolloutRecord => ({
    ordinal: 5,
    at: '2026-10-09T10:00:00.000Z',
    type: 'event_msg',
    payload: { type: 'item_completed', thread_id: 'th', turn_id: 'u1', item, ...payload },
  });
  const shot = (...content: unknown[]) =>
    completed({
      type: 'McpToolCall',
      id: 'exec-1',
      server: 'chrome-devtools',
      tool: 'take_screenshot',
      arguments: {},
      status: 'completed',
      result: { content, _meta: { note: 'kept' } },
    });

  it('скриншот в result.content — блок заменён, остальные поля записи, элемента и result на месте, исходник цел', () => {
    const source = shot(text("Took a screenshot of the current page's viewport."), mcp('QUJD'));
    const before = structuredClone(source);
    const { calls, save } = fakeSave();

    const stashed = stashCodexRecord(source, save);

    expect(calls).toEqual([['QUJD', 'image/png']]);
    expect(stashed).toEqual({
      ...before,
      payload: {
        ...before.payload,
        item: {
          ...(before.payload['item'] as object),
          result: {
            content: [text("Took a screenshot of the current page's viewport."), ref(1)],
            _meta: { note: 'kept' },
          },
        },
      },
    });
    expect(source).toEqual(before);
  });

  it('картинка промпта (UserMessage) и прочие элементы — та же запись, save не зовётся', () => {
    const { calls, save } = fakeSave();
    const message = completed({
      type: 'UserMessage',
      id: 'um1',
      content: [text('look'), { type: 'input_image', image_url: 'data:image/png;base64,PROMPT' }],
    });
    const viewed = completed({ type: 'ImageView', id: 'iv1', path: '/tmp/x.png' });
    const started: RolloutRecord = {
      ordinal: 1,
      at: '2026-10-09T10:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started' },
    };
    // Не McpToolCall, но с result: картинки вызова, который лента не показывает, на диск не идут.
    const other = completed({
      type: 'CustomToolCall',
      id: 'c1',
      result: { content: [mcp('QUJD')] },
    });
    // McpToolCall, но запись не о законченном элементе.
    const unfinished: RolloutRecord = {
      ...shot(mcp('QUJD')),
      payload: { ...shot(mcp('QUJD')).payload, type: 'item_started' },
    };

    for (const record of [message, viewed, started, other, unfinished]) {
      expect(stashCodexRecord(record, save)).toBe(record);
    }
    expect(calls).toEqual([]);
  });

  it('вызов без result (ошибка) или без картинок — та же запись', () => {
    const { calls, save } = fakeSave();
    const failed = completed({
      type: 'McpToolCall',
      id: 'e',
      server: 's',
      tool: 't',
      status: 'failed',
      error: { message: 'boom' },
    });
    const plain = shot(text('ok'));

    expect(stashCodexRecord(failed, save)).toBe(failed);
    expect(stashCodexRecord(plain, save)).toBe(plain);
    expect(calls).toEqual([]);
  });

  it('предел FEED_IMAGES_PER_CALL на запись', () => {
    const { calls, save } = fakeSave();

    const stashed = stashCodexRecord(
      shot(...Array.from({ length: FEED_IMAGES_PER_CALL + 1 }, (_, i) => mcp(`D${i}`))),
      save,
    );

    expect(calls).toHaveLength(FEED_IMAGES_PER_CALL);
    const content = (stashed.payload['item'] as { result: { content: unknown[] } }).result.content;
    expect(content.at(-1)).toEqual(omitted);
  });

  it('одну и ту же сырую запись можно провести дважды: ссылка есть оба раза', () => {
    const source = shot(mcp('QUJD'));
    const { save } = fakeSave();

    const first = stashCodexRecord(source, save);
    const second = stashCodexRecord(source, save);

    expect(JSON.stringify(first)).toContain('"parleyImage"');
    expect(JSON.stringify(second)).toContain('"parleyImage"');
    expect(JSON.stringify(second)).not.toContain('parleyImageOmitted');
  });
});
