/**
 * Тесты 1 и 11 (чистая часть) куска 7.2: корень «Файлов» по умолчанию и выбор человека,
 * раскрытые папки по ключу корня. Тесты 3 и 4 куска 7.3a: буферы живут с вкладкой, запись.
 */

import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TextFile } from '../../shared/files-types.js';
import type { GroupNode, TabSpec, WorkLayout } from '../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { tabId } from '../layout/ids.js';
import { useLayoutStore } from '../layout/store.js';
import { moveTab, pruneLayout } from '../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { bufferKey } from './buffer.js';
import { useNotesStore } from '../review/notes/store.js';
import { bindBuffersToLayouts, bufferName, defaultRoot, filesRootSpec, useFilesStore } from './store.js';

const worktree = (createdAt: string | null) => ({ path: '/wt/s02', branch: 'harnas/w-0003/s02', base: 'main', createdAt });

const entry = makeWork('w-01', {
  projectPath: '/tmp/proj',
  sessions: [
    makeSession('s-01', 'plain'),
    makeSession('s-02', 'wt', { worktree: worktree('2026-09-27T08:00:00.000Z') }),
    makeSession('s-04', 'planned', { worktree: worktree(null) }),
  ],
});
const key = '/tmp/proj w-01';

beforeEach(() => {
  useFilesStore.setState({ rootByWork: {}, expanded: {} });
});

describe('defaultRoot (тест 1)', () => {
  it('сессия с worktree → worktree; без — project; worktree с createdAt: null → project', () => {
    expect(defaultRoot(entry, 's-02')).toEqual({ kind: 'worktree', sessionId: 's-02' });
    expect(defaultRoot(entry, 's-01')).toEqual({ kind: 'project' });
    expect(defaultRoot(entry, 's-04')).toEqual({ kind: 'project' });
    expect(defaultRoot(entry, null)).toEqual({ kind: 'project' });
    expect(defaultRoot(entry, 's-99')).toEqual({ kind: 'project' });
  });
});

describe('filesRootSpec (тест 11)', () => {
  it('выбор человека держится при любом фокусе; без выбора — worktree сессии в фокусе', () => {
    expect(filesRootSpec({}, entry, 's-02')).toEqual({ kind: 'worktree', sessionId: 's-02' });
    useFilesStore.getState().setRoot(key, { kind: 'project' });
    const chosen = useFilesStore.getState().rootByWork;
    expect(filesRootSpec(chosen, entry, 's-02')).toEqual({ kind: 'project' });
    useFilesStore.getState().setRoot(key, { kind: 'worktree', sessionId: 's-02' });
    expect(filesRootSpec(useFilesStore.getState().rootByWork, entry, 's-01')).toEqual({ kind: 'worktree', sessionId: 's-02' });
    expect(filesRootSpec(useFilesStore.getState().rootByWork, entry, null)).toEqual({ kind: 'worktree', sessionId: 's-02' });
  });
});

describe('режим tree | search (кусок 7.4)', () => {
  it('openSearch — режим search работы и просьба о фокусе её поля; showTree — назад к дереву; другая работа не тронута (раунд fix-7.4, п. 1)', () => {
    useFilesStore.setState({ modeByWork: {}, focusSearch: null });
    useFilesStore.getState().openSearch(key);
    expect(useFilesStore.getState()).toMatchObject({ modeByWork: { [key]: 'search' }, focusSearch: key });
    expect(useFilesStore.getState().modeByWork['/tmp/proj w-02']).toBeUndefined();
    useFilesStore.getState().showTree(key);
    expect(useFilesStore.getState()).toMatchObject({ modeByWork: { [key]: 'tree' }, focusSearch: null });
  });
});

