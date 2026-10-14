// packages/desktop/src/renderer/chat/ChatToolbar.test.tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { ChatToolbar } from './ChatToolbar.js';

afterEach(() => {
  cleanup();
  useWorksStore.setState({ entries: [], branches: {}, loading: true, error: null });
  useLayoutStore.setState({ activeWorkKey: null, layouts: {}, hydrated: {}, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
});

describe('ChatToolbar — кнопка микрофона вида Terminal (спека 3.2)', () => {
  it('micTargetId — кнопка микрофона в тулбаре; без него — нет', () => {
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="claude" micTargetId="terminal:x" />);
    expect(screen.getByTestId('mic').dataset.target).toBe('terminal:x');
    rerender(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="claude" />);
    expect(screen.queryByTestId('mic')).toBeNull();
  });
});

describe('ChatToolbar — кнопка «Browser» панели браузера сессии (этап B2, спека браузера 4.11)', () => {
  const KEY = '/tmp/proj w-01';

  function setUp(): void {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-01', 'lead')] })], branches: {}, loading: false, error: null });
    const layout = openTab(emptyLayout(), { kind: 'terminal', id: 'terminal:s-01', sessionId: 's-01' }, 'active');
    useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: layout }, hydrated: { [KEY]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  }

  it('есть в обоих видах; нажата, пока панель открыта; нажатие открывает и прячет панель этой сессии', () => {
    setUp();
    const { rerender } = render(<ChatToolbar workKey={KEY} tabId="terminal:s-01" view="chat" available provider="claude" />);
    const button = screen.getByRole('button', { name: 'Browser' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(useLayoutStore.getState().layouts[KEY]?.panels?.['session:s-01']).toMatchObject({ open: true, pages: [{ url: '' }] });
    expect(screen.getByRole('button', { name: 'Browser' }).getAttribute('aria-pressed')).toBe('true');
    rerender(<ChatToolbar workKey={KEY} tabId="terminal:s-01" view="terminal" available provider="claude" micTargetId="terminal:x" />);
    expect(screen.getByRole('button', { name: 'Browser' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(useLayoutStore.getState().layouts[KEY]?.panels?.['session:s-01']?.open).toBe(false);
  });

  it('вкладки сессии нет в раскладке — кнопки нет: панели не у кого быть', () => {
    render(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" />);
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull();
  });
});
