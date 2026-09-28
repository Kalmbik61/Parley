/**
 * Стор ревью (кусок 8.2a, тест 9) — модуль-синглтон zustand, как и стор раскладки:
 * оба сбрасываются в `beforeEach`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TabSpec } from '../../shared/layout-types.js';
import { bufferKey } from '../files/buffer.js';
import { tabId } from '../layout/ids.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout, openTab } from '../layout/tree.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { bindReviewToLayout, changesSessionOf, useReviewStore } from './store.js';

const A = '/tmp/proj w-a';
const B = '/tmp/proj w-b';

function terminalTab(sessionId: string): TabSpec {
  return { kind: 'terminal', id: tabId.terminal(sessionId), sessionId };
}

let unbind: (() => void) | null = null;

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
  useReviewStore.setState({ changesSession: {}, revealed: {} });
});

afterEach(() => {
  unbind?.();
  unbind = null;
});

describe('review/store (кусок 8.2a, тест 9)', () => {
  it('выбор S03 в работе A, смена активной работы на B → выбора A нет', () => {
    unbind = bindReviewToLayout();
    useLayoutStore.getState().setActiveWork(A);
    useReviewStore.getState().selectChangesSession(A, 's-03');
    useReviewStore.getState().selectChangesSession(B, 's-01');
    expect(useReviewStore.getState().changesSession[A]).toBe('s-03');
    useLayoutStore.getState().setActiveWork(B);
    expect(useReviewStore.getState().changesSession[A]).toBeUndefined();
    // Выбор работы, в которую пришли, не трогается.
    expect(useReviewStore.getState().changesSession[B]).toBe('s-01');
  });

  it('после отписки смена работы выбор не стирает', () => {
    const off = bindReviewToLayout();
    useLayoutStore.getState().setActiveWork(A);
    useReviewStore.getState().selectChangesSession(A, 's-03');
    off();
    useLayoutStore.getState().setActiveWork(B);
    expect(useReviewStore.getState().changesSession[A]).toBe('s-03');
  });

  it('changesSessionOf: выбор, пока сессия в карте; пропала — focusedSessionOf', () => {
    const layout = openTab(emptyLayout(), terminalTab('s-02'));
    const layoutState = { layouts: { [A]: layout }, entries: () => [{ workKey: A, tabId: tabId.terminal('s-02'), at: 0 }] };
    const both = makeWork('w-a', { sessions: [makeSession('s-02', 'S02'), makeSession('s-03', 'S03')] });
    const review = { changesSession: { [A]: 's-03' } };
    expect(changesSessionOf(review, layoutState, A, both)).toBe('s-03');
    const gone = makeWork('w-a', { sessions: [makeSession('s-02', 'S02')] });
    expect(changesSessionOf(review, layoutState, A, gone)).toBe('s-02');
    expect(changesSessionOf({ changesSession: {} }, layoutState, A, both)).toBe('s-02');
  });

  it('revealFile дважды с тем же путём — nonce вырос; ключ — bufferKey', () => {
    const id = tabId.diff('s-02', null);
    useReviewStore.getState().revealFile(A, id, 'src/a.ts');
    const first = useReviewStore.getState().revealed[bufferKey(A, id)];
    useReviewStore.getState().revealFile(A, id, 'src/a.ts');
    const second = useReviewStore.getState().revealed[bufferKey(A, id)];
    expect(first?.path).toBe('src/a.ts');
    expect(second?.path).toBe('src/a.ts');
    expect(second!.nonce).toBeGreaterThan(first!.nonce);
    // Тот же id вкладки у другой работы — своя запись.
    expect(useReviewStore.getState().revealed[bufferKey(B, id)]).toBeUndefined();
  });
});
