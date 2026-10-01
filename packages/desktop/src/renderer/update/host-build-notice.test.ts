/**
 * Тост «хост от другой сборки» (0.2.0): окно обновили, а хост работает от прежнего приложения — агенты и git,
 * которые он запускает, идут от старой копии, и macOS по кругу спрашивает доступ к папкам. Тост один на пару
 * версий, кнопка «Restart host…» открывает то же подтверждение, что и палитра; хост той же сборки — тост снят.
 * `sonner` подставной: проверяется вызов тоста и его кнопка, а не разметка.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { HostStatus } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useHostStore } from '../store/host.js';
import { useUiStore } from '../store/ui.js';
import { HOST_BUILD_TOAST_ID, wireHostBuildNotice } from './host-build-notice.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));

const connected = (hostVersion: string): HostStatus => ({
  state: 'connected',
  hostVersion,
  methods: null,
});

interface ToastOptions {
  id: string;
  duration: number;
  action: { label: string; onClick: () => void };
}

/** Последний вызов `toast(message, options)`. */
function lastToast(): { message: string; options: ToastOptions } {
  const call = vi.mocked(toast).mock.calls.at(-1);
  if (call === undefined) throw new Error('тост не показан');
  return { message: call[0] as string, options: call[1] as unknown as ToastOptions };
}

let off: () => void = () => {};

beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(toast.dismiss).mockClear();
  useHostStore.setState({ status: { state: 'connecting' }, appVersion: null });
  useUiStore.getState().closeRestartHostDialog();
});

afterEach(() => {
  off();
  off = () => {};
});

describe('wireHostBuildNotice', () => {
  it('хост другой сборки — один тост с обеими версиями и кнопкой «Restart host…»', () => {
    off = wireHostBuildNotice();
    useHostStore.setState({ appVersion: '0.2.0' });
    useHostStore.setState({ status: connected('0.1.0') });

    expect(toast).toHaveBeenCalledTimes(1);
    const { message, options } = lastToast();
    expect(message).toBe(S.connection.hostOtherBuild('0.1.0', '0.2.0'));
    expect(options.id).toBe(HOST_BUILD_TOAST_ID);
    expect(options.duration).toBe(Infinity);
    expect(options.action.label).toBe(S.actions.restartHost);

    // Повтор того же статуса (`setHostMethods` шлёт connected заново) тост не множит.
    useHostStore.setState({ status: connected('0.1.0') });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('кнопка тоста открывает подтверждение перезапуска — то же, что у палитры', () => {
    useHostStore.setState({ appVersion: '0.2.0', status: connected('0.1.0') });
    off = wireHostBuildNotice();

    lastToast().options.action.onClick();
    expect(useUiStore.getState().dialogs.restartHost).toBe(true);
  });

  it('хост перезапущен той же сборкой — тост снимается', () => {
    useHostStore.setState({ appVersion: '0.2.0', status: connected('0.1.0') });
    off = wireHostBuildNotice();
    useHostStore.setState({ status: { state: 'disconnected', reason: 'closed' } });
    expect(toast.dismiss).not.toHaveBeenCalled();

    useHostStore.setState({ status: connected('0.2.0') });
    expect(toast.dismiss).toHaveBeenCalledWith(HOST_BUILD_TOAST_ID);
  });

  it('тост прежней подписки снимает и новая: хост перезапущен той же сборкой (ревью 0.2.0, п. 3)', () => {
    useHostStore.setState({ appVersion: '0.2.0', status: connected('0.1.0') });
    const first = wireHostBuildNotice();
    expect(toast).toHaveBeenCalledTimes(1);
    first();

    useHostStore.setState({ status: { state: 'disconnected', reason: 'closed' } });
    off = wireHostBuildNotice();
    useHostStore.setState({ status: connected('0.2.0') });
    expect(toast.dismiss).toHaveBeenCalledWith(HOST_BUILD_TOAST_ID);
  });

  it('переподключение к тому же старому хосту тост не повторяет', () => {
    off = wireHostBuildNotice();
    useHostStore.setState({ appVersion: '0.2.0', status: connected('0.1.0') });
    useHostStore.setState({ status: { state: 'disconnected', reason: 'closed' } });
    useHostStore.setState({ status: connected('0.1.0') });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('та же сборка или версия окна ещё не пришла — тоста нет', () => {
    off = wireHostBuildNotice();
    useHostStore.setState({ status: connected('0.1.0') });
    useHostStore.setState({ appVersion: '0.1.0' });
    expect(toast).not.toHaveBeenCalled();
  });
});
