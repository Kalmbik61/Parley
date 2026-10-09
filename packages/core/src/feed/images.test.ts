/**
 * Картинки результатов инструментов в ленте (план 2026-10-09, Task 1): обход JSON, который меняет
 * base64-картинки на ссылки на файлы, и сводка результата с пометками вместо байтов. Формы блоков —
 * из живых журналов: массив MCP у Claude (Anthropic), Read у Claude, MCP и Codex, OpenAI `input_image`.
 */

import { describe, expect, it } from 'vitest';
import { stashFeedImages, summarizeImageBlocks } from './images.js';
import { applyHookEvent, emptyFeedState } from './reduce.js';
import {
  FEED_IMAGE_MAX_BYTES,
  FEED_IMAGE_MIME_LIMIT,
  FEED_IMAGE_PATH_LIMIT,
  FEED_IMAGE_TTL_MS,
  FEED_IMAGES_PER_CALL,
  type FeedImageRef,
  type FeedState,
  type FeedTool,
} from './types.js';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4R';

const ref = (n: number, mime = 'image/png', bytes = 2048): FeedImageRef => ({
  path: `/home/.parley/feed-images/img${n}.png`,
  mime,
  bytes,
});

/** `save`, который помнит вызовы; ссылка по умолчанию — своя на каждый вызов. */
function recorder(answer: (call: number) => FeedImageRef | null = (call) => ref(call)) {
  const calls: { base64: string; mime: string }[] = [];
  const save = (base64: string, mime: string): FeedImageRef | null => {
    calls.push({ base64, mime });
    return answer(calls.length);
  };
  return { save, calls };
}

/** Замораживает значение целиком: любая запись в исходник в строгом режиме модуля — TypeError. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/** Четыре вида блока-картинки из живых журналов. */
const SHAPES: { name: string; block: Record<string, unknown>; type: string }[] = [
  {
    name: 'Anthropic: массив MCP у Claude',
    block: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    type: 'image',
  },
  {
    name: 'Read у Claude',
    block: {
      type: 'image',
      file: {
        base64: PNG,
        type: 'image/png',
        originalSize: 60950,
        dimensions: { originalWidth: 800, originalHeight: 600 },
      },
    },
    type: 'image',
  },
  {
    name: 'MCP и Codex',
    block: { type: 'image', data: PNG, mimeType: 'image/png' },
    type: 'image',
  },
  {
    name: 'OpenAI input_image',
    block: { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'high' },
    type: 'input_image',
  },
];

