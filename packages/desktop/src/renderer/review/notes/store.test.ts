/**
 * Стор заметок (кусок 8.4a, тесты 5 и 6) — модуль-синглтон zustand: у каждого теста своя
 * работа, чтобы загрузки и таймеры записи соседних тестов не пересекались.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { SendOutcome } from '../../terminal/send.js';
import type { DiffNote, NotesFile } from '../../../shared/notes-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { notesKey, useNotesStore } from './store.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let seq = 0;
let work: string;
let bridge: FakeBridge;
const S2 = 's-02';

function draft(overrides: Partial<Pick<DiffNote, 'path' | 'side' | 'startLine' | 'endLine' | 'body'>> = {}) {
  return { path: 'src/a.ts', side: 'modified' as const, startLine: 7, endLine: 7, body: 'fix', ...overrides };
}

function notes(): DiffNote[] {
  return useNotesStore.getState().bySession[notesKey(work, S2)] ?? [];
}

function existing(overrides: Partial<DiffNote> = {}): DiffNote {
  return {
    id: 'aaaaaaaa',
    path: 'src/a.ts',
    side: 'modified',
    startLine: 7,
    endLine: 7,
    body: 'saved before',
    createdAt: '2026-09-27T14:05:01.000Z',
    updatedAt: '2026-09-27T14:05:01.000Z',
    sentAt: null,
    sentTo: null,
    anchor: { text: 'line 7' },
    stale: false,
    ...overrides,
  };
}

beforeEach(() => {
  seq += 1;
  work = `/tmp/proj w-${seq}`;
  bridge = createFakeBridge();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T14:05:01.000Z'));
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('notesKey', () => {
  it('workKey и sessionId через NUL', () => {
    expect(notesKey('/p w-1', 's-02')).toBe('/p w-1\0s-02');
  });
});

describe('стор заметок: load (тест 6)', () => {
  it('load дважды → один loadNotes; заметки файла — в bySession', async () => {
    bridge.setNotes(work, S2, { file: { version: 1, notes: [existing()] }, corruptedTo: null });
    await Promise.all([useNotesStore.getState().load(bridge, work, S2), useNotesStore.getState().load(bridge, work, S2)]);
    await useNotesStore.getState().load(bridge, work, S2);
    expect(bridge.loadNotesCalls).toEqual([{ workKey: work, sessionId: S2 }]);
    expect(notes()).toEqual([existing()]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('corruptedTo → тост «Session notes were damaged — saved as <имя>»', async () => {
    bridge.setNotes(work, S2, { file: { version: 1, notes: [] }, corruptedTo: 's-02.corrupt-20260927-140501.json' });
    await useNotesStore.getState().load(bridge, work, S2);
    expect(vi.mocked(toast.error).mock.calls).toEqual([['Session notes were damaged — saved as s-02.corrupt-20260927-140501.json']]);
    expect(notes()).toEqual([]);
  });

  it('отказ loadNotes → пустые заметки, тост и предупреждение в консоль', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setNotes(work, S2, { code: 'failed', message: 'EACCES' });
    await useNotesStore.getState().load(bridge, work, S2);
    expect(notes()).toEqual([]);
    expect(vi.mocked(toast.error).mock.calls).toEqual([["Couldn't load review notes — changes to them won't be saved"]]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('отказ loadNotes → правка живёт в окне, а файл не пишется (fix-8.4a, пункт 1)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setNotes(work, S2, { code: 'failed', message: 'EACCES' });
    await useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().add(work, S2, draft({ body: 'kept in memory' }), 'x');
    await vi.advanceTimersByTimeAsync(1000);
    expect(notes().map((n) => n.body)).toEqual(['kept in memory']);
    expect(bridge.savedNotes).toEqual([]);
    vi.mocked(console.warn).mockRestore();
  });

  it('после отказа следующий load читает снова; удача — файловые заметки первыми, правки окна за ними, запись', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.setNotes(work, S2, { code: 'failed', message: 'EACCES' });
    await useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().add(work, S2, draft({ body: 'while failed' }), 'x');
    bridge.setNotes(work, S2, { file: { version: 1, notes: [existing()] }, corruptedTo: null });
    await useNotesStore.getState().load(bridge, work, S2);
    expect(bridge.loadNotesCalls).toHaveLength(2);
    expect(notes().map((n) => n.body)).toEqual(['saved before', 'while failed']);
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.savedNotes.map((s) => s.notes.notes.map((n) => n.body))).toEqual([['saved before', 'while failed']]);
    // Удачное чтение — последнее: дальше load моста не зовёт.
    await useNotesStore.getState().load(bridge, work, S2);
    expect(bridge.loadNotesCalls).toHaveLength(2);
    vi.mocked(console.warn).mockRestore();
  });
});

describe('стор заметок: правки и запись (тест 6)', () => {
  it('add: id — 8 hex, createdAt и updatedAt — сейчас, anchor.text — переданная строка, не отправлена', async () => {
    await useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().add(work, S2, draft({ startLine: 10, endLine: 14, body: 'two\nlines' }), 'const a = 1;');
    const [added] = notes();
    expect(added).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}$/),
      path: 'src/a.ts',
      side: 'modified',
      startLine: 10,
      endLine: 14,
      body: 'two\nlines',
      createdAt: '2026-09-27T14:05:01.000Z',
      updatedAt: '2026-09-27T14:05:01.000Z',
      sentAt: null,
      sentTo: null,
      anchor: { text: 'const a = 1;' },
      stale: false,
    });
  });

  it('три правки за 300 мс → одна saveNotes с итоговыми заметками', async () => {
    bridge.setNotes(work, S2, { file: { version: 1, notes: [existing()] }, corruptedTo: null });
    await useNotesStore.getState().load(bridge, work, S2);
    const store = useNotesStore.getState();
    store.add(work, S2, draft({ body: 'one' }), 'line 7');
    vi.advanceTimersByTime(100);
    vi.setSystemTime(new Date('2026-09-27T14:06:00.000Z'));
    store.update(work, S2, 'aaaaaaaa', 'edited');
    vi.advanceTimersByTime(100);
    const addedId = notes()[1]?.id ?? '';
    store.remove(work, S2, addedId);
    vi.advanceTimersByTime(299);
    expect(bridge.savedNotes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.savedNotes).toEqual([
      {
        workKey: work,
        sessionId: S2,
        notes: { version: 1, notes: [existing({ body: 'edited', updatedAt: '2026-09-27T14:06:00.000Z' })] } satisfies NotesFile,
      },
    ]);
  });

  it('запись — по сессии: правки двух сессий дают две saveNotes', async () => {
    await useNotesStore.getState().load(bridge, work, 's-01');
    await useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().add(work, 's-01', draft(), 'x');
    useNotesStore.getState().add(work, S2, draft(), 'x');
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.savedNotes.map((s) => s.sessionId).sort()).toEqual(['s-01', S2]);
  });

  it('заметки, добавленные до ответа loadNotes, не теряются: к ним дописываются файловые', async () => {
    bridge.setNotes(work, S2, { file: { version: 1, notes: [existing()] }, corruptedTo: null });
    const loading = useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().add(work, S2, draft({ body: 'early' }), 'x');
    await loading;
    expect(notes().map((n) => n.body)).toEqual(['saved before', 'early']);
  });
});

describe('стор заметок: отказ записи (fix-8.4a, пункт 2)', () => {
  it('отказ saveNotes → тост, заметки в окне; следующая правка пишет снова', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await useNotesStore.getState().load(bridge, work, S2);
    const save = vi.spyOn(bridge.app, 'saveNotes').mockRejectedValueOnce(new Error('EACCES'));
    useNotesStore.getState().add(work, S2, draft({ body: 'first' }), 'x');
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls).toEqual([["Couldn't save review notes"]]);
    expect(notes().map((n) => n.body)).toEqual(['first']);
    useNotesStore.getState().add(work, S2, draft({ body: 'second' }), 'x');
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.savedNotes.map((s) => s.notes.notes.map((n) => n.body))).toEqual([['first', 'second']]);
    vi.mocked(console.warn).mockRestore();
  });
});

describe('стор заметок: долгая загрузка (fix-8.4a, пункт 3)', () => {
  it('правка до ответа loadNotes, ответ позже 300 мс → одна saveNotes с файловыми и ранними заметками', async () => {
    let answer: (value: { file: NotesFile; corruptedTo: string | null }) => void = () => {};
    vi.spyOn(bridge.app, 'loadNotes').mockImplementationOnce(
      () => new Promise((resolve) => { answer = resolve; }),
    );
    const loading = useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().add(work, S2, draft({ body: 'early' }), 'x');
    await vi.advanceTimersByTimeAsync(500);
    expect(bridge.savedNotes).toEqual([]);
    answer({ file: { version: 1, notes: [existing()] }, corruptedTo: null });
    await loading;
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.savedNotes.map((s) => s.notes.notes.map((n) => n.body))).toEqual([['saved before', 'early']]);
  });
});

describe('стор заметок: relocateFile', () => {
  it('двигает заметки файла и стороны; не найденная — stale; прочие не трогает', async () => {
    bridge.setNotes(work, S2, {
      file: {
        version: 1,
        notes: [
          existing({ id: '00000001', startLine: 2, endLine: 3, anchor: { text: 'b' } }),
          existing({ id: '00000002', startLine: 4, endLine: 4, anchor: { text: 'gone' } }),
          existing({ id: '00000003', startLine: 2, endLine: 2, anchor: { text: 'b' }, side: 'original' }),
          existing({ id: '00000004', path: 'src/other.ts', startLine: 2, endLine: 2, anchor: { text: 'b' } }),
        ],
      },
      corruptedTo: null,
    });
    await useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().relocateFile(work, S2, 'src/a.ts', 'modified', ['new', 'new', 'a', 'b', 'c']);
    const byId = Object.fromEntries(notes().map((n) => [n.id, n]));
    expect(byId['00000001']).toMatchObject({ startLine: 4, endLine: 5, stale: false });
    expect(byId['00000002']).toMatchObject({ startLine: 4, endLine: 4, stale: true });
    expect(byId['00000003']).toMatchObject({ startLine: 2, endLine: 2, stale: false });
    expect(byId['00000004']).toMatchObject({ startLine: 2, endLine: 2, stale: false });
  });

  it('ничего не сдвинулось → записи нет', async () => {
    bridge.setNotes(work, S2, { file: { version: 1, notes: [existing()] }, corruptedTo: null });
    await useNotesStore.getState().load(bridge, work, S2);
    useNotesStore.getState().relocateFile(work, S2, 'src/a.ts', 'modified', ['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.savedNotes).toEqual([]);
  });
});

describe('стор заметок: applyOutcome (тест 5)', () => {
  const SENT_AT = '2026-09-27T14:07:00.000Z';

  async function withTwoNotes(): Promise<void> {
    bridge.setNotes(work, S2, {
      file: { version: 1, notes: [existing({ id: '00000001' }), existing({ id: '00000002' })] },
      corruptedTo: null,
    });
    await useNotesStore.getState().load(bridge, work, S2);
    vi.setSystemTime(new Date(SENT_AT));
  }

  function sent(): Array<Pick<DiffNote, 'id' | 'sentAt' | 'sentTo'>> {
    return notes().map(({ id, sentAt, sentTo }) => ({ id, sentAt, sentTo }));
  }

  it('submitted → sentAt и sentTo только у переданных id', async () => {
    await withTwoNotes();
    useNotesStore.getState().applyOutcome(work, S2, ['00000001'], 's-03', { inserted: true, submitted: true, reason: null });
    expect(sent()).toEqual([
      { id: '00000001', sentAt: SENT_AT, sentTo: 's-03' },
      { id: '00000002', sentAt: null, sentTo: null },
    ]);
  });

  it("вставка без Enter с reason: 'draft' → sentAt и sentTo", async () => {
    await withTwoNotes();
    useNotesStore.getState().applyOutcome(work, S2, ['00000001', '00000002'], S2, { inserted: true, submitted: false, reason: 'draft' });
    expect(sent()).toEqual([
      { id: '00000001', sentAt: SENT_AT, sentTo: S2 },
      { id: '00000002', sentAt: SENT_AT, sentTo: S2 },
    ]);
  });

  it('blocked, busy, no-paste-mode и { error: not_found } → sentAt: null, записи нет', async () => {
    await withTwoNotes();
    const outcomes: SendOutcome[] = [
      { inserted: false, submitted: false, reason: 'blocked' },
      { inserted: false, submitted: false, reason: 'busy' },
      { inserted: false, submitted: false, reason: 'no-paste-mode' },
      { error: 'not_found', message: 'no pty' },
      { error: 'failed', message: 'boom' },
    ];
    for (const outcome of outcomes) useNotesStore.getState().applyOutcome(work, S2, ['00000001'], S2, outcome);
    expect(sent()[0]).toEqual({ id: '00000001', sentAt: null, sentTo: null });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.savedNotes).toEqual([]);
  });

  it('цепочка busy, затем submitted (два вызова, как у Retry) → sentAt поставлен и записан', async () => {
    await withTwoNotes();
    useNotesStore.getState().applyOutcome(work, S2, ['00000001'], S2, { inserted: false, submitted: false, reason: 'busy' });
    expect(sent()[0]?.sentAt).toBeNull();
    useNotesStore.getState().applyOutcome(work, S2, ['00000001'], S2, { inserted: true, submitted: true, reason: null });
    expect(sent()[0]).toEqual({ id: '00000001', sentAt: SENT_AT, sentTo: S2 });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.savedNotes.at(-1)?.notes.notes[0]).toMatchObject({ sentAt: SENT_AT, sentTo: S2 });
  });
});
