/**
 * Тело вкладки сессии и каркас вида «Chat» (план 2026-10-01, Task 3, подкусок 3a): какой вид рисует
 * `TerminalBody`, сегмент «Chat | Terminal» и временный список ленты.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { FeedItem, WorkSession } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import type { TerminalView } from '../../shared/layout-types.js';
import { TerminalBody } from '../layout/bodies/TerminalBody.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { makeSession } from '../test-utils/work-fixtures.js';
import { resetFeedStoreForTests, useFeedStore } from './store.js';

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' };
const FEED_METHODS = [...REQUIRED_METHODS, 'feed.snapshot', 'feed.subscribe', 'feed.unsubscribe'];

function hostWith(methods: string[]): void {
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods } });
}

function renderBody(session: WorkSession, view?: TerminalView): void {
  const tab = view === undefined
    ? { kind: 'terminal' as const, id: 'terminal:s-01', sessionId: 's-01' }
    : { kind: 'terminal' as const, id: 'terminal:s-01', sessionId: 's-01', view };
  render(<TerminalBody workKey="/tmp/p w-01" tab={tab} session={session} sessionRef={REF} active />);
}

const segment = (name: string): HTMLElement => screen.getByRole('radio', { name });

beforeEach(() => {
  resetFeedStoreForTests();
  hostWith(FEED_METHODS);
  useProvidersStore.setState({ providers: [] });
  useUiStore.setState({ visibleSessionRefs: {} });
});

afterEach(() => {
  cleanup();
  resetFeedStoreForTests();
  useHostStore.setState({ status: { state: 'connecting' } });
  useProvidersStore.setState({ providers: [] });
});

describe('TerminalBody — вид вкладки', () => {
  it('Claude без поля view — ChatView с тулбаром, выбран Chat; сессия видима', () => {
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('chat-view')).toBeTruthy();
    expect(screen.queryByTestId('terminal-body')).toBeNull();
    expect(segment('Chat').getAttribute('aria-checked')).toBe('true');
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('false');
    expect(useUiStore.getState().visibleSessionRefs[refKey(REF)]).toBe(true);
  });

  it('view terminal — заглушка под поверхность с тулбаром, выбран Terminal', () => {
    renderBody(makeSession('s-01', 'S01'), 'terminal');
    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect(segment('Terminal').getAttribute('aria-checked')).toBe('true');
    // Видимость сессии в терминале ставит поверхность, не тело.
    expect(useUiStore.getState().visibleSessionRefs[refKey(REF)]).toBeUndefined();
  });

  it('codex — терминал, сегмент выключен с подсказкой', () => {
    renderBody(makeSession('s-01', 'S01', { provider: 'codex' }), 'chat');
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
    expect((segment('Terminal') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTitle(S.chat.terminalOnly)).toBeTruthy();
  });

  it('старый claude (2.1.280) — терминал с выключенным сегментом', () => {
    useProvidersStore.setState({
      providers: [{ id: 'claude', label: 'Claude Code', available: true, version: '2.1.280', limits: null }],
    });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect((segment('Chat') as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост без feed.snapshot — заглушка без тулбара и сегмента', () => {
    hostWith([...REQUIRED_METHODS]);
    renderBody(makeSession('s-01', 'S01'), 'chat');
    expect(screen.getByTestId('terminal-body')).toBeTruthy();
    expect(screen.queryByTestId('chat-toolbar')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('ChatView — временная область ленты', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const items: FeedItem[] = [
    { id: 'p1', at, kind: 'prompt', text: 'hi', images: 0 },
    {
      id: 'perm1',
      at,
      kind: 'permission',
      cardId: 'c1',
      state: 'pending',
      toolUseId: null,
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      suggestions: [],
      notified: false,
    },
  ];

  it('пока снимка нет — Loading', () => {
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByText(S.chat.loading)).toBeTruthy();
  });

  it('элементы — строкой «kind — id»; ожидающая карточка — «ждёт ответа» без кнопок', () => {
    useFeedStore.setState({ feeds: { [refKey(REF)]: { items, revision: 1, status: 'ready' } } });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByText('prompt — p1')).toBeTruthy();
    expect(screen.getByText('permission — perm1')).toBeTruthy();
    expect(screen.getByText(S.chat.waiting)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ошибка ленты — подсказка открыть терминал', () => {
    useFeedStore.setState({ feeds: { [refKey(REF)]: { items: [], revision: 0, status: 'error', error: 'boom' } } });
    renderBody(makeSession('s-01', 'S01'));
    expect(screen.getByText(S.chat.feedUnavailable)).toBeTruthy();
  });
});
