/**
 * Диалог «New session or room» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.5, 2.1): один агент — один
 * `sessions.create` без `rooms.create`; N агентов — N `sessions.create` (тихий старт) и `rooms.create` с `lead` и
 * `quiet: true`; частичный сбой — итог по агентам и «Retry» только упавшим; контролы модели и усилия по `models` и
 * `effort` провайдера; «In its own worktree»; агент по умолчанию; работа диалога.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Result } from '@parley/protocol';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RESOURCE_LIMITS } from '@parley/core/resource-policy';
import { S } from '../../../shared/strings.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { tabId } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { groups } from '../../layout/tree.js';
import { roomKey } from '../../lib/room-view.js';
import { workKey } from '../../lib/tree-order.js';
import { useUiStore } from '../../store/ui.js';
import { useHostStore } from '../../store/host.js';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { useWorksStore } from '../../store/works.js';
import { recordOnInsert } from '../../test-utils/dom-insert.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { chooseOption, installRadixSelectPolyfills } from '../../test-utils/radix-select.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { NewSessionOrRoomDialog } from './NewSessionOrRoomDialog.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

installRadixSelectPolyfills();

const PROJECT = '/tmp/proj';
const KEY = workKey(PROJECT, 'w-01');

const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    available: true,
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
    ],
    effort: true,
  },
  { id: 'codex', label: 'Codex', available: true, models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }], effort: true },
  { id: 'glm', label: 'GLM', available: true },
  { id: 'cursor', label: 'Cursor', available: false },
];

let bridge: FakeBridge;
/** Номер следующей сессии, которую вернёт `sessions.create`: s-01, s-02, … */
let nextSession = 1;

const callsOf = (method: string): Array<Record<string, unknown>> =>
  bridge.calls.filter((call) => call.method === method).map((call) => call.params as Record<string, unknown>);

function stubHost(): void {
  bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('providers.list', async () => ({ providers: PROVIDERS }));
  bridge.setHandler('worktrees.available', async () => ({ available: true }));
  bridge.setHandler('sessions.create', async (params) => ({
    ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: `s-${String(nextSession++).padStart(2, '0')}` },
  }));
  bridge.setHandler('rooms.create', async () => ({ roomId: 'r-01' }));
}

beforeEach(() => {
  nextSession = 1;
  bridge = createFakeBridge();
  window.parley = bridge;
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.4.0', methods: [...REQUIRED_METHODS] }, connections: 1 });
  stubHost();
  useWorksStore.setState({
    entries: [makeWork('w-01', { projectPath: PROJECT, title: 'Payments' }), makeWork('w-02', { projectPath: '/tmp/other', title: 'Auth' })],
    branches: {},
    loading: false,
    error: null,
  });
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: {},
    hydrated: {},
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  // Без `init`: его `loadUi` затёр бы `lastProvider`, заданный тестом; `patchUi` пишет зеркало и так.
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: true, roomExpanded: {} });
});

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
});

interface Rendered {
  onOpenChange: ReturnType<typeof vi.fn>;
}

/** Диалог открыт; `providers.list` этого открытия уже ответил. */
async function renderDialog(
  props: { work?: { projectPath: string; workId: string } | null; room?: boolean } = {},
): Promise<Rendered> {
  const onOpenChange = vi.fn();
  render(
    <NewSessionOrRoomDialog open bridge={bridge} work={props.work ?? null} room={props.room ?? false} onOpenChange={onOpenChange} />,
  );
  await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
  await act(async () => {});
  return { onOpenChange };
}

const dialog = (): HTMLElement => screen.getByRole('dialog', { name: /^(New (session|room)|Save as recipe)$/ });
const rows = (): HTMLElement[] => [...dialog().querySelectorAll<HTMLElement>('[data-agent-row]')];
const button = (name: string | RegExp): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;
const providerRadio = (row: number, name: string): HTMLElement =>
  within(within(rows()[row] as HTMLElement).getByRole('radiogroup', { name: `Agent ${row + 1}` })).getByRole('radio', { name });
/** Список уровней effort строки (нормалайзер модели и effort 2026-10-06): Radix Select, у кнопки роль combobox. */
const effortSelect = (row: number): HTMLElement => within(rows()[row] as HTMLElement).getByRole('combobox', { name: 'Effort' });
const modelSelect = (row: number): HTMLElement => within(rows()[row] as HTMLElement).getByRole('combobox', { name: 'Model' });
/** Имена пунктов открытого списка: пункт Radix связан со своим `ItemText`, описание уровня второй строкой в имя не входит. */
async function optionNames(trigger: HTMLElement): Promise<string[]> {
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const options = await screen.findAllByRole('option');
  return options.map((option) => document.getElementById(option.getAttribute('aria-labelledby') ?? '')?.textContent ?? '');
}
const isChecked = (element: HTMLElement): boolean => element.getAttribute('aria-checked') === 'true';

async function addAgent(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) fireEvent.click(button(S.dialogs.newSession.addAgent));
  await act(async () => {});
}

describe('NewSessionOrRoomDialog — вид и состав (1.5)', () => {
  it('один агент: заголовок New session, подсказка, сводка, Start session; звезды ведущего нет', async () => {
    await renderDialog();
    expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
    expect(screen.getByText('Add another agent to make it a room.')).toBeTruthy();
    expect(screen.getByText('One session in Payments')).toBeTruthy();
    expect(button('Start session').disabled).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^(Lead|Make lead)$/ })).toBeNull();
    // Название — Session name, необязательное.
    expect(screen.getByPlaceholderText('Optional')).toBeTruthy();
  });

  it('два и больше: заголовок New room, подсказка, Room with 3 agents in …, Create room, у каждого звезда; ведущий — первый', async () => {
    await renderDialog();
    await addAgent(2);
    expect(screen.getByRole('heading', { name: 'New room' })).toBeTruthy();
    expect(screen.getByText('The agents discuss the task you write in the room. The lead brings you a decision.')).toBeTruthy();
    expect(screen.getByText('Room with 3 agents in Payments')).toBeTruthy();
    expect(button('Create room')).toBeTruthy();
    expect(screen.getByPlaceholderText('What the agents will discuss')).toBeTruthy();
    const stars = screen.getAllByRole('button', { name: /^(Lead|Make lead)$/ });
    expect(stars.map((star) => star.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(stars.map((star) => star.textContent)).toEqual(['★', '☆', '☆']);
  });

  it('«New room» (room) открывает сразу два агента — комнату', async () => {
    await renderDialog({ room: true });
    expect(screen.getByRole('heading', { name: 'New room' })).toBeTruthy();
    expect(rows()).toHaveLength(2);
  });

  it('провайдеры — пилюли: доступные выбираются, недоступный открывает карточку; по умолчанию Claude', async () => {
    await renderDialog();
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    expect(isChecked(providerRadio(0, 'Codex'))).toBe(false);
    expect((providerRadio(0, 'Cursor') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(isChecked(providerRadio(0, 'Codex'))).toBe(true);
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(false);
  });

  it('провайдеры — радиогруппа с клавиатуры: Tab берёт выбранного, стрелки переходят на соседнего доступного по кругу и выбирают его', async () => {
    await renderDialog();
    const claude = providerRadio(0, 'Claude');
    const codex = providerRadio(0, 'Codex');
    expect([claude.getAttribute('tabindex'), codex.getAttribute('tabindex')]).toEqual(['0', '-1']);
    act(() => claude.focus());
    fireEvent.keyDown(claude, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(codex);
    expect(isChecked(codex)).toBe(true);
    expect([claude.getAttribute('tabindex'), codex.getAttribute('tabindex')]).toEqual(['-1', '0']);
    fireEvent.keyDown(codex, { key: 'ArrowRight' });
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
    // Недоступный Cursor открывает подключение с клавиатуры, но GLM остаётся выбранным.
    fireEvent.keyDown(providerRadio(0, 'GLM'), { key: 'ArrowDown' });
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
    expect(await screen.findByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('ui.lastProvider — агент по умолчанию, как у диалога новой работы', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, lastProvider: 'codex' } });
    await renderDialog();
    expect(isChecked(providerRadio(0, 'Codex'))).toBe(true);
  });

  it('«+ Add agent»: провайдер последней строки, модель Default, effort Default', async () => {
    await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    await addAgent();
    expect(rows()).toHaveLength(2);
    expect(isChecked(providerRadio(1, 'Codex'))).toBe(true);
    expect(modelSelect(1).textContent).toBe('Default');
    expect(effortSelect(1).textContent).toBe('Default');
  });

  it('удалить агента: недоступно при одном; удаление возвращает заголовок New session; ведущий, которого убрали, — первый', async () => {
    await renderDialog();
    const remove = (): HTMLButtonElement[] => screen.getAllByRole('button', { name: 'Remove agent' }) as HTMLButtonElement[];
    expect(remove()[0]?.disabled).toBe(true);
    await addAgent(2);
    // Звезда — у второго, и его убирают: ведущим становится первый оставшийся.
    fireEvent.click(screen.getAllByRole('button', { name: 'Make lead' })[0] as HTMLElement);
    expect(screen.getAllByRole('button', { name: /^(Lead|Make lead)$/ }).map((star) => star.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
    fireEvent.click(remove()[1] as HTMLElement);
    expect(rows()).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /^(Lead|Make lead)$/ }).map((star) => star.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    fireEvent.click(remove()[1] as HTMLElement);
    expect(screen.getByRole('heading', { name: 'New session' })).toBeTruthy();
    expect(remove()[0]?.disabled).toBe(true);
  });

  it('каждое открытие — с чистой формой: один агент, пустое название', async () => {
    const onOpenChange = vi.fn();
    const view = render(<NewSessionOrRoomDialog open bridge={bridge} work={null} room={false} onOpenChange={onOpenChange} />);
    await act(async () => {});
    await addAgent();
    fireEvent.change(screen.getByPlaceholderText('What the agents will discuss'), { target: { value: 'Sync' } });
    view.rerender(<NewSessionOrRoomDialog open={false} bridge={bridge} work={null} room={false} onOpenChange={onOpenChange} />);
    view.rerender(<NewSessionOrRoomDialog open bridge={bridge} work={null} room={false} onOpenChange={onOpenChange} />);
    await act(async () => {});
    expect(rows()).toHaveLength(1);
    expect((screen.getByPlaceholderText('Optional') as HTMLInputElement).value).toBe('');
  });

  it('форма сбрасывается до отрисовки: название и состав агентов появляются уже чистыми, а не как в прошлое открытие', async () => {
    const onOpenChange = vi.fn();
    const element = (open: boolean): JSX.Element => (
      <NewSessionOrRoomDialog open={open} bridge={bridge} work={null} room={false} onOpenChange={onOpenChange} />
    );
    const view = render(element(true));
    await act(async () => {});
    await addAgent();
    fireEvent.change(screen.getByPlaceholderText('What the agents will discuss'), { target: { value: 'Sync' } });
    view.rerender(element(false));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Что диалог показывает в тот миг, когда попал в DOM: с `useEffect` сброса тут стояли бы «Sync» и два агента.
    const shown = recordOnInsert((inserted) => {
      const name = inserted.querySelector<HTMLInputElement>('input[placeholder]');
      return name === null ? null : { name: name.value, agents: inserted.querySelectorAll('[data-agent-row]').length };
    });
    try {
      view.rerender(element(true));
    } finally {
      shown.stop();
    }
    expect(shown.seen).toEqual([{ name: '', agents: 1 }]);
  });
});

describe('NewSessionOrRoomDialog — один агент (2.1)', () => {
  it('один sessions.create с model и effort, без rooms.create; lastProvider запоминается; диалог закрывается', async () => {
    const { onOpenChange } = await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }), 'GPT-6 Astra');
    await chooseOption(effortSelect(0), 'High');
    fireEvent.change(screen.getByPlaceholderText('Optional'), { target: { value: '  Auth work ' } });
    fireEvent.click(button('Start session'));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toEqual([
      {
        projectPath: PROJECT,
        workId: 'w-01',
        provider: 'codex',
        label: 'Auth work',
        task: '',
        parent: null,
        worktree: false,
        model: 'gpt-6-astra',
        effort: 'high',
      },
    ]);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(useUiStore.getState().ui.lastProvider).toBe('codex');
  });

  it('модель и effort Default: ни model, ни effort не уходят — CLI берёт своё', async () => {
    await renderDialog();
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    const params = callsOf('sessions.create')[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('model');
    expect(params).not.toHaveProperty('effort');
    expect(params).toMatchObject({ provider: 'claude', label: '', task: '' });
  });

  it('терминал открывается, когда снимок работ принёс сессию — не раньше', async () => {
    useLayoutStore.setState({ layouts: { [KEY]: { root: { type: 'group', id: 'g-1', tabs: [], activeTabId: null }, activeGroupId: 'g-1', closedTabs: [] } }, hydrated: { [KEY]: true } });
    await renderDialog();
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    await act(async () => {});
    const tabs = (): string[] => {
      const layout = useLayoutStore.getState().layouts[KEY];
      return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
    };
    // Снимка ещё нет — вкладка не открыта вслепую: иначе мелькнуло бы «Session deleted».
    expect(tabs()).toEqual([]);
    act(() =>
      useWorksStore.setState({
        entries: [makeWork('w-01', { projectPath: PROJECT, title: 'Payments', sessions: [makeSession('s-01', '')] }), makeWork('w-02', { projectPath: '/tmp/other' })],
      }),
    );
    expect(tabs()).toEqual([tabId.terminal('s-01')]);
    expect(useLayoutStore.getState().activeWorkKey).toBe(KEY);
  });

  it('отказ sessions.create — итог по агенту, Retry вместо Start session, диалог открыт', async () => {
    bridge.setHandler('sessions.create', async () => {
      throw { code: 'conflict', message: 'хост против' };
    });
    const { onOpenChange } = await renderDialog();
    fireEvent.click(button('Start session'));
    expect(await screen.findByText("Couldn't create session: conflicting state.")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Retry')).toBeTruthy();
  });
});

describe('NewSessionOrRoomDialog — контролы модели и усилия по providers.list (решение 5)', () => {
  it('есть список — select с пунктом Default первым, дальше подписи списка', async () => {
    await renderDialog();
    const model = within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' });
    expect(model.textContent).toBe('Default');
    fireEvent.keyDown(model, { key: 'ArrowDown' });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Default', 'Opus', 'Sonnet']);
  });

  it('выбранная модель уходит id; смена провайдера возвращает Default и model не уходит', async () => {
    await renderDialog();
    await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }), 'Opus');
    expect(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }).textContent).toBe('Opus');
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }).textContent).toBe('Default');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).not.toHaveProperty('model');
  });

  it.each([
    ['models: null', { id: 'claude', label: 'Claude', available: true, models: null, effort: false }],
    ['models: []', { id: 'claude', label: 'Claude', available: true, models: [], effort: false }],
    ['поля models нет — старый хост', { id: 'claude', label: 'Claude', available: true }],
  ])('%s — контрола модели и усилия нет, sessions.create без model и effort', async (_name, provider) => {
    bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('providers.list', async () => ({ providers: [provider] }));
    await renderDialog();
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    const params = callsOf('sessions.create')[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('model');
    expect(params).not.toHaveProperty('effort');
  });

  it('effort: false при непустом списке — модель есть, усилия нет; effort: true при models: null — наоборот', async () => {
    bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('providers.list', async () => ({
      providers: [
        { id: 'claude', label: 'Claude', available: true, models: [{ id: 'opus', label: 'Opus' }], effort: false },
        { id: 'codex', label: 'Codex', available: true, models: null, effort: true },
      ],
    }));
    await renderDialog();
    expect(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(effortSelect(0)).toBeTruthy();
  });

  it('старый хост: у моделей нет efforts, effort: true — Default, Low, Medium, High; выбранный уходит', async () => {
    await renderDialog();
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High']);
    fireEvent.click(screen.getByRole('option', { name: 'Low' }));
    expect(effortSelect(0).textContent).toBe('Low');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', effort: 'low' });
  });
});

