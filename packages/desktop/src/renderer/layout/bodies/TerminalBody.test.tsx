import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { refKey, type SessionRef } from '@parley/protocol';
import { useChatUiStore } from '../../chat/ui-store.js';
import { useLayoutStore } from '../store.js';
import { emptyLayout, findTab, openTab } from '../tree.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { fakeDictationDeps } from '../../test-utils/dictation.js';
import { makeSession } from '../../test-utils/work-fixtures.js';
import { useDictationStore } from '../../voice/dictation-store.js';
import { TerminalBody, type TerminalBodyProps } from './TerminalBody.js';

vi.mock('../../browser/panel/PanelHost.js', () => ({ PanelHost: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../../chat/ChatToolbar.js', () => ({ ChatToolbar: ({ micTargetId }: { micTargetId: string }) => <div data-testid="mic" data-target={micTargetId} /> }));
vi.mock('../../chat/ChatView.js', () => ({ ChatView: () => <div data-testid="chat-view" /> }));
vi.mock('../../lib/feed-view.js', async (original) => ({
  ...await original<typeof import('../../lib/feed-view.js')>(),
  useHostHasFeed: () => true,
  useFeedAvailability: () => () => true,
  useSessionStarted: () => true,
}));

const sessionRef: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };
const key = refKey(sessionRef);
const targetId = `chat-draft:${key}`;
const tab = { kind: 'terminal' as const, id: 't-01', sessionId: 's-01', view: 'terminal' as const };
let unconfigure: () => void;

function props(provider = 'qwen'): TerminalBodyProps {
  const bridge = createFakeBridge();
  return { workKey: 'work', tab, session: makeSession('s-01', '', { provider }), sessionRef, active: true, bridge, sendDeps: { bridge, session: () => null, openSession: vi.fn() } };
}

beforeEach(() => {
  useChatUiStore.setState({ drafts: {} });
  useLayoutStore.setState({ layouts: {}, hydrated: {}, pending: {} });
  useLayoutStore.getState().hydrate('work', openTab(emptyLayout(), tab, 'active'));
  unconfigure = useDictationStore.getState().configure(fakeDictationDeps('dictated text'));
});

afterEach(() => {
  cleanup();
  unconfigure();
});

async function dictate(): Promise<void> {
  await act(async () => {
    await useDictationStore.getState().toggle(targetId);
    await useDictationStore.getState().toggle(targetId);
  });
}

it.each(['qwen', 'claude', 'codex', 'opencode', 'kimi'])('routes the Terminal toolbar microphone for %s', (provider) => {
  render(<TerminalBody {...props(provider)} />);
  expect(screen.getByTestId('mic').getAttribute('data-target')).toBe(`${provider === 'kimi' ? 'terminal' : 'chat-draft'}:${key}`);
});

it.each([['existing', 'existing dictated text'], ['existing\n', 'existing\ndictated text'], ['', 'dictated text']])('appends to the latest draft %j and requests Chat', async (draft, expected) => {
  render(<TerminalBody {...props()} />);
  act(() => useChatUiStore.getState().setDraft(key, draft));
  await dictate();
  expect(useChatUiStore.getState().drafts[key]).toBe(expected);
  const layout = useLayoutStore.getState().layouts.work!;
  const found = findTab(layout, tab.id)!;
  expect(found.group.tabs[found.index]).toMatchObject({ view: 'chat' });
});

it('keeps the target registered across the switch to Chat', async () => {
  const view = render(<TerminalBody {...props()} />);
  view.rerender(<TerminalBody {...props()} tab={{ ...tab, view: 'chat' }} />);
  expect(screen.getByTestId('chat-view')).toBeTruthy();
  await dictate();
  expect(useChatUiStore.getState().drafts[key]).toBe('dictated text');
});

it('unregisters the draft target on unmount', async () => {
  const view = render(<TerminalBody {...props()} />);
  view.unmount();
  await dictate();
  expect(useChatUiStore.getState().drafts[key]).toBeUndefined();
});

it('cleanup preserves a newer registration with the same id', async () => {
  const view = render(<TerminalBody {...props()} />);
  const insert = vi.fn();
  const unregister = useDictationStore.getState().register({ id: targetId, element: () => null, insert });
  view.unmount();
  await dictate();
  expect(insert).toHaveBeenCalledWith('dictated text');
  unregister();
});
