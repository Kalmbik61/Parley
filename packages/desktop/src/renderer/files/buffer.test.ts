/**
 * Тесты 1 и 2 куска 7.3a: машина состояний буфера (спека 10.5) и эхо своей записи.
 */

import { describe, expect, it } from 'vitest';
import type { TextFile } from '../../shared/files-types.js';
import { bufferKey, bufferReducer, bufferView, initialBuffer, isBufferDirty, type BufferEvent, type BufferModel } from './buffer.js';

function file(text: string, mtimeMs: number): TextFile {
  return { text, mtimeMs, size: text.length, binary: false, utf8: true, readOnlyReason: null };
}

function run(model: BufferModel, ...events: BufferEvent[]): BufferModel {
  return events.reduce(bufferReducer, model);
}

const clean = (): BufferModel => run(initialBuffer(), { type: 'loaded', file: file('a', 1) });
const dirty = (): BufferModel => run(clean(), { type: 'edited', text: 'ab' });

describe('bufferKey', () => {
  it('ключ работы и id вкладки через NUL: у двух работ одного проекта ключи разные', () => {
    expect(bufferKey('/p w-1', 'file:p:src/a.ts')).toBe('/p w-1\0file:p:src/a.ts');
    expect(bufferKey('/p w-1', 'file:p:src/a.ts')).not.toBe(bufferKey('/p w-2', 'file:p:src/a.ts'));
  });
});

describe('bufferReducer (тест 1)', () => {
  it('loaded — clean, текст и mtime с диска; правка — dirty; правка назад — снова clean', () => {
    const model = clean();
    expect(model).toMatchObject({ status: 'clean', text: 'a', savedText: 'a', mtimeMs: 1, diskMtimeMs: 1 });
    expect(isBufferDirty(model)).toBe(false);
    const edited = run(model, { type: 'edited', text: 'ab' });
    expect(edited.status).toBe('dirty');
    expect(isBufferDirty(edited)).toBe(true);
    expect(run(edited, { type: 'edited', text: 'a' }).status).toBe('clean');
  });

  it('clean + disk-changed → disk-changed-clean, после reloaded — clean с новым текстом, плашка 2 с и не дольше', () => {
    const changed = run(clean(), { type: 'disk-changed', mtimeMs: 9 });
    expect(changed.status).toBe('disk-changed-clean');
    expect(bufferView(changed, 0).banner).toBe('none');
    const reloaded = run(changed, { type: 'reloaded', file: file('new', 9), at: 1000 });
    expect(reloaded).toMatchObject({ status: 'clean', text: 'new', savedText: 'new', mtimeMs: 9 });
    expect(bufferView(reloaded, 1000)).toEqual({ banner: 'none', confirmOverwrite: false, reloadedFlash: true });
    expect(bufferView(reloaded, 2999).reloadedFlash).toBe(true);
    expect(bufferView(reloaded, 3000).reloadedFlash).toBe(false);
    expect(bufferView(reloaded, 10_000).reloadedFlash).toBe(false);
  });

  it('dirty + disk-changed → disk-changed-dirty, баннер; keep-mine снимает баннер, confirmOverwrite; saved — clean без него', () => {
    const changed = run(dirty(), { type: 'disk-changed', mtimeMs: 9 });
    expect(changed.status).toBe('disk-changed-dirty');
    expect(bufferView(changed, 0).banner).toBe('disk-changed');
    const kept = run(changed, { type: 'keep-mine' });
    expect(bufferView(kept, 0)).toEqual({ banner: 'none', confirmOverwrite: true, reloadedFlash: false });
    expect(isBufferDirty(kept)).toBe(true);
    const saved = run(kept, { type: 'save-started' }, { type: 'saved', mtimeMs: 12 });
    expect(saved).toMatchObject({ status: 'clean', savedText: 'ab', mtimeMs: 12 });
    expect(bufferView(saved, 0).confirmOverwrite).toBe(false);
  });

  it('disk-deleted → deleted; потом disk-changed → disk-changed-clean без правок и disk-changed-dirty с ними', () => {
    const deletedClean = run(clean(), { type: 'disk-deleted' });
    expect(deletedClean.status).toBe('deleted');
    expect(deletedClean.mtimeMs).toBeNull();
    expect(bufferView(deletedClean, 0).banner).toBe('deleted');
    expect(run(deletedClean, { type: 'disk-changed', mtimeMs: 20 }).status).toBe('disk-changed-clean');
    const deletedDirty = run(dirty(), { type: 'disk-deleted' });
    expect(run(deletedDirty, { type: 'disk-changed', mtimeMs: 20 }).status).toBe('disk-changed-dirty');
  });

  it('save-conflict → disk-changed-dirty с mtime диска', () => {
    const conflict = run(dirty(), { type: 'save-started' }, { type: 'save-conflict', mtimeMs: 30 });
    expect(conflict).toMatchObject({ status: 'disk-changed-dirty', diskMtimeMs: 30, mtimeMs: 1 });
  });

  it('save-started в saving — та же модель', () => {
    const saving = run(dirty(), { type: 'save-started' });
    expect(saving.status).toBe('saving');
    expect(bufferReducer(saving, { type: 'save-started' })).toBe(saving);
  });

  it("failed { not_found } при loading — error с кодом; при saving — назад в dirty", () => {
    const failedLoad = run(initialBuffer(), { type: 'failed', code: 'not_found' });
    expect(failedLoad).toMatchObject({ status: 'error', errorCode: 'not_found' });
    const failedSave = run(dirty(), { type: 'save-started' }, { type: 'failed', code: 'failed' });
    expect(failedSave).toMatchObject({ status: 'dirty', text: 'ab', savedText: 'a' });
  });

  it('правка во время saving остаётся правкой: после saved — dirty, сохранённым считается записанный текст', () => {
    const model = run(dirty(), { type: 'save-started' }, { type: 'edited', text: 'abc' }, { type: 'saved', mtimeMs: 5 });
    expect(model).toMatchObject({ status: 'dirty', text: 'abc', savedText: 'ab', mtimeMs: 5 });
  });

  it('loading и error правки и события диска не принимают', () => {
    const loading = initialBuffer();
    expect(bufferReducer(loading, { type: 'edited', text: 'x' })).toBe(loading);
    expect(bufferReducer(loading, { type: 'disk-changed', mtimeMs: 3 })).toBe(loading);
    expect(isBufferDirty(loading)).toBe(false);
  });

  it('только чтение (not-utf8, too-large): правка не принимается', () => {
    const readOnly = run(initialBuffer(), { type: 'loaded', file: { ...file('x', 1), readOnlyReason: 'not-utf8' } });
    expect(readOnly.readOnlyReason).toBe('not-utf8');
    expect(bufferReducer(readOnly, { type: 'edited', text: 'y' })).toBe(readOnly);
  });
});

