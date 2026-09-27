/**
 * Раунд исправлений 1 куска 1.3, находка B№3 (линза B, живой рендер): фон
 * старой палитры темы окна на корневом `<div>` заменили на `bg-background`,
 * пару `text-foreground` рядом — забыли (спека 4.9: старая палитра уходит
 * целиком). С куска 1.4 старой палитры в кодовой базе больше нет вовсе (её
 * файлы удалены) — тест переживает это как общую проверку: на корневом
 * `<div>` нет произвольного `var(...)`, только именованные токены.
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
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false, createRoom: null },
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
  it('text-foreground рядом с bg-background, без произвольного var(--…) старой палитры', () => {
    const { container } = render(<App />);
    const root = container.querySelector('.bg-background');
    expect(root).not.toBeNull();
    expect(root?.className).toContain('text-foreground');
    expect(root?.className ?? '').not.toMatch(/var\(--/);
  });
});
