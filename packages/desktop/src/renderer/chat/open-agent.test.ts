/**
 * «Открыть» строку поповера агентов (кусок 4b плана 2026-10-01): вкладка сессии открывается обычным переходом окна,
 * вид вкладки — «Chat», просьба показать карточку агента ставится в `ui-store.ts`; сессии уже нет — тост, как у клика по
 * уведомлению, без просьбы.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { WorkEntry } from '@parley/core';
import { refKey, type SessionRef } from '@parley/protocol';
import type { TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { S } from '../../shared/strings.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { useWorksStore } from '../store/works.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { openAgentCard } from './open-agent.js';
import { resetChatUiStoreForTests, useChatUiStore } from './ui-store.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const REF: SessionRef = { projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' };
const KEY = '/tmp/p w-01';
const OTHER_KEY = '/tmp/p w-02';

const entries = (): WorkEntry[] => [
  makeWork('w-01', { projectPath: '/tmp/p', sessions: [makeSession('s-01', 'one'), makeSession('s-02', 'two')] }),
  makeWork('w-02', { projectPath: '/tmp/p', sessions: [makeSession('s-01', 'other')] }),
];

function layoutOf(tabs: TabSpec[], activeTabId: string | null = tabs[0]?.id ?? null): WorkLayout {
  return { root: { type: 'group', id: 'g1', tabs, activeTabId }, activeGroupId: 'g1', closedTabs: [] };
}

function setLayouts(layouts: Record<string, WorkLayout>, activeWorkKey: string): void {
  useLayoutStore.setState({
    activeWorkKey,
    layouts,
    hydrated: Object.fromEntries(Object.keys(layouts).map((key) => [key, true as const])),
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
}

const tabOf = (key: string, id: string): TabSpec | undefined =>
  groups(useLayoutStore.getState().layouts[key]!).flatMap((group) => group.tabs).find((tab) => tab.id === id);
const activeTabOf = (key: string): string | null => groups(useLayoutStore.getState().layouts[key]!)[0]?.activeTabId ?? null;

beforeEach(() => {
  // Ожидание показа вкладки (`whenShown`) опрашивает DOM до двух секунд — в тесте оно не нужно.
  vi.useFakeTimers();
  vi.mocked(toast).mockClear();
  resetChatUiStoreForTests();
  useWorksStore.setState({ entries: entries(), branches: {}, loading: false, error: null });
  setLayouts({ [KEY]: layoutOf([{ kind: 'mail', id: 'mail' }]), [OTHER_KEY]: layoutOf([]) }, OTHER_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  resetChatUiStoreForTests();
  useWorksStore.setState(useWorksStore.getInitialState(), true);
});

describe('openAgentCard', () => {
  it('вкладки сессии не было: работа становится активной, вкладка открыта и в фокусе, вид — Chat, просьба поставлена', () => {
    openAgentCard(REF, 'agent-1');
    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
    expect(tabOf(KEY, 'terminal:s-02')).toEqual({ kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02', view: 'chat' });
    expect(activeTabOf(KEY)).toBe('terminal:s-02');
    expect(useChatUiStore.getState().reveal).toMatchObject({ sessionKey: refKey(REF), agentId: 'agent-1' });
    expect(toast).not.toHaveBeenCalled();
  });

  it('человек сам выбрал терминал — вид переключается на Chat: просьба про карточку в ленте', () => {
    const tab: TabSpec = { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02', view: 'terminal' };
    setLayouts({ [KEY]: layoutOf([tab, { kind: 'mail', id: 'mail' }], 'mail') }, KEY);
    openAgentCard(REF, 'agent-1');
    expect(tabOf(KEY, 'terminal:s-02')).toMatchObject({ view: 'chat' });
    // Вкладка уже была открыта, но не активна — фокус на неё.
    expect(activeTabOf(KEY)).toBe('terminal:s-02');
    expect(useChatUiStore.getState().reveal).toMatchObject({ agentId: 'agent-1' });
  });

  it('вкладка уже в виде Chat и активна — всё остаётся, просьба поставлена; повторная просьба — новая (другой nonce)', () => {
    const tab: TabSpec = { kind: 'terminal', id: 'terminal:s-02', sessionId: 's-02', view: 'chat' };
    setLayouts({ [KEY]: layoutOf([tab]) }, KEY);
    openAgentCard(REF, 'agent-1');
    const first = useChatUiStore.getState().reveal!;
    openAgentCard(REF, 'agent-1');
    expect(useChatUiStore.getState().reveal!.nonce).toBeGreaterThan(first.nonce);
    expect(tabOf(KEY, 'terminal:s-02')).toEqual(tab);
  });

  it('раскладка работы ещё не пришла с диска — обе операции ждут её hydrate в очереди и применяются по порядку', () => {
    useLayoutStore.setState({ hydrated: {}, layouts: {}, pending: {}, activeWorkKey: null });
    openAgentCard(REF, 'agent-1');
    expect(useLayoutStore.getState().pending[KEY]).toHaveLength(2);
    useLayoutStore.getState().hydrate(KEY, layoutOf([{ kind: 'mail', id: 'mail' }]));
    expect(tabOf(KEY, 'terminal:s-02')).toMatchObject({ kind: 'terminal', view: 'chat' });
    expect(useChatUiStore.getState().reveal).toMatchObject({ agentId: 'agent-1' });
  });

  it('сессии уже нет — тост «цели нет», раскладка и просьба не тронуты', () => {
    const before = useLayoutStore.getState().layouts;
    openAgentCard({ ...REF, sessionId: 's-99' }, 'agent-1');
    expect(toast).toHaveBeenCalledWith(S.notifications.targetGone);
    expect(useLayoutStore.getState().layouts).toBe(before);
    expect(useLayoutStore.getState().activeWorkKey).toBe(OTHER_KEY);
    expect(useChatUiStore.getState().reveal).toBeNull();
  });
});