describe('NewSessionOrRoomDialog — уровни effort по модели (нормалайзер модели и effort 2026-10-06, 5.9)', () => {
  const FIVE = [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
  ];
  const CODEX_LEVELS = [
    { id: 'low', label: 'Low', description: 'Fast responses with lighter reasoning' },
    { id: 'medium', label: 'Medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    { id: 'high', label: 'High', description: 'Greater reasoning depth for complex problems' },
    { id: 'xhigh', label: 'Extra high', description: 'Extra high reasoning depth for complex problems' },
    { id: 'max', label: 'Max', description: 'Maximum reasoning depth for the hardest problems' },
  ];
  const ULTRA = { id: 'ultra', label: 'Ultra', description: 'Maximum reasoning with automatic task delegation' };
  const LEVELED = [
    {
      id: 'claude',
      label: 'Claude',
      available: true,
      effort: true,
      models: [
        { id: 'opus', label: 'Opus', efforts: FIVE },
        { id: 'haiku', label: 'Haiku', efforts: null },
        { id: 'opusplan[1m]', label: 'Opus Plan (1M context)', efforts: FIVE },
      ],
    },
    {
      id: 'codex',
      label: 'Codex',
      available: true,
      effort: true,
      models: [
        { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...CODEX_LEVELS, ULTRA] },
        { id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_LEVELS },
      ],
    },
  ];

  beforeEach(() => {
    bridge.setHandler('providers.list', async () => ({ providers: LEVELED }));
  });

  it('Codex: у GPT-6.1-Sol есть Ultra с описанием второй строкой; смена на GPT-6-Luna сбрасывает Ultra в Default', async () => {
    await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(effortSelect(0).textContent).toBe('Default');
    await chooseOption(modelSelect(0), 'GPT-6.1-Sol');
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
    const ultra = screen.getByRole('option', { name: 'Ultra' });
    expect(ultra.textContent).toContain('Maximum reasoning with automatic task delegation');
    fireEvent.click(ultra);
    // В кнопке — только подпись уровня, без описания.
    expect(effortSelect(0).textContent).toBe('Ultra');
    await chooseOption(modelSelect(0), 'GPT-6-Luna');
    expect(effortSelect(0).textContent).toBe('Default');
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    fireEvent.click(screen.getByRole('option', { name: 'Max' }));
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'codex', model: 'gpt-6-luna', effort: 'max' });
  });

  it('уровень, который есть и у новой модели, остаётся: Opus с High → Opus Plan (1M context) с High', async () => {
    await renderDialog();
    await chooseOption(modelSelect(0), 'Opus');
    await chooseOption(effortSelect(0), 'High');
    await chooseOption(modelSelect(0), 'Opus Plan (1M context)');
    expect(effortSelect(0).textContent).toBe('High');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', model: 'opusplan[1m]', effort: 'high' });
  });

  it('Haiku — поля effort нет и effort не уходит; снова Opus — поле на Default', async () => {
    await renderDialog();
    await chooseOption(effortSelect(0), 'Max');
    await chooseOption(modelSelect(0), 'Haiku');
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    await chooseOption(modelSelect(0), 'Opus');
    expect(effortSelect(0).textContent).toBe('Default');
    await chooseOption(modelSelect(0), 'Haiku');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', model: 'haiku' });
    expect(callsOf('sessions.create')[0]).not.toHaveProperty('effort');
  });

  it('модель Default — общие уровни моделей провайдера: у Claude пять (Haiku не в счёт), у Codex — без Ultra', async () => {
    await renderDialog();
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
    fireEvent.click(screen.getByRole('option', { name: 'Default' }));
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(await optionNames(effortSelect(0))).toEqual(['Default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it('каталог сменился при открытом диалоге (providers.changed): выбранных модели и уровня больше нет — поля в Default, уходит явный Default', async () => {
    let providers = LEVELED;
    bridge.setHandler('providers.list', async () => ({ providers }));
    await renderDialog();
    fireEvent.click(providerRadio(0, 'Codex'));
    await chooseOption(modelSelect(0), 'GPT-6.1-Sol');
    await chooseOption(effortSelect(0), 'Ultra');
    // Новый каталог Codex: GPT-6.1-Sol из него ушла, а у оставшейся модели нет Ultra.
    providers = [LEVELED[0]!, { ...LEVELED[1]!, models: [{ id: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: CODEX_LEVELS }] }];
    act(() => bridge.emit('providers.changed', { provider: 'codex' }));
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(2));
    await act(async () => {});

    expect(modelSelect(0).textContent).toBe('Default');
    expect(effortSelect(0).textContent).toBe('Default');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    // Выбор был явным (тронут), поэтому уходит явный Default: `null` снимает и умолчание роли, флагов нет.
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'codex', model: null, effort: null });
  });

  it('смена провайдера сбрасывает и модель, и effort в Default', async () => {
    await renderDialog();
    await chooseOption(modelSelect(0), 'Opus');
    await chooseOption(effortSelect(0), 'Max');
    fireEvent.click(providerRadio(0, 'Codex'));
    expect(modelSelect(0).textContent).toBe('Default');
    expect(effortSelect(0).textContent).toBe('Default');
    fireEvent.click(providerRadio(0, 'Claude'));
    expect(modelSelect(0).textContent).toBe('Default');
    expect(effortSelect(0).textContent).toBe('Default');
  });
});

describe('NewSessionOrRoomDialog — несколько агентов: комната (2.1)', () => {
  it('три агента — три sessions.create (тихий старт) и rooms.create с lead, quiet и названием Room {n}', async () => {
    const { onOpenChange } = await renderDialog();
    await addAgent(2);
    fireEvent.click(providerRadio(1, 'Codex'));
    await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }), 'Sonnet');
    // Ведущий — третий.
    fireEvent.click(screen.getAllByRole('button', { name: 'Make lead' })[1] as HTMLElement);
    fireEvent.click(button('Create room'));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toEqual([
      { projectPath: PROJECT, workId: 'w-01', provider: 'claude', label: '', task: '', parent: null, worktree: false, model: 'sonnet' },
      { projectPath: PROJECT, workId: 'w-01', provider: 'codex', label: '', task: '', parent: null, worktree: false },
      { projectPath: PROJECT, workId: 'w-01', provider: 'claude', label: '', task: '', parent: null, worktree: false },
    ]);
    expect(callsOf('rooms.create')).toEqual([
      { projectPath: PROJECT, workId: 'w-01', title: 'Room 1', members: ['s-01', 's-02', 's-03'], lead: 's-03', quiet: true },
    ]);
    // Комната создана после всех сессий: порядок вызовов.
    const order = bridge.calls.map((call) => call.method).filter((method) => method === 'sessions.create' || method === 'rooms.create');
    expect(order).toEqual(['sessions.create', 'sessions.create', 'sessions.create', 'rooms.create']);
  });

  it('название по умолчанию — по числу комнат работы; введённое (без пробелов по краям) — как есть', async () => {
    useWorksStore.setState({
      entries: [makeWork('w-01', { projectPath: PROJECT, title: 'Payments', rooms: [makeRoom('r-01', 'A'), makeRoom('r-02', 'B')] })],
    });
    await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    expect(callsOf('rooms.create')[0]).toMatchObject({ title: 'Room 3' });

    cleanup();
    bridge.calls.length = 0;
    nextSession = 1;
    await renderDialog({ room: true });
    fireEvent.change(screen.getByPlaceholderText('What the agents will discuss'), { target: { value: '  Refunds  ' } });
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    expect(callsOf('rooms.create')[0]).toMatchObject({ title: 'Refunds' });
    // Название — у комнаты, а не у сессий: окно шлёт им пустой ярлык (хост поставит «новую сессию», и строка сайдбара
    // покажет S01 New session, S02 New session — до автозаголовка).
    expect(callsOf('sessions.create').map((params) => params['label'])).toEqual(['', '']);
  });

  it('вкладка комнаты открывается, а её строка разворачивается, когда снимок принёс комнату', async () => {
    useLayoutStore.setState({ layouts: { [KEY]: { root: { type: 'group', id: 'g-1', tabs: [], activeTabId: null }, activeGroupId: 'g-1', closedTabs: [] } }, hydrated: { [KEY]: true } });
    await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    await act(async () => {});
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBeUndefined();

    const room = { ...makeRoom('r-01', 'Room 1'), members: ['s-01', 's-02'], lead: 's-01' };
    act(() =>
      useWorksStore.setState({
        entries: [
          makeWork('w-01', { projectPath: PROJECT, title: 'Payments', sessions: [makeSession('s-01', ''), makeSession('s-02', '')], rooms: [room] }),
          makeWork('w-02', { projectPath: '/tmp/other' }),
        ],
      }),
    );
    const layout = useLayoutStore.getState().layouts[KEY];
    expect(layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id))).toEqual([tabId.room('r-01')]);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(true);
  });

  it('lastProvider — провайдер последней строки', async () => {
    await renderDialog({ room: true });
    fireEvent.click(providerRadio(1, 'Codex'));
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    expect(useUiStore.getState().ui.lastProvider).toBe('codex');
  });

  it('двойной клик по «Create room» — одна комната и по одной сессии на агента', async () => {
    await renderDialog({ room: true });
    const create = button('Create room');
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    await act(async () => {});
    expect(callsOf('sessions.create')).toHaveLength(2);
    expect(callsOf('rooms.create')).toHaveLength(1);
  });
});

