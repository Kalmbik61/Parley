import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostNotice } from '@parley/protocol';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { useNoticesStore } from './notices.js';

const notice = (text: string): HostNotice => ({ kind: 'launch-failed', ref: null, text, at: '2026-01-01T00:00:00.000Z' });

beforeEach(() => {
  useNoticesStore.setState({ notices: [] });
});

describe('useNoticesStore', () => {
  it('новые уведомления идут сверху', () => {
    const bridge = createFakeBridge();
    const dispose = useNoticesStore.getState().init(bridge);

    bridge.emit('host.notice', notice('первое'));
    bridge.emit('host.notice', notice('второе'));

    expect(useNoticesStore.getState().notices.map((n) => n.text)).toEqual(['второе', 'первое']);
    dispose();
  });

  it('не больше 20 записей', () => {
    const bridge = createFakeBridge();
    const dispose = useNoticesStore.getState().init(bridge);

    for (let i = 0; i < 25; i += 1) bridge.emit('host.notice', notice(`№${i}`));

    expect(useNoticesStore.getState().notices).toHaveLength(20);
    expect(useNoticesStore.getState().notices[0]?.text).toBe('№24');
    dispose();
  });

  // Хост повторяет стартовые уведомления клиенту сразу после `hello`, а окно подписывается позже (статус connected): такое
  // уведомление приходит раньше подписки, и его держит main (`host:notices-snapshot`).
  it('уведомление, пришедшее до подписки окна, берётся из снимка main', async () => {
    const bridge = createFakeBridge();
    bridge.setNoticesSnapshot([notice('до подписки')]);
    const dispose = useNoticesStore.getState().init(bridge);

    await vi.waitFor(() => expect(useNoticesStore.getState().notices.map((n) => n.text)).toEqual(['до подписки']));
    dispose();
  });

  it('снимок не дублирует уведомление, которое уже пришло событием', async () => {
    const bridge = createFakeBridge();
    bridge.setNoticesSnapshot([notice('то же')]);
    const dispose = useNoticesStore.getState().init(bridge);
    bridge.emit('host.notice', notice('то же'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useNoticesStore.getState().notices).toHaveLength(1);
    dispose();
  });

  it('переподключение: стор тот же, хост повторил стартовое уведомление — записей не прибавляется', async () => {
    const bridge = createFakeBridge();
    bridge.setNoticesSnapshot([notice('стартовое')]);
    const first = useNoticesStore.getState().init(bridge);
    await vi.waitFor(() => expect(useNoticesStore.getState().notices).toHaveLength(1));
    first();

    const second = useNoticesStore.getState().init(bridge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useNoticesStore.getState().notices.map((n) => n.text)).toEqual(['стартовое']);
    second();
  });

  it('снимок после подписки не ставит запись выше уведомления, пришедшего позже', async () => {
    const bridge = createFakeBridge();
    bridge.setNoticesSnapshot([{ ...notice('старое'), at: '2026-01-01T00:00:00.000Z' }]);
    const dispose = useNoticesStore.getState().init(bridge);
    bridge.emit('host.notice', { ...notice('новое'), at: '2026-02-01T00:00:00.000Z' });

    await vi.waitFor(() => expect(useNoticesStore.getState().notices).toHaveLength(2));
    expect(useNoticesStore.getState().notices.map((n) => n.text)).toEqual(['новое', 'старое']);
    dispose();
  });
});
