import { describe, expect, it } from 'vitest';
import { createLinkCode, deepLink, hashLinkCode, LINK_ALPHABET, LINK_TTL_MS, matchLinkCode, normalizeLinkCode } from './link.js';

const NOW = Date.parse('2026-10-20T10:00:00.000Z');

describe('createLinkCode', () => {
  it('формат: 6 групп по 4 знака из алфавита', () => {
    const { code } = createLinkCode(NOW);
    expect(code).toMatch(new RegExp(`^([${LINK_ALPHABET}]{4}-){5}[${LINK_ALPHABET}]{4}$`));
  });
  it('случайность подменяется, запись хранит хеш и срок', () => {
    const { code, pending } = createLinkCode(NOW, () => 0);
    expect(code).toBe('AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    expect(pending).toEqual({ codeHash: hashLinkCode(code), expiresAt: new Date(NOW + LINK_TTL_MS).toISOString(), attempts: 0 });
  });
});

describe('normalizeLinkCode', () => {
  it('верхний регистр, без дефисов и пробелов', () => {
    expect(normalizeLinkCode(' abcd-efgh jklm ')).toBe('ABCDEFGHJKLM');
  });
});

describe('matchLinkCode', () => {
  const { code, pending } = createLinkCode(NOW);
  it('совпадение с другим регистром и без дефисов', () => {
    expect(matchLinkCode(pending, code.toLowerCase().replaceAll('-', ''), NOW + 1000)).toBe('match');
  });
  it('истёкший срок', () => {
    expect(matchLinkCode(pending, code, NOW + LINK_TTL_MS)).toBe('expired');
  });
  it('несовпадение', () => {
    expect(matchLinkCode(pending, 'AAAA-AAAA', NOW + 1000)).toBe('mismatch');
  });
});

describe('deepLink', () => {
  it('ссылка на бота с кодом', () => {
    expect(deepLink('parley_bot', 'ABCD-EFGH')).toBe('https://t.me/parley_bot?start=ABCD-EFGH');
  });
});
