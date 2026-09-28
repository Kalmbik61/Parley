import { describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { applyDarkClass, followAppearance } from './appearance.js';

describe('applyDarkClass', () => {
  it('true ставит .dark, false снимает (тест 4)', () => {
    const root = document.createElement('html');

    applyDarkClass(true, root);
    expect(root.classList.contains('dark')).toBe(true);

    applyDarkClass(false, root);
    expect(root.classList.contains('dark')).toBe(false);
  });
});

// Раунд main-r2, п. 1 (ревью 6.3-B, Important 1): источник истины темы — nativeTheme main, а
// не prefers-color-scheme рендерера: выбор «Theme: dark/light» меняет его, а не медиа-запрос.
describe('followAppearance', () => {
  it('начальное значение — app.isDark() main, дальше — события app:appearance; отписка снимает слушатель', () => {
    const bridge = createFakeBridge();
    bridge.setDark(true);
    const onChange = vi.fn();
    const unsubscribe = followAppearance(bridge, onChange);
    expect(onChange).toHaveBeenLastCalledWith(true);

    bridge.emitAppearance(false);
    expect(onChange).toHaveBeenLastCalledWith(false);

    unsubscribe();
    bridge.emitAppearance(true);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
