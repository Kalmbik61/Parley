import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { S } from '../../shared/strings.js';
// packages/desktop/src/renderer/chat/ChatToolbar.test.tsx
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { ChatToolbar } from './ChatToolbar.js';

afterEach(() => {
  cleanup();
  useHostStore.setState({ status: { state: 'connecting' } });
  useProvidersStore.setState({ providers: [], loaded: false });
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

describe('ChatToolbar — где человек: тег и ярлык сессии по центру', () => {
  const KEY = '/tmp/proj w-01';

  function setUp(label: string): void {
    useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-38', label)] })], branches: {}, loading: false, error: null });
    const layout = openTab(emptyLayout(), { kind: 'terminal', id: 'terminal:s-38', sessionId: 's-38' }, 'active');
    useLayoutStore.setState({ activeWorkKey: KEY, layouts: { [KEY]: layout }, hydrated: { [KEY]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  }

  it('подпись как в сайдбаре в обоих видах, полный текст в подсказке; переименование обновляет её', () => {
    setUp('УЛУЧШАЙЗИНГ-ЛИД');
    const { rerender } = render(<ChatToolbar workKey={KEY} tabId="terminal:s-38" view="chat" available provider="claude" />);
    const title = screen.getByTestId('chat-toolbar-title');
    expect(title.textContent).toBe('S38 УЛУЧШАЙЗИНГ-ЛИД');
    expect(title.title).toBe('S38 УЛУЧШАЙЗИНГ-ЛИД');
    // Обрезка многоточием и только свободное место: соседей подпись не теснит.
    expect(title.className).toContain('truncate');
    expect(title.className).toContain('min-w-0');
    expect(title.className).toContain('flex-1');
    rerender(<ChatToolbar workKey={KEY} tabId="terminal:s-38" view="terminal" available provider="claude" />);
    expect(screen.getByTestId('chat-toolbar-title').textContent).toBe('S38 УЛУЧШАЙЗИНГ-ЛИД');

    act(() => {
      useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-38', 'новое имя')] })] });
    });
    expect(screen.getByTestId('chat-toolbar-title').textContent).toBe('S38 новое имя');
    expect(screen.getByTestId('chat-toolbar-title').title).toBe('S38 новое имя');
  });

  it('вкладки сессии нет в раскладке — подписи нет, место остаётся пустым', () => {
    render(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" />);
    const title = screen.getByTestId('chat-toolbar-title');
    expect(title.textContent).toBe('');
    expect(title.hasAttribute('title')).toBe(false);
  });
});

describe('ChatToolbar — расход токенов сессии (спека расхода токенов, 3.4)', () => {
  it('metrics — значок в тулбаре; без них — нет', () => {
    const metrics = { tokensIn: 10, tokensOut: 2, durationMs: null, unread: 0, subagents: 0, model: null };
    const { rerender } = render(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={metrics} />);
    expect(screen.getByTestId('chat-usage-chip').textContent).toBe('↑10 ↓2');
    rerender(<ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={null} />);
    expect(screen.queryByTestId('chat-usage-chip')).toBeNull();
  });
});

describe('ChatToolbar — чип контекста сессии (спека 2026-10-15, 3.4)', () => {
  it('contextChip — рядом со значком расхода (спека 2026-10-15, 3.4)', () => {
    const metrics = { tokensIn: 10, tokensOut: 2, durationMs: null, unread: 0, subagents: 0, model: null };
    render(
      <ChatToolbar workKey="k" tabId="t" view="chat" available provider="claude" metrics={metrics} contextChip={<span data-testid="ctx">62%</span>} />,
    );
    const usage = screen.getByTestId('chat-usage-chip');
    const chip = screen.getByTestId('ctx');
    expect(usage.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});


describe('ChatToolbar availability explanation', () => {
  it.each([
    [null, ['feed-codex'], S.chat.versionUnknown],
    ['0.159.0', ['feed-codex'], S.chat.terminalOnlyFor('codex')],
    ['0.162.0', [], S.chat.hostFeedUnsupported],
  ] as const)('explains version %s with features %s', (version, features, title) => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.16.0', methods: ['feed.snapshot'], features: [...features] } });
    useProvidersStore.setState({ providers: [{ id: 'codex', label: 'Codex', available: true, version, limits: null }], loaded: true });
    render(<ChatToolbar workKey="k" tabId="t" view="terminal" available={false} provider="codex" />);
    expect(screen.getByTitle(title).contains(screen.getByText('Chat'))).toBe(true);
    expect((screen.getByText('Chat') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables supported Chat without a warning tooltip', () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.16.0', methods: ['feed.snapshot'], features: ['feed-codex'] } });
    useProvidersStore.setState({ providers: [{ id: 'codex', label: 'Codex', available: true, version: '0.162.0', limits: null }], loaded: true });
    render(<ChatToolbar workKey="k" tabId="t" view="terminal" available provider="codex" />);
    expect((screen.getByText('Chat') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Chat').closest('[title]')).toBeNull();
  });
});
