import { describe, expect, it } from 'vitest';
import {
  DEVTOOLS_LIMITS,
  isFailed,
  isViewportSpec,
  MOBILE_USER_AGENT,
  VIEWPORT_PRESETS,
  viewportSize,
  type NetworkEntry,
} from './browser-devtools.js';

function request(patch: Partial<NetworkEntry>): NetworkEntry {
  return {
    id: 'r1',
    epoch: 0,
    ts: 0,
    method: 'GET',
    url: 'http://localhost:5173/api',
    kind: 'fetch',
    status: 200,
    statusText: 'OK',
    failure: null,
    mimeType: null,
    encodedBytes: null,
    durationMs: null,
    fromCache: false,
    remoteAddress: null,
    requestHeaders: [],
    responseHeaders: [],
    hasPostData: false,
    postData: null,
    ...patch,
  };
}

describe('isFailed (спека 3.4)', () => {
  it('ответ 4xx и 5xx — упал; 2xx и 3xx — нет', () => {
    expect(isFailed(request({ status: 500 }))).toBe(true);
    expect(isFailed(request({ status: 404 }))).toBe(true);
    expect(isFailed(request({ status: 200 }))).toBe(false);
    expect(isFailed(request({ status: 304 }))).toBe(false);
  });

  it('отказ без ответа — упал; отмена и запрос в пути — нет', () => {
    expect(isFailed(request({ status: null, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } }))).toBe(true);
    expect(isFailed(request({ status: null, failure: { reason: 'net', text: 'net::ERR_CONNECTION_REFUSED' } }))).toBe(true);
    expect(isFailed(request({ status: null, failure: { reason: 'blocked', text: 'mixed-content' } }))).toBe(true);
    expect(isFailed(request({ status: null, failure: { reason: 'canceled', text: 'net::ERR_ABORTED' } }))).toBe(false);
    expect(isFailed(request({ status: null }))).toBe(false);
  });

  it('ответ 200 и отказ CORS после него — упал', () => {
    expect(isFailed(request({ status: 200, failure: { reason: 'cors', text: 'MissingAllowOriginHeader' } }))).toBe(true);
  });
});

describe('размеры вьюпорта (спека 4.2)', () => {
  it('пресеты — как в Chrome; мобильные — Mobile S, M, L и Tablet', () => {
    expect(VIEWPORT_PRESETS).toEqual({
      'mobile-s': { width: 320, height: 568, mobile: true },
      'mobile-m': { width: 375, height: 812, mobile: true },
      'mobile-l': { width: 430, height: 932, mobile: true },
      tablet: { width: 768, height: 1024, mobile: true },
      laptop: { width: 1280, height: 800, mobile: false },
      desktop: { width: 1440, height: 900, mobile: false },
    });
  });

  it('viewportSize: пресет, повёрнутый пресет, свой размер', () => {
    expect(viewportSize({ preset: 'mobile-m', rotated: false, dpr: 2 })).toEqual({ width: 375, height: 812, mobile: true, dpr: 2 });
    expect(viewportSize({ preset: 'mobile-m', rotated: true, dpr: 3 })).toEqual({ width: 812, height: 375, mobile: true, dpr: 3 });
    expect(viewportSize({ width: 1024, height: 700, mobile: false, dpr: 1 })).toEqual({ width: 1024, height: 700, mobile: false, dpr: 1 });
  });

  it('мобильный UA — iPhone Safari', () => {
    expect(MOBILE_USER_AGENT).toMatch(/iPhone.*Mobile.*Safari/);
  });
});

describe('isViewportSpec (раскладка и мост)', () => {
  it('верные пресет и свой размер — да', () => {
    expect(isViewportSpec({ preset: 'tablet', rotated: true, dpr: 1 })).toBe(true);
    expect(isViewportSpec({ width: 200, height: 2400, mobile: true, dpr: 3 })).toBe(true);
    expect(isViewportSpec({ width: 3840, height: 200, mobile: false, dpr: 2 })).toBe(true);
  });

  it('чужой пресет, DPR 4, размер вне 200–3840 × 200–2400, дробный, без полей, не объект — нет', () => {
    const bad: unknown[] = [
      { preset: 'phone', rotated: false, dpr: 2 },
      { preset: 'toString', rotated: false, dpr: 2 },
      { preset: 'mobile-m', dpr: 2 },
      { preset: 'mobile-m', rotated: false, dpr: 4 },
      { width: 199, height: 600, mobile: false, dpr: 1 },
      { width: 3841, height: 600, mobile: false, dpr: 1 },
      { width: 800, height: 2401, mobile: false, dpr: 1 },
      { width: 800.5, height: 600, mobile: false, dpr: 1 },
      { width: 800, height: 600, dpr: 1 },
      null,
      'mobile-m',
      [],
    ];
    for (const value of bad) expect(isViewportSpec(value), JSON.stringify(value)).toBe(false);
  });
});

describe('DEVTOOLS_LIMITS (спека, раздел 8)', () => {
  it('числа таблицы', () => {
    expect(DEVTOOLS_LIMITS).toEqual({
      consoleEntries: 1000,
      networkEntries: 500,
      consoleText: 10_000,
      stackFrames: 20,
      url: 4096,
      headers: 64,
      headerValue: 2048,
      postData: 65_536,
      panelBody: 1_048_576,
      batchMs: 150,
      batchMax: 200,
      resourceBuffer: 5_242_880,
      totalBuffer: 52_428_800,
      customMin: 200,
      customMaxWidth: 3840,
      customMaxHeight: 2400,
    });
  });
});
