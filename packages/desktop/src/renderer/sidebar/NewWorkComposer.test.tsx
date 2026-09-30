/**
 * Диалог «New workspace» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.7; поведение — спека Orca-UI 6.6): пределы
 * полей `validateDraft`, название из первого промпта, порядок `works.create` → `sessions.create`, вкладка новой
 * сессии — только после снимка работ, «Retry» повторяет лишь `sessions.create`, агент по умолчанию, проект,
 * «In its own worktree». Полей прежней формы (цель, ярлык, «Start a session», «Create more») больше нет.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { recordOnInsert } from '../test-utils/dom-insert.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { NewWorkComposer, titleFromPrompt, validateDraft, type NewWorkDraft } from './NewWorkComposer.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(toast).mockClear();
});

const PROJECT = '/tmp/p';

/** Невидимые символы формата, которые названию не место: строятся кодами, чтобы в исходнике не было невидимых знаков. */
const ZWSP = String.fromCharCode(0x200b);
const WORD_JOINER = String.fromCharCode(0x2060);
const BOM = String.fromCharCode(0xfeff);

const PROVIDERS = [
  { id: 'claude', label: 'Claude', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'cursor', label: 'Cursor', available: false },
];

function draft(patch: Partial<NewWorkDraft> = {}): NewWorkDraft {
  return { projectPath: PROJECT, title: 'T', prompt: '', provider: 'claude', ...patch };
}

describe('validateDraft (тест 1)', () => {
  it('без проекта — «Select a project folder»', () => {
    expect(validateDraft(draft({ projectPath: null })).projectPath).toBe('Select a project folder');
  });

  it('ни названия, ни первого промпта — «Enter a title or a first prompt»; есть промпт — названия хватает и без поля', () => {
    expect(validateDraft(draft({ title: '', prompt: '' })).title).toBe('Enter a title or a first prompt');
    expect(validateDraft(draft({ title: '   ', prompt: '  \n ' })).title).toBe('Enter a title or a first prompt');
    expect(validateDraft(draft({ title: '', prompt: 'Fix the login' })).title).toBeUndefined();
  });

  it('введённое название: 121 символ — ошибка, 120 знаков и 120 эмодзи — нет', () => {
    expect(validateDraft(draft({ title: 'a'.repeat(121) })).title).toBe('Title: 1–120 characters');
    expect(validateDraft(draft({ title: '😀'.repeat(120) })).title).toBeUndefined();
    expect(validateDraft(draft({ title: 'a'.repeat(120) })).title).toBeUndefined();
  });

  it('название обрезается по краям, как works.rename: только невидимые символы — как пустое, 120 + пробелы — нет', () => {
    expect(validateDraft(draft({ title: ` ${ZWSP}${WORD_JOINER}${BOM} ` })).title).toBe('Enter a title or a first prompt');
    expect(validateDraft(draft({ title: `  ${'a'.repeat(120)}${ZWSP} ` })).title).toBeUndefined();
  });

  it('первый промпт: 20001 — ошибка, ровно 20000 — нет', () => {
    expect(validateDraft(draft({ prompt: 't'.repeat(20001) })).prompt).toBe('First prompt: up to 20,000 characters');
    expect(validateDraft(draft({ prompt: 't'.repeat(20000) }))).toEqual({});
  });

  it('без агента — «Select an agent»', () => {
    expect(validateDraft(draft({ provider: null })).provider).toBe('Select an agent');
  });
});

