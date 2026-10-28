/** Тема иконки роя (спека роя v1, 7.5): берётся из флага тёмности окна в сторе. */

import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useUiStore } from '../store/ui.js';
import { useSwarmIconTheme } from './use-swarm-icon-theme.js';

afterEach(() => {
  act(() => useUiStore.getState().setDark(false));
});

describe('useSwarmIconTheme', () => {
  it('light у светлого окна, dark у тёмного, следует за сменой темы', () => {
    act(() => useUiStore.getState().setDark(false));
    const { result } = renderHook(() => useSwarmIconTheme());
    expect(result.current).toBe('light');
    act(() => useUiStore.getState().setDark(true));
    expect(result.current).toBe('dark');
  });
});
