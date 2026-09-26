import { describe, expect, it } from 'vitest';
import { noticeTitle, sessionRowLabel } from './participant.js';

describe('sessionRowLabel', () => {
  it('s-03 → S03, склеивается с ярлыком', () => {
    expect(sessionRowLabel('s-03', 'бэкенд')).toBe('S03 бэкенд');
  });

  it('пустой ярлык — только тег', () => {
    expect(sessionRowLabel('s-01', '')).toBe('S01');
  });

  it('чужая форма id печатается как есть', () => {
    expect(sessionRowLabel('manual-123', 'ручная')).toBe('manual-123 ручная');
  });
});

describe('noticeTitle', () => {
  it('S03 ждёт ответа', () => {
    expect(noticeTitle('s-03', 'ждёт ответа')).toBe('S03 ждёт ответа');
  });
});