describe('toggleDir', () => {
  it('раскрывает и сворачивает папку своего корня, чужой корень не трогает; Set — новый', () => {
    const { toggleDir } = useFilesStore.getState();
    toggleDir('r1', 'src');
    const first = useFilesStore.getState().expanded.r1;
    expect([...(first ?? [])]).toEqual(['src']);
    toggleDir('r1', 'src/lib');
    expect(useFilesStore.getState().expanded.r1).not.toBe(first);
    expect([...(useFilesStore.getState().expanded.r1 ?? [])]).toEqual(['src', 'src/lib']);
    toggleDir('r1', 'src');
    expect([...(useFilesStore.getState().expanded.r1 ?? [])]).toEqual(['src/lib']);
    expect(useFilesStore.getState().expanded.r2).toBeUndefined();
  });
});

// ---- Буферы (кусок 7.3a, тесты 3 и 4) ---------------------------------------------------------

describe('буферы: жизнь по раскладке (тест 3)', () => {
  const W = '/tmp/proj w-01';
  const root = { workKey: W, spec: { kind: 'project' as const } };
  const fileTab = (path: string): TabSpec => ({ kind: 'file', id: tabId.file({ kind: 'project' }, path), root: { kind: 'project' }, path });
  const A = fileTab('src/a.ts');
  const B = fileTab('src/b.ts');
  let bridge: FakeBridge;
  let unbind: () => void;

  function layoutWith(...tabs: TabSpec[]): WorkLayout {
    const group: GroupNode = { type: 'group', id: 'g1', tabs, activeTabId: tabs[0]?.id ?? null };
    const other: GroupNode = { type: 'group', id: 'g2', tabs: [{ kind: 'mail', id: 'mail' }], activeTabId: 'mail' };
    return { root: { type: 'split', id: 's1', direction: 'row', ratio: 0.5, children: [group, other] }, activeGroupId: 'g1', closedTabs: [] };
  }

  beforeEach(() => {
    bridge = createFakeBridge();
    bridge.setFile(root, 'src/a.ts', { text: 'a', mtimeMs: 1, size: 1, binary: false, utf8: true, readOnlyReason: null });
    bridge.setFile(root, 'src/b.ts', { text: 'b', mtimeMs: 1, size: 1, binary: false, utf8: true, readOnlyReason: null });
    useFilesStore.setState({ buffers: {}, reveals: {} });
    useLayoutStore.setState({ activeWorkKey: W, layouts: { [W]: layoutWith(A, B) }, hydrated: { [W]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
    useLayoutStore.getState().setCloseGuard(null);
    unbind = bindBuffersToLayouts(bridge);
  });

  afterEach(() => unbind());

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('openBuffer дважды — один readText и один watch, модель clean', async () => {
    useFilesStore.getState().openBuffer(bridge, W, A.id, root, 'src/a.ts');
    useFilesStore.getState().openBuffer(bridge, W, A.id, root, 'src/a.ts');
    await settle();
    expect(bridge.readTextCalls).toHaveLength(1);
    expect(bridge.watchCalls).toHaveLength(1);
    expect(useFilesStore.getState().buffers[bufferKey(W, A.id)]?.model.status).toBe('clean');
  });

  it('requestCloseTabs, pruneLayout и drop отпускают буфер с unwatch; moveTab в другую группу — нет', async () => {
    const { openBuffer } = useFilesStore.getState();
    openBuffer(bridge, W, A.id, root, 'src/a.ts');
    openBuffer(bridge, W, B.id, root, 'src/b.ts');
    await settle();
    const [watchA, watchB] = bridge.watchCalls.map((call) => call.id);

    useLayoutStore.getState().apply(W, (layout) => moveTab(layout, A.id, { groupId: 'g2', index: 0 }));
    await settle();
    expect(useFilesStore.getState().buffers[bufferKey(W, A.id)]).toBeDefined();
    expect(bridge.unwatchCalls).toEqual([]);

    await useLayoutStore.getState().requestCloseTabs(W, [A.id]);
    await settle();
    expect(useFilesStore.getState().buffers[bufferKey(W, A.id)]).toBeUndefined();
    expect(bridge.unwatchCalls).toEqual([watchA]);

    useLayoutStore.getState().apply(W, (layout) => pruneLayout(layout, (tab) => tab.kind !== 'file'));
    await settle();
    expect(useFilesStore.getState().buffers[bufferKey(W, B.id)]).toBeUndefined();
    expect(bridge.unwatchCalls).toEqual([watchA, watchB]);

    // drop работы: вкладка снова открыта, буфер открыт — работа ушла из раскладок.
    useLayoutStore.setState({ layouts: { [W]: layoutWith(A) } });
    openBuffer(bridge, W, A.id, root, 'src/a.ts');
    await settle();
    useLayoutStore.getState().drop(W);
    await settle();
    expect(useFilesStore.getState().buffers).toEqual({});
    expect(bridge.unwatchCalls).toHaveLength(3);
  });

  it('закрыть и открыть заново до ответа чтения: старый ответ не применяется к новому буферу (fix-7.3 п. 2)', async () => {
    const reads: Array<(file: TextFile) => void> = [];
    const slow = { ...bridge, files: { ...bridge.files, readText: () => new Promise<TextFile>((resolve) => reads.push(resolve)) } };
    const file = (text: string, mtimeMs: number): TextFile => ({ text, mtimeMs, size: text.length, binary: false, utf8: true, readOnlyReason: null });
    useFilesStore.getState().openBuffer(slow, W, A.id, root, 'src/a.ts');
    await useLayoutStore.getState().requestCloseTabs(W, [A.id]);
    useLayoutStore.setState({ layouts: { [W]: layoutWith(A, B) } });
    // Тело вкладки создаёт `root` на каждый рендер — открытие заново приходит с новым объектом.
    useFilesStore.getState().openBuffer(slow, W, A.id, { ...root }, 'src/a.ts');
    expect(reads).toHaveLength(2);
    reads[0]?.(file('old', 1));
    await settle();
    expect(useFilesStore.getState().buffers[bufferKey(W, A.id)]?.model.status).toBe('loading');
    reads[1]?.(file('fresh', 2));
    await settle();
    expect(useFilesStore.getState().buffers[bufferKey(W, A.id)]?.model).toMatchObject({ status: 'clean', text: 'fresh', mtimeMs: 2 });
  });

  it('files.onChanged: clean — тихая перезагрузка с плашкой; dirty — disk-changed-dirty; удалён — deleted', async () => {
    const { openBuffer, dispatch } = useFilesStore.getState();
    openBuffer(bridge, W, A.id, root, 'src/a.ts');
    openBuffer(bridge, W, B.id, root, 'src/b.ts');
    await settle();
    const [watchA, watchB] = bridge.watchCalls.map((call) => call.id);
    const keyA = bufferKey(W, A.id);
    const keyB = bufferKey(W, B.id);
    dispatch(keyB, { type: 'edited', text: 'mine' });

    bridge.setFile(root, 'src/a.ts', { text: 'agent', mtimeMs: 7, size: 5, binary: false, utf8: true, readOnlyReason: null });
    bridge.emitFileChanged({ id: watchA ?? '', path: 'src/a.ts', mtimeMs: 7, deleted: false });
    bridge.emitFileChanged({ id: watchB ?? '', path: 'src/b.ts', mtimeMs: 7, deleted: false });
    await settle();
    const modelA = useFilesStore.getState().buffers[keyA]?.model;
    expect(modelA).toMatchObject({ status: 'clean', text: 'agent', mtimeMs: 7 });
    expect(modelA?.reloadedAt).not.toBeNull();
    expect(useFilesStore.getState().buffers[keyB]?.model).toMatchObject({ status: 'disk-changed-dirty', text: 'mine' });

    bridge.emitFileChanged({ id: watchA ?? '', path: 'src/a.ts', mtimeMs: null, deleted: true });
    await settle();
    expect(useFilesStore.getState().buffers[keyA]?.model.status).toBe('deleted');
  });

  it('revealAt — разовая позиция: takeReveal отдаёт её один раз', () => {
    useFilesStore.getState().revealAt(W, A.id, 3, 5);
    expect(useFilesStore.getState().takeReveal(bufferKey(W, A.id))).toEqual({ line: 3, col: 5 });
    expect(useFilesStore.getState().takeReveal(bufferKey(W, A.id))).toBeNull();
  });

  it('счёт грязных буферов уходит в main при каждом изменении (app:dirty-buffers)', async () => {
    const { openBuffer, dispatch } = useFilesStore.getState();
    openBuffer(bridge, W, A.id, root, 'src/a.ts');
    await settle();
    dispatch(bufferKey(W, A.id), { type: 'edited', text: 'x' });
    dispatch(bufferKey(W, A.id), { type: 'edited', text: 'xy' });
    dispatch(bufferKey(W, A.id), { type: 'edited', text: 'a' });
    expect(bridge.dirtyBufferCounts).toEqual([1, 0]);
  });

  it('отложенная запись заметок держит закрытие окна, как грязный буфер (раунд fix-final-c, п. 2)', async () => {
    const { openBuffer, dispatch } = useFilesStore.getState();
    openBuffer(bridge, W, A.id, root, 'src/a.ts');
    await settle();
    act(() => useNotesStore.setState({ pendingSaves: 1 }));
    dispatch(bufferKey(W, A.id), { type: 'edited', text: 'x' });
    act(() => useNotesStore.setState({ pendingSaves: 0 }));
    dispatch(bufferKey(W, A.id), { type: 'edited', text: 'a' });
    expect(bridge.dirtyBufferCounts).toEqual([1, 2, 1, 0]);
  });
});

describe('save (тест 4)', () => {
  const W = '/tmp/proj w-01';
  const root = { workKey: W, spec: { kind: 'project' as const } };
  const tab = tabId.file({ kind: 'project' }, 'a.ts');
  const key = bufferKey(W, tab);
  let bridge: FakeBridge;

  beforeEach(async () => {
    bridge = createFakeBridge();
    bridge.setFile(root, 'a.ts', { text: 'a', mtimeMs: 1, size: 1, binary: false, utf8: true, readOnlyReason: null });
    useFilesStore.setState({ buffers: {}, reveals: {} });
    useFilesStore.getState().openBuffer(bridge, W, tab, root, 'a.ts');
    await new Promise((resolve) => setTimeout(resolve, 0));
    useFilesStore.getState().dispatch(key, { type: 'edited', text: 'ab' });
  });

  it('write с mtimeMs буфера; ответ — saved, буфер clean', async () => {
    expect(await useFilesStore.getState().save(bridge, W, tab)).toBe('saved');
    expect(bridge.writes).toEqual([{ root, path: 'a.ts', text: 'ab', expectedMtimeMs: 1 }]);
    expect(useFilesStore.getState().buffers[key]?.model.status).toBe('clean');
  });

  it('буфер deleted → write с expectedMtimeMs: null', async () => {
    useFilesStore.getState().dispatch(key, { type: 'disk-deleted' });
    expect(await useFilesStore.getState().save(bridge, W, tab)).toBe('saved');
    expect(bridge.writes[0]?.expectedMtimeMs).toBeNull();
  });

  it('два save подряд без await — одна запись', async () => {
    const first = useFilesStore.getState().save(bridge, W, tab);
    const second = useFilesStore.getState().save(bridge, W, tab);
    expect(await first).toBe('saved');
    expect(await second).toBe('saved');
    expect(bridge.writes).toHaveLength(1);
  });

  it('висящая запись отпущенного буфера не достаётся новому буферу того же ключа (fix-7.3 п. 5)', async () => {
    let finishOld: (result: { ok: true; mtimeMs: number }) => void = () => {};
    const hanging = { ...bridge, files: { ...bridge.files, write: () => new Promise<{ ok: true; mtimeMs: number }>((resolve) => (finishOld = resolve)) } };
    const old = useFilesStore.getState().save(hanging, W, tab);
    // Сброс стора (как между тестами) или закрытие и открытие вкладки заново — буфер другой.
    useFilesStore.setState({ buffers: {}, reveals: {} });
    useFilesStore.getState().openBuffer(bridge, W, tab, { ...root }, 'a.ts');
    await new Promise((resolve) => setTimeout(resolve, 0));
    useFilesStore.getState().dispatch(key, { type: 'edited', text: 'abc' });
    expect(await useFilesStore.getState().save(bridge, W, tab)).toBe('saved');
    expect(bridge.writes).toEqual([{ root: { ...root }, path: 'a.ts', text: 'abc', expectedMtimeMs: 1 }]);
    // Поздний ответ старой записи не трогает новый буфер.
    useFilesStore.getState().dispatch(key, { type: 'edited', text: 'abcd' });
    finishOld({ ok: true, mtimeMs: 50 });
    await old;
    expect(useFilesStore.getState().buffers[key]?.model).toMatchObject({ status: 'dirty', text: 'abcd' });
  });

  it('conflict — disk-changed-dirty; overwrite — write с mtime диска', async () => {
    bridge.setWriteConflict(root, 'a.ts', 9);
    expect(await useFilesStore.getState().save(bridge, W, tab)).toBe('conflict');
    expect(useFilesStore.getState().buffers[key]?.model.status).toBe('disk-changed-dirty');
    expect(await useFilesStore.getState().save(bridge, W, tab, { overwrite: true })).toBe('saved');
    expect(bridge.writes[1]?.expectedMtimeMs).toBe(9);
  });

  it('отказ write — failed, буфер снова dirty', async () => {
    const failing = { ...bridge, files: { ...bridge.files, write: async () => Promise.reject({ code: 'files:denied', message: 'x' }) } };
    expect(await useFilesStore.getState().save(failing, W, tab)).toBe('failed');
    expect(useFilesStore.getState().buffers[key]?.model.status).toBe('dirty');
  });
});

describe('bufferName — имя в вопросах о файле, как у вкладки (раунд fix-live, D5)', () => {
  const W = '/tmp/proj w-01';
  const wt = (sessionId: string, path: string): TabSpec => ({
    kind: 'file',
    id: tabId.file({ kind: 'worktree', sessionId }, path),
    root: { kind: 'worktree', sessionId },
    path,
  });
  const S01 = wt('s-01', 'src/app.ts');
  const S02 = wt('s-02', 'src/app.ts');
  const ONLY = wt('s-02', 'src/only.ts');

  beforeEach(() => {
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [S01, S02, ONLY], activeTabId: S01.id };
    useLayoutStore.setState({ activeWorkKey: W, layouts: { [W]: { root: group, activeGroupId: 'g1', closedTabs: [] } }, hydrated: { [W]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
    useFilesStore.setState({ buffers: {}, reveals: {} });
  });

  it('один путь из двух worktree — вопрос называет файл с меткой корня, как заголовок вкладки', () => {
    expect(bufferName(bufferKey(W, S01.id))).toBe('app.ts · S01');
    expect(bufferName(bufferKey(W, S02.id))).toBe('app.ts · S02');
    expect(bufferName(bufferKey(W, ONLY.id))).toBe('only.ts');
  });

  it('длинное имя — полностью, без обрезки заголовка вкладки: диалог обрезает сам, полное — в title', () => {
    const long = `${'x'.repeat(60)}.ts`;
    const a = wt('s-01', long);
    const b = wt('s-02', long);
    const group: GroupNode = { type: 'group', id: 'g1', tabs: [a, b], activeTabId: a.id };
    useLayoutStore.setState({ layouts: { [W]: { root: group, activeGroupId: 'g1', closedTabs: [] } } });
    expect(bufferName(bufferKey(W, b.id))).toBe(`${long} · S02`);
  });

  it('вкладки уже нет в раскладке — имя файла буфера', () => {
    useLayoutStore.setState({ layouts: {} });
    useFilesStore.setState({ buffers: { [bufferKey(W, S02.id)]: { path: 'src/app.ts' } as never } });
    expect(bufferName(bufferKey(W, S02.id))).toBe('app.ts');
  });
});
