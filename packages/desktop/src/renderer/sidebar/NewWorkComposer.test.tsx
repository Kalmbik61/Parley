/**
 * Диалог «New workspace» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.7; поведение — спека Orca-UI 6.6): пределы
 * полей `validateDraft`, название из первого промпта, порядок `works.create` → `sessions.create` → `rooms.create` →
 * `rooms.send`, работа без агентов (только `works.create`), «Put them in a room» (комната или отдельные сессии), первый
 * промпт в комнате, вкладка новой сессии или комнаты — только после снимка работ, «Retry» повторяет лишь недостающее,
 * агент по умолчанию, проект, «In its own worktree». Полей прежней формы (цель, ярлык, «Start a session», «Create more»)
 * больше нет. Перед `works.create` — согласие на папку (спека 2026-10-21, 4.2 п. 1): `trust.list`, диалог «Trust … for agents?».
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
import { fakeDictationDeps } from '../test-utils/dictation.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { chooseOption, installRadixSelectPolyfills } from '../test-utils/radix-select.js';
import { makeRoom, makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { useDictationStore } from '../voice/dictation-store.js';
import { NewWorkComposer, titleFromPrompt, validateDraft, type NewWorkDraft } from './NewWorkComposer.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

installRadixSelectPolyfills();

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
  return { projectPath: PROJECT, title: 'T', prompt: '', agentCount: 1, ...patch };
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

  it('без агентов названию не из чего взяться — «Enter a title»; введённое название проходит', () => {
    expect(validateDraft(draft({ agentCount: 0, title: '', prompt: '' })).title).toBe('Enter a title');
    expect(validateDraft(draft({ agentCount: 0, title: '  ', prompt: '' })).title).toBe('Enter a title');
    expect(validateDraft(draft({ agentCount: 0, title: 'Solo', prompt: '' }))).toEqual({});
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
/** Номер следующей сессии, которую вернёт `sessions.create`: s-01, s-02, … */
let nextSession = 1;

beforeEach(() => {
  nextSession = 1;
  bridge = createFakeBridge();
  bridge.setHandler('providers.list', async () => ({ providers: PROVIDERS }));
  bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('worktrees.available', async () => ({ available: true }));
  bridge.setHandler('works.create', async () => ({ workId: 'w-new' }));
  bridge.setHandler('sessions.create', async (params) => ({
    ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: `s-${String(nextSession++).padStart(2, '0')}` },
  }));
  bridge.setHandler('rooms.create', async () => ({ roomId: 'r-01' }));
  bridge.setHandler('rooms.send', async () => ({ messageId: 'm-01' }));
  // Папки тестов уже доверены: диалог доверия — предмет отдельного describe ниже.
  bridge.setTrustFolders(['/tmp/p', '/tmp/two', '/tmp/fresh', '/tmp/gone'].map((folder) => ({ folder, grantedAt: '2026-10-21T10:00:00.000Z', by: 'window' as const })));
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
const rows = (): HTMLElement[] => [...screen.getByRole('dialog').querySelectorAll<HTMLElement>('[data-agent-row]')];
const providerRadio = (row: number, name: string): HTMLElement =>
  within(within(rows()[row] as HTMLElement).getByRole('radiogroup', { name: `Agent ${row + 1}` })).getByRole('radio', { name });
const roomSwitch = (): HTMLButtonElement | null => screen.queryByRole('switch', { name: 'Put them in a room' }) as HTMLButtonElement | null;
const worktreeSwitch = (): HTMLButtonElement | null => screen.queryByRole('switch', { name: S.dialogs.newSession.inOwnWorktree }) as HTMLButtonElement | null;

async function addAgent(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) fireEvent.click(screen.getByRole('button', { name: S.dialogs.newSession.addAgent }));
  await act(async () => {});
}

function typeTitle(value: string): void {
  fireEvent.change(titleField(), { target: { value } });
}

function typePrompt(value: string): void {
  fireEvent.change(promptField(), { target: { value } });
}

const callsOf = (method: string): Array<Record<string, unknown>> =>
  bridge.calls.filter((call) => call.method === method).map((call) => call.params as Record<string, unknown>);

