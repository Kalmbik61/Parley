// packages/desktop/src/main/browser/cdp-entries.test.ts
import { describe, expect, it } from 'vitest';
import { DEVTOOLS_LIMITS } from '../../shared/browser-devtools.js';
import {
  clip,
  consoleFromApi,
  consoleFromException,
  consoleFromLog,
  failureOf,
  formatConsoleArgs,
  headerPairs,
  networkKind,
  postDataOf,
  remoteAddress,
  remoteText,
} from './cdp-entries.js';

const APP = 'http://localhost:5173/src/app.js';
const FRAME = { functionName: 'save', url: APP, lineNumber: 9, columnNumber: 4 };
const str = (value: string): { type: string; value: string } => ({ type: 'string', value });

describe('аргументы консоли текстом (спека 1.4, 4.3)', () => {
  it('строка, число, NaN, undefined, null, символ', () => {
    expect(remoteText(str('hi'))).toBe('hi');
    expect(remoteText({ type: 'number', value: 42, description: '42' })).toBe('42');
    expect(remoteText({ type: 'number', unserializableValue: 'NaN', description: 'NaN' })).toBe('NaN');
    expect(remoteText({ type: 'undefined' })).toBe('undefined');
    expect(remoteText({ type: 'object', subtype: 'null', value: null })).toBe('null');
    expect(remoteText({ type: 'symbol', description: 'Symbol(id)' })).toBe('Symbol(id)');
  });

  it("объект — краткий предпросмотр CDP: {theme: 'dark', items: Array(12)}", () => {
    expect(
      remoteText({
        type: 'object',
        description: 'Object',
        preview: {
          description: 'Object',
          overflow: false,
          properties: [
            { name: 'theme', type: 'string', value: 'dark' },
            { name: 'items', type: 'object', subtype: 'array', value: 'Array(12)' },
          ],
        },
      }),
    ).toBe("{theme: 'dark', items: Array(12)}");
  });

  it('массив — описание и элементы; переполнение — «…»; объект класса — с его именем', () => {
    expect(
      remoteText({
        type: 'object',
        subtype: 'array',
        description: 'Array(2)',
        preview: {
          subtype: 'array',
          description: 'Array(2)',
          overflow: false,
          properties: [
            { name: '0', type: 'number', value: '1' },
            { name: '1', type: 'number', value: '2' },
          ],
        },
      }),
    ).toBe('Array(2) [1, 2]');
    expect(
      remoteText({ type: 'object', description: 'Object', preview: { description: 'Object', overflow: true, properties: [{ name: 'a', type: 'number', value: '1' }] } }),
    ).toBe('{a: 1, …}');
    expect(
      remoteText({ type: 'object', description: 'User', preview: { description: 'User', overflow: false, properties: [{ name: 'id', type: 'number', value: '7' }] } }),
    ).toBe('User {id: 7}');
  });

  it('ошибка — описание со стеком; объект без предпросмотра — описание', () => {
    expect(remoteText({ type: 'object', subtype: 'error', description: 'Error: broken\n    at save (app.js:10:5)' })).toBe(
      'Error: broken\n    at save (app.js:10:5)',
    );
    expect(remoteText({ type: 'object', description: 'HTMLDivElement' })).toBe('HTMLDivElement');
  });

  it('формат: %c, %s, %d и %% первого аргумента; лишние аргументы — через пробел', () => {
    expect(
      formatConsoleArgs([
        str('%c%s has %d items, 100%%'),
        str('color: red'),
        str('cart'),
        { type: 'number', value: 3.7, description: '3.7' },
        { type: 'number', value: 5, description: '5' },
      ]),
    ).toBe('cart has 3 items, 100% 5');
    expect(formatConsoleArgs([str('a'), str('b')])).toBe('a b');
    expect(formatConsoleArgs([])).toBe('');
  });
});