describe('titleFromPrompt (1.7: «Taken from the first prompt if empty»)', () => {
  it('первая непустая строка, без пробелов по краям', () => {
    expect(titleFromPrompt('\n  \n  Fix the login flow \nsecond line')).toBe('Fix the login flow');
  });

  it('до 40 знаков — по кодовым точкам, эмодзи не рвётся', () => {
    expect(titleFromPrompt('a'.repeat(80))).toBe('a'.repeat(40));
    expect(titleFromPrompt('😀'.repeat(60))).toBe('😀'.repeat(40));
  });

  it('обрезанное название не кончается пробелом', () => {
    expect(titleFromPrompt(`${'a'.repeat(39)} tail`)).toBe('a'.repeat(39));
  });

  it('одни пробелы и невидимые символы — пусто', () => {
    expect(titleFromPrompt('')).toBe('');
    expect(titleFromPrompt(` \n${ZWSP}\n `)).toBe('');
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
  render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="" onOpenChange={onOpenChange} />);
  // Агент по умолчанию выбирается после `providers.list`.
  await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
  await act(async () => {});
}

// Ошибка поля лежит внутри его `<label>` и входит в подпись — поэтому поле ищется по началу подписи.
const titleField = (): HTMLInputElement => screen.getByLabelText(/^Title/) as HTMLInputElement;
const promptField = (): HTMLTextAreaElement => screen.getByLabelText(/^First prompt/) as HTMLTextAreaElement;
const create = (): HTMLButtonElement => screen.getByRole('button', { name: S.dialogs.newWork.submit }) as HTMLButtonElement;

function typeTitle(value: string): void {
  fireEvent.change(titleField(), { target: { value } });
}

function typePrompt(value: string): void {
  fireEvent.change(promptField(), { target: { value } });
}

const callsOf = (method: string): unknown[] =>
  bridge.calls.filter((call) => call.method === method).map((call) => call.params);

function emitNewWork(): void {
  act(() =>
    useWorksStore.setState({
      entries: [
        makeWork('w-old', { projectPath: PROJECT }),
        makeWork('w-new', { projectPath: PROJECT, sessions: [makeSession('s-01', '')] }),
      ],
    }),
  );
}

describe('NewWorkComposer — вид (1.7)', () => {
  it('поля 1.7: Project, Agent, Title, First prompt; Cancel и Create workspace; прежних полей нет', async () => {
    await renderComposer();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New workspace' })).toBeTruthy();
    expect(within(dialog).getByText('Project')).toBeTruthy();
    expect(within(dialog).getByText('Agent')).toBeTruthy();
    expect(titleField().placeholder).toBe('Taken from the first prompt if empty');
    expect(promptField().placeholder).toBe('What should the agent do?');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(create()).toBeTruthy();
    // Цели, «Start a session», ярлыка и «Create more» больше нет.
    expect(within(dialog).queryByText('Goal')).toBeNull();
    expect(within(dialog).queryByText('Label')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('switch', { name: 'Start a session' })).toBeNull();
  });

  it('проекты — сегмент из имён папок, полный путь во всплывающей подсказке; проект открывшего выбран', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-deep', { projectPath: '/private/var/folders/xy/harnas-e2e-cards-123456' })],
    });
    await renderComposer();
    const project = screen.getByRole('radiogroup', { name: 'Project' });
    const items = within(project).getAllByRole('radio');
    expect(items.map((item) => item.textContent)).toEqual(['harnas-e2e-cards-123456', 'p']);
    expect(items.map((item) => item.getAttribute('title'))).toEqual(['/private/var/folders/xy/harnas-e2e-cards-123456', PROJECT]);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });

  it('длинное имя папки обрезается, сегмент переносится и не шире диалога', async () => {
    const long = `/tmp/${'p'.repeat(200)}`;
    useWorksStore.setState({ entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-long', { projectPath: long })] });
    await renderComposer();
    const project = screen.getByRole('radiogroup', { name: 'Project' });
    expect(project.className).toContain('max-w-full');
    expect(project.className).toContain('flex-wrap');
    const item = within(project).getByRole('radio', { name: 'p'.repeat(200) });
    expect(item.className).toContain('max-w-[16rem]');
    expect(item.querySelector('span')?.className).toContain('truncate');
  });

  it('выбор другого проекта в сегменте; повторный клик по выбранному его не снимает', async () => {
    useWorksStore.setState({ entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-two', { projectPath: '/tmp/two' })] });
    await renderComposer();
    const project = screen.getByRole('radiogroup', { name: 'Project' });
    fireEvent.click(within(project).getByRole('radio', { name: 'two' }));
    expect(within(project).getByRole('radio', { name: 'two' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(project).getByRole('radio', { name: 'two' }));
    expect(within(project).getByRole('radio', { name: 'two' }).getAttribute('aria-checked')).toBe('true');
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('works.create')).toHaveLength(1));
    expect(callsOf('works.create')[0]).toMatchObject({ projectPath: '/tmp/two' });
  });

  it('«Choose a folder…» добавляет папку в сегмент и выбирает её', async () => {
    vi.spyOn(bridge.app, 'chooseFolder').mockResolvedValueOnce('/tmp/fresh');
    await renderComposer();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }));
    await waitFor(() => expect(within(screen.getByRole('radiogroup', { name: 'Project' })).getByRole('radio', { name: 'fresh' })).toBeTruthy());
    expect(within(screen.getByRole('radiogroup', { name: 'Project' })).getByRole('radio', { name: 'fresh' }).getAttribute('aria-checked')).toBe('true');
    // Отказ от выбора папки ничего не меняет.
    vi.spyOn(bridge.app, 'chooseFolder').mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }));
    await act(async () => {});
    expect(within(screen.getByRole('radiogroup', { name: 'Project' })).getByRole('radio', { name: 'fresh' }).getAttribute('aria-checked')).toBe('true');
  });

  it('окно без работ: сегмента проектов нет, есть «Choose a folder…»; без проекта — ошибка', async () => {
    useWorksStore.setState({ entries: [] });
    render(<NewWorkComposer open bridge={bridge} projectPath={null} title="" onOpenChange={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole('radiogroup', { name: 'Project' })).toBeNull();
    typeTitle('title');
    fireEvent.click(create());
    expect(await screen.findByText('Select a project folder')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
  });

  it('⌘N без проекта открывшего — по умолчанию проект активной работы', async () => {
    useWorksStore.setState({ entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-two', { projectPath: '/tmp/two' })] });
    useLayoutStore.setState({ activeWorkKey: workKey('/tmp/two', 'w-two') });
    render(<NewWorkComposer open bridge={bridge} projectPath={null} title="" onOpenChange={() => {}} />);
    await act(async () => {});
    expect(within(screen.getByRole('radiogroup', { name: 'Project' })).getByRole('radio', { name: 'two' }).getAttribute('aria-checked')).toBe('true');
  });

  it('«+» заголовка проекта — его проект, а не активной работы', async () => {
    useWorksStore.setState({ entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-two', { projectPath: '/tmp/two' })] });
    useLayoutStore.setState({ activeWorkKey: workKey('/tmp/two', 'w-two') });
    await renderComposer();
    expect(within(screen.getByRole('radiogroup', { name: 'Project' })).getByRole('radio', { name: 'p' }).getAttribute('aria-checked')).toBe('true');
  });

  it('агент — сегмент только доступных провайдеров, подписи как в строке статуса', async () => {
    await renderComposer();
    const agent = screen.getByRole('radiogroup', { name: 'Agent' });
    expect(within(agent).getAllByRole('radio').map((item) => item.textContent)).toEqual(['Claude Code', 'Codex']);
    expect(within(agent).getByRole('radio', { name: 'Claude Code' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('NewWorkComposer — отправка', () => {
  it('тест 2: works.create с обрезанным названием и пустой целью, затем sessions.create с промптом и worktree; вкладка — только после снимка', async () => {
    await renderComposer();
    typeTitle(`  ${ZWSP}title${ZWSP} `);
    typePrompt('Fix the login flow');
    const worktree = await screen.findByRole('switch', { name: S.dialogs.newSession.inOwnWorktree });
    fireEvent.click(worktree);
    fireEvent.click(create());

    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('works.create')).toEqual([{ projectPath: PROJECT, title: 'title', goal: '' }]);
    expect(callsOf('sessions.create')[0]).toEqual({
      projectPath: PROJECT,
      workId: 'w-new',
      provider: 'claude',
      label: '',
      task: 'Fix the login flow',
      parent: null,
      worktree: true,
    });

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

  it('пустое название — из первого промпта: первая строка, до 40 знаков', async () => {
    await renderComposer();
    typePrompt(`\n${'w'.repeat(60)}\nsecond`);
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('works.create')).toHaveLength(1));
    expect(callsOf('works.create')[0]).toEqual({ projectPath: PROJECT, title: 'w'.repeat(40), goal: '' });
    expect(callsOf('sessions.create')[0]).toMatchObject({ task: `\n${'w'.repeat(60)}\nsecond` });
  });

  it('пустой промпт — тихий старт (task пуст), название обязательно', async () => {
    await renderComposer();
    fireEvent.click(create());
    expect(await screen.findByText('Enter a title or a first prompt')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);

    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ task: '', label: '' });
  });

  it('тест 3: sessions.create падает — работа не пересоздаётся, ошибка по коду, Retry зовёт только sessions.create', async () => {
    let fail = true;
    bridge.setHandler('sessions.create', async (params) => {
      if (fail) throw { code: 'conflict', message: 'хост против' };
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } };
    });
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('title');
    fireEvent.click(create());

    expect(await screen.findByText("Couldn't create session: conflicting state.")).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(1);
    expect(opened).toEqual([]);
    // Работа уже есть: проект и название заперты, агент и промпт — нет, чтобы поправить и повторить.
    expect(titleField().disabled).toBe(true);
    expect(within(screen.getByRole('radiogroup', { name: 'Project' })).getAllByRole('radio').every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
    expect(promptField().disabled).toBe(false);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('works.create')).toHaveLength(1);
    expect(callsOf('sessions.create')[1]).toMatchObject({ workId: 'w-new' });
    await waitFor(() => expect(opened).toEqual([false]));
  });

  it('Retry берёт агента и промпт, которые человек поправил после сбоя', async () => {
    let fail = true;
    bridge.setHandler('sessions.create', async (params) => {
      if (fail) throw { code: 'internal', message: 'сбой' };
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } };
    });
    await renderComposer();
    typeTitle('title');
    typePrompt('first');
    fireEvent.click(create());
    await screen.findByText("Couldn't create session: host error.");

    fail = false;
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Agent' })).getByRole('radio', { name: 'Codex' }));
    typePrompt('second');
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('sessions.create')[1]).toMatchObject({ provider: 'codex', task: 'second' });
  });

  it('ошибка works.create — текст createWorkspace, sessions.create не зовётся', async () => {
    bridge.setHandler('works.create', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(create());
    expect(await screen.findByText("Couldn't create workspace: host error.")).toBeTruthy();
    expect(callsOf('sessions.create')).toHaveLength(0);
  });

  it('ошибки полей не шлют ничего', async () => {
    await renderComposer();
    typeTitle('a'.repeat(121));
    fireEvent.click(create());
    expect(await screen.findByText('Title: 1–120 characters')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
  });

  it('⌘Enter — то же, что «Create workspace»', async () => {
    await renderComposer();
    typeTitle('title');
    fireEvent.keyDown(titleField(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
  });

  it('удачное создание закрывает диалог: onOpenChange(false)', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(opened).toEqual([false]));
  });
});

describe('NewWorkComposer — агент по умолчанию', () => {
  async function submitAndProvider(): Promise<Record<string, unknown>> {
    await renderComposer();
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    return callsOf('sessions.create')[0] as Record<string, unknown>;
  }

  it('тест 8: ui.lastProvider — он', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, lastProvider: 'codex' } });
    expect(await submitAndProvider()).toMatchObject({ provider: 'codex' });
  });

  it('тест 8: без lastProvider — claude', async () => {
    expect(await submitAndProvider()).toMatchObject({ provider: 'claude' });
  });

  it('тест 8: claude недоступен — первый доступный', async () => {
    bridge.setHandler('providers.list', async () => ({
      providers: [
        { id: 'claude', label: 'Claude', available: false },
        { id: 'cursor', label: 'Cursor', available: false },
        { id: 'codex', label: 'Codex', available: true },
      ],
    }));
    expect(await submitAndProvider()).toMatchObject({ provider: 'codex' });
  });

  it('выбор агента в сегменте — он уходит в sessions.create и запоминается', async () => {
    await renderComposer();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Agent' })).getByRole('radio', { name: 'Codex' }));
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'codex' });
    expect(useUiStore.getState().ui.lastProvider).toBe('codex');
  });
});