/** Снимок работ принёс новую работу: с сессиями и, если есть, комнатой. */
function emitNewWork(sessions: string[] = ['s-01'], roomId: string | null = null): void {
  const room = roomId === null ? [] : [{ ...makeRoom(roomId, 'Room 1'), members: sessions, lead: sessions[0] ?? '' }];
  act(() =>
    useWorksStore.setState({
      entries: [
        makeWork('w-old', { projectPath: PROJECT }),
        makeWork('w-new', { projectPath: PROJECT, sessions: sessions.map((id) => makeSession(id, '')), rooms: room }),
      ],
    }),
  );
}

const openTabs = (): string[] => {
  const layout = useLayoutStore.getState().layouts[NEW_KEY];
  return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
};

describe('NewWorkComposer — диктовка (спека 3.2)', () => {
  it('⌘⇧M в поле первого промпта внутри диалога — диктовка; Esc записи не закрывает диалог', async () => {
    useUiStore.setState({ ui: { ...useUiStore.getState().ui, voice: { enabled: true, model: 'small', language: 'auto' } } });
    const dispose = useDictationStore.getState().configure(fakeDictationDeps('hello from voice'));
    const onOpenChange = vi.fn();
    await renderComposer(onOpenChange);
    await addAgent();
    const prompt = promptField();
    prompt.focus();
    fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('mic').dataset.state).toBe('recording'));
    // Radix слушает Esc на `document`: событие идёт с поля, как от настоящей клавиши.
    fireEvent.keyDown(prompt, { key: 'Escape' });
    // Диалог открыт «пропом», поэтому закрытие видно только по просьбе Radix закрыться.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByTestId('mic').dataset.state).toBe('ready');
    fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('mic').dataset.state).toBe('recording'));
    fireEvent.keyDown(prompt, { key: 'M', code: 'KeyM', metaKey: true, shiftKey: true });
    await waitFor(() => expect(prompt.value).toBe('hello from voice'));
    dispose();
  });
});

describe('NewWorkComposer — ⌘Enter во время диктовки', () => {
  it('диктовка идёт: ⌘Enter завершает её, работа не создаётся', async () => {
    const finish = vi.spyOn(useDictationStore.getState(), 'finishBeforeSend').mockReturnValue(true);
    await renderComposer();
    await addAgent();
    typeTitle('title');
    fireEvent.keyDown(promptField(), { key: 'Enter', metaKey: true });
    expect(finish).toHaveBeenCalledWith('new-workspace');
    await act(async () => {});
    expect(callsOf('works.create')).toHaveLength(0);
    finish.mockRestore();
  });
});

