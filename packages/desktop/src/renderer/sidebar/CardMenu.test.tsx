/**
 * Тесты 1, 2, 5, 15, 16, 19 куска 3.4 и решения контролёра 2, 4, 5: меню карточки работы
 * (спека 6.4). Меню открывается правой кнопкой по карточке (`ui/context-menu`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import type { WorkEntry } from '@harnas/core';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { EMPTY_HISTORY } from '../layout/history.js';
import { useLayoutStore } from '../layout/store.js';
import { REQUIRED_METHODS } from '../lib/capabilities.js';
import { workKey } from '../lib/tree-order.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { makeSession, makeWork } from '../test-utils/work-fixtures.js';
import { CardMenu } from './CardMenu.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

let bridge: FakeBridge;
let disposeHost: () => void = () => {};

const entry = makeWork('w-01', {
  projectPath: '/tmp/proj',
  title: 'Redesign',
  sessions: [
    makeSession('s-01', 'plan', { lifecycle: 'active' }),
    makeSession('s-02', 'old', { lifecycle: 'closed' }),
    makeSession('s-03', 'later', { lifecycle: 'pending' }),
  ],
});
const key = workKey('/tmp/proj', 'w-01');

function renderMenu(target: WorkEntry = entry, patch: { pinned?: boolean; onRename?: () => void; onOpenMail?: () => void } = {}): void {
  render(
    <CardMenu
      entry={target}
      pinned={patch.pinned ?? false}
      bridge={bridge}
      onRename={patch.onRename ?? (() => {})}
      onOpenMail={patch.onOpenMail ?? (() => {})}
    >
      <div>card</div>
    </CardMenu>,
  );
}

function openMenu(): void {
  fireEvent.contextMenu(screen.getByText('card'));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  bridge = createFakeBridge();
  disposeHost = useHostStore.getState().init(bridge);
  useWorksStore.setState({ entries: [entry], branches: {}, loading: false, error: null });
  useUiStore.setState({
    ui: DEFAULT_UI,
    sidebarHolds: {},
    dialogs: { newWork: false, newSession: { open: false, work: null, room: false }, settings: false, mergeRoom: null },
  });
  useUiStore.getState().init(bridge);
  // Журнал — только вызовы меню: init стора ui спрашивает wake.state.
  bridge.calls.splice(0);
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  cleanup();
  disposeHost();
});

describe('CardMenu — закрепление (тест 1)', () => {
  it('Pin кладёт работу в pinnedWorks, Unpin убирает', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Pin'));
    expect(useUiStore.getState().ui.pinnedWorks).toEqual([key]);
    cleanup();

    renderMenu(entry, { pinned: true });
    openMenu();
    expect(screen.queryByText('Pin')).toBeNull();
    fireEvent.click(screen.getByText('Unpin'));
    expect(useUiStore.getState().ui.pinnedWorks).toEqual([]);
  });
});

describe('CardMenu — «Delete…» (тест 2, решение 5)', () => {
  it('до подтверждения ни одного вызова; после — stop живых, затем works.delete, ключ уходит из pinnedWorks', async () => {
    useUiStore.getState().patchUi({ pinnedWorks: [key, 'other'] });
    bridge.setHandler('sessions.stop', () => ({ ok: true as const }));
    bridge.setHandler('works.delete', () => ({ ok: true as const }));
    renderMenu(entry, { pinned: true });
    openMenu();
    fireEvent.click(screen.getByText('Delete…'));

    expect(screen.getByText('Delete "Redesign"?')).toBeTruthy();
    expect(screen.getByText('3 sessions will be deleted. Running agents will be stopped.')).toBeTruthy();
    expect(bridge.calls).toEqual([]);

    // Первая по DOM — кнопка подтверждения (крестик диалога — после неё).
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    await waitFor(() => expect(bridge.calls.map((call) => call.method)).toEqual(['sessions.stop', 'works.delete']));
    expect(bridge.calls[0]?.params).toEqual({ ref: { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' } });
    expect(bridge.calls[1]?.params).toEqual({ projectPath: '/tmp/proj', workId: 'w-01' });
    await waitFor(() => expect(useUiStore.getState().ui.pinnedWorks).toEqual(['other']));
  });

  it('Cancel в подтверждении — ни одного вызова', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(bridge.calls).toEqual([]);
  });

  it('conflict от хоста — тост «Couldn\'t delete workspace: conflicting state.»', async () => {
    bridge.setHandler('sessions.stop', () => ({ ok: true as const }));
    bridge.setHandler('works.delete', () => {
      throw encodeIpcError({ code: 'conflict', message: 'у работы есть живая сессия' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't delete workspace: conflicting state."));
    warn.mockRestore();
  });
});

describe('CardMenu — двойной клик в подтверждении (раунд 1, находка 6)', () => {
  it('Delete и Archive: два клика подряд по кнопке — один вызов, без лишнего тоста', async () => {
    bridge.setHandler('sessions.stop', () => ({ ok: true as const }));
    bridge.setHandler('works.delete', () => ({ ok: true as const }));
    bridge.setHandler('works.setStatus', () => ({ ok: true as const }));
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Archive'));
    const archive = screen.getAllByText('Archive')[0] as HTMLElement;
    act(() => {
      archive.click();
      archive.click();
    });
    openMenu();
    fireEvent.click(screen.getByText('Delete…'));
    const confirm = screen.getAllByText('Delete')[0] as HTMLElement;
    act(() => {
      confirm.click();
      confirm.click();
    });
    await flush();
    await waitFor(() => expect(bridge.calls.filter((call) => call.method === 'works.delete')).toHaveLength(1));
    expect(bridge.calls.filter((call) => call.method === 'works.setStatus')).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.method === 'sessions.stop')).toHaveLength(1);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('CardMenu — статус (тесты 16, 19, решение 2)', () => {
  it('Mark as done — works.setStatus done; Archive — только после подтверждения', async () => {
    bridge.setHandler('works.setStatus', () => ({ ok: true as const }));
    renderMenu();
    openMenu();
    expect(screen.queryByText('Reopen')).toBeNull();
    fireEvent.click(screen.getByText('Mark as done'));
    await flush();
    expect(bridge.calls).toEqual([{ method: 'works.setStatus', params: { projectPath: '/tmp/proj', workId: 'w-01', status: 'done' } }]);

    openMenu();
    fireEvent.click(screen.getByText('Archive'));
    expect(screen.getByText('Archive "Redesign"?')).toBeTruthy();
    // Архив прячет карточку, но не гасит агентов (ревью M13): вопрос говорит об этом прямо.
    expect(screen.getByText(/live sessions keep running while it is hidden/i)).toBeTruthy();
    expect(bridge.calls).toHaveLength(1);
    fireEvent.click(screen.getAllByText('Archive')[0] as HTMLElement);
    await flush();
    expect(bridge.calls[1]).toEqual({ method: 'works.setStatus', params: { projectPath: '/tmp/proj', workId: 'w-01', status: 'archived' } });
  });

  it('у done вместо Mark as done — Reopen → works.setStatus active (тест 19)', async () => {
    bridge.setHandler('works.setStatus', () => ({ ok: true as const }));
    renderMenu(makeWork('w-01', { projectPath: '/tmp/proj', title: 'Redesign', status: 'done' }));
    openMenu();
    expect(screen.queryByText('Mark as done')).toBeNull();
    expect(screen.getByText('Archive')).toBeTruthy();
    fireEvent.click(screen.getByText('Reopen'));
    await flush();
    expect(bridge.calls).toEqual([{ method: 'works.setStatus', params: { projectPath: '/tmp/proj', workId: 'w-01', status: 'active' } }]);
  });

  it('у archived — Reopen вместо Archive и Mark as done (решение контролёра 2)', async () => {
    bridge.setHandler('works.setStatus', () => ({ ok: true as const }));
    renderMenu(makeWork('w-01', { projectPath: '/tmp/proj', title: 'Redesign', status: 'archived' }));
    openMenu();
    expect(screen.queryByText('Mark as done')).toBeNull();
    expect(screen.queryByText('Archive')).toBeNull();
    fireEvent.click(screen.getByText('Reopen'));
    await flush();
    expect(bridge.calls).toEqual([{ method: 'works.setStatus', params: { projectPath: '/tmp/proj', workId: 'w-01', status: 'active' } }]);
  });

  it('not_found на Archive — тост «Couldn\'t archive workspace: not found.»; revealWork с not_found — свой тост (тест 16)', async () => {
    bridge.setHandler('works.setStatus', () => {
      throw encodeIpcError({ code: 'not_found', message: 'нет такой работы' });
    });
    bridge.setRevealWorkError(encodeIpcError({ code: 'not_found', message: 'work not found' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Archive'));
    fireEvent.click(screen.getAllByText('Archive')[0] as HTMLElement);
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't archive workspace: not found."));

    openMenu();
    fireEvent.click(screen.getByText('Reveal in Finder'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't reveal workspace in Finder: not found."));
    expect(bridge.revealedWorks).toEqual([{ projectPath: '/tmp/proj', workId: 'w-01' }]);
    warn.mockRestore();
  });
});

describe('CardMenu — прочие пункты', () => {
  it('New session — диалог 1.5 этой работы одним агентом (тест 15); New room — тот же диалог, открытый комнатой (два агента)', () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('New session'));
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: true,
      work: { projectPath: '/tmp/proj', workId: 'w-01' },
      room: false,
    });
    act(() => useUiStore.getState().closeNewSessionDialog());

    openMenu();
    fireEvent.click(screen.getByText('New room'));
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: true,
      work: { projectPath: '/tmp/proj', workId: 'w-01' },
      room: true,
    });
  });

  it('Open mail и Rename — колбэки карточки; Copy path — путь проекта в буфер', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const onOpenMail = vi.fn();
    const onRename = vi.fn();
    renderMenu(entry, { onOpenMail, onRename });
    openMenu();
    fireEvent.click(screen.getByText('Open mail'));
    openMenu();
    fireEvent.click(screen.getByText('Rename'));
    openMenu();
    fireEvent.click(screen.getByText('Copy path'));
    expect(onOpenMail).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('/tmp/proj');
    vi.unstubAllGlobals();
  });

  it('без works.rename у хоста пункта Rename нет, без works.setStatus — пунктов статуса (тест 5)', () => {
    act(() => bridge.setHostMethods(REQUIRED_METHODS.filter((method) => method !== 'works.rename' && method !== 'works.setStatus')));
    renderMenu();
    openMenu();
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.queryByText('Mark as done')).toBeNull();
    expect(screen.queryByText('Archive')).toBeNull();
    expect(screen.getByText('Delete…')).toBeTruthy();
  });

  it('«разрушители» — свой токен текста и на фокусе фон --accent, а не destructive (решение 4)', () => {
    renderMenu();
    openMenu();
    for (const text of ['Delete…', 'Archive']) {
      const item = screen.getByText(text).closest('[role="menuitem"]');
      expect(item?.className).toContain('text-menu-destructive');
      expect(item?.className).toContain('focus:text-menu-destructive');
      expect(item?.className).not.toContain('focus:bg-destructive');
      expect(item?.className).toContain('focus:bg-accent');
    }
  });

  it('открытое меню держит порядок сайдбара (sidebarHolds), закрытое — отпускает', () => {
    renderMenu();
    openMenu();
    expect(Object.keys(useUiStore.getState().sidebarHolds)).toHaveLength(1);
    fireEvent.keyDown(screen.getByText('Pin'), { key: 'Escape' });
    expect(useUiStore.getState().sidebarHolds).toEqual({});
  });
});

describe('CardMenu — «Delete…» и несохранённые файлы (тест 7 куска 7.3a)', () => {
  const fileTab = { kind: 'file', id: 'file:p:a.ts', root: { kind: 'project' }, path: 'a.ts' } as const;

  beforeEach(() => {
    useLayoutStore.setState({
      activeWorkKey: key,
      layouts: { [key]: { root: { type: 'group', id: 'g1', tabs: [fileTab, { kind: 'mail', id: 'mail' }], activeTabId: fileTab.id }, activeGroupId: 'g1', closedTabs: [] } },
      hydrated: { [key]: true },
      pending: {},
      history: EMPTY_HISTORY,
      mru: {},
      navigating: false,
    });
    bridge.setHandler('sessions.stop', () => ({ ok: true as const }));
    bridge.setHandler('works.delete', () => ({ ok: true as const }));
  });

  afterEach(() => useLayoutStore.getState().setCloseGuard(null));

  it('Cancel в вопросе о буфере — ни sessions.stop, ни works.delete; вопрос — только про вкладки file', async () => {
    const guard = vi.fn(async () => false);
    useLayoutStore.getState().setCloseGuard(guard);
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    await waitFor(() => expect(guard).toHaveBeenCalledWith(key, [fileTab.id]));
    await flush();
    expect(bridge.calls).toEqual([]);
  });

  it('вопрос пройден — вкладки файлов закрыты, затем stop и works.delete', async () => {
    useLayoutStore.getState().setCloseGuard(async () => true);
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText('Delete…'));
    fireEvent.click(screen.getAllByText('Delete')[0] as HTMLElement);
    await waitFor(() => expect(bridge.calls.map((call) => call.method)).toEqual(['sessions.stop', 'works.delete']));
    const root = useLayoutStore.getState().layouts[key]?.root;
    expect(root?.type === 'group' ? root.tabs.map((tab) => tab.id) : null).toEqual(['mail']);
  });
});