describe('NewSessionOrRoomDialog — частичный сбой запуска', () => {
  /** Второй вызов `sessions.create` падает, пока `fail` включён. */
  function failSecond(state: { fail: boolean }): void {
    let call = 0;
    bridge.setHandler('sessions.create', async (params) => {
      call += 1;
      if (call === 2 && state.fail) throw { code: 'internal', message: 'сбой' };
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: `s-${String(nextSession++).padStart(2, '0')}` } };
    });
  }

  it('комнаты нет до успеха всех; итог по каждому агенту; Retry вместо Create room; диалог открыт', async () => {
    failSecond({ fail: true });
    const { onOpenChange } = await renderDialog();
    await addAgent(2);
    fireEvent.click(button('Create room'));

    expect(await screen.findByText("Couldn't create session: host error.")).toBeTruthy();
    expect(callsOf('sessions.create')).toHaveLength(3);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalled();
    const results = screen.getAllByRole('status').map((line) => line.textContent);
    expect(results).toEqual(['S01 started', "Couldn't create session: host error.", 'S02 started']);
    expect(button('Retry')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create room' })).toBeNull();
  });

  it('Retry повторяет только упавших; комната — после успеха всех, с участниками в порядке строк', async () => {
    const state = { fail: true };
    failSecond(state);
    const { onOpenChange } = await renderDialog();
    await addAgent(2);
    fireEvent.click(providerRadio(1, 'Codex'));
    await screen.findByRole('button', { name: 'Create room' });
    fireEvent.click(button('Create room'));
    await screen.findByText("Couldn't create session: host error.");

    state.fail = false;
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // Три вызова первой попытки и один повтор — не четыре новых.
    expect(callsOf('sessions.create')).toHaveLength(4);
    expect(callsOf('sessions.create')[3]).toMatchObject({ provider: 'codex' });
    expect(callsOf('rooms.create')[0]).toMatchObject({ members: ['s-01', 's-03', 's-02'], lead: 's-01', quiet: true });
  });

  it('запущенные строки после первой попытки заперты, общие поля тоже; упавшая строка — доступна', async () => {
    failSecond({ fail: true });
    await renderDialog();
    await addAgent();
    fireEvent.click(button('Create room'));
    await screen.findByText("Couldn't create session: host error.");
    expect((providerRadio(0, 'Codex') as HTMLButtonElement).disabled).toBe(true);
    expect((providerRadio(1, 'Codex') as HTMLButtonElement).disabled).toBe(false);
    expect(button(S.dialogs.newSession.addAgent).disabled).toBe(true);
    expect((screen.getByPlaceholderText('What the agents will discuss') as HTMLInputElement).disabled).toBe(true);
    for (const remove of screen.getAllByRole('button', { name: 'Remove agent' })) expect((remove as HTMLButtonElement).disabled).toBe(true);
  });

  it('Cancel после частичного сбоя: диалог закрыт, rooms.create не звали, запущенные сессии остались', async () => {
    failSecond({ fail: true });
    const { onOpenChange } = await renderDialog();
    await addAgent();
    fireEvent.click(button('Create room'));
    await screen.findByText("Couldn't create session: host error.");
    fireEvent.click(button('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(callsOf('rooms.create')).toEqual([]);
  });

  it('rooms.create упал после запуска всех — ошибка комнаты, Retry зовёт только rooms.create', async () => {
    let fail = true;
    bridge.setHandler('rooms.create', async () => {
      if (fail) throw { code: 'internal', message: 'сбой' };
      return { roomId: 'r-01' };
    });
    const { onOpenChange } = await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    expect(await screen.findByText("Couldn't create room: host error.")).toBeTruthy();
    expect(callsOf('sessions.create')).toHaveLength(2);
    expect(onOpenChange).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toHaveLength(2);
    expect(callsOf('rooms.create')).toHaveLength(2);
  });
});

describe('NewSessionOrRoomDialog — «In its own worktree»', () => {
  const switchOf = (): HTMLButtonElement => screen.getByRole('switch', { name: 'In its own worktree' }) as HTMLButtonElement;

  it('не-git проект — флажок неактивен; git-проект (worktrees.available) — активен', async () => {
    bridge.setHandler('worktrees.available', async () => ({ available: false }));
    await renderDialog();
    expect(switchOf().disabled).toBe(true);
    cleanup();
    bridge.calls.length = 0;
    bridge.setHandler('worktrees.available', async () => ({ available: true }));
    await renderDialog();
    expect(switchOf().disabled).toBe(false);
  });

  it('включённый — worktree: true у каждой сессии комнаты', async () => {
    await renderDialog({ room: true });
    fireEvent.click(switchOf());
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    expect(callsOf('sessions.create').map((params) => params['worktree'])).toEqual([true, true]);
  });
});

describe('NewSessionOrRoomDialog — работа диалога и ответ providers.list', () => {
  it('работа по умолчанию — активная (не первая в списке); выбор человека — его; done и archived в списке нет', async () => {
    useWorksStore.setState({
      entries: [
        makeWork('w-01', { projectPath: PROJECT, title: 'Payments' }),
        makeWork('w-02', { projectPath: '/tmp/other', title: 'Auth' }),
        makeWork('w-03', { projectPath: '/tmp/third', title: 'Old', status: 'done' }),
      ],
    });
    useLayoutStore.setState({ activeWorkKey: workKey('/tmp/other', 'w-02') });
    await renderDialog();
    const select = (): HTMLElement => screen.getByRole('combobox', { name: 'Workspace' });
    expect(select().textContent).toBe('Auth · other');
    fireEvent.keyDown(select(), { key: 'ArrowDown' });
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual(['Payments · proj', 'Auth · other']);
    fireEvent.click(screen.getByRole('option', { name: 'Payments · proj' }));
    expect(select().textContent).toBe('Payments · proj');

    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ projectPath: PROJECT, workId: 'w-01' });
    // Диалог другой работы проверяет её git.
    expect(callsOf('worktrees.available').map((params) => params['projectPath'])).toContain(PROJECT);
  });

  it('работа из меню карточки неактивной карточки — диалог на ней, а не на активной', async () => {
    await renderDialog({ work: { projectPath: '/tmp/other', workId: 'w-02' } });
    expect(screen.getByRole('combobox', { name: 'Workspace' }).textContent).toBe('Auth · other');
    expect(screen.getByText('One session in Auth')).toBeTruthy();
  });

  it('Start session раньше ответа providers.list — кнопка неактивна; после ответа — агент по умолчанию, а не пустой', async () => {
    let release: () => void = () => {};
    bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('providers.list', () => new Promise((resolve) => (release = () => resolve({ providers: PROVIDERS }))));
    render(<NewSessionOrRoomDialog open bridge={bridge} work={null} room={false} onOpenChange={() => {}} />);
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
    expect(button('Start session').disabled).toBe(true);
    fireEvent.click(button('Start session'));
    await act(async () => {});
    expect(callsOf('sessions.create')).toEqual([]);

    await act(async () => release());
    expect(button('Start session').disabled).toBe(false);
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude' });
  });

  it('отказ providers.list — текст ошибки, кнопка неактивна', async () => {
    bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('providers.list', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    render(<NewSessionOrRoomDialog open bridge={bridge} work={null} room={false} onOpenChange={() => {}} />);
    expect(await screen.findByText("Couldn't load providers: host error.")).toBeTruthy();
    expect(button('Start session').disabled).toBe(true);
  });

  it('Cancel закрывает диалог, ничего не создав', async () => {
    const { onOpenChange } = await renderDialog();
    fireEvent.click(button('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(callsOf('sessions.create')).toEqual([]);
  });
});

// Правки по ревью куска 7 (находки 2, 5, 6).

/** Раскладка работы с пустой группой: вкладка, открытая диалогом, попадёт в неё. */
function emptyWorkLayout(): void {
  useLayoutStore.setState({
    layouts: { [KEY]: { root: { type: 'group', id: 'g-1', tabs: [], activeTabId: null }, activeGroupId: 'g-1', closedTabs: [] } },
    hydrated: { [KEY]: true },
  });
}

const openTabIds = (): string[] => {
  const layout = useLayoutStore.getState().layouts[KEY];
  return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
};

/** Снимок работ уже принёс созданное: вкладка, которую диалог решит открыть, открылась бы сразу — не «когда-нибудь». */
function listCreatedInSnapshot(): void {
  const room = { ...makeRoom('r-01', 'Room 1'), members: ['s-01', 's-02'], lead: 's-01' };
  useWorksStore.setState({
    entries: [
      makeWork('w-01', { projectPath: PROJECT, title: 'Payments', sessions: [makeSession('s-01', ''), makeSession('s-02', '')], rooms: [room] }),
      makeWork('w-02', { projectPath: '/tmp/other', title: 'Auth' }),
    ],
  });
}

describe('NewSessionOrRoomDialog — закрытие во время запуска (находка 2 ревью)', () => {
  /** `sessions.create` отвечает, когда тест его отпустит: `release(n)` — ответ на n-й вызов (с нуля). */
  function holdSessions(): { count: () => number; release: (index: number) => Promise<void> } {
    const pending: Array<() => void> = [];
    bridge.setHandler(
      'sessions.create',
      (params) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve({ ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: `s-${String(nextSession++).padStart(2, '0')}` } }),
          );
        }),
    );
    return {
      count: () => pending.length,
      release: async (index) => {
        await act(async () => pending[index]?.());
      },
    };
  }

  /** Диалог открыт на «мосте» теста; `view.rerender` — то, что делает родитель, когда закрывает или открывает его. */
  async function openDialog(room: boolean): Promise<{ view: ReturnType<typeof render>; onOpenChange: ReturnType<typeof vi.fn>; set: (open: boolean) => void }> {
    const onOpenChange = vi.fn();
    const element = (open: boolean): JSX.Element => (
      <NewSessionOrRoomDialog open={open} bridge={bridge} work={null} room={room} onOpenChange={onOpenChange} />
    );
    const view = render(element(true));
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
    await act(async () => {});
    return { view, onOpenChange, set: (open) => view.rerender(element(open)) };
  }

  it('Cancel, пока стартует первый агент комнаты: остальные агенты, комната и вкладка не создаются, диалог второй раз не закрывается', async () => {
    emptyWorkLayout();
    listCreatedInSnapshot();
    const held = holdSessions();
    const { onOpenChange, set } = await openDialog(true);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(held.count()).toBe(1));

    fireEvent.click(button('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    set(false);
    await held.release(0);
    await act(async () => {});

    expect(held.count()).toBe(1);
    expect(callsOf('sessions.create')).toHaveLength(1);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(openTabIds()).toEqual([]);
    // Человек отменил — «последний агент» не запоминается.
    expect(useUiStore.getState().ui.lastProvider).toBe(DEFAULT_UI.lastProvider);
  });

  it('закрыли и открыли заново, пока запуск шёл: старый запуск не идёт дальше, не закрывает новый диалог и не освобождает его кнопку', async () => {
    emptyWorkLayout();
    listCreatedInSnapshot();
    const held = holdSessions();
    const { onOpenChange, set } = await openDialog(true);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(held.count()).toBe(1));

    set(false);
    set(true);
    // Новое открытие — заново `providers.list`, чистая форма, кнопка не занята прежним запуском.
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(2));
    await waitFor(() => expect(button('Create room').disabled).toBe(false));
    expect(rows()).toHaveLength(2);

    // Новый запуск начался, а старый ещё ждёт ответа своего агента.
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(held.count()).toBe(2));
    await held.release(0);
    await act(async () => {});
    // Старый запуск ничего не сделал: не пошёл ко второму агенту, не закрыл диалог, не снял «занято» с нового запуска.
    expect(held.count()).toBe(2);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Create room').disabled).toBe(true);

    // Новый запуск идёт своим чередом: свои две сессии и комната.
    await held.release(1);
    await waitFor(() => expect(held.count()).toBe(3));
    await held.release(2);
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(1));
    expect(callsOf('sessions.create')).toHaveLength(3);
    expect(callsOf('rooms.create')[0]).toMatchObject({ members: ['s-02', 's-03'] });
  });

  it('старый запуск закончился, пока шёл новый: следующее закрытие отменяет уже новый запуск', async () => {
    emptyWorkLayout();
    listCreatedInSnapshot();
    const held = holdSessions();
    const { set } = await openDialog(true);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(held.count()).toBe(1));
    set(false);
    set(true);
    await waitFor(() => expect(button('Create room').disabled).toBe(false));
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(held.count()).toBe(2));
    await held.release(0);
    await act(async () => {});

    set(false);
    await held.release(1);
    await act(async () => {});
    expect(held.count()).toBe(2);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(openTabIds()).toEqual([]);
  });

  it('⌘T поверх открытого диалога (он уже как «New session»): форма начинается заново, запуск прежней формы отменяется', async () => {
    emptyWorkLayout();
    listCreatedInSnapshot();
    const held = holdSessions();
    const onOpenChange = vi.fn();
    const element = (room: boolean): JSX.Element => (
      <NewSessionOrRoomDialog open bridge={bridge} work={null} room={room} onOpenChange={onOpenChange} />
    );
    const view = render(element(true));
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1));
    await act(async () => {});
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(held.count()).toBe(1));

    view.rerender(element(false));
    await waitFor(() => expect(button('Start session').disabled).toBe(false));
    expect(rows()).toHaveLength(1);
    await held.release(0);
    await act(async () => {});

    expect(held.count()).toBe(1);
    expect(callsOf('rooms.create')).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(button('Start session').disabled).toBe(false);
    expect(openTabIds()).toEqual([]);
  });

  it('Cancel, пока создаётся комната: вкладка комнаты не открывается, диалог второй раз не закрывается', async () => {
    emptyWorkLayout();
    listCreatedInSnapshot();
    let releaseRoom: () => void = () => {};
    bridge.setHandler('rooms.create', () => new Promise((resolve) => (releaseRoom = () => resolve({ roomId: 'r-01' }))));
    const { onOpenChange, set } = await openDialog(true);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));

    fireEvent.click(button('Cancel'));
    set(false);
    await act(async () => releaseRoom());
    await act(async () => {});

    expect(openTabIds()).toEqual([]);
    expect(useUiStore.getState().roomExpanded).toEqual({});
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });

  it('закрыли и открыли заново, пока создаётся комната, и она упала: ошибка в новую форму не попадает', async () => {
    let rejectRoom: () => void = () => {};
    bridge.setHandler('rooms.create', () => new Promise((_resolve, reject) => (rejectRoom = () => reject({ code: 'internal', message: 'сбой' }))));
    const { set } = await openDialog(true);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));

    set(false);
    set(true);
    await waitFor(() => expect(button('Create room').disabled).toBe(false));
    await act(async () => rejectRoom());
    await act(async () => {});

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText("Couldn't create room: host error.")).toBeNull();
  });

  it('Cancel у одиночной сессии, пока она стартует: терминал не открывается, lastProvider не запоминается', async () => {
    emptyWorkLayout();
    listCreatedInSnapshot();
    const held = holdSessions();
    const { onOpenChange, set } = await openDialog(false);
    fireEvent.click(providerRadio(0, 'Codex'));
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(held.count()).toBe(1));

    fireEvent.click(button('Cancel'));
    set(false);
    await held.release(0);
    await act(async () => {});

    expect(openTabIds()).toEqual([]);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().ui.lastProvider).toBe(DEFAULT_UI.lastProvider);
  });
});