describe('NewWorkComposer — вид (1.7)', () => {
  it('без агентов: Project, Title, блок Agents с «Add agent»; промпта, worktree и переключателя комнаты нет; прежних полей нет', async () => {
    await renderComposer();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New workspace' })).toBeTruthy();
    expect(within(dialog).getByText('Project')).toBeTruthy();
    expect(within(dialog).getByText('Agents')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: S.dialogs.newSession.addAgent })).toBeTruthy();
    expect(rows()).toHaveLength(0);
    expect(titleField().placeholder).toBe('Name the workspace');
    expect(screen.queryByLabelText(/^First prompt/)).toBeNull();
    expect(worktreeSwitch()).toBeNull();
    expect(roomSwitch()).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(create()).toBeTruthy();
    // Цели, «Start a session», ярлыка и «Create more» больше нет.
    expect(within(dialog).queryByText('Goal')).toBeNull();
    expect(within(dialog).queryByText('Label')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByRole('switch', { name: 'Start a session' })).toBeNull();
  });

  it('первый агент: строка, поле First prompt, worktree; название берётся из промпта; переключателя комнаты ещё нет', async () => {
    await renderComposer();
    await addAgent();
    expect(rows()).toHaveLength(1);
    expect(promptField().placeholder).toBe('What should the agent do?');
    expect(titleField().placeholder).toBe('Taken from the first prompt if empty');
    expect(worktreeSwitch()).toBeTruthy();
    expect(roomSwitch()).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Lead|Make lead)$/ })).toBeNull();
    // Строка — та же, что в «New session or room»: роль, пилюли провайдеров, «×».
    expect(providerRadio(0, 'Claude').getAttribute('aria-checked')).toBe('true');
    expect(providerRadio(0, 'Codex').getAttribute('aria-checked')).toBe('false');
    expect(within(rows()[0] as HTMLElement).getByRole('button', { name: S.dialogs.newSession.removeAgent })).toBeTruthy();
  });

  it('второй агент: переключатель «Put them in a room» включён, у строк звёзды ведущего; убрали агента — переключатель пропал', async () => {
    await renderComposer();
    await addAgent(2);
    expect(roomSwitch()?.getAttribute('aria-checked')).toBe('true');
    expect(screen.getAllByRole('button', { name: /^(Lead|Make lead)$/ }).map((star) => star.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    fireEvent.click(roomSwitch() as HTMLElement);
    expect(screen.queryByRole('button', { name: /^(Lead|Make lead)$/ })).toBeNull();
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: S.dialogs.newSession.removeAgent }));
    expect(roomSwitch()).toBeNull();
  });

  it('удаление последнего агента возвращает работу без агентов: промпт и worktree пропали', async () => {
    await renderComposer();
    await addAgent();
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: S.dialogs.newSession.removeAgent }));
    expect(rows()).toHaveLength(0);
    expect(screen.queryByLabelText(/^First prompt/)).toBeNull();
    expect(worktreeSwitch()).toBeNull();
  });

  it('проекты — сегмент из имён папок, полный путь во всплывающей подсказке; проект открывшего выбран', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-deep', { projectPath: '/private/var/folders/xy/parley-e2e-cards-123456' })],
    });
    await renderComposer();
    const project = screen.getByRole('radiogroup', { name: 'Project' });
    const items = within(project).getAllByRole('radio');
    expect(items.map((item) => item.textContent)).toEqual(['parley-e2e-cards-123456', 'p']);
    expect(items.map((item) => item.getAttribute('title'))).toEqual(['/private/var/folders/xy/parley-e2e-cards-123456', PROJECT]);
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

  // Спека архива комнат и проектов, 6.3: проект, убранный из списка («Remove from list…»), в выборе не показывается.
  it('убранный из списка проект в сегменте не показывается', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-gone', { projectPath: '/tmp/gone', status: 'archived' })],
    });
    useUiStore.setState({ ui: { ...DEFAULT_UI, hiddenProjects: ['/tmp/gone'] } });
    await renderComposer();
    const items = within(screen.getByRole('radiogroup', { name: 'Project' })).getAllByRole('radio');
    expect(items.map((item) => item.textContent)).toEqual(['p']);
  });

  it('убранный проект виден, когда он выбран: «+» его заголовка в режиме показа архивных и «Choose a folder…»', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-gone', { projectPath: '/tmp/gone', status: 'archived' })],
    });
    useUiStore.setState({ ui: { ...DEFAULT_UI, hiddenProjects: ['/tmp/gone', '/tmp/fresh'] } });
    render(<NewWorkComposer open bridge={bridge} projectPath="/tmp/gone" title="" onOpenChange={() => {}} />);
    await act(async () => {});
    const group = (): HTMLElement => screen.getByRole('radiogroup', { name: 'Project' });
    expect(within(group()).getAllByRole('radio').map((item) => item.textContent)).toEqual(['gone', 'p']);
    expect(within(group()).getByRole('radio', { name: 'gone' }).getAttribute('aria-checked')).toBe('true');

    vi.spyOn(bridge.app, 'chooseFolder').mockResolvedValueOnce('/tmp/fresh');
    fireEvent.click(screen.getByRole('button', { name: 'Choose a folder…' }));
    await waitFor(() => expect(within(group()).getByRole('radio', { name: 'fresh' }).getAttribute('aria-checked')).toBe('true'));
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

  it('пилюли провайдеров — как в «New session or room»: доступные и недоступный, выбор меняет агента', async () => {
    await renderComposer();
    await addAgent();
    expect(providerRadio(0, 'Cursor')).toBeTruthy();
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(providerRadio(0, 'Codex').getAttribute('aria-checked')).toBe('true');
    expect(providerRadio(0, 'Claude').getAttribute('aria-checked')).toBe('false');
  });
});