describe('числа плана — константы', () => {
  it('шесть картинок на вызов, 20 МиБ на картинку, 7 суток хранения', () => {
    expect(FEED_IMAGES_PER_CALL).toBe(6);
    expect(FEED_IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(FEED_IMAGE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('границы ссылки — как у схемы протокола: путь 4096 символов, тип 100', () => {
    expect(FEED_IMAGE_PATH_LIMIT).toBe(4096);
    expect(FEED_IMAGE_MIME_LIMIT).toBe(100);
  });
});

describe('stashFeedImages: четыре вида блоков', () => {
  it.each(SHAPES)('$name: байты уходят в save, блок несёт ссылку и прежний type', (shape) => {
    const { save, calls } = recorder();
    const out = stashFeedImages(shape.block, save);

    expect(calls).toEqual([{ base64: PNG, mime: 'image/png' }]);
    expect(out).toEqual({ type: shape.type, parleyImage: ref(1) });
    expect(JSON.stringify(out)).not.toContain('iVBOR');
  });

  it('mime берётся из media_type, mimeType, file.type и data-URL — любой, не только png', () => {
    const { save, calls } = recorder();
    stashFeedImages(
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } },
        { type: 'image', file: { base64: JPEG, type: 'image/webp' } },
        { type: 'image', data: JPEG, mimeType: 'image/gif' },
        { type: 'input_image', image_url: `data:image/jpeg;base64,${JPEG}` },
      ],
      save,
    );

    expect(calls.map((call) => call.mime)).toEqual([
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/jpeg',
    ]);
    expect(calls.every((call) => call.base64 === JPEG)).toBe(true);
  });

  it('data-URL с параметрами: mime — первая часть, байты — после запятой', () => {
    const { save, calls } = recorder();
    stashFeedImages(
      { type: 'input_image', image_url: `data:image/png;name=shot.png;base64,${PNG}` },
      save,
    );

    expect(calls).toEqual([{ base64: PNG, mime: 'image/png' }]);
  });

  it('схема data: и токен base64 — без учёта регистра; пробелы вокруг токена не мешают', () => {
    const { save, calls } = recorder();
    const out = stashFeedImages(
      [
        { type: 'input_image', image_url: `DATA:image/png;base64,${PNG}` },
        { type: 'input_image', image_url: `Data:image/png;BASE64,${PNG}` },
        { type: 'input_image', image_url: `data:image/png;name=shot.png; Base64 ,${PNG}` },
      ],
      save,
    );

    expect(calls).toEqual([
      { base64: PNG, mime: 'image/png' },
      { base64: PNG, mime: 'image/png' },
      { base64: PNG, mime: 'image/png' },
    ]);
    expect(JSON.stringify(out)).not.toContain('iVBOR');
  });

  it('mime уходит в save без пробелов по краям и в нижнем регистре — из любого поля и из data-URL', () => {
    const { save, calls } = recorder();
    stashFeedImages(
      [
        { type: 'image', source: { type: 'base64', media_type: ' Image/PNG ', data: PNG } },
        { type: 'image', file: { base64: PNG, type: 'IMAGE/JPEG' } },
        { type: 'image', data: PNG, mimeType: 'Image/WebP\n' },
        { type: 'input_image', image_url: `data: IMAGE/GIF ;base64,${PNG}` },
      ],
      save,
    );

    expect(calls.map((call) => call.mime)).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
    ]);
  });

  it('mime из одних пробелов — всё равно что не назван: save не зовётся, картинка выброшена', () => {
    const { save, calls } = recorder();
    const out = stashFeedImages({ type: 'image', data: PNG, mimeType: '  \t' }, save);

    expect(calls).toEqual([]);
    expect(out).toEqual({ type: 'image', parleyImageOmitted: true });
  });

  it('save вернул null (большая, неизвестный тип, битая) — parleyImageOmitted, тип прежний', () => {
    const { save } = recorder(() => null);

    expect(stashFeedImages(SHAPES[0]?.block, save)).toEqual({
      type: 'image',
      parleyImageOmitted: true,
    });
    expect(stashFeedImages(SHAPES[3]?.block, save)).toEqual({
      type: 'input_image',
      parleyImageOmitted: true,
    });
  });

  it('save бросил (диск полон) — картинка выброшена, остальные обработаны, байтов нет', () => {
    let call = 0;
    const out = stashFeedImages(
      [
        { type: 'image', data: PNG, mimeType: 'image/png' },
        { type: 'image', data: PNG, mimeType: 'image/png' },
      ],
      (): FeedImageRef | null => {
        call += 1;
        if (call === 1) throw new Error('ENOSPC');
        return ref(call);
      },
    );

    expect(out).toEqual([
      { type: 'image', parleyImageOmitted: true },
      { type: 'image', parleyImage: ref(2) },
    ]);
  });

  it('mime не определить — save не зовётся, картинка выброшена, байтов в блоке нет', () => {
    const { save, calls } = recorder();
    const out = stashFeedImages(
      [
        { type: 'image', data: PNG },
        { type: 'image', source: { type: 'base64', data: PNG } },
        { type: 'input_image', image_url: `data:;base64,${PNG}` },
      ],
      save,
    );

    expect(calls).toEqual([]);
    expect(out).toEqual([
      { type: 'image', parleyImageOmitted: true },
      { type: 'image', parleyImageOmitted: true },
      { type: 'input_image', parleyImageOmitted: true },
    ]);
  });
});

