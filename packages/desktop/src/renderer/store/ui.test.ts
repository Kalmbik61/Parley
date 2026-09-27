import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from './ui.js';

beforeEach(() => {
  useUiStore.setState({
    windowFocused: true,
    wakePaused: null,
    dialogs: {
      newWork: false,
      newSession: { open: false, parentSessionId: null, work: null },
      settings: false,
      createRoom: null,
    },
    ui: DEFAULT_UI,
    uiLoaded: false,
  });
});

describe('useUiStore диалоги', () => {
  it('новая работа — открыть без проекта и с проектом «+» заголовка (кусок 3.5), закрыть', () => {
    useUiStore.getState().openNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: null, title: '' });
    useUiStore.getState().closeNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: false, projectPath: null, title: '' });
    useUiStore.getState().openNewWorkDialog('/tmp/p');
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: '/tmp/p', title: '' });
    useUiStore.getState().closeNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: false, projectPath: null, title: '' });
  });

  it('новая сессия — помнит родителя', () => {
    useUiStore.getState().openNewSessionDialog('s-01');
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: true,
      parentSessionId: 's-01',
      work: null,
    });
    useUiStore.getState().closeNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: false,
      parentSessionId: null,
      work: null,
    });
  });

  it('новая сессия из меню карточки помнит свою работу; закрытие её забывает (кусок 3.4)', () => {
    useUiStore.getState().openNewSessionDialog(null, { projectPath: '/tmp/p', workId: 'w-02' });
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: true,
      parentSessionId: null,
      work: { projectPath: '/tmp/p', workId: 'w-02' },
    });
    useUiStore.getState().closeNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession.work).toBeNull();
  });

  it('«New room» из меню карточки — createRoom без обязательного участника (кусок 3.4)', () => {
    useUiStore.getState().openCreateRoomDialog({ projectPath: '/tmp/p', workId: 'w-01', requiredMember: null });
    expect(useUiStore.getState().dialogs.createRoom).toEqual({ projectPath: '/tmp/p', workId: 'w-01', requiredMember: null });
  });
});

describe('useUiStore.setSidebarHold (кусок 3.4)', () => {
  it('держатели порядка — по id; повторное снятие и повторная установка не меняют стор', () => {
    useUiStore.setState({ sidebarHolds: {} });
    useUiStore.getState().setSidebarHold('menu:a', true);
    useUiStore.getState().setSidebarHold('rename:b', true);
    const before = useUiStore.getState().sidebarHolds;
    useUiStore.getState().setSidebarHold('menu:a', true);
    expect(useUiStore.getState().sidebarHolds).toBe(before);
    useUiStore.getState().setSidebarHold('menu:a', false);
    expect(useUiStore.getState().sidebarHolds).toEqual({ 'rename:b': true });
    useUiStore.getState().setSidebarHold('menu:a', false);
    useUiStore.getState().setSidebarHold('rename:b', false);
    expect(useUiStore.getState().sidebarHolds).toEqual({});
  });
});

describe('useUiStore.setDark', () => {
  afterEach(() => {
    document.documentElement.classList.remove('dark');
  });

  it('true ставит .dark на <html> и dark: true в сторе; false снимает и то, и другое (тест 7)', () => {
    useUiStore.getState().setDark(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(useUiStore.getState().dark).toBe(true);

    useUiStore.getState().setDark(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(useUiStore.getState().dark).toBe(false);
  });
});

describe('useUiStore.init', () => {
  it('забирает wake.state и реагирует на wake.changed', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('wake.state', () => ({ paused: true }));
    const dispose = useUiStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useUiStore.getState().wakePaused).toBe(true);

    bridge.emit('wake.changed', { paused: false });
    expect(useUiStore.getState().wakePaused).toBe(false);
    dispose();
  });

  it('toggleWake зовёт wake.pause/wake.resume по текущему состоянию', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('wake.state', () => ({ paused: false }));
    bridge.setHandler('wake.pause', () => ({ paused: true }));
    bridge.setHandler('wake.resume', () => ({ paused: false }));
    const dispose = useUiStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    await useUiStore.getState().toggleWake(bridge);
    expect(useUiStore.getState().wakePaused).toBe(true);

    await useUiStore.getState().toggleWake(bridge);
    expect(useUiStore.getState().wakePaused).toBe(false);
    dispose();
  });

  it('грузит ui.json в зеркало и ставит uiLoaded', async () => {
    const bridge = createFakeBridge();
    await bridge.app.saveUi({ pinnedWorks: ['a'] });
    const dispose = useUiStore.getState().init(bridge);
    await Promise.resolve();
    await Promise.resolve();

    expect(useUiStore.getState().uiLoaded).toBe(true);
    expect(useUiStore.getState().ui.pinnedWorks).toEqual(['a']);
    dispose();
  });
});