describe('NewWorkComposer — работа без агентов', () => {
  it('создаётся только works.create: ни sessions.create, ни rooms.create; работа становится активной, вкладки нет; диалог закрывается', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('  Solo work ');
    fireEvent.click(create());

    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toEqual([{ projectPath: PROJECT, title: 'Solo work', goal: '' }]);
    expect(callsOf('sessions.create')).toEqual([]);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(callsOf('rooms.send')).toEqual([]);

    // Работа становится активной только когда снимок принёс её; вкладки у пустой работы нет.
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    emitNewWork([]);
    expect(useLayoutStore.getState().activeWorkKey).toBe(NEW_KEY);
    act(() => useLayoutStore.getState().hydrate(NEW_KEY, null));
    expect(openTabs()).toEqual([]);
  });

  it('название обязательно: пустое — «Enter a title», ничего не отправляется', async () => {
    await renderComposer();
    fireEvent.click(create());
    expect(await screen.findByText('Enter a title')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
    // Пробелы и невидимые знаки — тоже пусто.
    typeTitle(`  ${ZWSP} `);
    fireEvent.click(create());
    expect(await screen.findByText('Enter a title')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
  });

  it('промпт, написанный до удаления агента, в пустую работу не попадает', async () => {
    await renderComposer();
    await addAgent();
    typePrompt('Will be dropped');
    fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: S.dialogs.newSession.removeAgent }));
    fireEvent.click(create());
    expect(await screen.findByText('Enter a title')).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
  });

  it('ошибка works.create — текст createWorkspace', async () => {
    bridge.setHandler('works.create', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderComposer();
    typeTitle('title');
    fireEvent.click(create());
    expect(await screen.findByText("Couldn't create workspace: host error.")).toBeTruthy();
    expect(callsOf('sessions.create')).toHaveLength(0);
  });
});

describe('NewWorkComposer — один агент', () => {
  it('тест 2: works.create с обрезанным названием и пустой целью, затем sessions.create с промптом и worktree; вкладка — только после снимка', async () => {
    await renderComposer();
    await addAgent();
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
    expect(callsOf('rooms.create')).toEqual([]);

    // Снимка ещё нет — ни активной работы, ни вкладки в очереди: иначе мелькнуло бы «Session deleted».
    await act(async () => {});
    expect(useLayoutStore.getState().activeWorkKey).toBeNull();
    expect(useLayoutStore.getState().pending[NEW_KEY]).toBeUndefined();

    emitNewWork();
    expect(useLayoutStore.getState().activeWorkKey).toBe(NEW_KEY);
    act(() => useLayoutStore.getState().hydrate(NEW_KEY, null));
    expect(openTabs()).toEqual([tabId.terminal('s-01')]);
    expect(useUiStore.getState().ui.lastProvider).toBe('claude');
  });

  it('модель строки уходит в sessions.create, как в «New session or room»', async () => {
    bridge.setHandler('providers.list', async () => ({
      providers: [{ id: 'claude', label: 'Claude', available: true, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }], effort: true }],
    }));
    await renderComposer();
    await addAgent();
    await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }), 'Sonnet');
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', model: 'sonnet' });
  });

  it('пустое название — из первого промпта: первая строка, до 40 знаков', async () => {
    await renderComposer();
    await addAgent();
    typePrompt(`\n${'w'.repeat(60)}\nsecond`);
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('works.create')).toHaveLength(1));
    expect(callsOf('works.create')[0]).toEqual({ projectPath: PROJECT, title: 'w'.repeat(40), goal: '' });
    expect(callsOf('sessions.create')[0]).toMatchObject({ task: `\n${'w'.repeat(60)}\nsecond` });
  });

  it('пустой промпт — тихий старт (task пуст), название обязательно', async () => {
    await renderComposer();
    await addAgent();
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
    await addAgent();
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

  it('sessions.create отказан бюджетом — ошибка называет лимит и что сделать', async () => {
    bridge.setHandler('sessions.create', async () => {
      throw { code: 'conflict', message: 'raw host text', data: { code: 'resource-budget', reason: 'concurrent', scope: 'work', limit: 10, used: 10 } };
    });
    await renderComposer(() => {});
    await addAgent();
    typeTitle('title');
    fireEvent.click(create());

    expect(
      await screen.findByText('Couldn\'t create session: 10 of 10 sessions are already running in this workspace. Put one to sleep or raise "Running sessions, workspace" in Settings.'),
    ).toBeTruthy();
  });

  it('Retry берёт агента и промпт, которые человек поправил после сбоя', async () => {
    let fail = true;
    bridge.setHandler('sessions.create', async (params) => {
      if (fail) throw { code: 'internal', message: 'сбой' };
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } };
    });
    await renderComposer();
    await addAgent();
    typeTitle('title');
    typePrompt('first');
    fireEvent.click(create());
    await screen.findByText("Couldn't create session: host error.");

    fail = false;
    fireEvent.click(providerRadio(0, 'Codex'));
    typePrompt('second');
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('sessions.create')[1]).toMatchObject({ provider: 'codex', task: 'second' });
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
    await addAgent();
    typeTitle('title');
    fireEvent.keyDown(titleField(), { key: 'Enter', metaKey: true });
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
  });

  it('удачное создание закрывает диалог: onOpenChange(false)', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent();
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(opened).toEqual([false]));
  });
});

