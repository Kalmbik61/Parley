import { describe, expect, it } from 'vitest';
import { normalizeUrl } from './url.js';

describe('normalizeUrl — таблица спеки 12.1 (тест 1 куска 9.1)', () => {
  it('localhost, 127.0.0.1 и [::1] — http://; прочее с точкой — https://; http(s) — как есть', () => {
    expect(normalizeUrl('localhost:3000/x')).toEqual({ ok: true, url: 'http://localhost:3000/x' });
    expect(normalizeUrl('127.0.0.1')).toEqual({ ok: true, url: 'http://127.0.0.1' });
    expect(normalizeUrl('[::1]:3000')).toEqual({ ok: true, url: 'http://[::1]:3000' });
    expect(normalizeUrl('example.com')).toEqual({ ok: true, url: 'https://example.com' });
    expect(normalizeUrl('example.com:8080/x')).toEqual({ ok: true, url: 'https://example.com:8080/x' });
    expect(normalizeUrl('https://a.b/c?d')).toEqual({ ok: true, url: 'https://a.b/c?d' });
    expect(normalizeUrl('  localhost  ')).toEqual({ ok: true, url: 'http://localhost' });
  });

  it('явная схема, кроме http(s) и file, — не адрес, и точка не делает её https://', () => {
    for (const input of [
      'привет мир',
      'javascript:alert(1)',
      'javascript:alert(document.domain)',
      'data:text/html,a.b',
      'mailto:a@b.c',
      'chrome://gpu',
      'about:blank',
      '',
      '   ',
      'localhost:abc',
    ]) {
      expect(normalizeUrl(input), input).toEqual({ ok: false, error: 'not-an-address' });
    }
  });

  it('file: — local-file', () => {
    expect(normalizeUrl('file:///etc/passwd')).toEqual({ ok: false, error: 'local-file' });
    expect(normalizeUrl('FILE:///etc/passwd')).toEqual({ ok: false, error: 'local-file' });
  });
});