describe('NewWorkComposer — раунд исправлений 1', () => {
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
    const pressAll = (): void => {
      fireEvent.click(create());
      fireEvent.click(create());
      fireEvent.keyDown(titleField(), { key: 'Enter', metaKey: true });
      fireEvent.keyDown(titleField(), { key: 'Enter', metaKey: true });
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
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});

    act(() => vi.advanceTimersByTime(9_000));
    expect(toast).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(toast).toHaveBeenCalledWith('Session started — it will appear in the sidebar shortly');

    // Поздний снимок уже не делает работу активной: человек мог уйти в другую.
    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(useLayoutStore.getState().pending[NEW_KEY]).toBeUndefined();
  });

  it('снимок пришёл до 10 с — работа активна, тоста нет', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(create());
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
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});
    cleanup();
    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    act(() => vi.advanceTimersByTime(10_000));
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('NewWorkComposer — раунд исправлений 2 (агент по умолчанию, worktree)', () => {
  /** `providers.list`, который тест отпускает сам, — ответ приходит после открытия диалога. */
  function deferProviders(): () => Promise<void> {
    let release: () => void = () => {};
    bridge.setHandler('providers.list', () => new Promise((resolve) => (release = () => resolve({ providers: PROVIDERS }))));
    return async () => act(async () => release());
  }

  it('providers.list пришёл после открытия, затем Create — без «Select an agent», с агентом по умолчанию', async () => {
    const release = deferProviders();
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />);
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
    await release();
    expect(within(screen.getByRole('radiogroup', { name: 'Agent' })).getByRole('radio', { name: 'Claude Code' }).getAttribute('aria-checked')).toBe('true');
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(screen.queryByText(S.dialogs.newWork.agentRequired)).toBeNull();
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude' });
  });

  it('Create раньше ответа providers.list — диалог дожидается его и создаёт с агентом по умолчанию, ошибки агента нет', async () => {
    const release = deferProviders();
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />);
    typeTitle('title');
    fireEvent.click(create());
    await act(async () => {});
    expect(screen.queryByText(S.dialogs.newWork.agentRequired)).toBeNull();
    expect(callsOf('works.create')).toHaveLength(0);
    await release();
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(screen.queryByText(S.dialogs.newWork.agentRequired)).toBeNull();
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude' });
  });

  it('«In its own worktree» — только у git-проекта (worktrees.available)', async () => {
    bridge.setHandler('worktrees.available', async () => ({ available: false }));
    await renderComposer();
    expect(screen.queryByRole('switch', { name: S.dialogs.newSession.inOwnWorktree })).toBeNull();
    cleanup();
    bridge.setHandler('worktrees.available', async () => ({ available: true }));
    await renderComposer();
    expect(await screen.findByRole('switch', { name: S.dialogs.newSession.inOwnWorktree })).toBeTruthy();
  });
});

