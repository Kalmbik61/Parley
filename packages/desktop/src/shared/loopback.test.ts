import { describe, expect, it } from 'vitest';
import { isLoopbackUrl } from './loopback.js';

describe('isLoopbackUrl (спека 7)', () => {
  it('localhost, *.localhost, 127.0.0.0/8 и [::1] по http и https — loopback', () => {
    for (const url of [
      'http://localhost:5173/',
      'https://localhost/settings?x=1',
      'http://LOCALHOST:3000',
      'http://localhost.:5173/',
      'http://app.localhost:8080/',
      'http://a.b.localhost/',
      'http://127.0.0.1:5173/',
      'http://127.1.2.3/',
      'https://127.255.255.254:8443/x',
      'http://127.1/',
      'http://0x7f.1/',
      'http://[::1]:5173/',
      'http://user:pw@localhost:5173/',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(true);
    }
  });

  it('локальная сеть, 0.0.0.0, чужие и похожие имена, хитрые адреса с @ — не loopback', () => {
    for (const url of [
      'http://192.168.1.10:5173/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://0.0.0.0:5173/',
      'http://128.0.0.1/',
      'https://example.com/',
      'http://localhost.example.com/',
      'http://localhost.evil.test/',
      'http://mylocalhost/',
      'http://127.0.0.1.nip.io/',
      'http://[::2]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost@evil.com/',
      'http://localhost:80@evil.com/',
      'http://127.0.0.1@evil.com/',
    ]) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });

  it('только http и https: file:, ws:, about:blank, data:, javascript: и не адрес — нет', () => {
    for (const url of ['file:///etc/hosts', 'ws://localhost:5173/', 'about:blank', 'data:text/html,x', 'javascript:alert(1)', 'localhost:5173', '/relative', '', 'not a url']) {
      expect(isLoopbackUrl(url), url).toBe(false);
    }
  });
});
