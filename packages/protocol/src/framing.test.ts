import { describe, expect, it } from 'vitest';
import {
  LineDecoder,
  LineTooLongError,
  MAX_LINE_BYTES,
  encodeLine,
  parseIncoming,
} from './framing.js';

describe('encodeLine', () => {
  it('даёт одну строку с переводом строки на конце и без переводов внутри', () => {
    const line = encodeLine({ id: 1, method: 'host.info', params: {} });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
  });
});

describe('LineDecoder', () => {
  it('разбирает два сообщения в одном куске', () => {
    const decoder = new LineDecoder();
    const chunk = Buffer.from('{"a":1}\n{"b":2}\n', 'utf8');
    expect(decoder.push(chunk)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('собирает одно сообщение, разрезанное на три куска', () => {
    const decoder = new LineDecoder();
    const text = '{"hello":"world"}\n';
    const bytes = Buffer.from(text, 'utf8');
    const third = Math.ceil(bytes.length / 3);
    const parts = [bytes.subarray(0, third), bytes.subarray(third, third * 2), bytes.subarray(third * 2)];
    let result: unknown[] = [];
    for (const part of parts) {
      result = result.concat(decoder.push(part));
    }
    expect(result).toEqual([{ hello: 'world' }]);
  });

  it('собирает целыми ё и 😀, разрезанные посередине байтов', () => {
    const decoder = new LineDecoder();
    const text = `{"text":"ё😀"}\n`;
    const bytes = Buffer.from(text, 'utf8');
    const emojiStart = bytes.indexOf(Buffer.from('😀', 'utf8'));
    // Режем ровно посередине 4-байтового знака эмодзи.
    const cut = emojiStart + 2;
    let result: unknown[] = [];
    result = result.concat(decoder.push(bytes.subarray(0, cut)));
    result = result.concat(decoder.push(bytes.subarray(cut)));
    expect(result).toEqual([{ text: 'ё😀' }]);
  });

  it('бросает LineTooLongError на строке длиннее MAX_LINE_BYTES', () => {
    const decoder = new LineDecoder();
    const huge = Buffer.alloc(MAX_LINE_BYTES + 1, 'a');
    expect(() => decoder.push(huge)).toThrow(LineTooLongError);
  });
});

describe('parseIncoming', () => {
  it('разбирает верный запрос', () => {
    const result = parseIncoming({ id: 7, method: 'host.info', params: {} });
    expect(result.kind).toBe('request');
    if (result.kind === 'request') {
      expect(result.message).toEqual({ id: 7, method: 'host.info', params: {} });
      expect(result.params).toEqual({});
    }
  });

  it('разбирает уведомление без id', () => {
    const result = parseIncoming({
      method: 'pty.input',
      params: { ref: { projectPath: '/p', workId: 'w', sessionId: 's' }, data: 'x' },
    });
    expect(result.kind).toBe('notification');
    if (result.kind === 'notification') {
      expect(result.message.method).toBe('pty.input');
    }
  });

  it('неизвестный метод даёт unknown_method с id', () => {
    const result = parseIncoming({ id: 3, method: 'no.such.method', params: {} });
    expect(result).toEqual({
      kind: 'invalid',
      id: 3,
      error: { code: 'unknown_method', message: 'неизвестный метод: no.such.method' },
    });
  });

  it('неверные params дают bad_request с текстом zod', () => {
    const result = parseIncoming({ id: 4, method: 'sessions.resume', params: { ref: 'не объект' } });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.id).toBe(4);
      expect(result.error.code).toBe('bad_request');
      expect(typeof result.error.message).toBe('string');
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it('мусор без id даёт invalid с id: null', () => {
    const result = parseIncoming({ foo: 'bar' });
    expect(result).toEqual({
      kind: 'invalid',
      id: null,
      error: { code: 'bad_request', message: 'нет поля method' },
    });
  });

  it('совсем не объект тоже даёт invalid с id: null', () => {
    expect(parseIncoming('мусор')).toEqual({
      kind: 'invalid',
      id: null,
      error: { code: 'bad_request', message: 'ожидался объект' },
    });
    expect(parseIncoming(null)).toEqual({
      kind: 'invalid',
      id: null,
      error: { code: 'bad_request', message: 'ожидался объект' },
    });
  });
});
