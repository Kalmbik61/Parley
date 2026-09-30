/**
 * Диалог «New room» из двух сессий (кусок 7 плана «Organic», спека окна 2026-09-29, 1.6, 2.5): подзаголовок,
 * ведущий по умолчанию — та, на которую бросили, `rooms.create` с двумя участниками, выбранным `lead`,
 * `origin: [перетащенная, цель]` и `quiet: true`; комната открывается вкладкой, когда снимок её принёс.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_HISTORY } from '../../layout/history.js';
import { tabId } from '../../layout/ids.js';
import { useLayoutStore } from '../../layout/store.js';
import { groups } from '../../layout/tree.js';
import { roomKey } from '../../lib/room-view.js';
import { workKey } from '../../lib/tree-order.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { MergeRoomDialog } from './MergeRoomDialog.js';

const PROJECT = '/tmp/proj';
const KEY = workKey(PROJECT, 'w-01');

let bridge: FakeBridge;

const callsOf = (method: string): Array<Record<string, unknown>> =>
  bridge.calls.filter((call) => call.method === method).map((call) => call.params as Record<string, unknown>);

const sessions = () => [
  makeSession('s-02', 'бэкенд', { task: 'Обновить README: вход по ссылке' }),
  makeSession('s-03', 'ревью', { provider: 'codex', task: 'Логин по e-mail: план и разбивка' }),
];

function setWorks(rooms = [] as ReturnType<typeof makeRoom>[]): void {
  useWorksStore.setState({
    entries: [makeWork('w-01', { projectPath: PROJECT, title: 'Payments', sessions: sessions(), rooms })],
    branches: {},
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  bridge = createFakeBridge();
  bridge.setHandler('rooms.create', async () => ({ roomId: 'r-01' }));
  setWorks();
  useLayoutStore.setState({
    activeWorkKey: KEY,
    layouts: { [KEY]: { root: { type: 'group', id: 'g-1', tabs: [], activeTabId: null }, activeGroupId: 'g-1', closedTabs: [] } },
    hydrated: { [KEY]: true },
    pending: {},
    history: EMPTY_HISTORY,
    mru: {},
    navigating: false,
  });
  useUiStore.setState({ roomExpanded: {} });
});

afterEach(cleanup);

function renderDialog(onOpenChange: (open: boolean) => void = () => {}, dragged = 's-03', target = 's-02'): void {
  render(
    <MergeRoomDialog open bridge={bridge} projectPath={PROJECT} workId="w-01" dragged={dragged} target={target} onOpenChange={onOpenChange} />,
  );
}

const pills = (): HTMLElement[] => within(screen.getByRole('radiogroup', { name: 'Lead' })).getAllByRole('radio');

describe('MergeRoomDialog — вид (1.6)', () => {
  it('заголовок New room, подзаголовок «цель and бросили move into the room.», поле Name, Cancel и Create room', () => {
    renderDialog();
    expect(screen.getByRole('heading', { name: 'New room' })).toBeTruthy();
    expect(screen.getByText('S02 бэкенд and S03 ревью move into the room.')).toBeTruthy();
    expect(screen.getByPlaceholderText('What the agents will discuss')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create room' })).toBeTruthy();
  });

  it('ведущий — две пилюли: сессия, на которую бросили, первой и выбрана; имя и задача в каждой', () => {
    renderDialog();
    const [first, second] = pills();
    expect(first?.getAttribute('aria-checked')).toBe('true');
    expect(second?.getAttribute('aria-checked')).toBe('false');
    expect(first?.textContent).toContain('S02 бэкенд');
    expect(first?.textContent).toContain('Обновить README: вход по ссылке');
    expect(second?.textContent).toContain('S03 ревью');
    expect(second?.textContent).toContain('Логин по e-mail: план и разбивка');
  });

  it('пилюли ведущего с клавиатуры: Tab берёт выбранную, стрелка переходит на другую и выбирает её', () => {
    renderDialog();
    const [first, second] = pills();
    expect([first?.getAttribute('tabindex'), second?.getAttribute('tabindex')]).toEqual(['0', '-1']);
    act(() => first?.focus());
    fireEvent.keyDown(first as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    expect(pills().map((pill) => pill.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    fireEvent.keyDown(second as HTMLElement, { key: 'ArrowRight' });
    expect(pills().map((pill) => pill.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('выбор пилюли меняет ведущего', () => {
    renderDialog();
    fireEvent.click(pills()[1] as HTMLElement);
    expect(pills().map((pill) => pill.getAttribute('aria-checked'))).toEqual(['false', 'true']);
  });
});

describe('MergeRoomDialog — Create room', () => {
  it('rooms.create: участники [цель, брошенная], lead — цель по умолчанию, origin [брошенная, цель], quiet; название по числу комнат', async () => {
    const onOpenChange = vi.fn();
    setWorks([makeRoom('r-01', 'A')]);
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')).toEqual([
      { projectPath: PROJECT, workId: 'w-01', title: 'Room 2', members: ['s-02', 's-03'], lead: 's-02', origin: ['s-03', 's-02'], quiet: true },
    ]);
  });

  it('введённое название и выбранный ведущий уходят как есть', async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.change(screen.getByPlaceholderText('What the agents will discuss'), { target: { value: '  Login flow ' } });
    fireEvent.click(pills()[1] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')[0]).toMatchObject({ title: 'Login flow', lead: 's-03' });
  });

  it('вкладка комнаты открывается и строка разворачивается, когда снимок принёс комнату — не раньше', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(callsOf('rooms.create')).toHaveLength(1));
    await act(async () => {});
    const tabs = (): string[] => {
      const layout = useLayoutStore.getState().layouts[KEY];
      return layout === undefined ? [] : groups(layout).flatMap((group) => group.tabs.map((tab) => tab.id));
    };
    expect(tabs()).toEqual([]);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBeUndefined();

    act(() => setWorks([{ ...makeRoom('r-01', 'Room 1'), members: ['s-02', 's-03'], lead: 's-02' }]));
    expect(tabs()).toEqual([tabId.room('r-01')]);
    expect(useUiStore.getState().roomExpanded[roomKey(KEY, 'r-01')]).toBe(true);
  });

  it('отказ хоста — ошибка createRoom, диалог открыт; повтор возможен', async () => {
    let fail = true;
    bridge.setHandler('rooms.create', async () => {
      if (fail) throw { code: 'bad_request', message: 'сессия закрыта' };
      return { roomId: 'r-01' };
    });
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByText("Couldn't create room: invalid request.")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')).toHaveLength(2);
  });

  it('двойной клик по Create room — одна комната', async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    const create = screen.getByRole('button', { name: 'Create room' });
    fireEvent.click(create);
    fireEvent.click(create);
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(callsOf('rooms.create')).toHaveLength(1);
  });

  it('Cancel закрывает диалог, ничего не создав', () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(callsOf('rooms.create')).toEqual([]);
  });
});

describe('MergeRoomDialog — сессию или работу удалили, пока диалог был открыт', () => {
  it('диалог закрывается сам, комнаты из них не собрать', async () => {
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    expect(onOpenChange).not.toHaveBeenCalled();
    act(() => useWorksStore.setState({ entries: [makeWork('w-01', { projectPath: PROJECT, sessions: [makeSession('s-02', 'бэкенд')] })] }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('длинные ярлыки и задача не выталкивают пилюли: имя и задача обрезаются', () => {
    useWorksStore.setState({
      entries: [
        makeWork('w-01', {
          projectPath: PROJECT,
          sessions: [makeSession('s-02', 'L'.repeat(40), { task: 'T'.repeat(2000) }), makeSession('s-03', 'ревью')],
        }),
      ],
    });
    renderDialog();
    const first = pills()[0] as HTMLElement;
    const [name, task] = [...first.querySelectorAll('span')].filter((node) => node.className.includes('truncate'));
    expect(name?.className).toContain('shrink-0');
    expect(name?.className).toContain('max-w-[70%]');
    expect(task?.className).toContain('min-w-0');
    expect(first.className).toContain('min-w-0');
  });
});
