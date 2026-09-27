/**
 * Раунд исправлений 1, Minor (`store.ts` `navigate()`): `navigating` не должен
 * залипать `true` навсегда, если операция внутри `back()`/`forward()` бросает
 * исключение. Отдельный файл, а не `store.test.ts`: здесь `layout/tree.ts`
 * подставлен целиком с бросающим `focusTab` — остальные тесты стора
 * полагаются на настоящий, и `vi.mock` в этом файле их не должен касаться
 * (мок в vitest скопирован по файлу теста, не глобален).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./tree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tree.js')>();
  return {
    ...actual,
    focusTab: () => {
      throw new Error('тестовое исключение в focusTab');
    },
  };
});

import type { TabSpec } from '../../shared/layout-types.js';
import { tabId } from './ids.js';
import { emptyLayout, openTab } from './tree.js';
import { EMPTY_HISTORY } from './history.js';
import { useLayoutStore } from './store.js';

function terminalTab(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

beforeEach(() => {
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
});

describe('navigate() — navigating сбрасывается через finally (раунд исправлений 1, Minor)', () => {
  it('back(), бросающий исключение внутри apply(focusTab), всё равно сбрасывает navigating', () => {
    const tab1 = terminalTab('s-01');
    const tab2 = terminalTab('s-02');
    const layout = openTab(emptyLayout(), tab1, 'active');

    useLayoutStore.getState().hydrate('w1', layout);
    useLayoutStore.getState().setActiveWork('w1');
    // Вторая запись истории без focusTab (openTab тоже меняет активную вкладку).
    useLayoutStore.getState().apply('w1', (l) => openTab(l, tab2, 'active'));

    expect(useLayoutStore.getState().entries()).toHaveLength(2);
    expect(useLayoutStore.getState().canBack()).toBe(true);

    expect(() => useLayoutStore.getState().back()).toThrow('тестовое исключение в focusTab');
    expect(useLayoutStore.getState().navigating).toBe(false);
  });
});
