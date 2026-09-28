/**
 * Кусок 8.4b, тесты 1, 2 и 4–9 на вкладке диффа целиком: постановка заметки «+» и ⌘⇧A, view zone
 * под `endLine`, отправка (Retry тоста, blocked, «Send all unsent», «Send file notes», предел
 * 64 КиБ), рамка (без нажатия `pty.send` нет), переезд, одна колонка, режим коммита и загрузка
 * заметок сессии. Monaco и `IntersectionObserver` подменены, как в `DiffTab.test.tsx`; sonner —
 * тоже: кнопки тоста тест жмёт сам.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { WorkEntry, WorktreeDiff } from '@harnas/core';
import type { SendResult } from '@harnas/protocol';
import type { DiffFile, FileRoot, TextFile } from '../../shared/files-types.js';
import type { TabSpec } from '../../shared/layout-types.js';
import type { DiffNote } from '../../shared/notes-types.js';
import { tabId } from '../layout/ids.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { useActivityStore } from '../store/activity.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import type { SendWithToastDeps } from '../terminal/send.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { KeyCode, KeyMod, monacoMock } from '../test-utils/monaco-mock.js';
import { activityMap, makeActivity, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { DiffTab } from './DiffTab.js';
import { notesKey, useNotesStore } from './notes/store.js';
import { useReviewStore } from './store.js';

vi.mock('@monaco-editor/react', async () => (await import('../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('../files/editor/monaco-setup.js', async () => (await import('../test-utils/monaco-mock.js')).monacoSetupMock);
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }));

const BASE = 'a'.repeat(40);
const HASH = 'b'.repeat(40);
const WORKTREE = { path: '/tmp/wt/s-02', branch: 'harnas/w-a/s02', base: 'master', createdAt: '2026-09-27T08:00:00Z' };
const CHORD = KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA;
/** Местное 14:05 — `en-US` показывает его как 2:05 PM. */
const AT = new Date(2026, 8, 27, 14, 5).toISOString();

class FakeIO {
  static all: FakeIO[] = [];
  readonly targets = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) {
    FakeIO.all.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function intersect(paths: string[]): void {
  act(() => {
    for (const io of FakeIO.all) {
      const entries = [...io.targets]
        .filter((target) => paths.includes(target.getAttribute('data-diff-path') ?? ''))
        .map((target) => ({ target, isIntersecting: true }) as unknown as IntersectionObserverEntry);
      if (entries.length > 0) io.callback(entries, io as unknown as IntersectionObserver);
    }
  });
}

function text(value: string): TextFile {
  return { text: value, mtimeMs: 1, size: value.length, binary: false, utf8: true, readOnlyReason: null };
}

function file(path: string): DiffFile {
  return { path, status: 'M', oldPath: null, additions: 1, deletions: 1 };
}

function diff(files: DiffFile[]): WorktreeDiff {
  return {
    patch: '',
    files,
    uncommitted: true,
    baseCheckout: '/tmp/proj',
    baseDirty: false,
    mergeBase: BASE,
    stats: { additions: files.length, deletions: files.length },
    commits: [],
    uncommittedPaths: files.map((f) => f.path),
  };
}

function work(title = 'w-a'): WorkEntry {
  return makeWork('w-a', {
    projectPath: '/tmp/proj',
    title,
    sessions: [makeSession('s-02', 'two', { worktree: WORKTREE }), makeSession('s-03', 'three'), makeSession('s-04', 'four', { lifecycle: 'sleeping' })],
  });
}

/** 30 строк `line N`; `mark` — своя строка на месте N. */
function lines(marks: Record<number, string> = {}, count = 30): string {
  return `${Array.from({ length: count }, (_, i) => marks[i + 1] ?? `line ${i + 1}`).join('\n')}\n`;
}

function note(overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: 'aaaaaaaa',
    path: 'a.ts',
    side: 'modified',
    startLine: 10,
    endLine: 10,
    body: 'fix a',
    createdAt: AT,
    updatedAt: AT,
    sentAt: null,
    sentTo: null,
    anchor: { text: 'line 10' },
    stale: false,
    ...overrides,
  };
}

