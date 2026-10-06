import { describe, expect, it } from 'vitest';
import { joinTranscript, spliceTranscript } from './insert.js';

describe('вставка расшифровки (спека 3.3, Фокус ревью 1)', () => {
  it('пробел слева — только если перед кареткой не пусто и нет пробела', () => {
    expect(joinTranscript('', 'hello')).toBe('hello');
    expect(joinTranscript('fix ', 'hello')).toBe('hello');
    expect(joinTranscript('fix\n', 'hello')).toBe('hello');
    expect(joinTranscript('fix', 'hello')).toBe(' hello');
  });

  it('середина многострочного текста: правая часть цела, каретка — в конце вставки', () => {
    const value = 'line one\nline two tail';
    const caret = 'line one\nline two'.length;
    expect(spliceTranscript(value, caret, 'inserted')).toEqual({ value: 'line one\nline two inserted tail', caret: caret + ' inserted'.length });
  });

  it('каретка за пределами — в конец', () => {
    expect(spliceTranscript('abc', 99, 'x')).toEqual({ value: 'abc x', caret: 5 });
  });
});