describe('useUiStore.patchUi / setAppearance / setSidebar (кусок 2.3, тест 8)', () => {
  it('два патча подряд — оба в зеркале, app.saveUi получил их порознь по одному ключу', () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');

    useUiStore.getState().patchUi({ pinnedWorks: ['a'] });
    useUiStore.getState().patchUi({ collapsedProjects: ['/p'] });

    expect(useUiStore.getState().ui.pinnedWorks).toEqual(['a']);
    expect(useUiStore.getState().ui.collapsedProjects).toEqual(['/p']);
    expect(saveUiSpy).toHaveBeenNthCalledWith(1, { pinnedWorks: ['a'] });
    expect(saveUiSpy).toHaveBeenNthCalledWith(2, { collapsedProjects: ['/p'] });
    dispose();
  });

  it('setSidebar сливает патч с зеркалом и сохраняет open (тест 8)', () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');

    useUiStore.getState().setSidebar('left', { width: 300 });

    expect(useUiStore.getState().ui.leftSidebar).toEqual({ open: true, width: 300 });
    expect(saveUiSpy).toHaveBeenCalledWith({ leftSidebar: { open: true, width: 300 } });
    dispose();
  });

  it('setAppearance зовёт bridge.app.setAppearance и меняет зеркало', () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    const setAppearanceSpy = vi.spyOn(bridge.app, 'setAppearance');

    useUiStore.getState().setAppearance('dark');

    expect(useUiStore.getState().ui.appearance).toBe('dark');
    expect(setAppearanceSpy).toHaveBeenCalledWith('dark');
    dispose();
  });
});

describe('useUiStore — форма работы с названием и «Создать комнату с…» (куски 2.3, 6.2)', () => {
  it('openNewWorkDialog(null, X) — форма с названием X («Create workspace …» палитры, кусок 6.2)', () => {
    useUiStore.getState().openNewWorkDialog(null, 'X');
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: null, title: 'X' });
  });

  it('openCreateRoomDialog/closeCreateRoomDialog', () => {
    useUiStore.getState().openCreateRoomDialog({
      projectPath: '/tmp/p',
      workId: 'w-01',
      requiredMember: { id: 's-01', label: 'S01 план' },
    });
    expect(useUiStore.getState().dialogs.createRoom).toEqual({
      projectPath: '/tmp/p',
      workId: 'w-01',
      requiredMember: { id: 's-01', label: 'S01 план' },
    });
    useUiStore.getState().closeCreateRoomDialog();
    expect(useUiStore.getState().dialogs.createRoom).toBeNull();
  });
});

// Тест 16 куска 4.2: видимость документа и фокус окна для «просмотрено» (спека 7.2).
describe('useUiStore — documentVisible и windowFocused (тест 16 куска 4.2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('начальное documentVisible — по document.visibilityState', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.resetModules();
    const fresh = await import('./ui.js');
    expect(fresh.useUiStore.getState().documentVisible).toBe(false);
  });

  it('visibilitychange в hidden → false, обратно → true; blur → windowFocused: false без document.hasFocus()', () => {
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    const hasFocus = vi.spyOn(document, 'hasFocus');

    state.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useUiStore.getState().documentVisible).toBe(false);
    state.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useUiStore.getState().documentVisible).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(useUiStore.getState().windowFocused).toBe(false);
    window.dispatchEvent(new Event('focus'));
    expect(useUiStore.getState().windowFocused).toBe(true);
    expect(hasFocus).not.toHaveBeenCalled();

    dispose();
    state.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(useUiStore.getState().documentVisible).toBe(true);
  });
});
