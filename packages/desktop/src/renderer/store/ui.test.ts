import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRef } from '@harnas/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from './ui.js';

const ref: SessionRef = { projectPath: '/tmp/proj', workId: 'w-01', sessionId: 's-01' };

beforeEach(() => {
  useUiStore.setState({
    selectedRef: null,
    selectedWorkKey: null,
    windowFocused: true,
    wakePaused: null,
    dialogs: { newWork: false, newSession: { open: false, parentSessionId: null }, settings: false },
    lastSessionByWork: {},
    activePanelId: null,
  });
});

describe('useUiStore.selectSession', () => {
  it('запоминает выбор и последнюю сессию работы', () => {
    useUiStore.getState().selectSession('/tmp/proj w-01', ref);

    expect(useUiStore.getState().selectedRef).toEqual(ref);
    expect(useUiStore.getState().lastSessionByWork['/tmp/proj w-01']).toBe('s-01');
  });
});

describe('useUiStore.setActivePanelId', () => {
  it('запоминает id активной панели сетки; сброс — в null', () => {
    useUiStore.getState().setActivePanelId('terminal:/tmp/proj\u0000w-01\u0000s-01');
    expect(useUiStore.getState().activePanelId).toBe('terminal:/tmp/proj\u0000w-01\u0000s-01');

    useUiStore.getState().setActivePanelId(null);
    expect(useUiStore.getState().activePanelId).toBeNull();
  });
});

describe('useUiStore диалоги', () => {
  it('новая работа — открыть/закрыть', () => {
    useUiStore.getState().openNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toBe(true);
    useUiStore.getState().closeNewWorkDialog();
    expect(useUiStore.getState().dialogs.newWork).toBe(false);
  });

  it('новая сессия — помнит родителя', () => {
    useUiStore.getState().openNewSessionDialog('s-01');
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: true, parentSessionId: 's-01' });
    useUiStore.getState().closeNewSessionDialog();
    expect(useUiStore.getState().dialogs.newSession).toEqual({ open: false, parentSessionId: null });
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
});