describe('NewWorkComposer — несколько агентов', () => {
  it('«Put them in a room» выключен: по sessions.create на агента с одним и тем же task, комнаты и письма нет; вкладка первой сессии', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent(2);
    fireEvent.click(providerRadio(1, 'Codex'));
    fireEvent.click(roomSwitch() as HTMLElement);
    typeTitle('Parallel');
    typePrompt('Do the thing');
    fireEvent.click(create());

    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toEqual([{ projectPath: PROJECT, title: 'Parallel', goal: '' }]);
    expect(callsOf('sessions.create').map((params) => [params['workId'], params['provider'], params['label'], params['task']])).toEqual([
      ['w-new', 'claude', '', 'Do the thing'],
      ['w-new', 'codex', '', 'Do the thing'],
    ]);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(callsOf('rooms.send')).toEqual([]);
    expect(useUiStore.getState().ui.lastProvider).toBe('codex');

    emitNewWork(['s-01', 's-02']);
    act(() => useLayoutStore.getState().hydrate(NEW_KEY, null));
    expect(openTabs()).toEqual([tabId.terminal('s-01')]);
  });

  it('«Put them in a room» включён по умолчанию: sessions.create тихо, rooms.create с ведущим, вкладка комнаты', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Make lead' })[0] as HTMLElement);
    typeTitle('Team');
    fireEvent.click(create());

    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('sessions.create').map((params) => params['task'])).toEqual(['', '']);
    expect(callsOf('rooms.create')).toEqual([
      { projectPath: PROJECT, workId: 'w-new', title: 'Room 1', members: ['s-01', 's-02'], lead: 's-02', quiet: true },
    ]);
    // Промпта нет — в комнату ничего не отправляется.
    expect(callsOf('rooms.send')).toEqual([]);

    emitNewWork(['s-01', 's-02'], 'r-01');
    act(() => useLayoutStore.getState().hydrate(NEW_KEY, null));
    expect(openTabs()).toEqual([tabId.room('r-01')]);
  });

  it('комната: первый промпт уходит в неё письмом человека всем участникам после rooms.create', async () => {
    const order: string[] = [];
    bridge.setHandler('rooms.create', async () => {
      order.push('rooms.create');
      return { roomId: 'r-01' };
    });
    bridge.setHandler('rooms.send', async () => {
      order.push('rooms.send');
      return { messageId: 'm-01' };
    });
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent(2);
    typePrompt('Discuss the plan');
    fireEvent.click(create());

    await waitFor(() => expect(opened).toEqual([false]));
    // Название — из промпта, а сессии комнаты стартуют без задачи.
    expect(callsOf('works.create')[0]).toEqual({ projectPath: PROJECT, title: 'Discuss the plan', goal: '' });
    expect(callsOf('sessions.create').map((params) => params['task'])).toEqual(['', '']);
    expect(order).toEqual(['rooms.create', 'rooms.send']);
    expect(callsOf('rooms.send')).toEqual([
      { projectPath: PROJECT, workId: 'w-new', roomId: 'r-01', to: [], text: 'Discuss the plan', kind: 'note', requestedAt: expect.any(Number) },
    ]);
  });

  it('комната: sessions.create не пересоздаётся при сбое второй — Retry запускает только её, затем комнату и промпт', async () => {
    let call = 0;
    let fail = true;
    bridge.setHandler('sessions.create', async (params) => {
      call += 1;
      if (call === 2 && fail) throw { code: 'internal', message: 'сбой' };
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: `s-${String(nextSession++).padStart(2, '0')}` } };
    });
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent(2);
    typeTitle('Team');
    typePrompt('Go');
    fireEvent.click(create());
    await screen.findByText("Couldn't create session: host error.");
    expect(callsOf('rooms.create')).toEqual([]);
    expect(callsOf('rooms.send')).toEqual([]);
    expect(opened).toEqual([]);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toHaveLength(1);
    expect(callsOf('sessions.create')).toHaveLength(3);
    expect(callsOf('rooms.create')).toHaveLength(1);
    expect(callsOf('rooms.send')).toHaveLength(1);
  });

  it('комната: rooms.create упал — Retry повторяет только его и не запускает сессии заново', async () => {
    let fail = true;
    bridge.setHandler('rooms.create', async () => {
      if (fail) throw { code: 'internal', message: 'сбой' };
      return { roomId: 'r-01' };
    });
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent(2);
    typeTitle('Team');
    fireEvent.click(create());
    expect(await screen.findByText("Couldn't create room: host error.")).toBeTruthy();
    expect(opened).toEqual([]);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toHaveLength(1);
    expect(callsOf('sessions.create')).toHaveLength(2);
    expect(callsOf('rooms.create')).toHaveLength(2);
  });

  it('комната: rooms.send упал — ошибка, диалог открыт; Retry шлёт только промпт, комнату заново не создаёт', async () => {
    let fail = true;
    bridge.setHandler('rooms.send', async () => {
      if (fail) throw { code: 'internal', message: 'сбой' };
      return { messageId: 'm-01' };
    });
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    await addAgent(2);
    typeTitle('Team');
    typePrompt('Hello room');
    fireEvent.click(create());
    expect(await screen.findByText(/The room is ready, but the first prompt was not sent\./)).toBeTruthy();
    expect(opened).toEqual([]);
    // Состав и комната уже есть — менять их нельзя.
    expect(roomSwitch()?.disabled).toBe(true);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: S.common.retry }));
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toHaveLength(1);
    expect(callsOf('sessions.create')).toHaveLength(2);
    expect(callsOf('rooms.create')).toHaveLength(1);
    expect(callsOf('rooms.send')).toHaveLength(2);
  });

  it('участники комнаты уходят с lean из настройки leanAgents; без комнаты поля lean нет', async () => {
    bridge.setHandler('settings.get', async () => ({ config: { leanAgents: true } as never, locked: {} }));
    await renderComposer();
    await addAgent(2);
    typeTitle('Team');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    expect(callsOf('sessions.create').map((params) => params['lean'])).toEqual([true, true]);

    cleanup();
    bridge.calls.length = 0;
    nextSession = 1;
    await renderComposer();
    await addAgent(2);
    fireEvent.click(roomSwitch() as HTMLElement);
    typeTitle('Apart');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('sessions.create').every((params) => !('lean' in params))).toBe(true);
  });

  it('worktree строки: значок у каждой строки при двух агентах уходит в свою сессию', async () => {
    await renderComposer();
    await addAgent(2);
    fireEvent.click(roomSwitch() as HTMLElement);
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: S.recipes.worktreeField }));
    typeTitle('Apart');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    expect(callsOf('sessions.create').map((params) => params['worktree'])).toEqual([false, true]);
  });
});

