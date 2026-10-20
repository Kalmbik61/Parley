import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENT_ACTIONS,
  AGENT_COOKIE_ACTIONS,
  AGENT_DEFAULTS,
  AGENT_MODIFIERS,
  AGENT_STORAGE_ACTIONS,
  AGENT_VIEWPORT_PRESETS,
  AGENT_INPUT,
  AGENT_VIEWPORT,
  AGENT_LIMITS,
  BROWSER_AGENT_ERROR_CODES,
  BROWSER_AGENT_FEATURE,
  BROWSER_AGENT_OPS,
  browserAgentArgs,
  browserAgentRequest,
  browserAgentResultParams,
} from './browser-agent.js';
import type { BrowserAgentOpEvent, BrowserAgentOpenResult, BrowserAgentOwner } from './browser-agent.js';
import type { EventData } from './events.js';
import * as protocol from './index.js';
import { METHODS } from './methods.js';
import type { Params, Result } from './methods.js';
import { parseIncoming } from './framing.js';

describe('канал агента к браузеру: константы (спека 3.7, 5.1, раздел 8; этап B2)', () => {
  it('возможность окна и операции: чтения C, open, управление D', () => {
    expect(BROWSER_AGENT_FEATURE).toBe('browser-agent');
    expect(BROWSER_AGENT_OPS).toEqual(['tabs', 'console', 'network', 'screenshot', 'open', 'navigate', 'snapshot', 'action', 'wait_for', 'resize', 'evaluate', 'cookies', 'storage', 'downloads']);
  });

  it('одиннадцать кодов: девять прежних, human_busy и stale_ref (спека 5.1)', () => {
    expect([...BROWSER_AGENT_ERROR_CODES].sort()).toEqual([
      'access_denied',
      'bad_request',
      'human_busy',
      'no_tab',
      'not_loopback',
      'stale_ref',
      'tab_hidden',
      'tab_not_loaded',
      'timeout',
      'unsupported',
      'window_not_connected',
    ]);
  });

  it('пределы: 30 с на операцию, 10 с окну на вкладку, 64 КБ на запрос и пределы чтения; ввод агента', () => {
    expect(AGENT_LIMITS).toEqual({
      opMs: 30_000,
      openMs: 10_000,
      requestBytes: 65_536,
      listBytes: 20_480,
      listEntries: 100,
      detailBody: 8192,
      headerValue: 256,
      headers: 40,
      listQuery: 80,
      listStackFrames: 5,
      listEntryText: 1024,
      screenshotLongSide: 1568,
      fullPageViewports: 3,
      panelPages: 5,
      captureReadyMs: 2000,
      captureRetries: 2,
      screenshotBytes: 3_500_000,
      metricsMs: 1500,
      loadMs: 15_000,
      waitMs: 10_000,
      text: 10_000,
      snapshotBytes: 51_200,
      guardTailMs: 2_000,
      settleMs: 300,
      pollMs: 500,
      resizeMs: 2_000,
      clickDotMs: 600,
      badgeOps: 5,
      typingIdleMs: 1_000,
      focusMs: 10_000,
      evalMs: 10_000,
      evalBytes: 20_480,
      storageValue: 8192,
      uploadFiles: 10,
      uploadBytes: 104_857_600,
      downloadBytes: 209_715_200,
      downloads: 20,
      downloadDays: 7,
    });
    expect(AGENT_INPUT).toEqual({ url: 4096, room: 64, pattern: 200, requestId: 200, key: 32, scroll: 10_000, option: 1024, path: 4096, cookieName: 256, cookieValue: 4096, storageKey: 1024 });
    expect(AGENT_DEFAULTS).toEqual({ limit: 50, level: 'error', failedOnly: true, fullPage: false, interactiveOnly: false, values: false });
    expect(AGENT_VIEWPORT).toEqual({ min: 200, maxWidth: 3840, maxHeight: 2400 });
  });

  it('индекс пакета отдаёт имена канала', () => {
    expect(protocol.BROWSER_AGENT_FEATURE).toBe(BROWSER_AGENT_FEATURE);
    expect(protocol.browserAgentArgs).toBe(browserAgentArgs);
    expect(protocol.browserAgentRequest).toBe(browserAgentRequest);
    expect(protocol.browserAgentResultParams).toBe(browserAgentResultParams);
    expect(protocol.AGENT_LIMITS).toBe(AGENT_LIMITS);
    expect(protocol.AGENT_VIEWPORT).toBe(AGENT_VIEWPORT);
  });
});