describe('stashFeedImages: обход', () => {
  it('исходник не меняется: ни блок, ни объемлющие объекты и массивы', () => {
    const input = deepFreeze({
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'Took a screenshot' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
            ],
          },
        ],
      },
      toolUseResult: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
    });
    const before = structuredClone(input);
    const { save } = recorder();

    const out = stashFeedImages(input, save);

    expect(input).toEqual(before);
    expect(out).not.toBe(input);
    expect(JSON.stringify(out)).not.toContain('iVBOR');
  });

  it('заменяет картинку на любой глубине записи журнала; соседи и текстовые блоки — те же объекты', () => {
    const text = { type: 'text', text: 'Took a screenshot' };
    const note = { type: 'text', text: '[Image: source: /tmp/x.png]' };
    const record = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [text, { type: 'image', data: PNG, mimeType: 'image/png' }, note],
          },
        ],
      },
      toolUseResult: [text, { type: 'image', data: PNG, mimeType: 'image/png' }, note],
    };
    const { save, calls } = recorder();

    const out = stashFeedImages(record, save) as typeof record;

    // Одна и та же картинка стоит в записи дважды — save зовётся на каждое место, повтор снимает хранилище.
    expect(calls).toHaveLength(2);
    const [inContent] = out.message.content as { content: unknown[] }[];
    expect(inContent?.content).toEqual([text, { type: 'image', parleyImage: ref(1) }, note]);
    expect(out.toolUseResult).toEqual([text, { type: 'image', parleyImage: ref(2) }, note]);
    expect(inContent?.content[0]).toBe(text);
    expect(inContent?.content[2]).toBe(note);
    expect(out.uuid).toBe('u1');
    expect(out.message.role).toBe('user');
  });

  it('повторный обход обработанной записи метки снимает, save не зовёт: хост обходит сырую запись один раз', () => {
    const { save, calls } = recorder();
    const once = stashFeedImages(
      [{ type: 'text', text: 'a' }, ...SHAPES.map((shape) => shape.block)],
      save,
    );
    const callsAfterFirst = calls.length;

    expect(stashFeedImages(once, save)).toStrictEqual([
      { type: 'text', text: 'a' },
      ...SHAPES.map((shape) => ({ type: shape.type })),
    ]);
    expect(calls).toHaveLength(callsAfterFirst);
  });

  it('картинок нет — тот же объект (не копия), save не зовётся', () => {
    const { save, calls } = recorder();
    const value = {
      tool_response: [{ type: 'text', text: 'ok' }],
      deep: { a: [{ b: { c: 'x'.repeat(1000) } }] },
    };

    expect(stashFeedImages(value, save)).toBe(value);
    for (const plain of ['text', 42, true, null, undefined, [], {}, [[], [{}]]]) {
      expect(stashFeedImages(plain, save)).toBe(plain);
    }
    expect(calls).toEqual([]);
  });

  it('ключи, лишь похожие на метки, и значения-строки с их именами — тот же объект', () => {
    const { save, calls } = recorder();
    const value = {
      parleyImages: [1],
      ParleyImage: { path: '/a.png' },
      'parley-image': true,
      note: 'parleyImage parleyImageOmitted',
      blocks: [{ type: 'image', parleyImageOmit: true }],
    };

    expect(stashFeedImages(value, save)).toBe(value);
    expect(calls).toEqual([]);
  });

  it('не тронуто всё, что не одна из четырёх форм', () => {
    const { save, calls } = recorder();
    const values = [
      // Картинка по ссылке, а не байтами.
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'input_image', image_url: 'https://example.com/a.png' },
      // Data-URL без base64.
      { type: 'input_image', image_url: 'data:image/svg+xml,%3Csvg%2F%3E' },
      // Текст, внутри которого лежит data-URL, — не картинка.
      { type: 'text', text: `data:image/png;base64,${PNG}` },
      // Тип не картинка, хотя поля похожи.
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PNG } },
      { type: 'audio', data: PNG, mimeType: 'audio/wav' },
      // Картинка без байтов.
      { type: 'image' },
      { type: 'image', source: { type: 'base64' } },
      { type: 'image', data: 5, mimeType: 'image/png' },
      // Поля без блока.
      { source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { data: PNG, mimeType: 'image/png' },
    ];

    for (const value of values) expect(stashFeedImages(value, save)).toBe(value);
    expect(calls).toEqual([]);
  });

  it('глубина ограничена: вложенность в тысячи уровней не роняет обход', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20_000; i += 1) deep = { next: deep };
    const { save, calls } = recorder();

    expect(stashFeedImages(deep, save)).toBe(deep);
    expect(calls).toEqual([]);

    // На обычной глубине картинка замещается.
    const shallow = { a: { b: { c: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } } };
    expect(stashFeedImages(shallow, save)).toEqual({
      a: { b: { c: [{ type: 'image', parleyImage: ref(1) }] } },
    });
  });

  it('ключ __proto__ в чужом JSON не подменяет прототип копии', () => {
    const value = JSON.parse(
      `{"__proto__":{"type":"image","data":"${PNG}","mimeType":"image/png"},"keep":1}`,
    ) as Record<string, unknown>;
    const { save } = recorder();

    const out = stashFeedImages(value, save) as Record<string, unknown>;

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({
      type: 'image',
      parleyImage: ref(1),
    });
    expect(out['keep']).toBe(1);
  });
});

