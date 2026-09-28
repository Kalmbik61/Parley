/**
 * Кусок 7.3b, тесты 1, 3, 4, 8 и 9: тело вкладки файла с подставным Monaco и мостом. ⌘S и ⌥Z —
 * команды поддельного редактора (`press`), как их вызвал бы Monaco.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRoot, TextFile } from '../../../shared/files-types.js';
import type { TabSpec, WorkLayout } from '../../../shared/layout-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { tabId } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { groups } from '../../layout/tree.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { KeyCode, KeyMod, monacoMock } from '../../test-utils/monaco-mock.js';
import { makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { bufferKey } from '../buffer.js';
import { bindBuffersToLayouts, useFilesStore } from '../store.js';
import { FileBody } from './FileBody.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
vi.mock('@monaco-editor/react', async () => (await import('../../test-utils/monaco-mock.js')).monacoReactMock);
vi.mock('./monaco-setup.js', async () => (await import('../../test-utils/monaco-mock.js')).monacoSetupMock);

const W = '/tmp/proj w-01';
const WORKTREE = { path: '/wt/s02', branch: 'harnas/w-0001/s02', base: 'main', createdAt: '2026-09-27T08:00:00.000Z' };
const ENTRY = makeWork('w-01', { projectPath: '/tmp/proj', sessions: [makeSession('s-02', 'two', { worktree: WORKTREE })] });
const ROOT: FileRoot = { workKey: W, spec: { kind: 'project' } };

function fileTab(path: string, spec: FileRoot['spec'] = { kind: 'project' }): Extract<TabSpec, { kind: 'file' }> {
  return { kind: 'file', id: tabId.file(spec, path), root: spec, path };
}

function textFile(text: string, patch: Partial<TextFile> = {}): TextFile {
  return { text, mtimeMs: 100, size: text.length, binary: false, utf8: true, readOnlyReason: null, ...patch };
}

const TAB = fileTab('src/a.ts');
const SAVE = KeyMod.CtrlCmd | KeyCode.KeyS;

let bridge: FakeBridge;
let unbind: () => void;
let onClose: ReturnType<typeof vi.fn>;

function layoutWith(...tabs: TabSpec[]): WorkLayout {
  return { root: { type: 'group', id: 'g1', tabs, activeTabId: tabs[0]?.id ?? null }, activeGroupId: 'g1', closedTabs: [] };
}

function renderBody(tab = TAB): void {
  render(<FileBody bridge={bridge} workKey={W} entry={ENTRY} tab={tab} onClose={onClose} />);
}

async function editor(): Promise<(typeof monacoMock.editors)[number]> {
  await waitFor(() => expect(monacoMock.editors.length).toBeGreaterThan(0));
  const last = monacoMock.editors.at(-1);
  if (last === undefined) throw new Error('нет редактора');
  return last;
}

beforeEach(() => {
  monacoMock.reset();
  vi.mocked(toast).mockClear();
  bridge = createFakeBridge();
  onClose = vi.fn();
  useFilesStore.setState({ buffers: {}, reveals: {} });
  useLayoutStore.setState({ activeWorkKey: W, layouts: { [W]: layoutWith(TAB) }, hydrated: { [W]: true }, pending: {}, history: EMPTY_HISTORY, mru: {}, navigating: false });
  unbind = bindBuffersToLayouts(bridge);
});

afterEach(() => {
  cleanup();
  unbind();
});

describe('⌘S и конфликт (тест 1)', () => {
  it('⌘S зовёт write с expectedMtimeMs; conflict — вопрос; Overwrite пишет с новым mtime', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    renderBody();
    const textarea = await screen.findByTestId('monaco-textarea');
    fireEvent.change(textarea, { target: { value: 'mine\n' } });
    const fake = await editor();

    await act(async () => fake.press(SAVE));
    expect(bridge.writes).toEqual([{ root: ROOT, path: 'src/a.ts', text: 'mine\n', expectedMtimeMs: 100 }]);

    fireEvent.change(textarea, { target: { value: 'mine 2\n' } });
    bridge.setWriteConflict(ROOT, 'src/a.ts', 777);
    await act(async () => fake.press(SAVE));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('File changed on disk after you opened it. Overwrite the changes on disk?');

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(bridge.writes).toHaveLength(3));
    expect(bridge.writes[2]).toEqual({ root: ROOT, path: 'src/a.ts', text: 'mine 2\n', expectedMtimeMs: 777 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useFilesStore.getState().buffers[bufferKey(W, TAB.id)]?.model.status).toBe('clean');
  });

  it('Compare переводит тело в сравнение, число вкладок раскладки прежнее; Cancel закрывает вопрос', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('disk\n'));
    renderBody();
    const textarea = await screen.findByTestId('monaco-textarea');
    fireEvent.change(textarea, { target: { value: 'mine\n' } });
    bridge.setWriteConflict(ROOT, 'src/a.ts', 555);
    await act(async () => (await editor()).press(SAVE));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));

    await screen.findByTestId('monaco-diff-editor');
    expect((screen.getByTestId('monaco-diff-original') as HTMLTextAreaElement).value).toBe('disk\n');
    expect((screen.getByTestId('monaco-diff-modified') as HTMLTextAreaElement).value).toBe('mine\n');
    const layout = useLayoutStore.getState().layouts[W];
    if (layout === undefined) throw new Error('нет раскладки');
    expect(groups(layout).flatMap((group) => group.tabs)).toHaveLength(1);

    // Обратно к правке — Close сравнения; правка на месте.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(((await screen.findByTestId('monaco-textarea')) as HTMLTextAreaElement).value).toBe('mine\n');
  });

  it('Keep mine, затем ⌘S — сначала вопрос перезаписи, без записи; Cancel — записи нет', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    renderBody();
    fireEvent.change(await screen.findByTestId('monaco-textarea'), { target: { value: 'mine\n' } });
    await waitFor(() => expect(bridge.watchCalls).toHaveLength(1));
    act(() => bridge.emitFileChanged({ id: bridge.watchCalls[0]?.id ?? '', path: 'src/a.ts', mtimeMs: 300, deleted: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep mine' }));
    expect(screen.queryByTestId('disk-change-banner')).toBeNull();

    await act(async () => (await editor()).press(SAVE));
    await screen.findByRole('dialog');
    expect(bridge.writes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bridge.writes).toEqual([]);
  });

  it('ошибка записи — тост по коду: files:denied — «Path is outside…», прочее — errorText', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    renderBody();
    fireEvent.change(await screen.findByTestId('monaco-textarea'), { target: { value: 'b\n' } });
    const write = vi.spyOn(bridge.files, 'write').mockRejectedValueOnce({ code: 'files:denied', message: 'x' });
    await act(async () => (await editor()).press(SAVE));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Path is outside the workspace folders'));
    write.mockRejectedValueOnce({ code: 'internal', message: 'x' });
    await act(async () => (await editor()).press(SAVE));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("Couldn't save file: host error."));
  });
});

describe('только чтение (тест 3)', () => {
  it("readOnlyReason 'too-large' — редактор только для чтения и плашка", async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('big', { readOnlyReason: 'too-large' }));
    renderBody();
    expect(await screen.findByText('Large file — editing disabled')).toBeTruthy();
    expect((await editor()).options.readOnly).toBe(true);
  });

  it("'not-utf8' — плашка Not UTF-8", async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('x', { utf8: false, readOnlyReason: 'not-utf8' }));
    renderBody();
    expect(await screen.findByText('Not UTF-8 — editing disabled')).toBeTruthy();
  });
});

describe('тела по коду (тест 4)', () => {
  it('not_found — File not found и Close', async () => {
    renderBody();
    expect(await screen.findByText('File not found')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('files:denied — Session folder no longer exists и Close', async () => {
    bridge.setFile(ROOT, 'src/a.ts', { code: 'files:denied', message: 'gone' });
    renderBody();
    expect(await screen.findByText('Session folder no longer exists')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('files:too-large — File is larger than 20 MB и Reveal in Finder', async () => {
    bridge.setFile(ROOT, 'src/a.ts', { code: 'files:too-large', message: 'big' });
    renderBody();
    expect(await screen.findByText('File is larger than 20 MB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Finder' }));
    await waitFor(() => expect(bridge.revealedPaths).toEqual(['/tmp/proj/src/a.ts']));
  });

  it("двоичный — Binary file; Open in default app → app.openPath, ответ 'revealed' — тост", async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\0b', { binary: true }));
    bridge.setOpenPathResult('revealed');
    renderBody();
    expect(await screen.findByText('Binary file')).toBeTruthy();
    expect(monacoMock.editors).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Open in default app' }));
    await waitFor(() => expect(bridge.openedPaths).toEqual(['/tmp/proj/src/a.ts']));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith("This file type doesn't open here — revealed in Finder"));
  });

  it('путь файла worktree — абсолютный путь от папки worktree', async () => {
    const tab = fileTab('b.bin', { kind: 'worktree', sessionId: 's-02' });
    useLayoutStore.setState({ layouts: { [W]: layoutWith(tab) } });
    bridge.setFile({ workKey: W, spec: tab.root }, 'b.bin', textFile('\0', { binary: true }));
    renderBody(tab);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in default app' }));
    await waitFor(() => expect(bridge.openedPaths).toEqual(['/wt/s02/b.bin']));
  });
});

describe('сбой загрузки (тест 8)', () => {
  it("rejectInit — Editor didn't load, Retry и Open in default app; Retry монтирует заново", async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    monacoMock.rejectInit(new Error('monaco failed'));
    renderBody();
    expect(await screen.findByText("Editor didn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open in default app' }));
    await waitFor(() => expect(bridge.openedPaths).toEqual(['/tmp/proj/src/a.ts']));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('monaco-textarea')).toBeTruthy();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('синхронный бросок редактора — та же граница; опции — с renderWhitespace selection', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    monacoMock.throwOnRender(new Error('boom'));
    renderBody();
    expect(await screen.findByText("Editor didn't load")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in default app' })).toBeTruthy();
    monacoMock.throwOnRender(null);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const fake = await editor();
    expect(fake.options).toMatchObject({
      renderWhitespace: 'selection',
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
    });
    errorSpy.mockRestore();
  });
});

describe('⌥Z (тест 9)', () => {
  it('команда Alt+Z переключает wordWrap', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    renderBody();
    const fake = await editor();
    expect(fake.options.wordWrap).toBe('off');
    act(() => fake.press(KeyMod.Alt | KeyCode.KeyZ));
    expect(fake.options.wordWrap).toBe('on');
    act(() => fake.press(KeyMod.Alt | KeyCode.KeyZ));
    expect(fake.options.wordWrap).toBe('off');
  });
});

describe('изменение на диске', () => {
  it('Save again у удалённого — write с expectedMtimeMs: null (тест 5)', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    renderBody();
    await screen.findByTestId('monaco-textarea');
    await waitFor(() => expect(bridge.watchCalls).toHaveLength(1));
    act(() => bridge.emitFileChanged({ id: bridge.watchCalls[0]?.id ?? '', path: 'src/a.ts', mtimeMs: null, deleted: true }));
    expect((await screen.findByTestId('disk-change-banner')).textContent).toContain('File deleted on disk');
    fireEvent.click(screen.getByRole('button', { name: 'Save again' }));
    await waitFor(() => expect(bridge.writes).toHaveLength(1));
    expect(bridge.writes[0]?.expectedMtimeMs).toBeNull();
  });

  it('Reload — текст с диска, правка пропала; тихая перезагрузка clean — плашка Reloaded from disk', async () => {
    bridge.setFile(ROOT, 'src/a.ts', textFile('a\n'));
    renderBody();
    const textarea = (await screen.findByTestId('monaco-textarea')) as HTMLTextAreaElement;
    await waitFor(() => expect(bridge.watchCalls).toHaveLength(1));
    const watchId = bridge.watchCalls[0]?.id ?? '';

    // clean: тихо, с плашкой.
    bridge.setFile(ROOT, 'src/a.ts', textFile('agent\n', { mtimeMs: 200 }));
    act(() => bridge.emitFileChanged({ id: watchId, path: 'src/a.ts', mtimeMs: 200, deleted: false }));
    expect(await screen.findByText('Reloaded from disk')).toBeTruthy();
    await waitFor(() => expect(textarea.value).toBe('agent\n'));

    // dirty: баннер, Reload.
    fireEvent.change(textarea, { target: { value: 'mine\n' } });
    bridge.setFile(ROOT, 'src/a.ts', textFile('agent 2\n', { mtimeMs: 300 }));
    act(() => bridge.emitFileChanged({ id: watchId, path: 'src/a.ts', mtimeMs: 300, deleted: false }));
    expect((await screen.findByTestId('disk-change-banner')).textContent).toContain('File changed on disk (probably by the agent)');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(textarea.value).toBe('agent 2\n'));
    expect(screen.queryByTestId('disk-change-banner')).toBeNull();
  });
});