describe('NewWorkComposer — агент по умолчанию', () => {
  async function submitAndProvider(): Promise<Record<string, unknown>> {
    await renderComposer();
    await addAgent();
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

  it('выбор агента в строке — он уходит в sessions.create и запоминается', async () => {
    await renderComposer();
    await addAgent();
    fireEvent.click(providerRadio(0, 'Codex'));
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
    await addAgent();
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

  it('закрыли диалог, пока идёт запуск, — остальные агенты и комната не создаются', async () => {
    let releaseFirst: () => void = () => {};
    bridge.setHandler(
      'sessions.create',
      (params) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } });
        }),
    );
    const element = (open: boolean): JSX.Element => (
      <NewWorkComposer open={open} bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />
    );
    const view = render(element(true));
    await act(async () => {});
    await addAgent(2);
    typeTitle('Team');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    view.rerender(element(false));
    await act(async () => releaseFirst());
    await act(async () => {});
    expect(callsOf('sessions.create')).toHaveLength(1);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(callsOf('rooms.send')).toEqual([]);
  });

  it('снимок не принёс работу за 10 с — подписка снята, тост, вкладка не открывается', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderComposer();
    await addAgent();
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
    await addAgent();
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
    await addAgent();
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

  it('providers.list пришёл после открытия, затем Create — с агентом по умолчанию', async () => {
    const release = deferProviders();
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />);
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
    await addAgent();
    await release();
    expect(providerRadio(0, 'Claude').getAttribute('aria-checked')).toBe('true');
    typeTitle('title');
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude' });
  });

  it('агент добавлен раньше ответа providers.list — Create неактивна и ничего не создаёт, пока список не пришёл', async () => {
    const release = deferProviders();
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />);
    await addAgent();
    typeTitle('title');
    expect(create().disabled).toBe(true);
    fireEvent.click(create());
    fireEvent.keyDown(titleField(), { key: 'Enter', metaKey: true });
    await act(async () => {});
    expect(callsOf('works.create')).toHaveLength(0);
    await release();
    expect(create().disabled).toBe(false);
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude' });
  });

  it('работа без агентов не ждёт providers.list', async () => {
    deferProviders();
    render(<NewWorkComposer open bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />);
    typeTitle('title');
    expect(create().disabled).toBe(false);
    fireEvent.click(create());
    await waitFor(() => expect(callsOf('works.create')).toHaveLength(1));
  });

  it('«In its own worktree» — только с агентом и у git-проекта (worktrees.available)', async () => {
    bridge.setHandler('worktrees.available', async () => ({ available: false }));
    await renderComposer();
    await addAgent();
    expect(worktreeSwitch()).toBeNull();
    cleanup();
    bridge.setHandler('worktrees.available', async () => ({ available: true }));
    await renderComposer();
    expect(worktreeSwitch()).toBeNull();
    await addAgent();
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
  it('повторное открытие: название, промпт и агенты сброшены до отрисовки, а не после неё', async () => {
    const element = (open: boolean): JSX.Element => (
      <NewWorkComposer open={open} bridge={bridge} projectPath={PROJECT} title="" onOpenChange={() => {}} />
    );
    const view = render(element(true));
    await act(async () => {});
    await addAgent(2);
    typeTitle('Old title');
    fireEvent.change(promptField(), { target: { value: 'Old prompt' } });
    view.rerender(element(false));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Что поля показывают в тот миг, когда диалог попал в DOM: с `useEffect` сброса тут стояли бы прежние «Old …» и два агента.
    const shown = recordOnInsert((inserted) => {
      const title = inserted.querySelector<HTMLInputElement>('input');
      return title === null ? null : { title: title.value, agents: inserted.querySelectorAll('[data-agent-row]').length, prompt: inserted.querySelector('textarea') === null };
    });
    try {
      view.rerender(element(true));
    } finally {
      shown.stop();
    }
    expect(shown.seen).toEqual([{ title: '', agents: 0, prompt: true }]);
  });
});

