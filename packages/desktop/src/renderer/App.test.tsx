/**
 * Раунд исправлений 1 куска 1.3, находка B№3 (линза B, живой рендер):
 * `bg-[var(--h-base)]` на корневом `<div>` заменили на `bg-background`,
 * `text-[var(--h-text)]` рядом — забыли (спека 4.9: `--h-*` уходит вместе со
 * старой палитрой). Сейчас у остатка нет видимого эффекта (все реальные
 * текстовые узлы красят себя сами явным классом), но это прямой остаток
 * каталожной темы Catppuccin, который течёт вниз по DOM и расходится с новым
 * фоном при обычной смене темы — закрываем тестом на сам класс.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { App } from './App.js';
import { createFakeBridge } from './test-utils/fake-bridge.js';
import { useActivityStore } from './store/activity.js';
import { useNoticesStore } from './store/notices.js';
import { useUiStore } from './store/ui.js';
import { useWorksStore } from './store/works.js';

// jsdom не знает ResizeObserver — `Workspace.tsx` заводит его на dockview
// безусловно, даже без открытых панелей терминала (тот же стаб, что и в
// `Workspace.test.tsx`).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  useWorksStore.setState({ entries: [], branches: {}, loading: false, error: null });
  useActivityStore.setState({ byRef: {} });
  useNoticesStore.setState({ notices: [] });
  useUiStore.setState({
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false },
    lastSessionByWork: {},
    activePanelId: null,
    visibleSessionRefs: {},
    recentSessionRefs: [],
  });
  // `getHostClient()` читает `window.harnas` лениво — подставляем вручную,
  // как и задумано (комментарий в `host-client.ts`).
  window.harnas = createFakeBridge();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App — корневая обёртка окна (раунд исправлений 1, находка B№3)', () => {
  it('text-foreground рядом с bg-background, без остатка --h-text', () => {
    const { container } = render(<App />);
    const root = container.querySelector('.bg-background');
    expect(root).not.toBeNull();
    expect(root?.className).toContain('text-foreground');
    expect(root?.className).not.toContain('--h-text');
  });
});
