/**
 * Тост о новой версии (V6 плана релиза 0.1.0): «Parley X.Y.Z is available» с кнопками «Download» и «Later»,
 * закрытая версия — в `ui.json`, переключатель «Check for updates» и ожидание загрузки зеркала `ui.json`.
 * Мост подставной, `sonner` тоже: проверяется вызов тоста и поведение его кнопок, а не разметка.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { UpdateInfo } from '../../shared/bridge.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { UPDATE_TOAST_ID, wireUpdateNotice } from './update-notice.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));

const INFO: UpdateInfo = {
  version: '0.2.0',
  url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
};
const NEWER: UpdateInfo = {
  version: '0.3.0',
  url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.3.0',
};

interface ToastOptions {
  id: string;
  duration: number;
  action: { label: string; onClick: () => void };
  cancel: { label: string; onClick: () => void };
  onDismiss: () => void;
}

/** Последний вызов `toast(message, options)`: текст и параметры с кнопками. */
function lastToast(): { message: string; options: ToastOptions } {
  const call = vi.mocked(toast).mock.calls.at(-1);
  if (call === undefined) throw new Error('тост не показан');
  return { message: call[0] as string, options: call[1] as unknown as ToastOptions };
}

let bridge: FakeBridge;
let disposeUi: () => void;
let unwire: Array<() => void>;

/** Подписка с уборкой после теста: окно в тестах одно, а подписки на него не должны переживать тест. */
function wire(): () => void {
  const off = wireUpdateNotice(bridge);
  unwire.push(off);
  return off;
}

beforeEach(async () => {
  bridge = createFakeBridge();
  unwire = [];
  vi.mocked(toast).mockClear();
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
  // `patchUi` пишет через мост, запомненный в `init`; зеркало `ui.json` загружается ответом `app.loadUi()`.
  disposeUi = useUiStore.getState().init(bridge);
  await vi.waitFor(() => expect(useUiStore.getState().uiLoaded).toBe(true));
});

afterEach(() => {
  for (const off of unwire) off();
  disposeUi();
  vi.restoreAllMocks();
});

describe('wireUpdateNotice — тост', () => {
  it('найденный релиз: «Parley X.Y.Z is available» с кнопками Download и Later; у тоста нет таймера', () => {
    wire();

    bridge.emitUpdate(INFO);

    expect(toast).toHaveBeenCalledTimes(1);
    const { message, options } = lastToast();
    expect(message).toBe('Parley 0.2.0 is available');
    expect(options.id).toBe(UPDATE_TOAST_ID);
    // Стоит, пока человек его не закроет: самозакрывающийся тост унёс бы весть, не дав решить.
    expect(options.duration).toBe(Infinity);
    expect(options.action.label).toBe('Download');
    expect(options.cancel.label).toBe('Later');
  });

  it('найденное до подписки (окно грузилось или показывало «Connecting…») показывается сразу', () => {
    bridge.setPendingUpdate(INFO);

    wire();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.2.0 is available');
  });

  it('та же версия снова (проверка раз в сутки, переподключение) — тот же тост на месте, а не второй', () => {
    wire();

    bridge.emitUpdate(INFO);
    bridge.emitUpdate({ ...INFO });

    expect(toast).toHaveBeenCalledTimes(2);
    const ids = vi.mocked(toast).mock.calls.map((call) => (call[1] as unknown as ToastOptions).id);
    expect(new Set(ids)).toEqual(new Set([UPDATE_TOAST_ID]));
  });

  it('после отписки события и загрузка ui.json больше ничего не показывают', () => {
    useUiStore.setState({ uiLoaded: false });
    const off = wire();
    bridge.emitUpdate(INFO);
    off();

    bridge.emitUpdate(NEWER);
    useUiStore.setState({ uiLoaded: true });

    expect(toast).not.toHaveBeenCalled();
  });
});

