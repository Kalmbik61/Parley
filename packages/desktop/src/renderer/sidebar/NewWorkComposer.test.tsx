/**
 * Форма новой работы (кусок 3.5, спека 6.6): пределы полей `validateDraft`, порядок
 * `works.create` → `sessions.create`, вкладка новой сессии — только после снимка работ,
 * «Retry» повторяет лишь `sessions.create`, «Create more», агент и ярлык по умолчанию.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { tabId } from '../layout/ids.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { groups } from '../layout/tree.js';
import { workKey } from '../lib/tree-order.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { NewWorkComposer, validateDraft, type NewWorkDraft } from './NewWorkComposer.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(toast).mockClear();
});

const PROJECT = '/tmp/p';

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'cursor', label: 'Cursor', available: false },
];

function draft(patch: Partial<NewWorkDraft> = {}): NewWorkDraft {
  return {
    projectPath: PROJECT,
    title: 'T',
    goal: '',
    startSession: true,
    provider: 'claude',
    label: '',
    task: '',
    worktree: false,
    createMore: false,
    ...patch,
  };
}

describe('validateDraft (тест 1)', () => {
  it('без проекта — «Select a project folder»', () => {
    expect(validateDraft(draft({ projectPath: null })).projectPath).toBe('Select a project folder');
  });

  it('название: пусто и 121 символ — ошибка, 120 эмодзи — нет', () => {
    expect(validateDraft(draft({ title: '' })).title).toBe('Title: 1–120 characters');
    expect(validateDraft(draft({ title: 'a'.repeat(121) })).title).toBe('Title: 1–120 characters');
    expect(validateDraft(draft({ title: '😀'.repeat(120) })).title).toBeUndefined();
    expect(validateDraft(draft({ title: 'a'.repeat(120) })).title).toBeUndefined();
  });

  it('название обрезается по краям, как works.rename: только невидимые символы — ошибка, 120 + пробелы — нет', () => {
    expect(validateDraft(draft({ title: ' \u200B\u2060\uFEFF ' })).title).toBe('Title: 1–120 characters');
    expect(validateDraft(draft({ title: `  ${'a'.repeat(120)}\u200B ` })).title).toBeUndefined();
  });

  it('цель 4001, ярлык 41, задача 20001 — ошибки; ровно на пределе — нет', () => {
    const over = validateDraft(draft({ goal: 'g'.repeat(4001), label: 'l'.repeat(41), task: 't'.repeat(20001) }));
    expect(over.goal).toBe('Goal: up to 4,000 characters');
    expect(over.label).toBe('Label: up to 40 characters');
    expect(over.task).toBe('Task: up to 20,000 characters');
    expect(validateDraft(draft({ goal: 'g'.repeat(4000), label: 'l'.repeat(40), task: 't'.repeat(20000) }))).toEqual({});
  });

  it('при startSession без агента — «Select an agent»; без сессии агент не нужен', () => {
    expect(validateDraft(draft({ provider: null })).provider).toBe('Select an agent');
    expect(validateDraft(draft({ provider: null, startSession: false })).provider).toBeUndefined();
  });
});

let bridge: FakeBridge;

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('providers.list', async () => ({ providers: PROVIDERS }));
  bridge.setHandler('worktrees.available', async () => ({ available: true }));
  bridge.setHandler('works.create', async () => ({ workId: 'w-new' }));
  bridge.setHandler('sessions.create', async (params) => ({
    ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' },
  }));
  useWorksStore.setState({ entries: [makeWork('w-old', { projectPath: PROJECT })], branches: {}, loading: false, error: null });
  useLayoutStore.setState({
    activeWorkKey: null,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  // Без `init`: его `loadUi` затёр бы `lastProvider`, заданный тестом; `patchUi` пишет зеркало и так.
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true });
});

const NEW_KEY = workKey(PROJECT, 'w-new');

async function renderComposer(onOpenChange: (open: boolean) => void = () => {}): Promise<void> {
  render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} onOpenChange={onOpenChange} />);
  // Агент по умолчанию выбирается после `providers.list`.
  await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
  await act(async () => {});
}

function typeTitle(value: string): void {
  fireEvent.change(screen.getByLabelText(S.dialogs.newWork.titleField), { target: { value } });
}

const callsOf = (method: string): unknown[] =>
  bridge.calls.filter((call) => call.method === method).map((call) => call.params);

function emitNewWork(): void {
  act(() =>
    useWorksStore.setState({
      entries: [
        makeWork('w-old', { projectPath: PROJECT }),
        makeWork('w-new', { projectPath: PROJECT, sessions: [makeSession('s-01', 'Claude Code')] }),
      ],
    }),
  );
}

describe('NewWorkComposer — отправка', () => {
  it('тест 2: works.create с обрезанным названием, затем sessions.create с worktree; вкладка — только после снимка', async () => {
    await renderComposer();
    typeTitle('  \u200Btitle\u200B ');
    const worktree = await screen.findByRole('switch', { name: S.dialogs.newSession.inOwnWorktree });
    fireEvent.click(worktree);
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));

    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('works.create')).toEqual([{ projectPath: PROJECT, title: 'title', goal: '' }]);
    expect(callsOf('sessions.create')[0]).toMatchObject({ projectPath: PROJECT, workId: 'w-new', provider: 'claude', worktree: true, parent: null });

    // Снимка ещё нет — ни активной работы, ни вкладки в очереди: иначе мелькнуло бы «Session deleted».
    await act(async () => {});
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(useLayoutStore.getState().pending[NEW_KEY]).toBeUndefined();

    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBe(NEW_KEY);
    act(() => useLayoutStore.getState().hydrate(NEW_KEY, null));
    const layout = useLayoutStore.getState().layouts[NEW_KEY];
    expect(layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual([tabId.terminal('s-01')]);
    expect(useUiStore.getState().ui.lastProvider).toBe('claude');
  });

  it('тест 3: sessions.create падает — работа не пересоздаётся, ошибка по коду, Retry зовёт только sessions.create', async () => {
    let fail = true;
    bridge.setHandler('sessions.create', async (params) => {
      if (fail) throw { code: 'conflict', message: 'хост против' };
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } };
    });
    const onOpenChange: (open: boolean) => void = (open) => opened.push(open);
    const opened: boolean[] = [];
    await renderComposer(onOpenChange);
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));

    expect(await screen.findByText("Couldn't create session: conflicting state.")).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(1);
    expect(opened).toEqual([]);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('works.create')).toHaveLength(1);
    expect(callsOf('sessions.create')[1]).toMatchObject({ workId: 'w-new' });
    await waitFor(() => expect(opened).toEqual([false]));
  });

  it('ошибка works.create — текст createWorkspace, sessions.create не зовётся', async () => {
    bridge.setHandler('works.create', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    expect(await screen.findByText("Couldn't create workspace: host error.")).toBeTruthy();
    expect(callsOf('sessions.create')).toHaveLength(0);
  });

  it('ошибки полей не шлют ничего', async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    expect(await screen.findByText('Title: 1–120 characters')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
  });

  it('⌘Enter — то же, что «Create»', async () => {
    await renderComposer();
    typeTitle('title');
    fireEvent.keyDown(screen.getByLabelText(S.dialogs.newWork.titleField), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
  });

  it('тест 4: «Create more» — после успеха форма открыта, название пусто, проект и агент сохранены', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    fireEvent.click(screen.getByRole('checkbox', { name: S.dialogs.newWork.createMore }));
    typeTitle('first');
    fireEvent.change(screen.getByLabelText(S.dialogs.newWork.goalField), { target: { value: 'goal' } });
    fireEvent.change(screen.getByLabelText(S.dialogs.newSession.taskField), { target: { value: 'task' } });
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});

    expect(opened).toEqual([]);
    expect((screen.getByLabelText(S.dialogs.newWork.titleField) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(S.dialogs.newWork.goalField) as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByLabelText(S.dialogs.newSession.taskField) as HTMLTextAreaElement).value).toBe('');

    typeTitle('second');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('works.create')[1]).toEqual({ projectPath: PROJECT, title: 'second', goal: '' });
    expect(callsOf('sessions.create')[1]).toMatchObject({ provider: 'claude', projectPath: PROJECT });
  });

  it('без «Start a session» — только works.create; работа активна после снимка', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    fireEvent.click(screen.getByRole('switch', { name: S.dialogs.newWork.startSession }));
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('sessions.create')).toHaveLength(0);
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBe(NEW_KEY);
  });
});

describe('NewWorkComposer — агент и ярлык по умолчанию', () => {
  async function submitAndProvider(): Promise<Record<string, unknown>> {
    await renderComposer();
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    return callsOf('sessions.create')[0] as Record<string, unknown>;
  }

  it('тест 8: ui.lastProvider — он', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, lastProvider: 'codex' } });
    expect(await submitAndProvider()).toMatchObject({ provider: 'codex', label: 'Codex' });
  });

  it('тест 8: без lastProvider — claude', async () => {
    expect(await submitAndProvider()).toMatchObject({ provider: 'claude' });
  });

  it('тест 8: claude недоступен — первый доступный', async () => {
    bridge.setHandler('providers.list', async () => ({
      providers: [
        { id: 'claude', label: 'Claude Code', available: false },
        { id: 'cursor', label: 'Cursor', available: false },
        { id: 'codex', label: 'Codex', available: true },
      ],
    }));
    expect(await submitAndProvider()).toMatchObject({ provider: 'codex' });
  });

  it('тест 9: пустой ярлык — label провайдера; непустой — как введён', async () => {
    expect(await submitAndProvider()).toMatchObject({ label: 'Claude Code' });
    cleanup();
    bridge.calls.length = 0;
    await renderComposer();
    typeTitle('title');
    fireEvent.change(screen.getByLabelText(S.dialogs.newSession.labelField), { target: { value: 'мой ярлык' } });
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ label: 'мой ярлык' });
  });
});

describe('NewWorkComposer — раунд исправлений 1', () => {
  it('плейсхолдер агента — «Agent…», пока список агентов не пришёл', async () => {
    bridge.setHandler('providers.list', () => new Promise(() => {}));
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} onOpenChange={() => {}} />);
    expect(await screen.findByText('Agent…')).toBeTruthy();
    expect(screen.queryByText(S.dialogs.newSession.providerPlaceholder)).toBeNull();
  });

  it('двойной клик Create и двойной ⌘Enter во время ожидания — один works.create и один sessions.create', async () => {
    let finishWork: (value: { workId: string }) => void = () => {};
    let finishSession: () => void = () => {};
    bridge.setHandler('works.create', () => new Promise((resolve) => (finishWork = resolve)));
    bridge.setHandler(
      'sessions.create',
      (params) =>
        new Promise((resolve) => {
          finishSession = () => resolve({ ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } });
        }),
    );
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('title');
    const create = screen.getByRole('button', { name: S.common.create });
    const title = screen.getByLabelText(S.dialogs.newWork.titleField);
    const pressAll = (): void => {
      fireEvent.click(create);
      fireEvent.click(create);
      fireEvent.keyDown(title, { key: 'Enter', metaKey: true });
      fireEvent.keyDown(title, { key: 'Enter', metaKey: true });
    };
    pressAll();
    await act(async () => {});
    expect(callsOf('works.create')).toHaveLength(1);

    await act(async () => finishWork({ workId: 'w-new' }));
    expect(callsOf('sessions.create')).toHaveLength(1);
    pressAll();
    await act(async () => {});
    await act(async () => finishSession());
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toHaveLength(1);
    expect(callsOf('sessions.create')).toHaveLength(1);
  });

  it('снимок не принёс работу за 10 с — подписка снята, тост, вкладка не открывается', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});

    act(() => vi.advanceTimersByTime(9_000));
    expect(toast).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(toast).toHaveBeenCalledWith('Workspace created — it will appear in the sidebar shortly');

    // Поздний снимок уже не делает работу активной: человек мог уйти в другую.
    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(useLayoutStore.getState().pending[NEW_KEY]).toBeUndefined();
  });

  it('снимок пришёл до 10 с — работа активна, тоста нет', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});
    act(() => vi.advanceTimersByTime(5_000));
    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBe(NEW_KEY);
    act(() => vi.advanceTimersByTime(10_000));
    expect(toast).not.toHaveBeenCalled();
  });

  it('размонтирование снимает ожидание: ни активации, ни тоста', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(screen.getByRole('button', { name: S.common.create }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});
    cleanup();
    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(toast).not.toHaveBeenCalled();
  });
});