let seq = 0;
let KEY: string;
let WT: FileRoot;
let bridge: FakeBridge;
let sendDeps: SendWithToastDeps;
let sent: string[];

function count(method: string): number {
  return bridge.calls.filter((call) => call.method === method).length;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function section(path: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-diff-path="${path}"]`);
  if (found === null) throw new Error(`нет секции ${path}`);
  return found;
}

function liveFor(path: string): (typeof monacoMock.diffEditors)[number] {
  const found = monacoMock.diffEditors.filter((editor) => !editor.disposed).find((editor) => editor.original.text.startsWith(`base ${path}`));
  if (found === undefined) throw new Error(`нет живого редактора ${path}`);
  return found;
}

function serve(path: string, modified = lines()): void {
  bridge.setGitShow(WT, BASE, path, text(`base ${path}\n${lines()}`));
  bridge.setFile(WT, path, text(modified));
}

/** Карточка зоны: overlay widget рядом с узлом зоны (`useViewZones`), по тому же ключу. */
function card(zone: { domNode: HTMLElement } | undefined): HTMLElement {
  const key = zone?.domNode.getAttribute('data-note-zone');
  const found = zone?.domNode.parentElement?.querySelector<HTMLElement>(`[data-note-overlay="${key}"]`);
  if (found === null || found === undefined) throw new Error('нет карточки зоны');
  return found;
}

function notesNow(): DiffNote[] {
  return useNotesStore.getState().bySession[notesKey(KEY, 's-02')] ?? [];
}

const branchTab = (): Extract<TabSpec, { kind: 'diff' }> => ({ kind: 'diff', id: tabId.diff('s-02', null), sessionId: 's-02', commit: null });

function renderTab(tab = branchTab(), entry = work()): ReturnType<typeof render> {
  return render(<DiffTab bridge={bridge} workKey={KEY} entry={entry} tab={tab} sendDeps={sendDeps} />);
}

/** Протяжка по гаттеру стороны от строки a до b (шаг поддельного редактора — 20 px). */
function drag(root: HTMLElement, side: 'modified' | 'original', from: number, to: number): void {
  const strip = root.querySelector<HTMLElement>(`[data-testid="gutter-add"][data-side="${side}"]`);
  if (strip === null) throw new Error(`нет гаттера ${side}`);
  // Наведение — над DOM стороны редактора (оверлей указатель не ловит, fix-8.4b п. 2), протяжка — с «+».
  const dom = root.querySelector<HTMLElement>(`div[data-side="${side}"] > [data-testid="monaco-zone-host"]`);
  if (dom === null) throw new Error(`нет редактора ${side}`);
  fireEvent.pointerMove(dom, { clientX: 10, clientY: (from - 1) * 20 + 10 });
  const plus = strip.querySelector<HTMLElement>('button');
  if (plus === null) throw new Error(`нет «+» ${side}`);
  fireEvent.pointerDown(plus, { clientY: (from - 1) * 20 + 10, button: 0 });
  fireEvent.pointerMove(plus, { clientY: (to - 1) * 20 + 10 });
  fireEvent.pointerUp(plus, { clientY: (to - 1) * 20 + 10 });
}

function answers(...results: SendResult[]): void {
  const queue = [...results];
  bridge.setHandler('pty.send', (params) => {
    sent.push(params.text);
    const next = queue.shift();
    if (next === undefined) throw new Error('лишний pty.send');
    return next;
  });
}

const SUBMITTED: SendResult = { inserted: true, submitted: true, reason: null };

beforeEach(() => {
  seq += 1;
  KEY = `/tmp/proj w-notes-${seq}`;
  WT = { workKey: KEY, spec: { kind: 'worktree', sessionId: 's-02' } };
  vi.useFakeTimers();
  FakeIO.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  monacoMock.reset();
  bridge = createFakeBridge();
  bridge.setHandler('worktrees.diff', () => diff([file('a.ts')]));
  useHostStore.getState().init(bridge);
  bridge.setHostMethods([...REQUIRED_METHODS]);
  useActivityStore.setState({ byRef: {} });
  useReviewStore.setState({ changesSession: {}, revealed: {}, discarded: {} });
  useUiStore.setState((state) => ({ ui: { ...state.ui, diffView: 'split' } }));
  sent = [];
  sendDeps = { bridge, session: () => null, openSession: vi.fn() };
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useHostStore.setState({ status: { state: 'connecting' } });
});

describe('постановка и показ (тесты 1 и 2)', () => {
  it('протяжка 10–14 открывает поле под строкой 14; ⌘Enter — заметка 10–14 с якорем строки 10 и view zone под endLine', async () => {
    serve('a.ts');
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    expect(section('a.ts').querySelectorAll('[data-testid="gutter-add"]')).toHaveLength(2);

    drag(section('a.ts'), 'modified', 10, 14);
    await flush();
    expect(editor.modified.zones.map((zone) => zone.afterLineNumber)).toEqual([14]);
    const field = within(card(editor.modified.zones[0])).getByRole('textbox');
    fireEvent.change(field, { target: { value: 'split this function' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await flush();

    expect(notesNow()).toMatchObject([{ path: 'a.ts', side: 'modified', startLine: 10, endLine: 14, body: 'split this function', anchor: { text: 'line 10' } }]);
    expect(editor.modified.zones).toHaveLength(1);
    const zone = editor.modified.zones[0];
    expect(zone?.afterLineNumber).toBe(14);
    const shown = within(card(zone)).getByTestId('note-zone');
    expect(shown.textContent).toContain('split this function');
    expect(shown.textContent).toContain('You');
    for (const name of ['Edit', 'Delete']) expect(within(shown).getByRole('button', { name })).toBeTruthy();
    expect(within(shown).getByRole('button', { name: /^Send/ })).toBeTruthy();
  });

  it('⌘⇧A — заметка на выделение; на старой стороне в двух колонках — к original; Esc отменяет', async () => {
    serve('a.ts');
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    editor.original.selection = { startLineNumber: 3, endLineNumber: 4 };
    act(() => editor.original.press(CHORD));
    await flush();
    expect(editor.original.zones.map((zone) => zone.afterLineNumber)).toEqual([4]);
    fireEvent.keyDown(within(card(editor.original.zones[0])).getByRole('textbox'), { key: 'Escape' });
    await flush();
    expect(editor.original.zones).toHaveLength(0);

    act(() => editor.original.press(CHORD));
    await flush();
    const field = within(card(editor.original.zones[0])).getByRole('textbox');
    fireEvent.change(field, { target: { value: 'old side' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await flush();
    // Строка 3 старой стороны — `line 2`: первая строка base — заголовок `base a.ts`.
    expect(notesNow()).toMatchObject([{ side: 'original', startLine: 3, endLine: 4, anchor: { text: 'line 2' } }]);
  });

  it('Edit — поле с прежним текстом, ⌘Enter меняет текст; Delete убирает заметку и зону', async () => {
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [note()] }, corruptedTo: null });
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    const zone = (): HTMLElement => card(editor.modified.zones[0]);
    fireEvent.click(within(zone()).getByRole('button', { name: 'Edit' }));
    await flush();
    const field = within(zone()).getByRole('textbox') as HTMLTextAreaElement;
    expect(field.value).toBe('fix a');
    fireEvent.change(field, { target: { value: 'fix a better' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await flush();
    expect(notesNow()[0]?.body).toBe('fix a better');
    fireEvent.click(within(zone()).getByRole('button', { name: 'Delete' }));
    await flush();
    expect(notesNow()).toEqual([]);
    expect(editor.modified.zones).toHaveLength(0);
  });
});

describe('отправка (тест 4)', () => {
  it('busy → тост с Retry → Retry отвечает submitted → у заметки sentAt, зона свёрнута в Sent to S02', async () => {
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [note()] }, corruptedTo: null });
    answers({ inserted: false, submitted: false, reason: 'busy' }, SUBMITTED);
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    fireEvent.click(within(card(editor.modified.zones[0])).getByRole('button', { name: /^Send/ }));
    await flush();
    expect(count('pty.send')).toBe(1);
    expect(sent[0]).toContain('Review notes for S02 (branch harnas/w-a/s02):');
    expect(sent[0]).toContain('File: a.ts\nLine: 10\nNote: fix a');
    expect(notesNow()[0]?.sentAt).toBeNull();
    const [message, options] = vi.mocked(toast.error).mock.calls.at(-1) ?? [];
    expect(message).toBe('S02 is busy with another message — retry in a second');
    const retry = (options as { action?: { label: string; onClick(): void } } | undefined)?.action;
    expect(retry?.label).toBe('Retry');

    act(() => retry?.onClick());
    await flush();
    expect(count('pty.send')).toBe(2);
    expect(notesNow()[0]).toMatchObject({ sentTo: 's-02' });
    expect(notesNow()[0]?.sentAt).not.toBeNull();
    expect(card(editor.modified.zones[0]).textContent).toContain('Sent to S02 ·');
  });

  it('blocked → sentAt: null; получатель из меню — другая сессия', async () => {
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [note()] }, corruptedTo: null });
    answers({ inserted: false, submitted: false, reason: 'blocked' });
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const zone = card(liveFor('a.ts').modified.zones[0]);
    fireEvent.keyDown(within(zone).getByRole('button', { name: 'Choose recipient' }), { key: 'Enter' });
    const menu = screen.getByRole('menu');
    const other = within(menu).getAllByRole('menuitem').find((item) => item.getAttribute('data-session-id') === 's-03');
    fireEvent.click(other as HTMLElement);
    await flush();
    const params = bridge.calls.find((call) => call.method === 'pty.send')?.params as { ref: { sessionId: string }; submit: boolean };
    expect(params.ref.sessionId).toBe('s-03');
    expect(params.submit).toBe(true);
    expect(notesNow()[0]).toMatchObject({ sentAt: null, sentTo: null });
  });

  it('Send all unsent пропускает stale и отправленные; Send file notes берёт только заметки файла', async () => {
    bridge.setHandler('worktrees.diff', () => diff([file('a.ts'), file('b.ts')]));
    serve('a.ts');
    serve('b.ts');
    bridge.setNotes(KEY, 's-02', {
      file: {
        version: 1,
        notes: [
          note({ id: '00000001', body: 'A unsent' }),
          note({ id: '00000002', body: 'A sent', sentAt: AT, sentTo: 's-02' }),
          note({ id: '00000003', path: 'b.ts', body: 'B stale', stale: true, anchor: { text: 'nowhere' } }),
          note({ id: '00000004', path: 'b.ts', startLine: 12, endLine: 12, body: 'B unsent', anchor: { text: 'line 12' } }),
        ],
      },
      corruptedTo: null,
    });
    answers(SUBMITTED, SUBMITTED);
    renderTab();
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /^Send all unsent/ }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('A unsent');
    expect(sent[0]).toContain('B unsent');
    expect(sent[0]).not.toContain('B stale');
    expect(sent[0]).not.toContain('A sent');

    // Всё неустаревшее отправлено: «Send file notes» у a.ts больше нечего слать; у b.ts — тоже.
    expect(within(section('a.ts')).queryByRole('button', { name: /^Send file notes/ })).toBeNull();
    act(() => useNotesStore.getState().add(KEY, 's-02', { path: 'a.ts', side: 'modified', startLine: 20, endLine: 20, body: 'A later' }, 'line 20'));
    act(() => useNotesStore.getState().add(KEY, 's-02', { path: 'b.ts', side: 'modified', startLine: 21, endLine: 21, body: 'B later' }, 'line 21'));
    await flush();
    fireEvent.click(within(section('a.ts')).getByRole('button', { name: /^Send file notes/ }));
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('A later');
    expect(sent[1]).not.toContain('B later');
  });

  it('текст больше 64 КиБ — тост Too long…, pty.send нет, заметки не отправлены', async () => {
    serve('a.ts');
    const big = Array.from({ length: 17 }, (_, i) => note({ id: (0x10000000 + i).toString(16), startLine: i + 1, endLine: i + 1, body: 'x'.repeat(4000), anchor: { text: `line ${i + 1}` } }));
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: big }, corruptedTo: null });
    answers();
    renderTab();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /^Send all unsent/ }));
    await flush();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Too long for one message to the agent — 64 KB max');
    expect(count('pty.send')).toBe(0);
    expect(notesNow().every((item) => item.sentAt === null)).toBe(true);
  });

  it('двойной клик Send — одна отправка, пока идёт первая (одно нажатие — одно действие)', async () => {
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [note()] }, corruptedTo: null });
    let release: (value: SendResult) => void = () => {};
    bridge.setHandler('pty.send', (params) => {
      sent.push(params.text);
      return new Promise<SendResult>((resolve) => {
        release = resolve;
      });
    });
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const button = within(card(liveFor('a.ts').modified.zones[0])).getByRole('button', { name: /^Send/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(count('pty.send')).toBe(1);
    release(SUBMITTED);
    await flush();
    expect(notesNow()[0]?.sentAt).not.toBeNull();
  });
});

describe('рамка (тест 5)', () => {
  it('загрузка, переезд, обновление вкладки и ⌘Enter в поле — ни одного pty.send', async () => {
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [note()] }, corruptedTo: null });
    answers();
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    drag(section('a.ts'), 'modified', 20, 20);
    await flush();
    const editor = liveFor('a.ts');
    const field = within(card(editor.modified.zones.find((zone) => zone.afterLineNumber === 20))).getByRole('textbox');
    fireEvent.change(field, { target: { value: 'saved, not sent' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    serve('a.ts', lines({ 1: 'inserted' }, 31));
    act(() => bridge.emit('works.changed', { entries: [work('renamed')], branches: {} }));
    await flush(2500);
    expect(notesNow()).toHaveLength(2);
    expect(count('pty.send')).toBe(0);
  });
});

describe('переезд (тест 6)', () => {
  it('выше вставлены 5 строк, сессия вышла из working — заметка на строке 15; строку убрали — Outdated', async () => {
    const ref = { projectPath: '/tmp/proj', workId: 'w-a', sessionId: 's-02' };
    serve('a.ts', lines({ 10: 'target' }));
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [note({ anchor: { text: 'target' } })] }, corruptedTo: null });
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    expect(editor.modified.zones.map((zone) => zone.afterLineNumber)).toEqual([10]);

    const shifted = `${['n1', 'n2', 'n3', 'n4', 'n5'].join('\n')}\n${lines({ 10: 'target' })}`;
    serve('a.ts', shifted);
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'working')]) }));
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'idle')]) }));
    await flush(2500);
    expect(notesNow()[0]).toMatchObject({ startLine: 15, endLine: 15, stale: false });
    expect(editor.modified.zones.map((zone) => zone.afterLineNumber)).toEqual([15]);

    serve('a.ts', lines());
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'working')]) }));
    act(() => useActivityStore.setState({ byRef: activityMap([makeActivity(ref, 'idle')]) }));
    await flush(2500);
    expect(notesNow()[0]?.stale).toBe(true);
    expect(within(card(editor.modified.zones[0])).getByText('Outdated')).toBeTruthy();
  });
});

describe('одна колонка (тест 7)', () => {
  it('заметка к original — полоса Original · line 7 над редактором; «+» ставит заметку к modified', async () => {
    useUiStore.setState((state) => ({ ui: { ...state.ui, diffView: 'inline' } }));
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', {
      file: { version: 1, notes: [note({ side: 'original', startLine: 7, endLine: 7, body: 'old side note', anchor: { text: 'line 6' } })] },
      corruptedTo: null,
    });
    renderTab();
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    const strip = within(section('a.ts')).getByTestId('original-notes');
    expect(strip.textContent).toContain('Original · line 7');
    expect(strip.textContent).toContain('old side note');
    expect(editor.original.zones).toHaveLength(0);
    // Гаттер — только у modified: старой стороны в одной колонке не видно.
    expect(section('a.ts').querySelectorAll('[data-testid="gutter-add"]')).toHaveLength(1);

    drag(section('a.ts'), 'modified', 5, 5);
    await flush();
    const field = within(card(editor.modified.zones[0])).getByRole('textbox');
    fireEvent.change(field, { target: { value: 'new side' } });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await flush();
    expect(notesNow().find((item) => item.body === 'new side')).toMatchObject({ side: 'modified', startLine: 5 });

    // Две колонки — заметка к original снова view zone своей стороны.
    act(() => useUiStore.setState((state) => ({ ui: { ...state.ui, diffView: 'split' } })));
    await flush();
    expect(within(section('a.ts')).queryByTestId('original-notes')).toBeNull();
    expect(editor.original.zones.map((zone) => zone.afterLineNumber)).toEqual([7]);
  });
});

describe('режим коммита (тест 8)', () => {
  it('«+» нет, ⌘⇧A заметку не ставит, zones пусты, заметки не грузятся', async () => {
    bridge.setCommitFiles(WT, HASH, [file('a.ts')]);
    bridge.setGitShow(WT, `${HASH}^`, 'a.ts', text(`base a.ts\n${lines()}`));
    bridge.setGitShow(WT, HASH, 'a.ts', text(lines()));
    act(() => useNotesStore.getState().add(KEY, 's-02', { path: 'a.ts', side: 'modified', startLine: 3, endLine: 3, body: 'branch note' }, 'line 3'));
    renderTab({ kind: 'diff', id: tabId.diff('s-02', HASH), sessionId: 's-02', commit: HASH });
    await flush();
    intersect(['a.ts']);
    await flush();
    const editor = liveFor('a.ts');
    expect(section('a.ts').querySelector('[data-testid="gutter-add"]')).toBeNull();
    editor.modified.selection = { startLineNumber: 2, endLineNumber: 2 };
    act(() => editor.modified.press(CHORD));
    await flush();
    expect(editor.modified.zones).toEqual([]);
    expect(editor.original.zones).toEqual([]);
    expect(notesNow()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Send all unsent/ })).toBeNull();
    expect(bridge.loadNotesCalls).toEqual([]);
  });
});

describe('загрузка (тест 9)', () => {
  it('открытие вкладки грузит заметки сессии один раз; повторное открытие — без нового чтения', async () => {
    serve('a.ts');
    const first = renderTab();
    await flush();
    first.unmount();
    renderTab();
    await flush();
    expect(bridge.loadNotesCalls.filter((call) => call.workKey === KEY && call.sessionId === 's-02')).toHaveLength(1);
  });

  it('битые — тост Session notes were damaged — saved as <имя>, полного пути в DOM нет', async () => {
    serve('a.ts');
    bridge.setNotes(KEY, 's-02', { file: { version: 1, notes: [] }, corruptedTo: 's-02.corrupt-20260927-140501.json' });
    renderTab();
    await flush();
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Session notes were damaged — saved as s-02.corrupt-20260927-140501.json');
    expect(document.body.textContent).not.toContain('/notes/');
  });
});
