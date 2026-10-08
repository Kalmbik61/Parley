import { describe, expect, it } from 'vitest';
import { consoleEntry, networkEntry } from '../../test-utils/devtools-fixtures.js';
import {
  base64Bytes,
  consoleCopyText,
  formFields,
  headerValue,
  nameParts,
  prettyJson,
  queryParams,
  sizeText,
  sourceLabel,
  statusCell,
} from './format.js';

const APP = 'http://localhost:5173/src/app.js';

describe('строки консоли (спека 4.3)', () => {
  it('sourceLabel — файл:строка; без файла — хост; не адрес — как есть', () => {
    expect(sourceLabel({ url: APP, line: 10, column: 5 })).toBe('app.js:10');
    expect(sourceLabel({ url: 'http://localhost:5173/', line: 1, column: 1 })).toBe('localhost:5173:1');
    expect(sourceLabel({ url: 'eval', line: 3, column: 1 })).toBe('eval:3');
  });

  it('consoleCopyText — текст и кадры «at fn (url:строка:столбец)»', () => {
    expect(consoleCopyText(consoleEntry(1, { text: 'Uncaught Error: boom', stack: [{ fn: 'save', url: APP, line: 10, column: 5 }] }))).toBe(
      `Uncaught Error: boom\n    at save (${APP}:10:5)`,
    );
  });
});

describe('ячейки Network (спека 4.4)', () => {
  it('statusCell: отказ важнее кода; без ответа — (pending)', () => {
    expect(statusCell(networkEntry('a', { status: 500 }))).toEqual({ text: '500', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: 304 }))).toEqual({ text: '304', tone: 'normal' });
    expect(statusCell(networkEntry('a', { status: 200, failure: { reason: 'cors', text: 'X' } }))).toEqual({ text: 'CORS', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: null, failure: { reason: 'blocked', text: 'csp' } }))).toEqual({ text: 'blocked', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: null, failure: { reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' } }))).toEqual({ text: 'failed', tone: 'error' });
    expect(statusCell(networkEntry('a', { status: null, failure: { reason: 'canceled', text: '' } }))).toEqual({ text: '(canceled)', tone: 'muted' });
    expect(statusCell(networkEntry('a', { status: null }))).toEqual({ text: '(pending)', tone: 'muted' });
  });

  it('nameParts: свой origin — путь и query; чужой — ещё хост; не адрес — как есть', () => {
    expect(nameParts('http://localhost:5173/api/x?q=1', 'http://localhost:5173/page')).toEqual({ path: '/api/x?q=1', host: null });
    expect(nameParts('http://127.0.0.1:9/data', 'http://localhost:5173/')).toEqual({ path: '/data', host: '127.0.0.1:9' });
    expect(nameParts('not a url', 'http://localhost:5173/')).toEqual({ path: 'not a url', host: null });
  });

  it('sizeText: из кэша — (cache); B, kB, MB; неизвестен — тире', () => {
    expect(sizeText(networkEntry('a', { fromCache: true }))).toBe('(cache)');
    expect(sizeText(networkEntry('a', { encodedBytes: 512 }))).toBe('512 B');
    expect(sizeText(networkEntry('a', { encodedBytes: 2048 }))).toBe('2.0 kB');
    expect(sizeText(networkEntry('a', { encodedBytes: 3_145_728 }))).toBe('3.0 MB');
    expect(sizeText(networkEntry('a', { encodedBytes: null }))).toBe('—');
  });
});

describe('тела и заголовки (спека 4.4)', () => {
  it('prettyJson: JSON — с отступами; не JSON — null', () => {
    expect(prettyJson('{"a":[1]}')).toBe('{\n  "a": [\n    1\n  ]\n}');
    expect(prettyJson('<html>')).toBeNull();
  });

  it('base64Bytes: три байта на четыре знака без добивки', () => {
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });

  it('queryParams и formFields — пары по порядку; headerValue — без учёта регистра имени', () => {
    expect(queryParams('http://x/a?tab=1&q=two%20words')).toEqual([
      ['tab', '1'],
      ['q', 'two words'],
    ]);
    expect(queryParams('not a url')).toEqual([]);
    expect(formFields('name=Ann&age=30')).toEqual([
      ['name', 'Ann'],
      ['age', '30'],
    ]);
    expect(headerValue([['Content-Type', 'application/json']], 'content-type')).toBe('application/json');
    expect(headerValue([], 'content-type')).toBeNull();
  });
});
