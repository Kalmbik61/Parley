import { describe, expect, it, vi } from 'vitest';
import { applyDarkClass, watchSystemDark } from './appearance.js';

describe('applyDarkClass', () => {
  it('true ставит .dark, false снимает (тест 4)', () => {
    const root = document.createElement('html');

    applyDarkClass(true, root);
    expect(root.classList.contains('dark')).toBe(true);

    applyDarkClass(false, root);
    expect(root.classList.contains('dark')).toBe(false);
  });
});

describe('watchSystemDark', () => {
  it('зовёт колбэк на change подставного matchMedia, отписка снимает слушатель (тест 4)', () => {
    type Listener = (event: { matches: boolean }) => void;
    const listeners = new Set<Listener>();
    const fakeMedia = {
      addEventListener: (_type: string, listener: Listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: Listener) => {
        listeners.delete(listener);
      },
    };
    const original = globalThis.matchMedia;
    globalThis.matchMedia = vi.fn().mockReturnValue(fakeMedia) as unknown as typeof matchMedia;

    try {
      const onChange = vi.fn();
      const unsubscribe = watchSystemDark(onChange);

      expect(listeners.size).toBe(1);
      for (const listener of listeners) listener({ matches: true });
      expect(onChange).toHaveBeenCalledWith(true);

      unsubscribe();
      expect(listeners.size).toBe(0);
    } finally {
      globalThis.matchMedia = original;
    }
  });
});
