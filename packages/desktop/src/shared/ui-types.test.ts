import { describe, expect, it } from 'vitest';
import { DEFAULT_UI, normalizeUi } from './ui-types.js';

describe('normalizeUi', () => {
  it('пустой объект → DEFAULT_UI', () => {
    expect(normalizeUi({})).toEqual(DEFAULT_UI);
  });

  it('ширина левого сайдбара приводится к пределам 220–500', () => {
    expect(normalizeUi({ leftSidebar: { width: 9999 } }).leftSidebar.width).toBe(500);
    expect(normalizeUi({ leftSidebar: { width: 10 } }).leftSidebar.width).toBe(220);
  });

  it('неизвестный appearance → system', () => {
    expect(normalizeUi({ appearance: 'blue' }).appearance).toBe('system');
  });

  it('лишний ключ верхнего уровня выкинут', () => {
    const result = normalizeUi({ mystery: 'value' }) as UiFileWithMystery;
    expect(result.mystery).toBeUndefined();
    expect(result).toEqual(DEFAULT_UI);
  });
});

interface UiFileWithMystery {
  mystery?: unknown;
}