describe('wireUpdateNotice — кнопки и закрытая версия', () => {
  it('Download открывает страницу релиза в браузере и закрывает версию в ui.json', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdate(INFO);

    lastToast().options.action.onClick();

    expect(bridge.externalOpened).toEqual([INFO.url]);
    expect(saveUi).toHaveBeenCalledWith({ dismissedUpdate: '0.2.0' });
    expect(useUiStore.getState().ui.dismissedUpdate).toBe('0.2.0');
  });

  it('Later закрывает версию в ui.json и ничего не открывает', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdate(INFO);

    lastToast().options.cancel.onClick();

    expect(bridge.externalOpened).toEqual([]);
    expect(saveUi).toHaveBeenCalledTimes(1);
    expect(saveUi).toHaveBeenCalledWith({ dismissedUpdate: '0.2.0' });
    expect(useUiStore.getState().ui.dismissedUpdate).toBe('0.2.0');
  });

  it('смахивание тоста (onDismiss) закрывает версию так же', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdate(INFO);

    lastToast().options.onDismiss();

    expect(bridge.externalOpened).toEqual([]);
    expect(saveUi).toHaveBeenCalledTimes(1);
    expect(saveUi).toHaveBeenCalledWith({ dismissedUpdate: '0.2.0' });
  });

  it('версия, уже записанная закрытой, второй раз не пишется', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdate(INFO);
    const { options } = lastToast();

    options.cancel.onClick();
    options.onDismiss();
    options.action.onClick();

    expect(saveUi).toHaveBeenCalledTimes(1);
  });

  it('закрытая версия больше не показывается — ни тем же событием, ни при новой подписке; более новая показывается', () => {
    wire();
    bridge.emitUpdate(INFO);
    lastToast().options.cancel.onClick();
    vi.mocked(toast).mockClear();

    bridge.emitUpdate(INFO);
    expect(toast).not.toHaveBeenCalled();

    // Обрыв связи и возврат: подписка заводится заново и снова получает найденное от main.
    unwire.pop()?.();
    bridge.setPendingUpdate(INFO);
    wire();
    expect(toast).not.toHaveBeenCalled();

    bridge.emitUpdate(NEWER);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.3.0 is available');
  });

  it('версия, закрытая в прошлом запуске (ui.json), тоста не даёт', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, dismissedUpdate: '0.2.0' } });
    wire();

    bridge.emitUpdate(INFO);

    expect(toast).not.toHaveBeenCalled();
  });

  it('Download: отказ открыть адрес — в консоль, а не исключением; версия при этом закрыта', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(bridge.app, 'openExternal').mockRejectedValue(new Error('no browser'));
    wire();
    bridge.emitUpdate(INFO);

    lastToast().options.action.onClick();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[parley] openExternal', expect.any(Error)),
    );

    expect(useUiStore.getState().ui.dismissedUpdate).toBe('0.2.0');
  });
});

describe('wireUpdateNotice — переключатель и загрузка ui.json', () => {
  it('«Check for updates» выключен — тоста нет, даже если main успел найти релиз; включили — следующее сообщение показывает', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: false } });
    wire();

    bridge.emitUpdate(INFO);
    expect(toast).not.toHaveBeenCalled();

    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: true } });
    bridge.emitUpdate(INFO);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('пока зеркало ui.json не загружено — ждёт; загрузилось — показывает', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();

    bridge.emitUpdate(INFO);
    expect(toast).not.toHaveBeenCalled();

    useUiStore.setState({ uiLoaded: true });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.2.0 is available');
  });

  it('загрузилось зеркало с уже закрытой версией — тоста не будет: до ответа app.loadUi() он не мелькнул', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();
    bridge.emitUpdate(INFO);

    useUiStore.setState({ ui: { ...DEFAULT_UI, dismissedUpdate: '0.2.0' }, uiLoaded: true });

    expect(toast).not.toHaveBeenCalled();
  });

  it('загрузилось зеркало с выключенным переключателем — тоста не будет', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();
    bridge.emitUpdate(INFO);

    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: false }, uiLoaded: true });

    expect(toast).not.toHaveBeenCalled();
  });

  it('без найденного релиза загрузка ui.json тост не создаёт', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();

    useUiStore.setState({ uiLoaded: true });

    expect(toast).not.toHaveBeenCalled();
  });
});
