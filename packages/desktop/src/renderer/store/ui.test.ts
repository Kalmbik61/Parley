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
      newSession: { open: false, work: null, room: false },
      settings: false,
      mergeRoom: null,
      restartHost: false,
    },
    showArchived: false,
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

  it('новая сессия — диалог 1.5 открывается на активной работе, одним агентом; закрытие его сбрасывает', () => {
    useUiStore.getState().openNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, work: null, room: false });
    useUiStore.getState().closeNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: false, work: null, room: false });
  });

  it('новая сессия из меню карточки помнит свою работу; закрытие её забывает (кусок 3.4)', () => {
    useUiStore.getState().openNewSessionDialog({ projectPath: '/tmp/p', workId: 'w-02' });
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: true,
      work: { projectPath: '/tmp/p', workId: 'w-02' },
      room: false,
    });
    useUiStore.getState().closeNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession.work).toBeNull();
  });

  it('«New room» (меню карточки, палитра) — тот же диалог, открытый комнатой; закрытие сбрасывает и это', () => {
    useUiStore.getState().openNewSessionDialog({ projectPath: '/tmp/p', workId: 'w-01' }, { room: true });
    expect(useUiStore.getState().dialogs.newSession).toEqual({
      open: true,
      work: { projectPath: '/tmp/p', workId: 'w-01' },
      room: true,
    });
    useUiStore.getState().closeNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession.room).toBe(false);
    useUiStore.getState().openNewSessionDialog(undefined, { room: true });
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, work: null, room: true });
  });
});

