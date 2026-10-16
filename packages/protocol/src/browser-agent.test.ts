import { describe, expect, expectTypeOf, it } from 'vitest';
import {
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
  it('возможность окна и операции: чтения C перед open', () => {
    expect(BROWSER_AGENT_FEATURE).toBe('browser-agent');
    expect(BROWSER_AGENT_OPS).toEqual(['tabs', 'console', 'network', 'screenshot', 'open']);
  });

  it('девять кодов: шесть B2 и три чтения C (спека 5.1)', () => {
    expect([...BROWSER_AGENT_ERROR_CODES].sort()).toEqual([
      'access_denied',
      'bad_request',
      'no_tab',
      'not_loopback',
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
      text: 10_000,
      listBytes: 20_480,
      listEntries: 100,
      detailBody: 8192,
      screenshotLongSide: 1568,
      fullPageViewports: 3,
      panelPages: 5,
      captureReadyMs: 2000,
      captureRetries: 2,
      screenshotBytes: 3_500_000,
    });
    expect(AGENT_INPUT).toEqual({ url: 4096, room: 64, pattern: 200, requestId: 200 });
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
    expect(browserAgentRequest.safeParse({ op: 'evaluate', args: {} }).success).toBe(false);
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

  it('network: failedOnly, urlPattern, limit, requestId', () => {
    expect(ok('network', { tab: 't1', failedOnly: false, urlPattern: '/api', limit: 5, requestId: '1234.56' })).toBe(true);
    expect(ok('network', { tab: 't1', requestId: '' })).toBe(false);
    expect(ok('network', { tab: 't1', failedOnly: 'yes' })).toBe(false);
  });

  it('screenshot: ширина и высота в пределах Custom, fullPage; ref — этап D, сейчас отказ', () => {
    expect(ok('screenshot', { tab: 't1' })).toBe(true);
    expect(ok('screenshot', { tab: 't1', width: 375, height: 812, fullPage: true })).toBe(true);
    for (const bad of [{ tab: 't1', width: 199 }, { tab: 't1', width: 3841 }, { tab: 't1', height: 2401 }, { tab: 't1', width: 375.5 }, { tab: 't1', ref: 'e1' }]) {
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
    expect(parse({ opId: 'op-1', ok: false, error: { code: 'boom', message: 'x' } })).toBe(false);
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
    expectTypeOf<BrowserAgentOpenResult>().toEqualTypeOf<{ tab: string; owner: BrowserAgentOwner; url: string; reused: boolean; notes: string[] }>();
    expectTypeOf<BrowserAgentOpEvent['owners']>().toEqualTypeOf<BrowserAgentOwner[]>();
  });
});