describe('consoleFromApi (Runtime.consoleAPICalled)', () => {
  it('log — info из консоли; место и стек — с единицы', () => {
    expect(consoleFromApi({ type: 'log', args: [str('hello')], stackTrace: { callFrames: [FRAME] } })).toEqual({
      level: 'info',
      origin: 'console',
      text: 'hello',
      location: { url: APP, line: 10, column: 5 },
      stack: [{ fn: 'save', url: APP, line: 10, column: 5 }],
    });
  });

  it('уровни: error и assert — error, warning, debug; table и незнакомые — info', () => {
    const level = (type: string): string | undefined => consoleFromApi({ type, args: [str('x')] })?.level;
    expect(level('error')).toBe('error');
    expect(level('assert')).toBe('error');
    expect(level('warning')).toBe('warning');
    expect(level('debug')).toBe('debug');
    expect(level('table')).toBe('info');
    expect(level('somethingNew')).toBe('info');
    expect(consoleFromApi({ type: 'assert', args: [str('x > 0')] })?.text).toBe('Assertion failed: x > 0');
  });

  it('endGroup, clear, profile, profileEnd — не запись', () => {
    for (const type of ['endGroup', 'clear', 'profile', 'profileEnd']) {
      expect(consoleFromApi({ type, args: [] }), type).toBeNull();
    }
  });

  it('предупреждение безопасности Electron — не запись (спека 3.3)', () => {
    expect(
      consoleFromApi({ type: 'warning', args: [str('%cElectron Security Warning (Insecure Content-Security-Policy)'), str('font-weight: bold;')] }),
    ).toBeNull();
  });

  it('текст — до 10 000, стек — до 20 кадров; безымянная функция — (anonymous); без стека — без места', () => {
    const frames = Array.from({ length: 30 }, () => ({ url: APP, lineNumber: 0, columnNumber: 0 }));
    const draft = consoleFromApi({ type: 'log', args: [str('x'.repeat(20_000))], stackTrace: { callFrames: frames } });
    expect(draft?.text).toHaveLength(DEVTOOLS_LIMITS.consoleText);
    expect(draft?.stack).toHaveLength(DEVTOOLS_LIMITS.stackFrames);
    expect(draft?.stack[0]?.fn).toBe('(anonymous)');
    expect(consoleFromApi({ type: 'log', args: [str('x')] })?.location).toBeNull();
  });
});

describe('consoleFromException (Runtime.exceptionThrown)', () => {
  it('Uncaught Error: boom — первая строка описания и стек исключения', () => {
    expect(
      consoleFromException({
        exceptionDetails: {
          text: 'Uncaught',
          exception: { type: 'object', subtype: 'error', description: 'Error: boom\n    at tick (app.js:3:9)' },
          stackTrace: { callFrames: [FRAME] },
        },
      }),
    ).toEqual({
      level: 'error',
      origin: 'exception',
      text: 'Uncaught Error: boom',
      location: { url: APP, line: 10, column: 5 },
      stack: [{ fn: 'save', url: APP, line: 10, column: 5 }],
    });
  });

  it('отказ промиса и брошенная строка', () => {
    expect(
      consoleFromException({ exceptionDetails: { text: 'Uncaught (in promise)', exception: { type: 'object', subtype: 'error', description: 'Error: nope' } } }).text,
    ).toBe('Uncaught (in promise) Error: nope');
    expect(consoleFromException({ exceptionDetails: { text: 'Uncaught', exception: str('oops') } }).text).toBe('Uncaught oops');
  });

  it('текст CDP уже с сообщением — без повтора; без стека — место из url исключения', () => {
    const draft = consoleFromException({
      exceptionDetails: {
        text: 'Uncaught SyntaxError: Unexpected token',
        url: APP,
        lineNumber: 4,
        columnNumber: 2,
        exception: { type: 'object', subtype: 'error', description: 'SyntaxError: Unexpected token' },
      },
    });
    expect(draft.text).toBe('Uncaught SyntaxError: Unexpected token');
    expect(draft.location).toEqual({ url: APP, line: 5, column: 3 });
  });
});