describe('NewWorkComposer — начальное название (кусок 6.2)', () => {
  it('проп title — начальное название; works.create не зовётся, пока человек не нажал Create workspace', async () => {
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="Редизайн окна" onOpenChange={() => {}} />);
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
    expect(titleField().value).toBe('Редизайн окна');
    expect(callsOf('works.create')).toEqual([]);
  });
});

describe('NewWorkComposer — форма на открытии', () => {
  it('повторное открытие: название и промпт появляются уже сброшенными — сброс до отрисовки, а не после неё', async () => {
    const element = (open: boolean): JSX.Element => (
      <NewWorkComposer open={open} bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />
    );
    const view = render(element(true));
    await act(async () => {});
    typeTitle('Old title');
    fireEvent.change(promptField(), { target: { value: 'Old prompt' } });
    view.rerender(element(false));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Что поля показывают в тот миг, когда диалог попал в DOM: с `useEffect` сброса тут стояли бы прежние «Old …».
    const shown = recordOnInsert((inserted) => {
      const title = inserted.querySelector<HTMLInputElement>('input');
      const prompt = inserted.querySelector<HTMLTextAreaElement>('textarea');
      return title === null || prompt === null ? null : { title: title.value, prompt: prompt.value };
    });
    try {
      view.rerender(element(true));
    } finally {
      shown.stop();
    }
    expect(shown.seen).toEqual([{ title: '', prompt: '' }]);
  });
});