describe('NewSessionOrRoomDialog — «по умолчанию» фиксируется при запуске (находка 6 ревью)', () => {
  it('rooms.create упал: пилюли остаются теми, с которыми агенты запущены, а не прыгают на lastProvider', async () => {
    bridge.setHandler('rooms.create', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderDialog({ room: true });
    // Первая строка — агент по умолчанию (Claude), вторая — Codex явно: по её провайдеру запишется lastProvider.
    fireEvent.click(providerRadio(1, 'Codex'));
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    fireEvent.click(button('Create room'));
    expect(await screen.findByText("Couldn't create room: host error.")).toBeTruthy();

    expect(useUiStore.getState().ui.lastProvider).toBe('codex');
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    expect(isChecked(providerRadio(0, 'Codex'))).toBe(false);
    expect(isChecked(providerRadio(1, 'Codex'))).toBe(true);
    expect(screen.getAllByRole('status').map((line) => line.textContent)).toEqual(['S01 started', 'S02 started']);
  });
});

describe('NewSessionOrRoomDialog — ошибка диалога в подвале (находка 5 ревью)', () => {
  it('rooms.create упал: ошибка — role=alert в подвале, а не внизу прокручиваемого тела', async () => {
    bridge.setHandler('rooms.create', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Couldn't create room: host error.");
    expect(alert.closest('[data-dialog-footer]')).not.toBeNull();
  });

  it('отказ providers.list: ошибка тоже в подвале', async () => {
    bridge.setHandler('roles.list', async () => ({ roles: [], diagnostics: [], partial: false }));
  bridge.setHandler('providers.list', async () => {
      throw { code: 'internal', message: 'сбой' };
    });
    render(<NewSessionOrRoomDialog open bridge={bridge} work={null} room={false} onOpenChange={() => {}} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Couldn't load providers: host error.");
    expect(alert.closest('[data-dialog-footer]')).not.toBeNull();
  });

  it('без ошибки role=alert нет', async () => {
    await renderDialog();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('source-qualified role choices and explicit defaults', () => {
  const roles = [
    { id: 'builtin:planner', name: 'Planner', source: 'builtin' as const, provider: 'claude', description: 'Plan', model: 'opus', effort: 'high', readOnly: true, models: { claude: 'opus', codex: 'gpt-6-astra' } },
    { id: 'claude:Planner', name: 'Planner', source: 'claude' as const, provider: 'claude', description: 'Native', model: null, effort: null, readOnly: false },
    { id: 'codex:Planner', name: 'Planner', source: 'codex' as const, provider: 'codex', description: 'Native', model: 'gpt-6.1-sol', effort: 'xhigh', readOnly: true },
  ];
  const roleControl = () => within(rows()[0]!).getByRole('combobox', { name: 'Role' });
  it('distinguishes same-name sources, displays native effort and locks its provider without persisting defaults', async () => {
    bridge.setHandler('roles.list', async () => ({ roles, diagnostics: [], partial: false }));
    await renderDialog();
    await chooseOption(roleControl(), '🔒 Planner · Codex');
    expect(screen.getByText('Default effort: xhigh')).toBeTruthy();
    const providers = within(rows()[0]!).getByRole('radiogroup', { name: 'Agent 1' });
    expect(within(providers).getAllByRole('radio').every(item => (item as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    const sent = callsOf('sessions.create')[0]!;
    expect(sent).toMatchObject({ provider: 'codex', role: { source: 'codex', name: 'Planner' } });
    expect(Object.hasOwn(sent, 'effort')).toBe(false); expect(Object.hasOwn(sent, 'model')).toBe(false);
  });
  it('explicit Model Default clears a role default with null while untouched effort remains absent', async () => {
    bridge.setHandler('roles.list', async () => ({ roles, diagnostics: [], partial: false }));
    await renderDialog();
    await chooseOption(roleControl(), '🔒 Planner · Builtin');
    await chooseOption(within(rows()[0]!).getByRole('combobox', { name: 'Model' }), 'Default');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ role: { source: 'builtin', name: 'planner' }, model: null });
    expect(Object.hasOwn(callsOf('sessions.create')[0]!, 'effort')).toBe(false);
  });
});


describe('prepared backlog completion context', () => {
  const context = { projectPath: PROJECT, id: 'b-001', version: 'v1', task: 'Backlog title\n\nBacklog details' };
  async function prepared(room = true, onCreated = vi.fn().mockResolvedValue(undefined)) {
    const onOpenChange = vi.fn();
    render(<NewSessionOrRoomDialog open bridge={bridge} work={{ projectPath: PROJECT, workId: 'w-01' }} room={room}
      backlog={context} onCreated={onCreated} onOpenChange={onOpenChange} />);
    await waitFor(() => expect(callsOf('providers.list')).toHaveLength(1)); await act(async () => {});
    return { onCreated, onOpenChange };
  }
  it('prefills the task without changing plain creation choices and calls marking only after a room exists', async () => {
    const onCreated = vi.fn(async () => { expect(callsOf('rooms.create')).toHaveLength(1); });
    const { onOpenChange } = await prepared(true, onCreated);
    expect((screen.getByLabelText('Task') as HTMLTextAreaElement).value).toBe(context.task);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ projectPath: PROJECT, workId: 'w-01', roomId: 'r-01' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toHaveLength(2);
    for (const call of callsOf('sessions.create')) { expect(call.task).toBe(context.task); expect(call).not.toHaveProperty('model'); expect(call).not.toHaveProperty('effort'); }
  });
  it('room marker failure preserves the created target; Retry never creates a second room or session', async () => {
    const onCreated = vi.fn().mockRejectedValueOnce(new Error('PRIVATE_MARK_ERROR')).mockResolvedValue(undefined);
    const { onOpenChange } = await prepared(true, onCreated); fireEvent.click(button('Create room'));
    await screen.findByText(S.backlog.markFailed); expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.queryByText('PRIVATE_MARK_ERROR')).toBeNull();
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')).toHaveLength(1); expect(callsOf('sessions.create')).toHaveLength(2);
    expect(onCreated.mock.calls).toEqual([[{ projectPath: PROJECT, workId: 'w-01', roomId: 'r-01' }], [{ projectPath: PROJECT, workId: 'w-01', roomId: 'r-01' }]]);
  });
  it('a room creation failure leaves the stable prepared item unmarked; retry creates only the missing room', async () => {
    bridge.setHandler('rooms.create', () => { throw new Error('Room failed'); });
    const { onCreated } = await prepared(); fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1)); await act(async () => {});
    expect(onCreated).not.toHaveBeenCalled();
    bridge.setHandler('rooms.create', () => ({ roomId: 'r-02' })); fireEvent.click(button('Retry'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ projectPath: PROJECT, workId: 'w-01', roomId: 'r-02' }));
    expect(callsOf('sessions.create')).toHaveLength(2); expect(callsOf('rooms.create')).toHaveLength(2);
  });
  it('single-session Take preserves its target through marker Retry and does not offer a foreign project', async () => {
    const onCreated = vi.fn().mockRejectedValueOnce(new Error('marker')).mockResolvedValue(undefined);
    const { onOpenChange } = await prepared(false, onCreated); fireEvent.click(button('Start session'));
    await screen.findByText(S.backlog.markFailed); fireEvent.click(button('Retry'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toHaveLength(1); expect(callsOf('rooms.create')).toHaveLength(0);
    expect(onCreated.mock.calls[0]).toEqual([{ projectPath: PROJECT, workId: 'w-01', sessionId: 's-01' }]);
    expect(callsOf('sessions.create')[0]!.projectPath).toBe(PROJECT);
  });
});


describe('рецепты комнат (P26, спека рецептов 6.1, 6.2, 8)', () => {
  const role = (id: string, provider: string) => ({
    id, name: id.slice(id.indexOf(':') + 1), source: id.startsWith('builtin') ? ('builtin' as const) : ('claude' as const), provider,
    description: id, model: null, effort: null, readOnly: false, models: { claude: null, codex: null },
  });
  const ROLES = [role('builtin:planner', 'claude'), role('builtin:critic', 'codex'), role('builtin:executor', 'claude'), role('builtin:reviewer', 'codex'), role('builtin:architect', 'claude'), role('claude:security', 'claude')];
  interface Choice { role: string; worktree: boolean; lead: boolean; provider?: string; model?: string | null; effort?: string | null }
  const agentView = (choice: Choice, resolvedProvider = choice.provider ?? 'claude', status = 'ready') =>
    ({ choice, status, resolved: status === 'ready' ? { provider: resolvedProvider, model: null, effort: null, readOnly: false } : null });
  const recipeEntry = (id: string, name: string, mode: string, agents: unknown[], playbook = 'Lead playbook\n') => ({
    status: 'valid' as const,
    recipe: { id, source: id.startsWith('builtin') ? 'builtin' : 'project', name, description: `${name} description`, mode, playbook, agents: [] },
    agents,
  });
  const PLAN_BUILD = recipeEntry('builtin:plan-build', 'Plan & build', 'verified', [
    agentView({ role: 'builtin:planner', worktree: false, lead: true }),
    agentView({ role: 'builtin:critic', worktree: false, lead: false }, 'codex'),
    agentView({ role: 'builtin:executor', worktree: true, lead: false }),
    agentView({ role: 'builtin:reviewer', worktree: false, lead: false }, 'codex'),
  ]);
  const REVIEW = recipeEntry('builtin:review', 'Review', 'free', [
    agentView({ role: 'builtin:reviewer', worktree: false, lead: true }, 'codex'),
    agentView({ role: 'builtin:architect', worktree: false, lead: false }),
  ]);
  const BROKEN = { status: 'invalid' as const, id: 'project:broken', file: 'broken.md', diagnostic: { code: 'invalid-yaml' as const, line: 3 } };
  let entriesNow: unknown[] = [];
  const stubRecipes = (entries: unknown[] = [PLAN_BUILD, REVIEW, BROKEN]): void => {
    entriesNow = entries;
    bridge.setHandler('recipes.list', async () => ({ entries: entriesNow, partial: false, diagnostics: [] }) as never);
  };
  beforeEach(() => {
    bridge.setHandler('roles.list', async () => ({ roles: ROLES, diagnostics: [], partial: false }));
    stubRecipes();
  });

  const recipeSelect = (): HTMLElement => within(dialog()).getByRole('combobox', { name: 'Recipe' });
  const modeSelect = (): HTMLElement => within(dialog()).getByRole('combobox', { name: 'Mode' });
  async function pick(name: string | RegExp): Promise<void> {
    await waitFor(() => expect(within(dialog()).queryByRole('combobox', { name: 'Recipe' })).not.toBeNull());
    await chooseOption(recipeSelect(), name);
    await act(async () => {});
  }
  const roleOfRow = (row: number): string => within(rows()[row] as HTMLElement).getByRole('combobox', { name: 'Role' }).textContent ?? '';
  const worktreeButton = (row: number): HTMLElement => within(rows()[row] as HTMLElement).getByRole('button', { name: 'Own worktree' });
  const stars = (): Array<string | null> => screen.getAllByRole('button', { name: /^(Lead|Make lead)$/ }).map((item) => item.getAttribute('aria-pressed'));

  it('хост без recipes.list: выбора рецепта нет, диалог работает как раньше', async () => {
    bridge.setHandler('recipes.list', async () => { throw new Error('unknown method'); });
    await renderDialog();
    await act(async () => {});
    expect(within(dialog()).queryByRole('combobox', { name: 'Recipe' })).toBeNull();
    expect(button('Start session').disabled).toBe(false);
  });

  it('список: No recipe первым, встроенные, битый — с причиной и без возможности выбрать', async () => {
    await renderDialog();
    await waitFor(() => expect(within(dialog()).queryByRole('combobox', { name: 'Recipe' })).not.toBeNull());
    expect(recipeSelect().textContent).toBe('No recipe');
    fireEvent.keyDown(recipeSelect(), { key: 'ArrowDown' });
    const options = (await screen.findAllByRole('option')).map((item) => item.textContent);
    expect(options).toEqual(['No recipe', 'Plan & build', 'Review', 'broken.md · Not valid YAML']);
    const broken = screen.getByRole('option', { name: /broken\.md/ });
    expect(broken.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(broken);
    await act(async () => {});
    // Список остался открытым (прячет диалог от дерева доступности), строки не менялись.
    expect(document.querySelectorAll('[data-agent-row]')).toHaveLength(1);
  });

  it('выбор рецепта заполняет состав по ролям, режим и ведущего; описание — под списком', async () => {
    await renderDialog();
    await pick('Plan & build');
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole('heading', { name: 'New room' })).toBeTruthy();
    expect([0, 1, 2, 3].map(roleOfRow)).toEqual(['planner · Builtin', 'critic · Builtin', 'executor · Builtin', 'reviewer · Builtin']);
    expect(modeSelect().textContent).toBe('Verified');
    expect(stars()).toEqual(['true', 'false', 'false', 'false']);
    expect(isChecked(providerRadio(1, 'Codex'))).toBe(true);
    expect(isChecked(providerRadio(2, 'Claude'))).toBe(true);
    expect([0, 1, 2, 3].map((index) => worktreeButton(index).getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
    expect(dialog().querySelector('[data-recipe-description]')?.textContent).toBe('Plan & build description');
    expect(screen.getByText('Room with 4 agents in Payments')).toBeTruthy();
  });

  it('поля после выбора правятся: провайдер, роль, строки, ведущий, режим, worktree; No recipe строки не трогает', async () => {
    await renderDialog();
    await pick('Review');
    expect(stars()).toEqual(['true', 'false']);
    fireEvent.click(providerRadio(0, 'Claude'));
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'critic · Builtin');
    expect(roleOfRow(1)).toBe('critic · Builtin');
    fireEvent.click(screen.getAllByRole('button', { name: 'Make lead' })[0] as HTMLElement);
    expect(stars()).toEqual(['false', 'true']);
    await chooseOption(modeSelect(), 'Checklist');
    expect(modeSelect().textContent).toBe('Checklist');
    fireEvent.click(worktreeButton(1));
    expect(worktreeButton(1).getAttribute('aria-pressed')).toBe('true');
    await addAgent();
    expect(rows()).toHaveLength(3);
    fireEvent.click(within(rows()[2] as HTMLElement).getByRole('button', { name: 'Remove agent' }));
    expect(rows()).toHaveLength(2);
    await chooseOption(recipeSelect(), 'No recipe');
    expect(rows()).toHaveLength(2);
    expect(modeSelect().textContent).toBe('Checklist');
    expect(roleOfRow(1)).toBe('critic · Builtin');
  });

  it('запуск: роли, worktree построчно, rooms.create с mode и снимком рецепта из свежего recipes.list', async () => {
    const { onOpenChange } = await renderDialog();
    await pick('Plan & build');
    // Файл рецепта поправили, пока диалог был открыт: снимок берётся в момент создания.
    stubRecipes([{ ...PLAN_BUILD, recipe: { ...PLAN_BUILD.recipe, playbook: 'Edited playbook\n' } }, REVIEW]);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    const sessions = callsOf('sessions.create');
    expect(sessions.map((call) => call.role)).toEqual([
      { source: 'builtin', name: 'planner' }, { source: 'builtin', name: 'critic' }, { source: 'builtin', name: 'executor' }, { source: 'builtin', name: 'reviewer' },
    ]);
    expect(sessions.map((call) => call.provider)).toEqual(['claude', 'codex', 'claude', 'codex']);
    expect(sessions.map((call) => call.worktree)).toEqual([false, false, true, false]);
    // Умолчания роли не превращаются в явный выбор: model и effort не уходят.
    for (const call of sessions) { expect(call).not.toHaveProperty('model'); expect(call).not.toHaveProperty('effort'); }
    expect(callsOf('rooms.create')).toEqual([
      { projectPath: PROJECT, workId: 'w-01', title: 'Room 1', members: ['s-01', 's-02', 's-03', 's-04'], lead: 's-01', quiet: true, mode: 'verified',
        recipe: { id: 'builtin:plan-build', name: 'Plan & build', playbook: 'Edited playbook\n' } },
    ]);
  });

  it('режим, выбранный человеком, главнее режима рецепта; free не уходит параметром', async () => {
    const { onOpenChange } = await renderDialog();
    await pick('Plan & build');
    await chooseOption(modeSelect(), 'Free');
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')[0]).not.toHaveProperty('mode');
    expect(callsOf('rooms.create')[0]).toHaveProperty('recipe');
  });

  it('без рецепта режим выбирается в диалоге; одиночная сессия режима не показывает', async () => {
    const { onOpenChange } = await renderDialog();
    expect(within(dialog()).queryByRole('combobox', { name: 'Mode' })).toBeNull();
    await addAgent();
    await chooseOption(modeSelect(), 'Checklist');
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')[0]).toMatchObject({ mode: 'checklist' });
    expect(callsOf('rooms.create')[0]).not.toHaveProperty('recipe');
  });

  it('рецепт выбран, осталась одна строка: заметка, что рецепт и режим не сохранятся; создаётся обычная сессия', async () => {
    await renderDialog();
    await pick('Review');
    expect(dialog().querySelector('[data-recipe-dropped]')).toBeNull();
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: 'Remove agent' }));
    expect(rows()).toHaveLength(1);
    expect(dialog().querySelector('[data-recipe-dropped]')?.textContent).toMatch(/starts a plain session without them/);
    // Вернули вторую строку — заметки нет.
    await addAgent();
    expect(dialog().querySelector('[data-recipe-dropped]')).toBeNull();
  });

  it('режим без рецепта при одной строке тоже не теряется молча; без рецепта и режима заметки нет', async () => {
    await renderDialog();
    expect(dialog().querySelector('[data-recipe-dropped]')).toBeNull();
    await addAgent();
    await chooseOption(modeSelect(), 'Checklist');
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: 'Remove agent' }));
    expect(dialog().querySelector('[data-recipe-dropped]')).not.toBeNull();
  });

  it('заданное рецептом — явный выбор: провайдер, модель и усилие уходят и не перетираются умолчаниями роли', async () => {
    stubRecipes([recipeEntry('project:pinned', 'Pinned', 'free', [
      agentView({ role: 'builtin:critic', worktree: false, lead: true, provider: 'claude', model: 'sonnet', effort: 'high' }),
      agentView({ role: 'builtin:reviewer', worktree: false, lead: false }, 'codex'),
    ])]);
    const { onOpenChange } = await renderDialog();
    await pick('Pinned');
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    expect(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }).textContent).toBe('Sonnet');
    // Смена роли умолчание (Codex) поверх явного выбора рецепта не ставит.
    await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'planner · Builtin');
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    // Строка без явного провайдера следует роли.
    await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'critic · Builtin');
    expect(isChecked(providerRadio(1, 'Codex'))).toBe(true);
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'high', role: { source: 'builtin', name: 'planner' } });
    expect(callsOf('sessions.create')[1]).toMatchObject({ provider: 'codex' });
    expect(callsOf('sessions.create')[1]).not.toHaveProperty('model');
    expect(callsOf('sessions.create')[1]).not.toHaveProperty('effort');
  });

  it('провайдер встроенной роли недоступен на машине — строка берёт агента по умолчанию', async () => {
    stubRecipes([recipeEntry('project:far', 'Far', 'free', [
      agentView({ role: 'builtin:planner', worktree: false, lead: true }, 'cursor'),
      agentView({ role: 'builtin:reviewer', worktree: false, lead: false }, 'codex'),
    ])]);
    await renderDialog();
    await pick('Far');
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    expect(isChecked(providerRadio(1, 'Codex'))).toBe(true);
  });

  it('роли нет на этой машине: строка помечена, комната не создаётся, пока её не поправят', async () => {
    stubRecipes([recipeEntry('project:ghost', 'Ghost', 'free', [
      agentView({ role: 'builtin:planner', worktree: false, lead: true }),
      agentView({ role: 'claude:vanished', worktree: false, lead: false }, 'claude', 'role-missing'),
    ])]);
    await renderDialog();
    await pick('Ghost');
    expect(dialog().querySelector('[data-role-missing]')?.textContent).toBe('Role not found: claude:vanished. Pick another role or remove this agent.');
    expect(button('Create room').disabled).toBe(true);
    await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'reviewer · Builtin');
    expect(dialog().querySelector('[data-role-missing]')).toBeNull();
    expect(button('Create room').disabled).toBe(false);
    expect(callsOf('sessions.create')).toHaveLength(0);
  });

  it('не git-проект: worktree рецепта не просят, причина видна', async () => {
    bridge.setHandler('worktrees.available', async () => ({ available: false }));
    const { onOpenChange } = await renderDialog();
    await pick('Plan & build');
    expect(screen.getByText('This project is not a Git repository, so agents share the project folder.')).toBeTruthy();
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create').map((call) => call.worktree)).toEqual([false, false, false, false]);
  });

  it('сбой строки: комнаты и рецепта нет, итог по строке; Retry создаёт только упавших и комнату с mode и снимком', async () => {
    let fail = true;
    bridge.setHandler('sessions.create', async (params) => {
      const role = (params as { role?: { name: string } }).role?.name;
      if (role === 'critic' && fail) throw Object.assign(new Error('boom'), { code: 'internal' });
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: `s-${String(nextSession++).padStart(2, '0')}` } };
    });
    const { onOpenChange } = await renderDialog();
    await pick('Plan & build');
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(4));
    await act(async () => {});
    expect(callsOf('rooms.create')).toHaveLength(0);
    expect(button('Retry')).toBeTruthy();
    expect(within(rows()[1] as HTMLElement).getByRole('status').textContent).toMatch(/create session/);
    fail = false;
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // Повтор — только упавшая строка (critic), остальные не пересоздаются.
    expect(callsOf('sessions.create')).toHaveLength(5);
    expect((callsOf('sessions.create')[4] as { role: { name: string } }).role.name).toBe('critic');
    expect(callsOf('rooms.create')).toHaveLength(1);
    expect(callsOf('rooms.create')[0]).toMatchObject({ mode: 'verified', members: ['s-01', 's-04', 's-02', 's-03'], recipe: { id: 'builtin:plan-build' } });
  });

  it('рецепт исчез к созданию: комната без него не создаётся; когда он вернулся, Retry создаёт только комнату', async () => {
    const { onOpenChange } = await renderDialog();
    await pick('Plan & build');
    stubRecipes([REVIEW]);
    fireEvent.click(button('Create room'));
    await screen.findByText('The recipe is no longer available. Choose it again or pick No recipe.');
    expect(callsOf('rooms.create')).toHaveLength(0);
    expect(onOpenChange).not.toHaveBeenCalled();
    stubRecipes([PLAN_BUILD, REVIEW]);
    fireEvent.click(button('Retry'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toHaveLength(4);
    expect(callsOf('rooms.create')).toHaveLength(1);
  });

  it('старт рецепта запускает ровно его участников: четыре sessions.create и одна комната, временной одиночной сессии нет (P37)', async () => {
    const { onOpenChange } = await renderDialog();
    await pick('Plan & build');
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('sessions.create')).toHaveLength(4);
    expect(callsOf('sessions.create').map((call) => (call as { role: { name: string } }).role.name)).toEqual(['planner', 'critic', 'executor', 'reviewer']);
    expect(callsOf('rooms.create')).toHaveLength(1);
  });

  it('рецепт из четырёх при трёх свободных слотах: старт блокируется до первой сессии, а не наполовину (P37)', async () => {
    bridge.setHandler('settings.get', async () => ({ config: { ...DEFAULT_RESOURCE_LIMITS, workConcurrent: 3 } as never, locked: {} }));
    await renderDialog();
    await pick('Plan & build');
    await waitFor(() => expect(dialog().querySelector('[data-budget-blocked]')?.textContent).toBe('This start needs 4 session slots, 3 left. Stop a session or raise the limits in Settings → Agents.'));
    expect(button('Create room').disabled).toBe(true);
    expect(callsOf('sessions.create')).toHaveLength(0);
  });

  describe('Save as recipe', () => {
    const field = (name: string): HTMLInputElement => within(dialog()).getByLabelText(name) as HTMLInputElement;
    const typeIn = (name: string, value: string): void => { fireEvent.change(field(name), { target: { value } }); };
    async function openSave(): Promise<void> {
      await waitFor(() => expect(within(dialog()).queryByRole('combobox', { name: 'Recipe' })).not.toBeNull());
      fireEvent.click(button('Save as recipe…'));
      await act(async () => {});
    }
    /** Состав из двух ролей: исполнитель — ведущий, с явными провайдером и моделью и своим worktree. */
    async function compose(): Promise<void> {
      await addAgent();
      await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'planner · Builtin');
      await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'executor · Builtin');
      fireEvent.click(providerRadio(1, 'Codex'));
      await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Model' }), 'GPT-6 Astra');
      fireEvent.click(worktreeButton(1));
      fireEvent.click(screen.getByRole('button', { name: 'Make lead' }));
      await chooseOption(modeSelect(), 'Checklist');
    }

    it('кнопки нет у одиночной сессии; у комнаты она есть', async () => {
      await renderDialog();
      await waitFor(() => expect(within(dialog()).queryByRole('combobox', { name: 'Recipe' })).not.toBeNull());
      expect(screen.queryByRole('button', { name: 'Save as recipe…' })).toBeNull();
      await addAgent();
      expect(screen.getByRole('button', { name: 'Save as recipe…' })).toBeTruthy();
    });

    it('пишет состав, режим, worktree и ведущего; явные provider/model — только тронутые; плейбук — шаблон этапов', async () => {
      await renderDialog();
      await compose();
      await openSave();
      expect(screen.getByRole('heading', { name: 'Save as recipe' })).toBeTruthy();
      typeIn('Recipe name', 'Payments change');
      expect(field('File name').value).toBe('payments-change');
      typeIn('Description', 'Plan then build');
      expect((within(dialog()).getByLabelText('Lead playbook') as HTMLTextAreaElement).value).toMatch(/^1\. Ask the human/);
      fireEvent.click(button('Save recipe'));
      await waitFor(() => expect(bridge.saveRecipeCalls).toHaveLength(1));
      expect(bridge.saveRecipeCalls[0]).toMatchObject({
        projectPath: PROJECT, file: 'payments-change', name: 'Payments change', description: 'Plan then build', mode: 'checklist', replace: false,
        agents: [
          { role: 'builtin:planner', worktree: false, lead: false, count: 1 },
          { role: 'builtin:executor', worktree: true, lead: true, count: 1, provider: 'codex', model: 'gpt-6-astra' },
        ],
      });
      expect(bridge.saveRecipeCalls[0]?.agents[0]).not.toHaveProperty('provider');
      expect(bridge.saveRecipeCalls[0]?.playbook.endsWith('\n')).toBe(true);
      // Возврат в форму: список перечитан, новый рецепт выбран, диалог открыт.
      await waitFor(() => expect(screen.getByRole('heading', { name: 'New room' })).toBeTruthy());
      expect(vi.mocked(toast)).toHaveBeenCalledWith('Saved recipe Payments change');
      expect(callsOf('recipes.list').length).toBeGreaterThanOrEqual(2);
    });

    it('тронутый провайдер, который не определился (пустой у роли), в файл не уходит пустой строкой', async () => {
      bridge.setHandler('roles.list', async () => ({ roles: [...ROLES, role('claude:blank', '')], diagnostics: [], partial: false }));
      await renderDialog();
      await addAgent();
      await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'planner · Builtin');
      await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'executor · Builtin');
      fireEvent.click(providerRadio(1, 'Codex'));
      await chooseOption(within(rows()[1] as HTMLElement).getByRole('combobox', { name: 'Role' }), 'blank · Claude');
      await openSave();
      typeIn('Recipe name', 'Blank'); typeIn('Description', 'Y');
      fireEvent.click(button('Save recipe'));
      await waitFor(() => expect(bridge.saveRecipeCalls).toHaveLength(1));
      expect(bridge.saveRecipeCalls[0]?.agents[1]).not.toHaveProperty('provider');
    });

    it('плейбук выбранного рецепта предлагается как основа и правится', async () => {
      await renderDialog();
      await pick('Review');
      await openSave();
      expect((within(dialog()).getByLabelText('Lead playbook') as HTMLTextAreaElement).value).toBe('Lead playbook\n');
    });

    it('строка без роли — рецепт не собрать, файл не пишется', async () => {
      await renderDialog();
      await addAgent();
      await openSave();
      typeIn('Recipe name', 'X'); typeIn('Description', 'Y');
      fireEvent.click(button('Save recipe'));
      await screen.findByText('Choose a role for every agent to save a recipe.');
      expect(bridge.saveRecipeCalls).toHaveLength(0);
    });

    it('имя файла с ../ или слешем отвергается до обращения к main', async () => {
      await renderDialog();
      await compose();
      await openSave();
      typeIn('Recipe name', 'X'); typeIn('Description', 'Y');
      for (const bad of ['../escape', 'a/b', '.hidden', 'x.md', '']) {
        typeIn('File name', bad);
        fireEvent.click(button('Save recipe'));
        await screen.findByText('Use letters, digits, - and _ in the file name.');
      }
      expect(bridge.saveRecipeCalls).toHaveLength(0);
    });

    it('занятое имя: main ответил exists — предлагаются Rename и Replace, перезаписи без выбора нет', async () => {
      bridge.setSaveRecipeAnswer(async (request) => request.replace ? { status: 'saved', id: 'project:taken', opened: true } : { status: 'exists' });
      await renderDialog();
      await compose();
      await openSave();
      typeIn('Recipe name', 'Taken'); typeIn('Description', 'Y');
      fireEvent.click(button('Save recipe'));
      await screen.findByText('taken.md already exists. Rename the file or replace it.');
      expect(bridge.saveRecipeCalls.map((call) => call.replace)).toEqual([false]);
      expect(screen.queryByRole('button', { name: 'Save recipe' })).toBeNull();
      // Rename: сообщение уходит, поле имени файла доступно, запрос заново — уже без replace.
      fireEvent.click(button('Rename'));
      expect(screen.queryByText(/already exists/)).toBeNull();
      expect(document.activeElement).toBe(field('File name'));
      typeIn('File name', 'taken-2');
      fireEvent.click(button('Save recipe'));
      await waitFor(() => expect(bridge.saveRecipeCalls).toHaveLength(2));
      expect(bridge.saveRecipeCalls[1]).toMatchObject({ file: 'taken-2', replace: false });
    });

    it('Replace — явный выбор человека: запрос с replace: true', async () => {
      let first = true;
      bridge.setSaveRecipeAnswer(async (request) => { if (first) { first = false; return { status: 'exists' }; } return { status: 'saved', id: `project:${request.file}`, opened: false }; });
      await renderDialog();
      await compose();
      await openSave();
      typeIn('Recipe name', 'Taken'); typeIn('Description', 'Y');
      fireEvent.click(button('Save recipe'));
      await screen.findByRole('button', { name: 'Replace' });
      fireEvent.click(button('Replace'));
      await waitFor(() => expect(bridge.saveRecipeCalls).toHaveLength(2));
      expect(bridge.saveRecipeCalls.map((call) => call.replace)).toEqual([false, true]);
      await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('Saved recipe Taken. The file could not be opened.'));
    });

    it('отказ main — безопасный текст без сырой ошибки, форма остаётся', async () => {
      bridge.setSaveRecipeAnswer(async () => { throw Object.assign(new Error('/private/path EACCES'), { code: 'failed' }); });
      await renderDialog();
      await compose();
      await openSave();
      typeIn('Recipe name', 'X'); typeIn('Description', 'Y');
      fireEvent.click(button('Save recipe'));
      await screen.findByRole('alert');
      expect(dialog().textContent).not.toContain('EACCES');
      expect(button('Save recipe')).toBeTruthy();
    });

    it('Back возвращает в форму с тем же составом', async () => {
      await renderDialog();
      await compose();
      await openSave();
      fireEvent.click(button('Back'));
      expect(rows()).toHaveLength(2);
      expect(modeSelect().textContent).toBe('Checklist');
    });
  });
});