describe('useUiStore — показ архивных и подтверждение перезапуска хоста (кусок 6.3)', () => {
  it('showArchived — в памяти окна: переключается туда и обратно, app.saveUi не зовётся', async () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    await vi.waitFor(() => expect(useUiStore.getState().uiLoaded).toBe(true));
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    expect(useUiStore.getState().showArchived).toBe(false);
    useUiStore.getState().toggleShowArchived();
    expect(useUiStore.getState().showArchived).toBe(true);
    useUiStore.getState().toggleShowArchived();
    expect(useUiStore.getState().showArchived).toBe(false);
    expect(saveUi).not.toHaveBeenCalled();
    dispose();
  });

  it('dialogs.restartHost — confirmRestartHost открывает, closeRestartHostDialog закрывает', () => {
    expect(useUiStore.getState().dialogs.restartHost).toBe(false);
    useUiStore.getState().confirmRestartHost();
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
    useUiStore.getState().closeRestartHostDialog();
    expect(useUiStore.getState().dialogs.restartHost).toBe(false);
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

// Кусок 5 плана «Organic», спека окна 2026-09-29, 2.6 и 3.4: развёрнутость строк комнат сайдбара — только в памяти окна.
describe('useUiStore.roomExpanded (кусок 5)', () => {
  beforeEach(() => useUiStore.setState({ roomExpanded: {} }));

  it('по умолчанию пусто: развёрнутость решает правило 2.6, а не стор', () => {
    expect(useUiStore.getState().roomExpanded).toEqual({});
  });

  it('setRoomExpanded пишет и перекрывает значение по ключу комнаты; другие ключи не трогает', () => {
    useUiStore.getState().setRoomExpanded('/p w-01/r-01', true);
    useUiStore.getState().setRoomExpanded('/p w-01/r-02', false);
    expect(useUiStore.getState().roomExpanded).toEqual({ '/p w-01/r-01': true, '/p w-01/r-02': false });
    useUiStore.getState().setRoomExpanded('/p w-01/r-01', false);
    expect(useUiStore.getState().roomExpanded).toEqual({ '/p w-01/r-01': false, '/p w-01/r-02': false });
  });

  it('повторная запись того же значения не меняет объект стора — подписчики не перерисовываются', () => {
    useUiStore.getState().setRoomExpanded('/p w-01/r-01', true);
    const before = useUiStore.getState().roomExpanded;
    useUiStore.getState().setRoomExpanded('/p w-01/r-01', true);
    expect(useUiStore.getState().roomExpanded).toBe(before);
  });

  it('только в памяти: в ui.json (app.saveUi) не пишется и в зеркало ui не попадает', async () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    await vi.waitFor(() => expect(useUiStore.getState().uiLoaded).toBe(true));
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    useUiStore.getState().setRoomExpanded('/p w-01/r-01', true);
    expect(saveUi).not.toHaveBeenCalled();
    expect(Object.keys(useUiStore.getState().ui)).not.toContain('roomExpanded');
    dispose();
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

  it('setSidebar правого — tab и width сливаются с зеркалом, app.saveUi получает целый rightSidebar (7.2)', () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');

    useUiStore.getState().setSidebar('right', { tab: 'changes' });
    useUiStore.getState().setSidebar('right', { width: 400 });

    expect(useUiStore.getState().ui.rightSidebar).toEqual({ open: true, width: 400, tab: 'changes' });
    expect(saveUiSpy).toHaveBeenNthCalledWith(1, { rightSidebar: { open: true, width: DEFAULT_UI.rightSidebar.width, tab: 'changes' } });
    expect(saveUiSpy).toHaveBeenNthCalledWith(2, { rightSidebar: { open: true, width: 400, tab: 'changes' } });

    // У левого вкладки нет: лишний ключ в ui.json не уходит.
    useUiStore.getState().setSidebar('left', { open: false, tab: 'files' });
    expect(saveUiSpy).toHaveBeenLastCalledWith({ leftSidebar: { open: false, width: DEFAULT_UI.leftSidebar.width } });
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

describe('useUiStore — форма работы с названием (кусок 6.2) и диалог 1.6 (кусок 7)', () => {
  it('openNewWorkDialog(null, X) — форма с названием X («Create workspace …» палитры, кусок 6.2)', () => {
    useUiStore.getState().openNewWorkDialog(null, 'X');
    expect(useUiStore.getState().dialogs.newWork).toEqual({ open: true, projectPath: null, title: 'X' });
  });

  it('openMergeRoomDialog/closeMergeRoomDialog — бросили одну сессию на другую (диалог 1.6)', () => {
    useUiStore.getState().openMergeRoomDialog({ projectPath: '/tmp/p', workId: 'w-01', dragged: 's-03', target: 's-02' });
    expect(useUiStore.getState().dialogs.mergeRoom).toEqual({ projectPath: '/tmp/p', workId: 'w-01', dragged: 's-03', target: 's-02' });
    useUiStore.getState().closeMergeRoomDialog();
    expect(useUiStore.getState().dialogs.mergeRoom).toBeNull();
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

describe('useUiStore — windowFocused при фокусе в странице (тест 2 куска 9.2b)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DOM-blur при activeElement — webview флаг не снимает; обычный blur — снимает', () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    const webview = document.createElement('webview');
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(webview);
    window.dispatchEvent(new Event('blur'));
    expect(useUiStore.getState().windowFocused).toBe(true);
    active.mockReturnValue(document.body);
    window.dispatchEvent(new Event('blur'));
    expect(useUiStore.getState().windowFocused).toBe(false);
    dispose();
  });

  it('app:window-focus false/true и browser:focus ставят флаг; после отписки — нет', () => {
    const bridge = createFakeBridge();
    const dispose = useUiStore.getState().init(bridge);
    bridge.emitWindowFocus(false);
    expect(useUiStore.getState().windowFocused).toBe(false);
    bridge.emitWindowFocus(true);
    expect(useUiStore.getState().windowFocused).toBe(true);
    bridge.emitWindowFocus(false);
    bridge.emitBrowserFocus({ webContentsId: 7 });
    expect(useUiStore.getState().windowFocused).toBe(true);
    dispose();
    bridge.emitWindowFocus(false);
    expect(useUiStore.getState().windowFocused).toBe(true);
  });
});
