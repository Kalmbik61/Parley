import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogSnapshot } from '@parley/protocol';
import { S } from '../../shared/strings.js';
import { fakeDictationDeps } from '../test-utils/dictation.js';
import { useUiStore } from '../store/ui.js';
import { useDictationStore } from '../voice/dictation-store.js';
import type { DictationDeps } from '../voice/dictation-store.js';
import { boardProjects } from './board-model.js';
import type { BoardSlot } from './board-store.js';
import { useBoardStore } from './board-store.js';
import { NewTaskForm } from './NewTaskForm.js';

const snap = (projectPath: string, titles: string[] = []): BacklogSnapshot => ({
  projectPath, sharedProjectPath: projectPath, version: 'v1', file: { relativePath: '.parley/backlog.md', exists: true }, rule: 'problems',
  diagnostics: [], suggestions: [],
  items: titles.map((title, i) => ({ id: `b-${String(i + 1).padStart(3, '0')}`, title, details: '', checked: false, section: null })),
});
const slot = (snapshot: BacklogSnapshot): BoardSlot => ({ snapshot, live: true });
const call = vi.fn();
const bridge = { call, on: vi.fn() };
const slots = new Map<string, BoardSlot>([['/p', slot(snap('/p'))], ['/inbox', slot(snap('/inbox'))]]);
const projects = boardProjects(slots, '/inbox');
const title = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: S.board.taskField }) as HTMLTextAreaElement;
const saveButton = (): HTMLButtonElement => screen.getByRole('button', { name: S.board.save }) as HTMLButtonElement;
const micButton = (): HTMLElement => within(screen.getByTestId('mic')).getByRole('button');

/** Голос окна включён, диктовка подставная; снимается в `afterEach`, чтобы запись не пережила тест. */
let disposeDictation: (() => void) | null = null;
function startDictation(deps: DictationDeps = fakeDictationDeps('spoken task')): void {
  useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
  disposeDictation = useDictationStore.getState().configure(deps);
}

beforeEach(() => {
  useBoardStore.setState({ supported: true, slots: new Map(slots), inboxPath: '/inbox', filter: { kind: 'all' } });
  call.mockReset();
});
afterEach(() => {
  cleanup();
  disposeDictation?.();
  disposeDictation = null;
});

describe('NewTaskForm', () => {
  it('Save пишет в проект фильтра', async () => {
    call.mockResolvedValue(snap('/p', ['Fix it']));
    const onClose = vi.fn();
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={0} onClose={onClose} />);
    fireEvent.change(title(), { target: { value: 'Fix it' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('backlog.add', { projectPath: '/p', title: 'Fix it' });
    expect(useBoardStore.getState().slots.get('/p')!.snapshot!.items).toHaveLength(1);
  });

  it('без проекта — во Входящие, первая строка — заголовок, остальное — детали', async () => {
    call.mockResolvedValue(snap('/inbox', ['Loose']));
    const onClose = vi.fn();
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath={null} dictate={0} onClose={onClose} />);
    fireEvent.change(title(), { target: { value: 'Loose\nsecond line' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('backlog.add', { projectPath: '/inbox', title: 'Loose', details: 'second line' });
  });

  it('пустой заголовок — Save выключен', () => {
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath={null} dictate={0} onClose={vi.fn()} />);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(title(), { target: { value: '   ' } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(title(), { target: { value: 'x' } });
    expect(saveButton().disabled).toBe(false);
  });

  it('ошибка записи — S.board.failed, форма остаётся', async () => {
    call.mockRejectedValue(new Error('boom'));
    const onClose = vi.fn();
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={0} onClose={onClose} />);
    fireEvent.change(title(), { target: { value: 'x' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(S.board.failed)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter во время диктовки завершает её и не сохраняет', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
    const dispose = useDictationStore.getState().configure(fakeDictationDeps('spoken task'));
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={0} onClose={vi.fn()} />);
    const mic = screen.getByTestId('mic');
    fireEvent.click(within(mic).getByRole('button'));
    await waitFor(() => expect(mic.dataset.state).toBe('recording'));
    fireEvent.keyDown(title(), { key: 'Enter' });
    await waitFor(() => expect(title().value).toBe('spoken task'));
    expect(call).not.toHaveBeenCalled();
    dispose();
  });

  it('во время записи Save выключен', async () => {
    startDictation();
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={0} onClose={vi.fn()} />);
    fireEvent.change(title(), { target: { value: 'x' } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(micButton());
    await waitFor(() => expect(screen.getByTestId('mic').dataset.state).toBe('recording'));
    expect(saveButton().disabled).toBe(true);
  });

  it('dictate: при монтировании включает диктовку', async () => {
    startDictation();
    render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={1} onClose={vi.fn()} />);
    await waitFor(() => expect(useDictationStore.getState().phase).toBe('recording'));
    expect(useDictationStore.getState().targetId).toBe('board:new-task');
  });

  it('рост dictate включает диктовку в открытой форме и не стирает введённое', async () => {
    startDictation();
    const form = render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={0} onClose={vi.fn()} />);
    fireEvent.change(title(), { target: { value: 'Keep me' } });
    expect(useDictationStore.getState().phase).toBe('idle');
    form.rerender(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={1} onClose={vi.fn()} />);
    await waitFor(() => expect(useDictationStore.getState().phase).toBe('recording'));
    expect(title().value).toBe('Keep me');
  });

  it('размонтирование во время записи отменяет её', async () => {
    const cancelRecording = vi.fn();
    startDictation({
      ...fakeDictationDeps('spoken task'),
      record: async () => ({ stop: async () => ({ pcm: new ArrayBuffer(4), durationMs: 1000, peak: 0.5 }), cancel: cancelRecording }),
    });
    const form = render(<NewTaskForm bridge={bridge} projects={projects} defaultPath="/p" dictate={0} onClose={vi.fn()} />);
    fireEvent.click(micButton());
    await waitFor(() => expect(useDictationStore.getState().phase).toBe('recording'));
    form.unmount();
    expect(useDictationStore.getState().phase).toBe('idle');
    expect(useDictationStore.getState().targetId).toBeNull();
    expect(cancelRecording).toHaveBeenCalledTimes(1);
  });
});
