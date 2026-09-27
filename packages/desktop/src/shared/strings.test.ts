import { describe, expect, it } from 'vitest';
import type { ErrorCode } from '@harnas/protocol';
import { errorText, S } from './strings.js';

const CYRILLIC = /[Ѐ-ӿ]/;

/** Все семь кодов протокола (`packages/protocol/src/types.ts#ErrorCode`) плюс наш `'failed'`. */
const PROTOCOL_CODES: ErrorCode[] = [
  'unauthorized',
  'protocol_mismatch',
  'bad_request',
  'unknown_method',
  'not_found',
  'conflict',
  'internal',
];

describe('S.states', () => {
  it('содержит девять слов глоссария (спека 4.2)', () => {
    expect(S.states).toEqual({
      working: 'Working',
      blocked: 'Needs you',
      unseen: 'Done · unseen',
      idle: 'Idle',
      pending: 'Not started',
      asleep: 'Asleep',
      closed: 'Closed',
      done: 'Done',
      failed: 'Failed',
    });
  });

  it('ни одно слово состояния не содержит кириллицы', () => {
    for (const word of Object.values(S.states)) {
      expect(word).not.toMatch(CYRILLIC);
    }
  });
});

describe('errorText', () => {
  it.each(PROTOCOL_CODES)('код протокола %s даёт непустой английский текст', (code) => {
    const text = errorText(code);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(CYRILLIC);
  });

  it.each(PROTOCOL_CODES)('код протокола %s с action тоже без кириллицы', (code) => {
    const text = errorText(code, 'create session');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(CYRILLIC);
    expect(text).toContain('create session');
  });

  it('наш код failed даёт непустой текст', () => {
    expect(errorText('failed').length).toBeGreaterThan(0);
  });

  it('неизвестный код — тот же общий текст, что и failed', () => {
    expect(errorText('no-such-code')).toBe(errorText('failed'));
  });

  it('action встраивается в фразу целиком', () => {
    expect(errorText('conflict', 'merge')).toBe("Couldn't merge: conflicting state.");
  });

  it('без action — только причина с большой буквы', () => {
    expect(errorText('not_found')).toBe('Not found.');
  });
});