describe('эхо своей записи (тест 2)', () => {
  it('после saved { 5 } событие disk-changed { 5 } статус не меняет', () => {
    const saved = run(dirty(), { type: 'save-started' }, { type: 'saved', mtimeMs: 5 });
    expect(saved.ownWriteMtimeMs).toBe(5);
    expect(run(saved, { type: 'disk-changed', mtimeMs: 5 })).toEqual(saved);
    expect(run(saved, { type: 'disk-changed', mtimeMs: 4 })).toEqual(saved);
  });

  it('disk-changed во время saving отложено: после saved { 5 } событие с 5 пропущено', () => {
    const saving = run(dirty(), { type: 'save-started' }, { type: 'disk-changed', mtimeMs: 5 });
    expect(saving).toMatchObject({ status: 'saving', pendingDiskMtimeMs: 5 });
    const saved = run(saving, { type: 'saved', mtimeMs: 5 });
    expect(saved).toMatchObject({ status: 'clean', pendingDiskMtimeMs: null });
  });

  it('с 7 — disk-changed-clean без правок и disk-changed-dirty с правками после начала записи', () => {
    const cleanAfter = run(dirty(), { type: 'save-started' }, { type: 'disk-changed', mtimeMs: 7 }, { type: 'saved', mtimeMs: 5 });
    expect(cleanAfter).toMatchObject({ status: 'disk-changed-clean', diskMtimeMs: 7, pendingDiskMtimeMs: null });
    const dirtyAfter = run(
      dirty(),
      { type: 'save-started' },
      { type: 'disk-changed', mtimeMs: 7 },
      { type: 'edited', text: 'abc' },
      { type: 'saved', mtimeMs: 5 },
    );
    expect(dirtyAfter.status).toBe('disk-changed-dirty');
  });
});