describe('stashFeedImages: метки, которые принёс сам результат инструмента', () => {
  // Результат инструмента — чужой текст: метка из него не должна навести окно на произвольный файл.
  const FORGED = { path: '/Users/me/.ssh/id_rsa.png', mime: 'image/png', bytes: 1 };

  it('parleyImage и parleyImageOmitted у блока без байтов снимаются, тип блока остаётся', () => {
    const { save, calls } = recorder();
    const out = stashFeedImages(
      [
        { type: 'image', parleyImage: FORGED },
        { type: 'input_image', parleyImageOmitted: true },
      ],
      save,
    );

    expect(out).toStrictEqual([{ type: 'image' }, { type: 'input_image' }]);
    expect(calls).toEqual([]);
  });

  it('метка у объекта любого вида снимается, остальные поля и соседние объекты — те же', () => {
    const { save } = recorder();
    const sibling = { type: 'text', text: 'ok' };
    const untouched = { keep: 1 };
    const record = {
      toolUseResult: { parleyImage: FORGED, parleyImageOmitted: true, keep: 1 },
      content: [sibling, { type: 'image', parleyImage: FORGED }],
      untouched,
    };

    const out = stashFeedImages(record, save) as typeof record;

    expect(out.toolUseResult).toStrictEqual({ keep: 1 });
    expect(out.content[1]).toStrictEqual({ type: 'image' });
    expect(out.content[0]).toBe(sibling);
    expect(out.untouched).toBe(untouched);
  });

  it('блок с байтами и чужой меткой: остаётся только ссылка, которую дал save', () => {
    const { save } = recorder();
    const out = stashFeedImages(
      {
        type: 'image',
        data: PNG,
        mimeType: 'image/png',
        parleyImage: FORGED,
        parleyImageOmitted: true,
      },
      save,
    );

    expect(out).toStrictEqual({ type: 'image', parleyImage: ref(1) });
  });

  it('исходник не меняется', () => {
    const input = deepFreeze({
      result: { parleyImage: FORGED },
      list: [{ type: 'image', parleyImageOmitted: true }],
    });
    const before = structuredClone(input);
    const { save } = recorder();

    stashFeedImages(input, save);

    expect(input).toEqual(before);
  });

  it('через редьюсер: подложенная метка ссылкой не становится и в ленту не попадает', () => {
    const { save } = recorder();
    const event = stashFeedImages(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__evil__shot',
        tool_use_id: 't1',
        tool_input: {},
        tool_response: [
          { type: 'text', text: 'x' },
          { type: 'image', parleyImage: FORGED },
        ],
      },
      save,
    ) as Record<string, unknown>;
    const { state } = applyHookEvent(emptyFeedState(), event, '2026-10-09T10:00:00.000Z');
    const [tool] = state.items.filter((item): item is FeedTool => item.kind === 'tool');

    expect(tool?.response?.images).toBeUndefined();
    expect(tool?.response?.text).toBe('x\n[image omitted]');
    expect(JSON.stringify(state)).not.toContain('id_rsa');
  });
});