describe('бюджет работы при старте (P37)', () => {
  /** Пороги приходят из настроек при открытии диалога. */
  const stubSettings = (patch: Record<string, number> = {}): void => {
    // Диалогу нужны только пороги: остальное в настройках ему не интересно.
    bridge.setHandler('settings.get', async () => ({ config: { ...DEFAULT_RESOURCE_LIMITS, ...patch } as never, locked: {} }));
  };
  const activeSessions = (count: number): void => {
    useWorksStore.setState({
      entries: [
        makeWork('w-01', {
          projectPath: PROJECT,
          title: 'Payments',
          sessions: Array.from({ length: count }, (_, index) => makeSession(`s-0${index + 1}`, `s${index + 1}`)),
        }),
      ],
    });
  };
  const budgetLine = (): string | null => dialog().querySelector('[data-budget]')?.textContent ?? null;
  const blocked = (): string | null => dialog().querySelector('[data-budget-blocked]')?.textContent ?? null;

  it('подвал показывает занятое и сколько запусков осталось; пороги — из настроек, не выдуманные окном', async () => {
    stubSettings({ workConcurrent: 5, workLaunches: 9 });
    activeSessions(2);
    await renderDialog();
    await waitFor(() => expect(budgetLine()).toBe('2 of 5 sessions running · 9 starts left this hour'));
    expect(blocked()).toBeNull();
    expect(button('Start session').disabled).toBe(false);
  });

  it('хост без порогов (прежняя версия): подвала бюджета нет, решает хост', async () => {
    bridge.setHandler('settings.get', async () => { throw new Error('unknown method'); });
    await renderDialog();
    await act(async () => {});
    expect(budgetLine()).toBeNull();
    expect(button('Start session').disabled).toBe(false);
  });

  it('старт не помещается в слоты: кнопка неактивна, причина видна, ни одной sessions.create', async () => {
    stubSettings({ workConcurrent: 3 });
    activeSessions(2);
    await renderDialog({ room: true });
    await waitFor(() => expect(blocked()).toBe('This start needs 2 session slots, 1 left. Stop a session or raise the limits in Settings → Agents.'));
    expect(button('Create room').disabled).toBe(true);
    fireEvent.click(button('Create room'));
    await act(async () => {});
    expect(callsOf('sessions.create')).toHaveLength(0);
    expect(callsOf('rooms.create')).toHaveLength(0);

    // Убрали агента — теперь нужно одно место, и один агент помещается.
    fireEvent.click(screen.getAllByRole('button', { name: S.dialogs.newSession.removeAgent })[1] as HTMLElement);
    await act(async () => {});
    expect(blocked()).toBeNull();
  });

  it('окно запусков в часе исчерпано: сказано про запуски, а не про слоты', async () => {
    stubSettings({ workLaunches: 1 });
    await renderDialog({ room: true });
    await waitFor(() => expect(blocked()).toBe('This start needs 2 launches, 1 left this hour. Wait or raise the limits in Settings → Agents.'));
    expect(button('Create room').disabled).toBe(true);
  });

  it('комната больше своего порога: сказано про комнату, работа вместить могла бы', async () => {
    stubSettings({ roomConcurrent: 2 });
    await renderDialog({ room: true });
    await addAgent();
    await waitFor(() => expect(blocked()).toBe('A room runs at most 2 sessions at once; this one has 3. Remove an agent or raise the limit in Settings → Agents.'));
    expect(button('Create room').disabled).toBe(true);
  });

  it('старт команды запускает ровно запрошенных участников: три sessions.create, одна комната, лишней одиночной сессии нет', async () => {
    stubSettings();
    const { onOpenChange } = await renderDialog({ room: true });
    await addAgent();
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    expect(callsOf('sessions.create')).toHaveLength(3);
    expect(callsOf('sessions.create').every((call) => call.parent === null && call.task === '')).toBe(true);
    expect(callsOf('rooms.create')).toHaveLength(1);
    expect(callsOf('rooms.create')[0]?.members).toEqual(['s-01', 's-02', 's-03']);
  });

  it('отказ самого хоста по агенту показан его словами, комнаты нет, модель не запущена', async () => {
    stubSettings();
    bridge.setHandler('sessions.create', async () => {
      throw Object.assign(new Error('session limit reached: 10 of 10 sessions are running or reserved in this workspace; stop one or raise the limit in Settings'), {
        code: 'conflict', data: { code: 'resource-budget', reason: 'concurrent' },
      });
    });
    await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    await waitFor(() => expect(within(rows()[0] as HTMLElement).getByRole('status').textContent).toMatch(/^Not started: session limit reached: 10 of 10/));
    expect(callsOf('rooms.create')).toHaveLength(0);
    expect(button('Retry')).toBeTruthy();
  });

  it('Retry после частичного сбоя считает слоты только для упавших строк: запущенный уже занял своё место в карте', async () => {
    stubSettings({ workConcurrent: 3 });
    activeSessions(1);
    bridge.setHandler('sessions.create', async (params) => {
      if (callsOf('sessions.create').length === 2) throw Object.assign(new Error('boom'), { code: 'internal' });
      const id = `s-0${nextSession++ + 1}`;
      // Хост записал сессию в карту, окно получило новый снимок работ.
      const [entry] = useWorksStore.getState().entries;
      if (entry !== undefined) {
        useWorksStore.setState({ entries: [{ ...entry, map: { ...entry.map, sessions: [...entry.map.sessions, makeSession(id, id)] } }] });
      }
      return { ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: id } };
    });
    await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    await screen.findByRole('button', { name: 'Retry' });
    await act(async () => {});
    // Свободен один слот из трёх (занято два: прежняя и запущенная), и нужен один — упавшей строке.
    expect(budgetLine()).toBe('2 of 3 sessions running · 40 starts left this hour');
    expect(blocked()).toBeNull();
    expect(button('Retry').disabled).toBe(false);
  });
});

