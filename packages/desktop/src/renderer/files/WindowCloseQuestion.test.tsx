/**
 * Раунд fix-final-c, п. 2: заметки к диффу пишутся через 300 мс тишины — закрытие окна, ⌘Q и
 * перезагрузка в эти 300 мс не теряют заметку и отметку `sentAt`: `pagehide` сбрасывает отложенные
 * записи сразу, ответ на `app:confirm-close` ждёт их, а `beforeunload` отменяет выгрузку, пока
 * запись заметок ждёт (main спросит и повторит перезагрузку после ответа).
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotesStore } from '../review/notes/store.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { WindowCloseQuestion } from './SaveChangesDialog.js';
import { useFilesStore } from './store.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let bridge: FakeBridge;
let seq = 0;
let work: string;
const S2 = 's-02';

const draft = { path: 'src/a.ts', side: 'modified' as const, startLine: 1, endLine: 1, body: 'note' };

async function pendingNote(): Promise<void> {
  await useNotesStore.getState().load(bridge, work, S2);
  act(() => useNotesStore.getState().add(work, S2, draft, 'line 1'));
}

function unload(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  seq += 1;
  work = `/tmp/proj w-close-${seq}`;
  bridge = createFakeBridge();
  vi.useFakeTimers();
  useFilesStore.setState({ buffers: {}, reveals: {} });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('WindowCloseQuestion и отложенные заметки (раунд fix-final-c, п. 2)', () => {
  it('app:confirm-close без грязных буферов: заметка записана раньше ответа close', async () => {
    render(<WindowCloseQuestion bridge={bridge} />);
    await pendingNote();
    act(() => bridge.emitConfirmClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bridge.savedNotes).toHaveLength(1);
    expect(bridge.closeAnswers).toEqual(['close']);
  });

  it('запись заметки отказала — cancel: окно остаётся, заметки не пропали молча', async () => {
    render(<WindowCloseQuestion bridge={bridge} />);
    await pendingNote();
    vi.spyOn(bridge.app, 'saveNotes').mockRejectedValueOnce(new Error('EACCES'));
    act(() => bridge.emitConfirmClose());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(bridge.closeAnswers).toEqual(['cancel']);
  });

  it('pagehide — запись сразу, без 300 мс', async () => {
    render(<WindowCloseQuestion bridge={bridge} />);
    await pendingNote();
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.savedNotes).toHaveLength(1);
  });

  it('beforeunload: пока запись заметок ждёт — выгрузка отменяется (main спросит), после записи — нет', async () => {
    render(<WindowCloseQuestion bridge={bridge} />);
    await pendingNote();
    expect(unload()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(bridge.savedNotes).toHaveLength(1);
    expect(unload()).toBe(false);
  });
});
