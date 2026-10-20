/** Коды привязки Telegram: рождаются на Mac, живут 10 минут, на диске лежит только sha256 нормализованного кода. */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { PendingLink } from './types.js';

export const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_TTL_MS = 10 * 60_000;
export const LINK_ATTEMPTS = 5;
const LINK_GROUPS = 6;
const LINK_GROUP_SIZE = 4;

/** Новый код вида `ABCD-EFGH-JKLM-NPQR-STUV-WXYZ` и запись для state.json (без самого кода). */
export function createLinkCode(
  now: number,
  random: (max: number) => number = (max) => randomInt(max),
): { code: string; pending: PendingLink } {
  const groups: string[] = [];
  for (let g = 0; g < LINK_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < LINK_GROUP_SIZE; i += 1) group += LINK_ALPHABET[random(LINK_ALPHABET.length)];
    groups.push(group);
  }
  const code = groups.join('-');
  return { code, pending: { codeHash: hashLinkCode(code), expiresAt: new Date(now + LINK_TTL_MS).toISOString(), attempts: 0 } };
}

/** Верхний регистр, без дефисов и пробелов. */
export function normalizeLinkCode(text: string): string {
  return text.toUpperCase().replace(/[-\s]/g, '');
}

export function hashLinkCode(code: string): string {
  return createHash('sha256').update(normalizeLinkCode(code)).digest('hex');
}

export function matchLinkCode(pending: PendingLink, text: string, now: number): 'match' | 'mismatch' | 'expired' {
  if (now >= Date.parse(pending.expiresAt)) return 'expired';
  const actual = Buffer.from(hashLinkCode(text), 'hex');
  const expected = Buffer.from(pending.codeHash, 'hex');
  if (actual.length !== expected.length) return 'mismatch';
  return timingSafeEqual(actual, expected) ? 'match' : 'mismatch';
}

export function deepLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}