describe('NewWorkComposer — доверие к папке (спека 2026-10-21, 4.2 п. 1)', () => {
  const trustDialog = (): Promise<HTMLElement> => screen.findByRole('dialog', { name: `Trust ${PROJECT} for agents?` });
  const callOrder = (): string[] => bridge.calls.map((call) => call.method).filter((method) => ['trust.list', 'trust.grant', 'works.create', 'sessions.create'].includes(method));

  beforeEach(() => bridge.setTrustFolders([]));

  it('папки нет в trust.list — диалог, works.create до «Trust» не зовётся; «Trust» — trust.grant window, затем works.create', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('Solo work');
    fireEvent.click(create());
    const dialog = await trustDialog();
    expect(dialog.textContent).toContain('.codex/');
    expect(callsOf('works.create')).toHaveLength(0);
    expect(callsOf('trust.grant')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('trust.grant')).toEqual([{ folder: PROJECT, by: 'window' }]);
    expect(callsOf('works.create')).toEqual([{ projectPath: PROJECT, title: 'Solo work', goal: '' }]);
    expect(callOrder()).toEqual(['trust.list', 'trust.grant', 'works.create']);
  });

  it('«Cancel» — назад в композер: ни trust.grant, ни works.create; Create снова доступен и спрашивает заново', async () => {
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('Solo work');
    fireEvent.click(create());
    fireEvent.click(within(await trustDialog()).getByRole('button', { name: S.common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Trust ${PROJECT} for agents?` })).toBeNull());
    await act(async () => {});
    expect(callsOf('trust.grant')).toHaveLength(0);
    expect(callsOf('works.create')).toHaveLength(0);
    expect(opened).toEqual([]);
    expect(titleField().value).toBe('Solo work');
    expect(create().disabled).toBe(false);

    fireEvent.click(create());
    expect(await trustDialog()).toBeTruthy();
    expect(callsOf('trust.list')).toHaveLength(2);
  });

  it('папка в trust.list — диалога нет, works.create сразу', async () => {
    bridge.setTrustFolders([{ folder: PROJECT, grantedAt: '2026-10-21T10:00:00.000Z', by: 'island' }]);
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('Solo work');
    fireEvent.click(create());
    await waitFor(() => expect(opened).toEqual([false]));
    expect(screen.queryByRole('dialog', { name: /for agents\?$/ })).toBeNull();
    expect(callOrder()).toEqual(['trust.list', 'works.create']);
  });

  it('согласие спрашивается и при агентах любого провайдера: sessions.create — только после «Trust»', async () => {
    await renderComposer();
    await addAgent();
    typeTitle('Work');
    typePrompt('Do it');
    fireEvent.click(create());
    fireEvent.click(within(await trustDialog()).getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callOrder()).toEqual(['trust.list', 'trust.grant', 'works.create', 'sessions.create']);
  });

  it('хост прежней сборки без trust.list — спрашивать нечего, работа создаётся', async () => {
    bridge.setHandler('trust.list', async () => {
      throw { code: 'unknown_method', message: 'unknown method: trust.list' };
    });
    const opened: boolean[] = [];
    await renderComposer((open) => opened.push(open));
    typeTitle('Solo work');
    fireEvent.click(create());
    await waitFor(() => expect(opened).toEqual([false]));
    expect(callsOf('works.create')).toHaveLength(1);
  });

  it('trust.list отказал иначе — ошибка в диалоге, работа не создаётся, форма не заперта', async () => {
    bridge.setHandler('trust.list', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderComposer();
    typeTitle('Solo work');
    fireEvent.click(create());
    expect(await screen.findByText("Couldn't check the folder trust: host error.")).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
    expect(create().disabled).toBe(false);
  });

  it('trust.grant отказал — ошибка, работа не создаётся', async () => {
    bridge.setHandler('trust.grant', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderComposer();
    typeTitle('Solo work');
    fireEvent.click(create());
    fireEvent.click(within(await trustDialog()).getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    expect(await screen.findByText("Couldn't trust the folder: host error.")).toBeTruthy();
    expect(callsOf('works.create')).toHaveLength(0);
    expect(create().disabled).toBe(false);
  });

  it('диалог настроен на проект, выбранный сейчас: другая папка — своя запись trust.grant', async () => {
    useWorksStore.setState({ entries: [makeWork('w-old', { projectPath: PROJECT }), makeWork('w-two', { projectPath: '/tmp/two' })] });
    await renderComposer();
    fireEvent.click(screen.getByRole('radio', { name: 'two' }));
    typeTitle('Solo work');
    fireEvent.click(create());
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Trust /tmp/two for agents?' })).getByRole('button', { name: S.dialogs.trustFolder.confirm }));
    await waitFor(() => expect(callsOf('works.create')).toHaveLength(1));
    expect(callsOf('trust.grant')).toEqual([{ folder: '/tmp/two', by: 'window' }]);
  });
});
