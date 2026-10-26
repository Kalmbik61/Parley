import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { workKey } from '../../shared/work-keys.js';
import { panelRuntimeKey, usePanelRuntime } from '../browser/panel/runtime.js';
import { addPanelPage, setPanelOpen } from '../layout/panels.js';
import { useLayoutStore } from '../layout/store.js';
import { emptyLayout } from '../layout/tree.js';
import { useUiStore } from '../store/ui.js';
import { wireSessionVisibility } from './session-visibility.js';

const A = { projectPath: '/a', workId: 'w-1', sessionId: 's-01' };
const B = { ...A, projectPath: '/b' };
const OWNER = { kind: 'session' as const, sessionId: A.sessionId };
const KEY = workKey(A.projectPath, A.workId);
let dispose: (() => void) | undefined;
function setup() {
  const report = vi.fn();
  let focus: (focused: boolean) => void = () => {};
  const offFocus = vi.fn();
  dispose = wireSessionVisibility({ app: { reportSessionVisibility: report, onWindowFocus: (listener: typeof focus) => { focus = listener; return offFocus; } } } as unknown as ParleyBridge);
  const refs = () => report.mock.calls.at(-1)![0].refs;
  return { report, refs, focus: (value: boolean) => focus(value), offFocus };
}
beforeEach(() => {
  useUiStore.setState({ visibleSessionRefs: { [refKey(A)]: true, [refKey(B)]: true }, documentVisible: true });
  useLayoutStore.setState({ layouts: {} });
  usePanelRuntime.setState({ hosts: {}, usedAt: {}, published: {}, live: new Set() });
});
afterEach(() => { dispose?.(); dispose = undefined; });

describe('quiet Done visibility publisher', () => {
  it('reports only visible split refs, document visibility and increasing sequence; focus republishes', () => {
    const { report, refs, focus } = setup();
    expect(refs()).toEqual([A, B]);
    const firstSeq = report.mock.calls[0]![0].seq;
    focus(true);
    expect(report.mock.calls.at(-1)![0].seq).toBeGreaterThan(firstSeq);
    useUiStore.setState({ documentVisible: false });
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ documentVisible: false }));
    useUiStore.setState({ visibleSessionRefs: { [refKey(B)]: true }, documentVisible: true });
    expect(refs()).toEqual([B]);
  });

  it('open session panel excludes only its exact ref when missing/unmeasured/covering; close/beside restores it', () => {
    const { refs } = setup();
    const layout = addPanelPage(emptyLayout(), OWNER, { id: 'bp-a', url: 'about:blank' }).layout;
    useLayoutStore.setState({ layouts: { [KEY]: layout } });
    expect(refs()).toEqual([B]);
    const key = panelRuntimeKey(KEY, OWNER);
    usePanelRuntime.getState().mountHost(key, false);
    expect(refs()).toEqual([B]);
    // width0 -> 600: narrow remains false, measured changes.
    usePanelRuntime.getState().mountHost(key, false, true);
    expect(refs()).toEqual([A, B]);
    usePanelRuntime.getState().mountHost(key, true, true);
    expect(refs()).toEqual([B]);
    usePanelRuntime.getState().mountHost(key, false, true);
    expect(refs()).toEqual([A, B]);
    usePanelRuntime.getState().unmountHost(key);
    expect(refs()).toEqual([B]);
    useLayoutStore.setState({ layouts: { [KEY]: setPanelOpen(layout, OWNER, false) } });
    expect(refs()).toEqual([A, B]);
  });

  it('room panel does not exclude a visible session, and first 50 refs remain stable', () => {
    useLayoutStore.setState({ layouts: { [KEY]: addPanelPage(emptyLayout(), { kind: 'room', roomId: 'r-1' }, { id: 'bp-r', url: 'about:blank' }).layout } });
    const { refs } = setup();
    expect(refs()).toEqual([A, B]);
    const many = Array.from({ length: 52 }, (_, at) => ({ ...A, sessionId: `s-${String(at).padStart(2, '0')}` }));
    useUiStore.setState({ visibleSessionRefs: Object.fromEntries([...many].reverse().map((ref) => [refKey(ref), true])) });
    expect(refs()).toEqual(many.slice(0, 50));
  });

  it('disposes subscriptions, clears visibility, and keeps page sequence monotonic after rewiring', () => {
    const { report, offFocus } = setup();
    const firstSeq = report.mock.calls.at(-1)![0].seq;
    dispose?.(); dispose = undefined;
    expect(offFocus).toHaveBeenCalledOnce();
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ refs: [], documentVisible: false }));
    const count = report.mock.calls.length;
    usePanelRuntime.getState().mountHost(panelRuntimeKey(KEY, OWNER), true, true);
    useUiStore.setState({ visibleSessionRefs: {} });
    expect(report).toHaveBeenCalledTimes(count);
    const next = setup();
    expect(next.report.mock.calls[0]![0].seq).toBeGreaterThan(firstSeq);
  });
});