describe('summarizeImageBlocks: ссылка в границах схемы протокола', () => {
  const stashed = (parleyImage: unknown): unknown[] => [
    { type: 'text', text: 'x' },
    { type: 'image', parleyImage },
  ];
  const withPath = (length: number) => ({ path: `/${'a'.repeat(length - 1)}`, mime: 'image/png' });

  it('путь ровно FEED_IMAGE_PATH_LIMIT проходит; на символ длиннее — ссылки нет, в тексте [image omitted]', () => {
    const fits = withPath(FEED_IMAGE_PATH_LIMIT);
    expect(summarizeImageBlocks(stashed(fits))).toEqual({
      text: 'x\n[image png]',
      images: [fits],
    });

    expect(summarizeImageBlocks(stashed(withPath(FEED_IMAGE_PATH_LIMIT + 1)))).toEqual({
      text: 'x\n[image omitted]',
      images: [],
    });
  });

  it('mime ровно FEED_IMAGE_MIME_LIMIT проходит; на символ длиннее — ссылки нет', () => {
    const fits = { path: '/a.png', mime: 'x'.repeat(FEED_IMAGE_MIME_LIMIT) };
    expect(summarizeImageBlocks(stashed(fits))?.images).toEqual([fits]);

    const tooLong = { path: '/a.png', mime: 'x'.repeat(FEED_IMAGE_MIME_LIMIT + 1) };
    expect(summarizeImageBlocks(stashed(tooLong))).toEqual({
      text: 'x\n[image omitted]',
      images: [],
    });
  });
});

describe('картинка проходит редьюсер без байтов', () => {
  const AT = '2026-10-09T10:00:00.000Z';
  const run = (events: Record<string, unknown>[]): FeedState =>
    events.reduce<FeedState>((state, ev) => applyHookEvent(state, ev, AT).state, emptyFeedState());
  const tools = (state: FeedState): FeedTool[] =>
    state.items.filter((item): item is FeedTool => item.kind === 'tool');

  it('PostToolUse с картинкой MCP: ссылка в response.images, пометка в тексте, base64 нигде нет', () => {
    const { save } = recorder((call) => ref(call, 'image/png', 123 * 1024));
    const event = {
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__browser__screenshot',
      tool_use_id: 't1',
      tool_input: {},
      tool_response: [
        { type: 'text', text: 'Took a screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      ],
    };
    const state = run([stashFeedImages(event, save) as Record<string, unknown>]);
    const [tool] = tools(state);

    expect(tool?.response?.text).toBe('Took a screenshot\n[image png, 123 KB]');
    expect(tool?.response?.images).toEqual([ref(1, 'image/png', 123 * 1024)]);
    const wire = JSON.stringify(state);
    expect(wire).not.toContain('iVBOR');
    expect(wire).not.toContain('/9j/');
  });

  it('10 картинок по 5 МБ и одна битая: шесть ссылок, остальные — пометки, лента без base64', () => {
    const big = 'A'.repeat(5 * 1024 * 1024);
    const blocks = Array.from({ length: 11 }, (_, i) => ({
      type: 'image',
      source: { type: 'base64', media_type: i === 4 ? 'image/bmp' : 'image/png', data: big },
    }));
    // Хранилище отвергает неизвестный тип (null); остальным даёт ссылку.
    const { save } = recorder((call) => (call === 5 ? null : ref(call)));
    const stashed = stashFeedImages(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__browser__screenshots',
        tool_use_id: 't1',
        tool_input: {},
        tool_response: [{ type: 'text', text: 'shots' }, ...blocks],
      },
      save,
    ) as Record<string, unknown>;
    const state = run([stashed]);
    const [tool] = tools(state);

    expect(tool?.response?.images).toHaveLength(6);
    const lines = tool?.response?.text.split('\n') ?? [];
    expect(lines[0]).toBe('shots');
    expect(lines.filter((line) => line === '[image omitted]')).toHaveLength(5);
    expect(lines.filter((line) => line.startsWith('[image png'))).toHaveLength(6);
    expect(JSON.stringify(state)).not.toContain('AAAAAAAA');
  });
});
