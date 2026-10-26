import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createSessionVisibility } from './visibility.js';

const REF = { projectPath: '/p', workId: 'w-1', sessionId: 's-01' };
class Window extends EventEmitter {
  focused = true;
  visible = true;
  minimized = false;
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  isFocused = (): boolean => this.focused;
  isVisible = (): boolean => this.visible;
  isMinimized = (): boolean => this.minimized;
  isDestroyed = (): boolean => this.destroyed;
}
function setup() {
  const push = vi.fn();
  const relay = createSessionVisibility(push);
  const window = new Window();
  relay.track(window as unknown as BrowserWindow);
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const report = (seq = 1, refs = [REF], documentVisible = true) => relay.report(event(), { refs, documentVisible, seq });
  return { relay, window, event, report, push };
}

describe('main session visibility', () => {
  it('accepts exact refs from only the current main frame and increasing page sequence', () => {
    const { relay, window, event, report } = setup();
    const other = { ...REF, projectPath: '/other' };
    report(2, [REF, other]);
    const snapshot = relay.snapshot();
    expect(snapshot.refs).toEqual([REF, other]);
    relay.report({ ...event(), senderFrame: {} }, { seq: 3, refs: [], documentVisible: true });
    relay.report({ ...event(), sender: {} }, { seq: 3, refs: [], documentVisible: true });
    report(1, []);
    report(2, []);
    expect(relay.snapshot()).toEqual(snapshot);
    window.webContents.mainFrame = {};
    report(3, []);
    expect(relay.snapshot()).toEqual({ version: snapshot.version + 1, refs: [] });
  });

  it.each([null, {}, ...[{ seq: -1 }, { seq: 1.5 }, { seq: Infinity }, { refs: [{}] }, { documentVisible: 'yes' }, { refs: Array.from({ length: 51 }, () => REF) }].map((bad) => ({ seq: 2, refs: [], documentVisible: true, ...bad }))])('rejects malformed reports without changing a valid snapshot: %j', (bad) => {
    const { relay, event, report } = setup();
    report();
    const snapshot = relay.snapshot();
    relay.report(event(), bad);
    expect(relay.snapshot()).toEqual(snapshot);
  });

  it.each(['focused', 'visible', 'minimized', 'destroyed'] as const)('requires native window state: %s', (field) => {
    const { relay, window, report } = setup();
    window[field] = field === 'minimized' || field === 'destroyed';
    report();
    expect(relay.snapshot().refs).toEqual([]);
  });

  it.each(['blur', 'hide', 'minimize', 'closed'])('clears refs on %s; focus alone cannot revive them', (event) => {
    const { relay, window, report } = setup();
    report();
    const version = relay.snapshot().version;
    window.emit(event);
    window.emit('focus');
    expect(relay.snapshot()).toEqual({ version: version + 1, refs: [] });
    if (event !== 'closed') {
      report(2);
      expect(relay.snapshot().refs).toEqual([REF]);
    }
  });

  it('document hidden clears refs; 50 refs are accepted without truncating oversized reports', () => {
    const { relay, report } = setup();
    report(1, Array.from({ length: 50 }, (_, at) => ({ ...REF, sessionId: `s-${at}` })));
    expect(relay.snapshot().refs).toHaveLength(50);
    report(2, [REF], false);
    expect(relay.snapshot().refs).toEqual([]);
  });

  it('navigation/crash block old page reports; only committed new main documents reset seq', () => {
    const { relay, window, report } = setup();
    report(20);
    window.webContents.emit('did-start-navigation', {}, 'file:///new', false, true);
    report(21);
    expect(relay.snapshot().refs).toEqual([]);
    window.webContents.emit('did-navigate', {}, 'file:///new');
    report(1);
    expect(relay.snapshot().refs).toEqual([REF]);
    window.webContents.emit('render-process-gone');
    report(2);
    expect(relay.snapshot().refs).toEqual([]);
    window.webContents.emit('did-navigate', {}, 'file:///new');
    report(1);
    expect(relay.snapshot().refs).toEqual([REF]);
  });

  it('replaced window and subframe/same-document navigation cannot reset the current generation', () => {
    const { relay, window, report } = setup();
    report(10);
    window.webContents.emit('did-start-navigation', {}, 'file:///frame', false, false);
    window.webContents.emit('did-start-navigation', {}, 'file:///same#hash', true, true);
    expect(relay.snapshot().refs).toEqual([REF]);
    const next = new Window();
    relay.track(next as unknown as BrowserWindow);
    relay.report({ sender: next.webContents, senderFrame: next.webContents.mainFrame }, { seq: 1, refs: [REF], documentVisible: true });
    window.emit('closed');
    report(11, []);
    expect(relay.snapshot().refs).toEqual([REF]);
  });
});
