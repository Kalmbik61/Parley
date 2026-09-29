import { describe, expect, it } from 'vitest';
import type { ErrorCode, HostNotice, NoticeKind } from '@harnas/protocol';
import { errorText, noticeText, providerName, S } from './strings.js';

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

/** Все девять видов `NoticeKind` (`packages/protocol/src/types.ts`). */
const NOTICE_KINDS: NoticeKind[] = [
  'map-lock',
  'map-corrupt',
  'hooks-missing',
  'launch-failed',
  'pointer-timeout',
  'pointer-cancelled',
  'resume-failed',
  'resume-limit',
  'trust-wait',
];

/** `notice.text` — заведомо русский, как у хоста (раунд исправлений 1 куска E.1) — чтобы поймать случайную подстановку. */
function hostNotice(kind: NoticeKind, ref: HostNotice['ref'] = null): HostNotice {
  return { kind, ref, text: 'РУССКИЙ_ТЕКСТ_ХОСТА_НЕ_ДОЛЖЕН_ПОПАСТЬ_В_РЕЗУЛЬТАТ', at: '2026-01-01T00:00:00.000Z' };
}

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

// Имя провайдера для строки статуса и тултипов окна (спека 1.1, решение 3): по handoff — «Claude Code» и
// «Codex», прочим — метка хоста. Одна функция: ту же берёт тултип свёрнутой комнаты «2 Claude Code agents».
describe('providerName', () => {
  it('claude — «Claude Code», codex — «Codex», независимо от метки хоста', () => {
    expect(providerName('claude', 'Claude')).toBe('Claude Code');
    expect(providerName('codex', 'OpenAI Codex')).toBe('Codex');
  });

  it('регистр id не важен, как и у значка провайдера', () => {
    expect(providerName('Claude', 'x')).toBe('Claude Code');
    expect(providerName('CODEX', 'x')).toBe('Codex');
  });

  it('прочим провайдерам — метка, которую отдал хост', () => {
    expect(providerName('gemini', 'Gemini CLI')).toBe('Gemini CLI');
  });

  it('пустая метка — сам id, а не пустая строка', () => {
    expect(providerName('gemini', '')).toBe('gemini');
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

// Раунд исправлений 1 куска E.1 (ревью линза A, Critical): HostNotice.text
// хост пишет по-русски и не переводит (сквозное правило) — приходит рантаймом
// по сокету, страж `english-ui` его не ловит. `noticeText` — английский смысл
// по `notice.kind`, параллельно `errorText(code)`.
describe('noticeText', () => {
  it.each(NOTICE_KINDS)('вид %s без ярлыка — непустой английский текст без кириллицы', (kind) => {
    const text = noticeText(hostNotice(kind));
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(CYRILLIC);
  });

  it.each(NOTICE_KINDS)('вид %s не подставляет русский notice.text хоста в результат', (kind) => {
    expect(noticeText(hostNotice(kind))).not.toContain('РУССКИЙ_ТЕКСТ_ХОСТА');
  });

  it('без ярлыка — фраза с большой буквы и точкой', () => {
    expect(noticeText(hostNotice('trust-wait'))).toBe(
      'Not responding since launch — may be waiting for folder trust.',
    );
  });

  it('с ярлыком — ярлык впереди через двоеточие, без кириллицы', () => {
    const ref = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-03' };
    const text = noticeText(hostNotice('trust-wait', ref), 'S03 backend');
    expect(text).toBe('S03 backend: not responding since launch — may be waiting for folder trust.');
    expect(text).not.toMatch(CYRILLIC);
  });

  it('map-lock и map-corrupt (ref: null, без сессии) тоже дают английский текст', () => {
    expect(noticeText(hostNotice('map-lock'))).not.toMatch(CYRILLIC);
    expect(noticeText(hostNotice('map-corrupt'))).not.toMatch(CYRILLIC);
  });
});