describe('consoleFromLog (Log.entryAdded)', () => {
  it('«Failed to load resource» сети — origin network', () => {
    expect(
      consoleFromLog({
        entry: {
          source: 'network',
          level: 'error',
          text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
          url: 'http://localhost:5173/api',
        },
      }),
    ).toEqual({
      level: 'error',
      origin: 'network',
      text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
      location: { url: 'http://localhost:5173/api', line: 1, column: 1 },
      stack: [],
    });
  });

  it('строка с networkRequestId (CORS) — тоже network; verbose — debug; прочие — browser', () => {
    expect(
      consoleFromLog({ entry: { source: 'javascript', level: 'error', text: 'Access to fetch has been blocked by CORS policy', networkRequestId: '12.3' } }).origin,
    ).toBe('network');
    expect(consoleFromLog({ entry: { source: 'violation', level: 'verbose', text: 'slow handler' } })).toMatchObject({ origin: 'browser', level: 'debug' });
    expect(consoleFromLog({ entry: { source: 'deprecation', level: 'warning', text: 'old API' } })).toMatchObject({ origin: 'browser', level: 'warning' });
  });
});

describe('сеть (спека 3.3, раздел 8)', () => {
  it('networkKind: типы CDP → вид записи; Preflight и незнакомые — other', () => {
    expect(['Document', 'Fetch', 'XHR', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'WebSocket', 'Preflight', 'Ping'].map(networkKind)).toEqual([
      'document',
      'fetch',
      'xhr',
      'script',
      'stylesheet',
      'image',
      'font',
      'media',
      'websocket',
      'other',
      'other',
    ]);
    expect(networkKind(undefined)).toBe('other');
    expect(networkKind('toString')).toBe('other');
  });

  it('headerPairs: пары по порядку, не больше 64, значение до 2 КБ; не объект — пусто', () => {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`x-h${index}`, 'v']));
    expect(headerPairs(many)).toHaveLength(DEVTOOLS_LIMITS.headers);
    expect(headerPairs({ Accept: '*/*', 'X-Long': 'y'.repeat(5000) })).toEqual([
      ['Accept', '*/*'],
      ['X-Long', 'y'.repeat(DEVTOOLS_LIMITS.headerValue)],
    ]);
    expect(headerPairs(null)).toEqual([]);
  });

  it('failureOf: отмена, CORS, блок, сеть — в этом порядке', () => {
    expect(failureOf({ errorText: 'net::ERR_ABORTED', canceled: true, corsErrorStatus: { corsError: 'X' } })).toEqual({ reason: 'canceled', text: 'net::ERR_ABORTED' });
    expect(failureOf({ errorText: 'net::ERR_FAILED', corsErrorStatus: { corsError: 'MissingAllowOriginHeader', failedParameter: '' } })).toEqual({
      reason: 'cors',
      text: 'MissingAllowOriginHeader',
    });
    expect(failureOf({ errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'mixed-content' })).toEqual({ reason: 'blocked', text: 'mixed-content' });
    expect(failureOf({ errorText: 'net::ERR_CONNECTION_REFUSED' })).toEqual({ reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' });
  });

  it('remoteAddress: IPv4 с портом, IPv6 в скобках, без адреса — null', () => {
    expect(remoteAddress({ remoteIPAddress: '127.0.0.1', remotePort: 5173 })).toBe('127.0.0.1:5173');
    expect(remoteAddress({ remoteIPAddress: '::1', remotePort: 5173 })).toBe('[::1]:5173');
    expect(remoteAddress({})).toBeNull();
  });

  it('postDataOf: postData, склейка postDataEntries из base64, без тела — null; предел 64 КБ', () => {
    expect(postDataOf({ postData: '{"a":1}' })).toBe('{"a":1}');
    expect(
      postDataOf({ postDataEntries: [{ bytes: Buffer.from('a=1&').toString('base64') }, { bytes: Buffer.from('b=2').toString('base64') }] }),
    ).toBe('a=1&b=2');
    expect(postDataOf({})).toBeNull();
    expect(postDataOf({ postData: 'z'.repeat(70_000) })).toHaveLength(DEVTOOLS_LIMITS.postData);
  });

  it('clip не оставляет половину суррогатной пары', () => {
    expect(clip('ab😀', 3)).toBe('ab');
    expect(clip('abc', 5)).toBe('abc');
  });
});