describe('NewSessionOrRoomDialog — подключение провайдера', () => {
  type Providers = Result<'providers.list'>['providers'];
  const glm = (available = false): Providers[number] => ({
    id: 'glm', label: 'GLM', available, family: 'claude', version: '2.1.287',
    needs: available ? null : 'key', keyHint: available ? '••••test' : null,
    models: [{ id: 'glm-5.3', label: 'GLM-5.3' }, { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash' }], effort: false,
  });
  const list = (available = false): Providers => [...PROVIDERS.filter((provider) => provider.id !== 'glm'), glm(available)];
  const card = (): HTMLElement => document.querySelector<HTMLElement>('[data-provider-card]') as HTMLElement;
  function openable(): { set: (open: boolean) => void } {
    const element = (open: boolean): JSX.Element =>
      <NewSessionOrRoomDialog open={open} bridge={bridge} work={null} room={false} onOpenChange={() => {}} />;
    const view = render(element(true));
    return { set: (open) => view.rerender(element(open)) };
  }

  it('недоступная пилюля открывает общую карточку без смены провайдера или модели', async () => {
    bridge.setHandler('providers.list', async () => ({ providers: list() }));
    await renderDialog();
    const model = within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' });
    await chooseOption(model, 'Sonnet');
    // Radix возвращает фокус из списка модели до открытия следующей всплывающей панели.
    await waitFor(() => expect(document.activeElement).toBe(model));
    fireEvent.click(providerRadio(0, 'GLM'));
    const keyInput = await screen.findByLabelText('Z.ai API key');
    expect(keyInput.closest('form')).toBeNull();
    fireEvent.keyDown(keyInput, { key: 'Enter' });
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    expect(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }).textContent).toBe('Sonnet');
    expect(callsOf('sessions.create')).toEqual([]);
    for (const action of within(card()).getAllByRole('button')) expect(action.getAttribute('type')).toBe('button');
  });

  it('Save обновляет открытый диалог без события: GLM можно выбрать с моделями протокола и без effort', async () => {
    let providers = list();
    bridge.setHandler('providers.list', async () => ({ providers }));
    bridge.setHandler('providers.setKey', async () => { providers = list(true); return { keyHint: '••••test' }; });
    await renderDialog();
    fireEvent.click(providerRadio(0, 'GLM'));
    fireEvent.change(await screen.findByLabelText('Z.ai API key'), { target: { value: 'fake-test-key' } });
    fireEvent.click(button('Save'));
    await waitFor(() => expect(within(card()).getByText('Connected')).toBeTruthy());
    expect((screen.getByLabelText('Z.ai API key') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(card(), { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-provider-card]')).toBeNull());
    fireEvent.click(providerRadio(0, 'GLM'));
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
    expect(within(rows()[0] as HTMLElement).queryByRole('combobox', { name: 'Effort' })).toBeNull();
    await chooseOption(within(rows()[0] as HTMLElement).getByRole('combobox', { name: 'Model' }), 'GLM-5.3 Flash');
    fireEvent.click(button('Start session'));
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(1));
    expect(callsOf('sessions.create')[0]).toMatchObject({ provider: 'glm', model: 'glm-5.3-flash' });
    expect(callsOf('sessions.create')[0]).not.toHaveProperty('effort');
  });

  it('Escape внешнего слоя закрывает только карточку и возвращает фокус пилюле', async () => {
    bridge.setHandler('providers.list', async () => ({ providers: [PROVIDERS[0]!, { id: 'codex', label: 'Codex', available: false }] }));
    const captures: EventListenerOrEventListenerObject[] = [];
    const add = document.addEventListener.bind(document);
    const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'keydown' && typeof options === 'object' && options.capture && listener !== null) captures.push(listener);
      add(type, listener, options);
    });
    let onOpenChange: ReturnType<typeof vi.fn>;
    try {
      ({ onOpenChange } = await renderDialog());
    } finally {
      spy.mockRestore();
    }
    const outerEscape = captures.at(-1);
    expect(outerEscape).toBeDefined();
    const codex = providerRadio(0, 'Codex');
    act(() => providerRadio(0, 'Claude').focus());
    fireEvent.keyDown(providerRadio(0, 'Claude'), { key: 'ArrowRight' });
    const copy = await screen.findByRole('button', { name: 'Copy' });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    // В Electron первым срабатывал capture-обработчик диалога; воспроизводим именно эту границу.
    act(() => {
      const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
      if (typeof outerEscape === 'function') outerEscape.call(document, escape);
      else outerEscape?.handleEvent(escape);
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('[data-provider-card]')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(codex));
    expect(isChecked(providerRadio(0, 'Claude'))).toBe(true);
    fireEvent.keyDown(codex, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([1, 0.95])('изменение размера карточки раскрывает скрытый фокус, не прокручивает видимый или чужой и отключает наблюдение (scale=%s)', async (scale) => {
    const observers: ObservedResize[] = [];
    class ObservedResize implements ResizeObserver {
      target: Element | null = null;
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element): void { this.target = target; }
      unobserve(): void {}
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', ObservedResize);
    try {
      bridge.setHandler('providers.list', async () => ({ providers: list() }));
      await renderDialog();
      fireEvent.click(providerRadio(0, 'GLM'));
      const input = await screen.findByLabelText('Z.ai API key');
      await waitFor(() => expect(document.activeElement).toBe(input));
      const content = card().parentElement as HTMLElement;
      const observer = observers.find((entry) => entry.target === content);
      expect(observer).toBeDefined();
      // Геометрия реального сбоя: карточка сжалась после автофокуса, поле осталось ниже её нижнего края.
      Object.defineProperty(content, 'clientHeight', { configurable: true, value: 226 });
      Object.defineProperty(content, 'offsetHeight', { configurable: true, value: 226 });
      const bounds = vi.spyOn(content, 'getBoundingClientRect').mockReturnValue(new DOMRect(265, 12, 360 * scale, 225.6 * scale));
      vi.spyOn(input, 'getBoundingClientRect').mockImplementation(() => new DOMRect(281, 12 + (228 - content.scrollTop) * scale, 328 * scale, 36 * scale));
      const sizes: ResizeObserverEntry[] = [{
        target: content, borderBoxSize: [{ blockSize: 225.6, inlineSize: 360 }],
        contentBoxSize: [], devicePixelContentBoxSize: [], contentRect: new DOMRect(),
      }];
      act(() => observer?.callback(sizes, observer));
      expect(content.scrollTop).toBeCloseTo(38.4);
      // Повторная доставка не двигает уже видимое поле.
      act(() => observer?.callback(sizes, observer));
      expect(content.scrollTop).toBeCloseTo(38.4);
      content.scrollTop = 0;
      bounds.mockReturnValueOnce(new DOMRect(265, 12, 360, 0));
      act(() => observer?.callback(sizes, observer));
      expect(content.scrollTop).toBe(0);
      act(() => providerRadio(0, 'Claude').focus());
      content.scrollTop = 0;
      act(() => observer?.callback(sizes, observer));
      expect(content.scrollTop).toBe(0);
      fireEvent.keyDown(content, { key: 'Escape' });
      await waitFor(() => expect(observer?.disconnect).toHaveBeenCalledOnce());
    } finally {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])('Remove выбранного GLM блокирует запуск с понятным сообщением (room=%s)', async (room) => {
    let providers = list(true);
    bridge.setHandler('providers.list', async () => ({ providers }));
    bridge.setHandler('providers.clearKey', async () => { providers = list(); return { ok: true }; });
    await renderDialog({ room });
    fireEvent.click(providerRadio(0, 'GLM'));
    // Повторный клик по выбранному открывает управление подключением.
    fireEvent.click(providerRadio(0, 'GLM'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toBe('GLM is unavailable. Connect it or choose another agent.'));
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
    expect(button(room ? 'Create room' : 'Start session').disabled).toBe(true);
    fireEvent.click(button(room ? 'Create room' : 'Start session'));
    expect(callsOf('sessions.create')).toEqual([]);
    expect(callsOf('rooms.create')).toEqual([]);
  });

  it('карточка с анимацией закрытия не отключает наблюдателя следующей карточки', async () => {
    const observers: ObservedResize[] = [];
    class ObservedResize implements ResizeObserver {
      target: Element | null = null;
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element): void { this.target = target; }
      unobserve(): void {}
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', ObservedResize);
    const computedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computedStyle(element, pseudo);
      if (element.matches('[role="dialog"][data-side]')) {
        Object.defineProperty(style, 'animationName', {
          configurable: true,
          get: () => element.getAttribute('data-state') === 'open' ? 'card-enter' : 'card-exit',
        });
      }
      return style;
    });
    try {
      bridge.setHandler('providers.list', async () => ({ providers: list() }));
      await renderDialog();
      fireEvent.click(providerRadio(0, 'GLM'));
      await screen.findByLabelText('Z.ai API key');
      const priorContent = card().parentElement as HTMLElement;
      fireEvent.click(providerRadio(0, 'Cursor'));
      await waitFor(() => expect(document.querySelector('[data-provider-card="cursor"]')).not.toBeNull());
      const nextContent = document.querySelector('[data-provider-card="cursor"]')?.parentElement as HTMLElement;
      const observer = observers.find((entry) => entry.target === nextContent);
      expect(priorContent.isConnected).toBe(true);
      expect(nextContent.isConnected).toBe(true);
      expect(observer).toBeDefined();
      expect(observer?.disconnect).not.toHaveBeenCalled();
      // Старый узел уходит после того, как новый уже прикреплён и наблюдается.
      const end = new Event('animationend', { bubbles: true });
      Object.defineProperty(end, 'animationName', { value: 'card-exit' });
      fireEvent(priorContent, end);
      await waitFor(() => expect(priorContent.isConnected).toBe(false));
      expect(nextContent.isConnected).toBe(true);
      expect(observer?.disconnect).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('changed блокирует запуск до нового ответа, старый reload не возвращает подключение', async () => {
    bridge.setHandler('providers.list', async () => ({ providers: list(true) }));
    await renderDialog();
    fireEvent.click(providerRadio(0, 'GLM'));
    const pending: Array<(providers: Providers) => void> = [];
    bridge.setHandler('providers.list', () => new Promise((resolve) => pending.push((providers) => resolve({ providers }))));
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(button('Start session').disabled).toBe(true);
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]?.(list()));
    await act(async () => pending[0]?.(list(true)));
    expect(within(dialog()).getByRole('alert').textContent).toContain('GLM is unavailable');
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
    expect(button('Start session').disabled).toBe(true);
  });

  it('провайдер по умолчанию сохраняется при удалении ключа без тихой замены на Claude', async () => {
    let providers = list(true);
    useUiStore.setState({ ui: { ...DEFAULT_UI, lastProvider: 'glm' } });
    bridge.setHandler('providers.list', async () => ({ providers }));
    await renderDialog();
    providers = list();
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('GLM is unavailable'));
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
  });

  it('переподключение обновляет открытый диалог и отменяет ответ прежнего хоста', async () => {
    bridge.setHandler('providers.list', async () => ({ providers: list(true) }));
    await renderDialog();
    fireEvent.click(providerRadio(0, 'GLM'));
    let release: () => void = () => {};
    bridge.setHandler('providers.list', () => new Promise((resolve) => { release = () => resolve({ providers: list(true) }); }));
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    bridge.setHandler('providers.list', async () => ({ providers: list() }));
    act(() => useHostStore.setState({ connections: 2 }));
    await waitFor(() => expect(within(dialog()).getByRole('alert').textContent).toContain('GLM is unavailable'));
    await act(async () => release());
    expect(isChecked(providerRadio(0, 'GLM'))).toBe(true);
    expect(button('Start session').disabled).toBe(true);
  });

  it('закрытие очищает карточку, отписывает changed, ответы и ошибки прошлого открытия игнорируются', async () => {
    bridge.setHandler('providers.list', async () => ({ providers: list() }));
    const { set } = openable();
    await screen.findByRole('radio', { name: 'GLM' });
    fireEvent.click(providerRadio(0, 'GLM'));
    fireEvent.change(await screen.findByLabelText('Z.ai API key'), { target: { value: 'fake-unsaved-key' } });
    const pending: Array<{ resolve: (providers: Providers) => void; reject: (error: unknown) => void }> = [];
    bridge.setHandler('providers.list', () => new Promise((resolve, reject) => pending.push({ resolve: (providers) => resolve({ providers }), reject })));
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    set(false);
    const before = callsOf('providers.list').length;
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    expect(callsOf('providers.list')).toHaveLength(before);
    bridge.setHandler('providers.list', async () => ({ providers: list() }));
    set(true);
    await screen.findByRole('radio', { name: 'GLM' });
    await act(async () => { pending[0]?.resolve(list(true)); pending[1]?.reject({ code: 'internal', message: 'устаревшая ошибка' }); });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(providerRadio(0, 'GLM'));
    expect((await screen.findByLabelText('Z.ai API key') as HTMLInputElement).value).toBe('');
    expect(within(card()).getByText('Not connected')).toBeTruthy();
  });

  it('неудачный refresh не разрешает запуск старого доступного снимка, Check again восстанавливает его', async () => {
    bridge.setHandler('providers.list', async () => ({ providers: list(true) }));
    await renderDialog();
    fireEvent.click(providerRadio(0, 'GLM'));
    bridge.setHandler('providers.list', async () => { throw { code: 'internal', message: 'ошибка' }; });
    act(() => bridge.emit('providers.changed', { provider: 'glm' }));
    expect(await screen.findByText("Couldn't load providers: host error.")).toBeTruthy();
    expect(button('Start session').disabled).toBe(true);
    bridge.setHandler('providers.list', async () => ({ providers: list(true) }));
    fireEvent.click(providerRadio(0, 'GLM'));
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(within(dialog()).queryByRole('alert')).toBeNull());
    expect(button('Start session').disabled).toBe(false);
  });

  it('старый хост открывает существующее подтверждение Restart host без неизвестного RPC', async () => {
    useHostStore.setState({ status: { state: 'connected', hostVersion: '0.3.0', methods: REQUIRED_METHODS.filter((method) => !method.startsWith('providers.') || method === 'providers.list') } });
    bridge.setHandler('providers.list', async () => ({ providers: list() }));
    useUiStore.getState().closeRestartHostDialog();
    await renderDialog();
    fireEvent.click(providerRadio(0, 'GLM'));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart host' }));
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
    expect(callsOf('providers.setKey')).toEqual([]);
    expect(callsOf('providers.clearKey')).toEqual([]);
    expect(document.querySelector('[data-provider-card]')).toBeNull();
    useUiStore.getState().closeRestartHostDialog();
  });

  it('busy и запущенная строка запрещают открытие карточки недоступного провайдера', async () => {
    let release: () => void = () => {};
    bridge.setHandler('sessions.create', (params) => new Promise((resolve) => { release = () => resolve({ ref: { projectPath: params.projectPath, workId: params.workId ?? '', sessionId: 's-01' } }); }));
    bridge.setHandler('rooms.create', async () => { throw { code: 'internal', message: 'ошибка' }; });
    await renderDialog({ room: true });
    fireEvent.click(button('Create room'));
    expect((providerRadio(0, 'Cursor') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(providerRadio(0, 'Cursor'));
    expect(document.querySelector('[data-provider-card]')).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(callsOf('sessions.create')).toHaveLength(2));
    await act(async () => release());
    await screen.findByText("Couldn't create room: host error.");
    fireEvent.click(providerRadio(0, 'Cursor'));
    expect(document.querySelector('[data-provider-card]')).toBeNull();
  });
});
