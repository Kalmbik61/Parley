import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENT_INPUT,
  AGENT_LIMITS,
  BROWSER_AGENT_ERROR_CODES,
  BROWSER_AGENT_FEATURE,
  BROWSER_AGENT_OPS,
  browserAgentArgs,
  browserAgentRequest,
  browserAgentResultParams,
} from './browser-agent.js';
import type { BrowserAgentOpEvent, BrowserAgentOpenResult } from './browser-agent.js';
import type { EventData } from './events.js';
import * as protocol from './index.js';
import { METHODS } from './methods.js';
import type { Params, Result } from './methods.js';
import { parseIncoming } from './framing.js';

describe('канал агента к браузеру: константы (спека 3.7, 5.1, раздел 8; этап B2)', () => {
  it('возможность окна и единственная операция B2', () => {
    expect(BROWSER_AGENT_FEATURE).toBe('browser-agent');
    expect(BROWSER_AGENT_OPS).toEqual(['open']);
  });

  it('B2 отдаёт шесть кодов спеки 5.1', () => {
    expect([...BROWSER_AGENT_ERROR_CODES].sort()).toEqual([
      'access_denied',
      'bad_request',
      'not_loopback',
      'timeout',
      'unsupported',
      'window_not_connected',
    ]);
  });

  it('пределы: 30 с на операцию, 10 с окну на вкладку, 64 КБ на запрос; адрес до 4096 знаков', () => {
    expect(AGENT_LIMITS).toEqual({ opMs: 30_000, openMs: 10_000, requestBytes: 65_536 });
    expect(AGENT_INPUT).toEqual({ url: 4096 });
  });

  it('индекс пакета отдаёт имена канала', () => {
    expect(protocol.BROWSER_AGENT_FEATURE).toBe(BROWSER_AGENT_FEATURE);
    expect(protocol.browserAgentArgs).toBe(browserAgentArgs);
    expect(protocol.browserAgentRequest).toBe(browserAgentRequest);
    expect(protocol.browserAgentResultParams).toBe(browserAgentResultParams);
    expect(protocol.AGENT_LIMITS).toBe(AGENT_LIMITS);
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

  it('запрос агента: op из списка, args — любые (их проверяет схема операции), лишнее поле — отказ', () => {
    expect(browserAgentRequest.safeParse({ op: 'open', args: { url: 'http://localhost/' } }).success).toBe(true);
    expect(browserAgentRequest.safeParse({ op: 'open' }).success).toBe(true);
    expect(browserAgentRequest.safeParse({ op: 'evaluate', args: {} }).success).toBe(false);
    expect(browserAgentRequest.safeParse({ op: 'open', args: {}, extra: 1 }).success).toBe(false);
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
    expectTypeOf<BrowserAgentOpenResult>().toEqualTypeOf<{ tab: string; url: string; reused: boolean; notes: string[] }>();
  });
});