describe('схема аргументов open', () => {
  const ok = (args: unknown): boolean => browserAgentArgs.open.safeParse(args).success;

  it('url от одного знака до 4096; лишнее поле — в том числе tab и workKey — отказ', () => {
    expect(ok({ url: 'http://localhost:5173/' })).toBe(true);
    expect(ok({ url: 'x'.repeat(4096) })).toBe(true);
    for (const bad of [
      {},
      { url: '' },
      { url: 'x'.repeat(4097) },
      { url: 42 },
      { url: 'http://localhost/', tab: 't1' },
      { url: 'http://localhost/', workKey: '/p w-2' },
    ]) {
      expect(ok(bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it('own и room: булево и id комнаты по отдельности проходят, вместе — отказ (спека 5.1)', () => {
    const url = 'http://localhost:5173/';
    expect(ok({ url, own: true })).toBe(true);
    expect(ok({ url, own: false, room: 'r-01' })).toBe(true);
    expect(ok({ url, room: 'r-01' })).toBe(true);
    expect(ok({ url, own: true, room: 'r-01' })).toBe(false);
    for (const bad of [{ url, own: 'yes' }, { url, room: '' }, { url, room: 'r'.repeat(65) }, { url, room: 7 }]) {
      expect(ok(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('запрос агента: op из списка, args — любые (их проверяет схема операции), лишнее поле — отказ', () => {
    expect(browserAgentRequest.safeParse({ op: 'open', args: { url: 'http://localhost/' } }).success).toBe(true);
    expect(browserAgentRequest.safeParse({ op: 'open' }).success).toBe(true);
    expect(browserAgentRequest.safeParse({ op: 'teleport', args: {} }).success).toBe(false);
    expect(browserAgentRequest.safeParse({ op: 'open', args: {}, extra: 1 }).success).toBe(false);
  });
});

describe('схемы операций чтения', () => {
  const ok = (op: 'tabs' | 'console' | 'network' | 'screenshot', args: unknown): boolean => browserAgentArgs[op].safeParse(args).success;

  it('tabs — пустой объект; лишнее поле — отказ', () => {
    expect(ok('tabs', {})).toBe(true);
    expect(ok('tabs', { tab: 't1' })).toBe(false);
  });

  it('console: tab вида t<n>, level из трёх, pattern до 200, limit 1–100', () => {
    expect(ok('console', { tab: 't1' })).toBe(true);
    expect(ok('console', { tab: 't12', level: 'warning', pattern: 'boom', limit: 100 })).toBe(true);
    for (const bad of [{}, { tab: 'bp-abc123' }, { tab: 't1', level: 'info' }, { tab: 't1', pattern: '' }, { tab: 't1', pattern: 'x'.repeat(201) }, { tab: 't1', limit: 0 }, { tab: 't1', limit: 101 }, { tab: 't1', limit: 1.5 }, { tab: 't1', extra: 1 }]) {
      expect(ok('console', bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('console: after — целое от 0', () => {
    expect(ok('console', { tab: 't1', after: 0 })).toBe(true);
    for (const bad of [{ tab: 't1', after: -1 }, { tab: 't1', after: 1.5 }, { tab: 't1', after: '3' }]) expect(ok('console', bad), JSON.stringify(bad)).toBe(false);
  });

  it('network: failedOnly, urlPattern, limit, requestId', () => {
    expect(ok('network', { tab: 't1', failedOnly: false, urlPattern: '/api', limit: 5, requestId: '1234.56' })).toBe(true);
    expect(ok('network', { tab: 't1', requestId: '' })).toBe(false);
    expect(ok('network', { tab: 't1', failedOnly: 'yes' })).toBe(false);
  });

  it('screenshot: ширина и высота в пределах Custom, fullPage', () => {
    expect(ok('screenshot', { tab: 't1' })).toBe(true);
    expect(ok('screenshot', { tab: 't1', width: 375, height: 812, fullPage: true })).toBe(true);
    for (const bad of [{ tab: 't1', width: 199 }, { tab: 't1', width: 3841 }, { tab: 't1', height: 2401 }, { tab: 't1', width: 375.5 }]) {
      expect(ok('screenshot', bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('метод browser.agentResult и событие browser.agentOp', () => {
  it('метод в общей таблице; успех и отказ с кодом из списка; opId обязателен', () => {
    expect(METHODS['browser.agentResult']).toBe(browserAgentResultParams);
    const parse = (params: unknown): boolean => browserAgentResultParams.safeParse(params).success;
    expect(parse({ opId: 'op-1', ok: true, result: { tab: 't1', url: 'http://localhost/', reused: false, notes: [] } })).toBe(true);
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'not_loopback', message: 'Only localhost.' } })).toBe(true);
    // Код окна другой сборки хост принимает и сам приводит к `unsupported`: схема не должна терять ответ.
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'boom', message: 'x' } })).toBe(true);
    expect(parse({ opId: 'op-1', ok: false, error: { code: '', message: 'x' } })).toBe(false);
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'c'.repeat(65), message: 'x' } })).toBe(false);
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'timeout', message: 'x'.repeat(10_001) } })).toBe(false);
    expect(parse({ opId: '', ok: true, result: null })).toBe(false);
    expect(parse({ ok: true, result: null })).toBe(false);
    expect(parse({ opId: 'op-1', ok: true, result: null, extra: 1 })).toBe(false);
  });

  it('хост принимает вызов по общему разбору кадров: params проходят схему метода', () => {
    const line = { id: 7, method: 'browser.agentResult', params: { opId: 'op-1', ok: false, error: { code: 'timeout', message: 'x' } } };
    expect(parseIncoming(line)).toMatchObject({ kind: 'request', message: { method: 'browser.agentResult' } });
    expect(parseIncoming({ ...line, params: { opId: 'op-1' } })).toMatchObject({ kind: 'invalid' });
  });

  it('типы: параметры метода, ответ и событие', () => {
    expectTypeOf<Result<'browser.agentResult'>>().toEqualTypeOf<{ accepted: boolean }>();
    expectTypeOf<EventData<'browser.agentOp'>>().toEqualTypeOf<BrowserAgentOpEvent>();
    expectTypeOf<Params<'browser.agentResult'>>().toMatchTypeOf<{ opId: string }>();
    expectTypeOf<BrowserAgentOpenResult>().toEqualTypeOf<{ tab: string; owner: BrowserAgentOwner; url: string; reused: boolean; loaded: boolean; title: string; notes: string[] }>();
    expectTypeOf<BrowserAgentOpEvent['owners']>().toEqualTypeOf<BrowserAgentOwner[]>();
  });
});

describe('операции управления (этап D)', () => {
  const ok = (op: keyof typeof browserAgentArgs, args: unknown): boolean => browserAgentArgs[op].safeParse(args).success;
  const bad = (op: keyof typeof browserAgentArgs, list: unknown[]): void => {
    for (const args of list) expect(ok(op, args), JSON.stringify(args).slice(0, 80)).toBe(false);
  };

  it('списки действий, модификаторов, пресетов, действий кук и хранилища', () => {
    expect(AGENT_ACTIONS).toEqual(['click', 'double_click', 'hover', 'type', 'press', 'scroll', 'select', 'check', 'uncheck', 'drag', 'upload']);
    expect(AGENT_MODIFIERS).toEqual(['Alt', 'Control', 'Meta', 'Shift']);
    expect(AGENT_VIEWPORT_PRESETS).toEqual(['mobile-s', 'mobile-m', 'mobile-l', 'tablet', 'laptop', 'desktop']);
    expect(AGENT_COOKIE_ACTIONS).toEqual(['list', 'set', 'delete']);
    expect(AGENT_STORAGE_ACTIONS).toEqual(['list', 'get', 'set', 'delete', 'clear']);
  });

  it('navigate: ровно одно из url, back, forward, reload; hard — только с reload', () => {
    for (const args of [{ tab: 't1', url: '/settings' }, { tab: 't1', url: 'https://example.com/' }, { tab: 't1', back: true }, { tab: 't1', forward: true }, { tab: 't1', reload: true, hard: true }]) {
      expect(ok('navigate', args), JSON.stringify(args)).toBe(true);
    }
    bad('navigate', [{ tab: 't1' }, { tab: 't1', url: '/a', back: true }, { tab: 't1', back: false }, { tab: 't1', url: '/a', hard: true }, { url: '/a' }, { tab: 't1', url: `/${'x'.repeat(4096)}` }]);
  });

  it('snapshot: interactiveOnly — boolean', () => {
    expect(ok('snapshot', { tab: 't1' })).toBe(true);
    expect(ok('snapshot', { tab: 't1', interactiveOnly: true })).toBe(true);
    bad('snapshot', [{ tab: 't1', interactiveOnly: 'yes' }, { tab: 't1', ref: 'e1' }]);
  });

  it('action: цель, текст, клавиша, прокрутка, выбор, перетаскивание, файлы', () => {
    for (const args of [
      { tab: 't1', action: 'click', ref: 'e12' },
      { tab: 't1', action: 'double_click', x: 10.5, y: 20 },
      { tab: 't1', action: 'type', text: 'hello', submit: true },
      { tab: 't1', action: 'type', ref: 'e3', text: 'hello' },
      { tab: 't1', action: 'press', key: 'a', modifiers: ['Meta'] },
      { tab: 't1', action: 'scroll', direction: 'down', amount: 400 },
      { tab: 't1', action: 'select', ref: 'e4', value: 'Blue' },
      { tab: 't1', action: 'check', ref: 'e5' },
      { tab: 't1', action: 'uncheck', ref: 'e5' },
      { tab: 't1', action: 'drag', ref: 'e6', toRef: 'e7' },
      { tab: 't1', action: 'drag', x: 1, y: 2, toX: 300, toY: 2 },
      { tab: 't1', action: 'upload', ref: 'e8', files: ['/tmp/a.png'] },
    ]) {
      expect(ok('action', args), JSON.stringify(args)).toBe(true);
    }
    bad('action', [
      { tab: 't1', action: 'click' },
      { tab: 't1', action: 'click', x: 10 },
      { tab: 't1', action: 'click', ref: 'e1', x: 1, y: 2 },
      { tab: 't1', action: 'click', ref: 'button' },
      { tab: 't1', action: 'type' },
      { tab: 't1', action: 'press' },
      { tab: 't1', action: 'scroll' },
      { tab: 't1', action: 'select', ref: 'e4' },
      { tab: 't1', action: 'select', value: 'Blue' },
      { tab: 't1', action: 'check' },
      { tab: 't1', action: 'drag', ref: 'e6' },
      { tab: 't1', action: 'drag', ref: 'e6', toX: 1 },
      { tab: 't1', action: 'upload', ref: 'e8' },
      { tab: 't1', action: 'upload', files: ['/tmp/a.png'] },
      { tab: 't1', action: 'upload', ref: 'e8', files: [] },
      { tab: 't1', action: 'upload', ref: 'e8', files: Array.from({ length: 11 }, (_, i) => `/tmp/${i}`) },
      { tab: 't1', action: 'upload', ref: 'e8', files: ['relative/a.png'] },
      { tab: 't1', action: 'evaluate', ref: 'e1' },
      { tab: 't1', action: 'press', key: 'a', modifiers: ['Hyper'] },
      { tab: 't1', action: 'type', text: 'x'.repeat(10_001) },
      { tab: 't1', action: 'click', x: -1, y: 0 },
      { tab: 't1', action: 'scroll', direction: 'down', amount: 0 },
    ]);
  });

  it('wait_for: ровно одно из text, gone, ms; ms до 10 000', () => {
    for (const args of [{ tab: 't1', text: 'Saved' }, { tab: 't1', gone: 'Loading' }, { tab: 't1', ms: 10_000 }]) expect(ok('wait_for', args)).toBe(true);
    bad('wait_for', [{ tab: 't1' }, { tab: 't1', text: 'a', ms: 5 }, { tab: 't1', ms: 10_001 }, { tab: 't1', text: '' }]);
  });

  it('resize: пресет (rotated — только с ним), width и height вместе, или fit', () => {
    for (const args of [{ tab: 't1', preset: 'mobile-m' }, { tab: 't1', preset: 'tablet', rotated: true }, { tab: 't1', width: 500, height: 700 }, { tab: 't1', fit: true }]) {
      expect(ok('resize', args), JSON.stringify(args)).toBe(true);
    }
    bad('resize', [{ tab: 't1' }, { tab: 't1', preset: 'phone' }, { tab: 't1', width: 500 }, { tab: 't1', preset: 'laptop', fit: true }, { tab: 't1', width: 500, height: 700, rotated: true }, { tab: 't1', width: 199, height: 700 }]);
  });

  it('screenshot: ref — снимок элемента; ref вместе с fullPage — отказ', () => {
    expect(ok('screenshot', { tab: 't1', ref: 'e4' })).toBe(true);
    expect(ok('screenshot', { tab: 't1', ref: 'e4', width: 375, height: 812 })).toBe(true);
    bad('screenshot', [{ tab: 't1', ref: 'e4', fullPage: true }]);
  });

  it('evaluate: ровно одно из expression и function; ref — только с function', () => {
    for (const args of [{ tab: 't1', expression: 'document.title' }, { tab: 't1', function: '() => 1' }, { tab: 't1', function: '(el) => el.value', ref: 'e3' }]) {
      expect(ok('evaluate', args), JSON.stringify(args)).toBe(true);
    }
    bad('evaluate', [{ tab: 't1' }, { tab: 't1', expression: '1', function: '() => 1' }, { tab: 't1', expression: '1', ref: 'e3' }, { tab: 't1', expression: '' }, { tab: 't1', expression: 'x'.repeat(10_001) }]);
  });

  it('cookies: адрес и домен не принимаются — только страница агента (Фокус ревью 4)', () => {
    for (const args of [
      { tab: 't1', action: 'list' },
      { tab: 't1', action: 'list', values: true },
      { tab: 't1', action: 'set', name: 'theme', value: 'dark', path: '/', secure: true, httpOnly: false, sameSite: 'lax', expires: 1_900_000_000 },
      { tab: 't1', action: 'delete', name: 'theme' },
    ]) {
      expect(ok('cookies', args), JSON.stringify(args)).toBe(true);
    }
    bad('cookies', [
      { tab: 't1', action: 'list', url: 'https://github.com/' },
      { tab: 't1', action: 'set', name: 'a', value: 'b', domain: '.github.com' },
      { tab: 't1', action: 'set', name: 'a' },
      { tab: 't1', action: 'delete' },
      { tab: 't1', action: 'delete', name: 'a', values: true },
      { tab: 't1', action: 'list', path: '/' },
      { tab: 't1', action: 'set', name: 'a', value: 'b', path: 'no-slash' },
      { tab: 't1', action: 'set', name: 'a', value: 'b', sameSite: 'none' },
    ]);
  });

  it('storage: area и действие; get и delete — с key, set — с key и value, list и clear — без них', () => {
    for (const args of [
      { tab: 't1', area: 'local', action: 'list' },
      { tab: 't1', area: 'session', action: 'get', key: 'token' },
      { tab: 't1', area: 'local', action: 'set', key: 'theme', value: '' },
      { tab: 't1', area: 'local', action: 'delete', key: 'theme' },
      { tab: 't1', area: 'local', action: 'clear' },
    ]) {
      expect(ok('storage', args), JSON.stringify(args)).toBe(true);
    }
    bad('storage', [{ tab: 't1', action: 'list' }, { tab: 't1', area: 'indexeddb', action: 'list' }, { tab: 't1', area: 'local', action: 'get' }, { tab: 't1', area: 'local', action: 'set', key: 'a' }, { tab: 't1', area: 'local', action: 'clear', key: 'a' }, { tab: 't1', area: 'local', action: 'list', origin: 'https://github.com' }]);
  });

  it('downloads — пустой объект', () => {
    expect(ok('downloads', {})).toBe(true);
    bad('downloads', [{ tab: 't1' }]);
  });

  it('запрос агента принимает все операции этапа D', () => {
    for (const op of ['navigate', 'snapshot', 'action', 'wait_for', 'resize', 'evaluate', 'cookies', 'storage', 'downloads']) {
      expect(browserAgentRequest.safeParse({ op, args: {} }).success, op).toBe(true);
    }
  });
});
