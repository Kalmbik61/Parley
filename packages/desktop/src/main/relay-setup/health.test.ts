import { describe, expect, it } from 'vitest';
import { isPublicIPv4 } from './health.js';

describe('isPublicIPv4', () => {
  it('knows the ranges no certificate can be issued for', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '192.168.0.1', '172.16.0.1', '172.31.255.1', '100.64.0.1', '100.127.1.1', '169.254.9.9', '0.0.0.0', '224.0.0.1', '198.18.0.1']) expect(isPublicIPv4(ip)).toBe(false);
    for (const ip of ['203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.0.1']) expect(isPublicIPv4(ip)).toBe(true);
  });
});
