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
    paletteOpen: false,
    picker: null,
  });
});

describe('useUiStore диалоги', () => {
  it('новая работа — открыть без проекта и с проектом «+» заголовка (кусок 3.5), закрыть', () => {
    useUiStore.getState().openNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: null });
    useUiStore.getState().closeNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: false, projectPath: null });
    useUiStore.getState().openNewWorkDialog('/tmp/p');
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: '/tmp/p' });
    useUiStore.getState().closeNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: false, projectPath: null });
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

describe('useUiStore — палитра, выбор сессии (⌘D) и «Создать комнату с…» (кусок 2.3)', () => {
  it('paletteOpen переключается setPaletteOpen', () => {
    useUiStore.getState().setPaletteOpen(true);
    expect(useUiStore.getState().paletteOpen).toBe(true);
    useUiStore.getState().setPaletteOpen(false);
    expect(useUiStore.getState().paletteOpen).toBe(false);
  });

  it('openPicker/closePicker', () => {
    useUiStore.getState().openPicker({ workKey: 'w', direction: 'right', openSessionIds: ['s-01'] });
    expect(useUiStore.getState().picker).toEqual({ workKey: 'w', direction: 'right', openSessionIds: ['s-01'] });
    useUiStore.getState().closePicker();
    expect(useUiStore.getState().picker).toBeNull();
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
