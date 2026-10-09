/**
 * Что хост отдаёт обходу картинок (план 2026-10-09, Task 3, решения контролёра 1, 2 и 7): только
 * поддеревья результатов инструментов, а не записи и тела целиком; не больше `FEED_IMAGES_PER_CALL`
 * сохранений на вызов помощника; исходник не меняется, поэтому одну и ту же сырую запись можно провести
 * дважды и ссылка будет оба раза.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyCodexRecords,
  emptyCodexCursor,
  emptyFeedState,
  FEED_IMAGE_MAX_BYTES,
  FEED_IMAGES_PER_CALL,
} from '@parley/core';
import type { FeedImageRef, FeedTool, RawRecord, RolloutRecord } from '@parley/core';
import { makePng } from '../../test/png.js';
import { createFeedImageStore } from './image-store.js';
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
    const viewed = completed({ type: 'ImageView', id: 'iv1', path: '/nonexistent-dir/x.png' });
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

describe('stashCodexRecord — ImageView: файл, который посмотрел агент, копируется в хранилище', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'stash-view-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const view = (file: unknown, extra: Record<string, unknown> = {}): RolloutRecord => ({
    ordinal: 7,
    at: '2026-10-09T10:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'th',
      turn_id: 'u1',
      item: { type: 'ImageView', id: 'iv1', path: file, ...extra },
    },
  });
  const itemOf = (record: RolloutRecord): Record<string, unknown> =>
    record.payload['item'] as Record<string, unknown>;
  /** Файл-картинка в каталоге теста; байты зависят от `seed`. */
  const picture = (name = 'shot.png', seed = 0): { file: string; bytes: Buffer } => {
    const file = path.join(dir, name);
    const bytes = makePng(40, 30, seed);
    writeFileSync(file, bytes);
    return { file, bytes };
  };

  it('абсолютный путь к png: байты уходят в save, в элементе встаёт parleyImage; путь агента и остальные поля на месте, исходник цел', () => {
    const { file, bytes } = picture();
    const source = view(file);
    const before = structuredClone(source);
    const { calls, save } = fakeSave();

    const stashed = stashCodexRecord(source, save);

    expect(calls).toEqual([[bytes.toString('base64'), 'image/png']]);
    expect(itemOf(stashed)).toEqual({
      type: 'ImageView',
      id: 'iv1',
      path: file,
      parleyImage: {
        path: '/img/1.png',
        mime: 'image/png',
        bytes: bytes.toString('base64').length,
      },
    });
    expect(stashed).toEqual({ ...before, payload: { ...before.payload, item: itemOf(stashed) } });
    expect(source).toEqual(before);
  });

  it('так Codex пишет путь на деле — file:///…; проценты разбираются, файл читается', () => {
    const { file, bytes } = picture('my shot (1).png');
    const url = pathToFileURL(file).href;
    expect(url).toContain('%20');
    const { calls, save } = fakeSave();

    const stashed = stashCodexRecord(view(url), save);

    expect(calls).toEqual([[bytes.toString('base64'), 'image/png']]);
    expect(itemOf(stashed)['parleyImage']).toBeDefined();
    // Схема URL — без учёта регистра.
    const upper = stashCodexRecord(view(url.replace(/^file:/, 'FILE:')), save);
    expect(itemOf(upper)['parleyImage']).toBeDefined();
  });

  it('тип по расширению, регистр не важен: jpg, jpeg, gif, webp', () => {
    const { calls, save } = fakeSave();
    for (const name of ['a.jpg', 'b.JPEG', 'c.gif', 'd.WebP']) {
      picture(name);
      stashCodexRecord(view(path.join(dir, name)), save);
    }

    expect(calls.map(([, mime]) => mime)).toEqual([
      'image/jpeg',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ]);
  });

  describe('расширение проверяется у пути, в который превратился URL, а не у строки журнала', () => {
    // Файлы лежат на диске: если проверка смотрит не туда, обход их скопирует.
    const url = (name: string, tail = ''): string =>
      pathToFileURL(path.join(dir, name)).href + tail;

    it.each([
      ['запрос с «.png»', 'x.txt', '?.png'],
      ['фрагмент с «.png»', 'x.txt', '#.png'],
      ['запрос с «.png» после png-имени, расширение txt', 'x.png.txt', '?a=.png'],
    ])('%s — не картинка, save не зовётся', (_title, name, tail) => {
      picture(name);
      const { calls, save } = fakeSave();
      const record = view(url(name, tail));

      expect(stashCodexRecord(record, save)).toBe(record);
      expect(calls).toEqual([]);
    });

    it.each([
      [
        'процент-кодированная «n» в расширении',
        'x.png',
        (u: string) => u.replace('.png', '.p%6Eg'),
      ],
      ['запрос после png-имени', 'x.png', (u: string) => `${u}?v=1`],
      ['фрагмент после png-имени', 'x.png', (u: string) => `${u}#section`],
    ])('%s — картинка', (_title, name, transform) => {
      const { bytes } = picture(name);
      const { calls, save } = fakeSave();

      const stashed = stashCodexRecord(view(transform(url(name))), save);

      expect(calls).toEqual([[bytes.toString('base64'), 'image/png']]);
      expect(itemOf(stashed)['parleyImage']).toBeDefined();
    });
  });

  it('путь не абсолютный, чужая схема, чужой хост, закодированный слэш или не строка — файл не читается, запись та же', () => {
    picture('x.png');
    const { calls, save } = fakeSave();
    const inputs: unknown[] = [
      'x.png',
      './x.png',
      'shots/x.png',
      '~/x.png',
      'https://example.com/a.png',
      'file://remote-host/a.png',
      pathToFileURL(path.join(dir, 'a-b.png')).href.replace('a-b', 'a%2Fb'),
      undefined,
      null,
      42,
      '',
    ];
    for (const input of inputs) {
      const record = view(input);
      expect(stashCodexRecord(record, save), String(input)).toBe(record);
    }
    expect(calls).toEqual([]);
  });

  it('файла нет, каталог вместо файла, не картинка по расширению, пустой файл, больше FEED_IMAGE_MAX_BYTES — запись та же', () => {
    // Пустой файл — единственный, что доходит до save (настоящее хранилище его отвергает): здесь save отказывает.
    const { calls, save } = fakeSave([1]);
    mkdirSync(path.join(dir, 'folder.png'));
    writeFileSync(path.join(dir, 'notes.txt'), 'text');
    writeFileSync(path.join(dir, 'logo.svg'), '<svg/>');
    writeFileSync(path.join(dir, 'noext'), 'x');
    writeFileSync(path.join(dir, 'empty.png'), '');
    const huge = path.join(dir, 'huge.png');
    writeFileSync(huge, '');
    truncateSync(huge, FEED_IMAGE_MAX_BYTES + 1);

    const names = [
      'gone.png',
      'folder.png',
      'notes.txt',
      'logo.svg',
      'noext',
      'empty.png',
      'huge.png',
    ];
    for (const name of names) {
      const record = view(path.join(dir, name));
      expect(stashCodexRecord(record, save), name).toBe(record);
    }
    expect(calls.map(([data]) => data)).toEqual(['']);
  });

  it('хранилище отказало (null) или save бросил — запись та же, исключения нет', () => {
    const { file } = picture();
    const refused = view(file);
    expect(stashCodexRecord(refused, fakeSave([1]).save)).toBe(refused);

    const thrown = view(file);
    const failing = (): FeedImageRef | null => {
      throw new Error('disk full');
    };
    expect(stashCodexRecord(thrown, failing)).toBe(thrown);
  });

  it('метка parleyImage в данных чужая: снимается всегда, а при удачной копии её место занимает настоящая', () => {
    const forged = { path: '/Users/me/.ssh/id_rsa.png', mime: 'image/png' };
    const { calls, save } = fakeSave();

    const unreadable = stashCodexRecord(
      view(path.join(dir, 'gone.png'), { parleyImage: forged }),
      save,
    );
    expect(itemOf(unreadable)).not.toHaveProperty('parleyImage');
    expect(JSON.stringify(unreadable)).not.toContain('id_rsa');
    expect(calls).toEqual([]);

    const { file } = picture();
    const copied = stashCodexRecord(view(file, { parleyImage: forged }), save);
    expect(itemOf(copied)['parleyImage']).toEqual({
      path: '/img/1.png',
      mime: 'image/png',
      bytes: expect.any(Number),
    });
  });

  it('только законченный элемент: ImageView в записи item_started файл не читает', () => {
    const { file } = picture();
    const { calls, save } = fakeSave();
    const started: RolloutRecord = {
      ...view(file),
      payload: { ...view(file).payload, type: 'item_started' },
    };

    expect(stashCodexRecord(started, save)).toBe(started);
    expect(calls).toEqual([]);
  });

  describe('с настоящим хранилищем', () => {
    const tool = (record: RolloutRecord): FeedTool => {
      const { update } = applyCodexRecords(emptyFeedState(), [record], emptyCodexCursor());
      return update.state.items.find((item) => item.kind === 'tool') as FeedTool;
    };

    it('тот же путь, другое содержимое — две ссылки на два файла: лента показывает ту картинку, что агент посмотрел тогда', () => {
      const store = createFeedImageStore({ dir: path.join(dir, 'store') });
      const first = picture('shot.png', 1);
      const one = stashCodexRecord(view(first.file), store.save);
      // Агент переписал файл и посмотрел снова.
      const second = picture('shot.png', 2);
      const two = stashCodexRecord(view(second.file, { id: 'iv2' }), store.save);

      const refs = [one, two].map((record) => itemOf(record)['parleyImage'] as FeedImageRef);
      expect(refs[0]?.path).not.toBe(refs[1]?.path);
      expect(readdirSync(path.join(dir, 'store'))).toHaveLength(2);
      expect(readFileSync(refs[0]?.path ?? '').equals(first.bytes)).toBe(true);
      expect(readFileSync(refs[1]?.path ?? '').equals(second.bytes)).toBe(true);
    });

    it('редьюсер читает метку хоста: вызов ViewImage ведёт на копию, а не на файл агента; файл агента можно удалить', () => {
      const store = createFeedImageStore({ dir: path.join(dir, 'store') });
      const { file, bytes } = picture();

      const shown = tool(stashCodexRecord(view(pathToFileURL(file).href), store.save));
      rmSync(file);

      expect(shown.name).toBe('ViewImage');
      expect(shown.response?.images).toHaveLength(1);
      const image = shown.response?.images?.[0];
      expect(image?.path.startsWith(path.join(dir, 'store'))).toBe(true);
      expect(image).toMatchObject({ mime: 'image/png', bytes: bytes.length });
      expect(readFileSync(image?.path ?? '').equals(bytes)).toBe(true);
      expect(shown.response?.text).toMatch(/^\[image png, \d+ KB\]$/);
    });

    it('файла агента нет — вызов остаётся без картинки, как до этой возможности', () => {
      const store = createFeedImageStore({ dir: path.join(dir, 'store') });

      const shown = tool(stashCodexRecord(view(path.join(dir, 'gone.png')), store.save));

      expect(shown.name).toBe('ViewImage');
      expect(shown).not.toHaveProperty('response');
    });
  });
});
