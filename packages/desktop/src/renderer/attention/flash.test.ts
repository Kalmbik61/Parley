/**
 * Тест 16 куска 4.3: вспышка адресует вкладку парой работа + вкладка — id `terminal:s-01`
 * и `mail` одинаковы во всех работах, а `data-tab-id` носит и поверхность терминала.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashTab } from './flash.js';

function tab(workKey: string, tabId: string): HTMLElement {
  const element = document.createElement('div');
  element.setAttribute('role', 'tab');
  element.setAttribute('data-work-key', workKey);
  element.setAttribute('data-tab-id', tabId);
  document.body.append(element);
  return element;
}

describe('flashTab (тест 16 куска 4.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('data-flash на вкладке этой работы 600 мс, потом снят; чужие с тем же id — без него', () => {
    const other = tab('/tmp/b w-02', 'terminal:s-01');
    const target = tab('/tmp/a w-01', 'terminal:s-01');
    const surface = document.createElement('div');
    surface.setAttribute('data-tab-id', 'terminal:s-01');
    document.body.append(surface);

    flashTab('/tmp/a w-01', 'terminal:s-01');
    expect(target.hasAttribute('data-flash')).toBe(true);
    expect(other.hasAttribute('data-flash')).toBe(false);
    expect(surface.hasAttribute('data-flash')).toBe(false);

    vi.advanceTimersByTime(599);
    expect(target.hasAttribute('data-flash')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(target.hasAttribute('data-flash')).toBe(false);
  });

  it('повторная вспышка продлевает, а не снимает раньше времени; вкладки нет — ничего не падает', () => {
    const target = tab('/tmp/a w-01', 'mail');
    flashTab('/tmp/a w-01', 'mail');
    vi.advanceTimersByTime(400);
    flashTab('/tmp/a w-01', 'mail');
    vi.advanceTimersByTime(400);
    expect(target.hasAttribute('data-flash')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(target.hasAttribute('data-flash')).toBe(false);
    expect(() => flashTab('/tmp/none', 'mail')).not.toThrow();
  });
});
