/**
 * Тост о новой версии (V6 плана релиза 0.1.0): «Parley X.Y.Z is available» с кнопками «Download» и «Later»,
 * закрытая версия («Download», смахнули) — в `ui.json`, «Later» — только закрыть тост, переключатель
 * «Check for updates» (выключили — тост снимается, включили — возвращается) и ожидание загрузки зеркала `ui.json`.
 * Мост подставной, `sonner` тоже: проверяется вызов тоста и поведение его кнопок, а не разметка.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import type { UpdateInfo, UpdateState } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { useUiStore } from '../store/ui.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { UPDATE_TOAST_ID, wireUpdateNotice } from './update-notice.js';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));

const INFO: UpdateInfo = {
  version: '0.2.0',
  url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
};
const NEWER: UpdateInfo = {
  version: '0.3.0',
  url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.3.0',
};

/** Состояние «найден релиз» для моста: тост показывается только в нём. */
const avail = (info: UpdateInfo): UpdateState => ({
  phase: 'available',
  ...info,
  canInstall: false,
});

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
  vi.mocked(toast.dismiss).mockClear();
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

    bridge.emitUpdateState(avail(INFO));

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
    bridge.setUpdateState(avail(INFO));

    wire();

    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.2.0 is available');
  });

  it('та же версия снова (проверка раз в сутки, переподключение) — тот же тост на месте, а не второй', () => {
    wire();

    bridge.emitUpdateState(avail(INFO));
    bridge.emitUpdateState(avail({ ...INFO }));

    expect(toast).toHaveBeenCalledTimes(2);
    const ids = vi.mocked(toast).mock.calls.map((call) => (call[1] as unknown as ToastOptions).id);
    expect(new Set(ids)).toEqual(new Set([UPDATE_TOAST_ID]));
  });

  it('после отписки события и загрузка ui.json больше ничего не показывают', () => {
    useUiStore.setState({ uiLoaded: false });
    const off = wire();
    bridge.emitUpdateState(avail(INFO));
    off();

    bridge.emitUpdateState(avail(NEWER));
    useUiStore.setState({ uiLoaded: true });

    expect(toast).not.toHaveBeenCalled();
  });
});

describe('wireUpdateNotice — кнопки и закрытая версия', () => {
  it('Download открывает страницу релиза в браузере и закрывает версию в ui.json', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdateState(avail(INFO));

    lastToast().options.action.onClick();

    expect(bridge.externalOpened).toEqual([INFO.url]);
    expect(saveUi).toHaveBeenCalledWith({ dismissedUpdate: '0.2.0' });
    expect(useUiStore.getState().ui.dismissedUpdate).toBe('0.2.0');
  });

  // «Later» обещает «позже», а не «никогда»: записанная в ui.json версия не показалась бы больше ни при новом запуске,
  // ни на следующий день, пока не выйдет более новая.
  it('Later только закрывает тост: версия в ui.json не записывается, ничего не открывается, а следующая проверка снова скажет', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdateState(avail(INFO));

    lastToast().options.cancel.onClick();

    expect(bridge.externalOpened).toEqual([]);
    expect(saveUi).not.toHaveBeenCalled();
    expect(useUiStore.getState().ui.dismissedUpdate).toBeNull();
    // Проверка раз в сутки (или новый запуск) находит тот же релиз — тост на месте.
    vi.mocked(toast).mockClear();
    bridge.emitUpdateState(avail({ ...INFO }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.2.0 is available');
  });

  it('смахивание тоста (onDismiss) закрывает версию так же', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdateState(avail(INFO));

    lastToast().options.onDismiss();

    expect(bridge.externalOpened).toEqual([]);
    expect(saveUi).toHaveBeenCalledTimes(1);
    expect(saveUi).toHaveBeenCalledWith({ dismissedUpdate: '0.2.0' });
  });

  it('версия, уже записанная закрытой, второй раз не пишется', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdateState(avail(INFO));
    const { options } = lastToast();

    options.onDismiss();
    options.action.onClick();
    options.cancel.onClick();
    options.onDismiss();

    expect(saveUi).toHaveBeenCalledTimes(1);
  });

  it('закрытая версия больше не показывается — ни тем же событием, ни при новой подписке; более новая показывается', () => {
    wire();
    bridge.emitUpdateState(avail(INFO));
    // Закрыть насовсем — смахнуть тост; «Later» версию не закрывает.
    lastToast().options.onDismiss();
    vi.mocked(toast).mockClear();

    bridge.emitUpdateState(avail(INFO));
    expect(toast).not.toHaveBeenCalled();

    // Обрыв связи и возврат: подписка заводится заново и снова получает найденное от main.
    unwire.pop()?.();
    bridge.setUpdateState(avail(INFO));
    wire();
    expect(toast).not.toHaveBeenCalled();

    bridge.emitUpdateState(avail(NEWER));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.3.0 is available');
  });

  it('версия, закрытая в прошлом запуске (ui.json), тоста не даёт', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, dismissedUpdate: '0.2.0' } });
    wire();

    bridge.emitUpdateState(avail(INFO));

    expect(toast).not.toHaveBeenCalled();
  });

  it('Download: отказ открыть адрес — в консоль, а не исключением; версия при этом закрыта', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(bridge.app, 'openExternal').mockRejectedValue(new Error('no browser'));
    wire();
    bridge.emitUpdateState(avail(INFO));

    lastToast().options.action.onClick();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[parley] openExternal', expect.any(Error)),
    );

    expect(useUiStore.getState().ui.dismissedUpdate).toBe('0.2.0');
  });
});

describe('wireUpdateNotice — переключатель и загрузка ui.json', () => {
  it('«Check for updates» выключен — тоста нет, даже если main успел найти релиз; включили — найденное показывается сразу', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: false } });
    wire();

    bridge.emitUpdateState(avail(INFO));
    expect(toast).not.toHaveBeenCalled();

    // Без нового сообщения от main: оно придёт, когда main проверит (`settingsChanged`), а найденное уже на виду.
    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: true } });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.2.0 is available');
  });

  it('выключили переключатель при стоящем тосте — тост снимается, а `onDismiss` этого снятия версию не закрывает', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();
    bridge.emitUpdateState(avail(INFO));
    const { options } = lastToast();

    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: false } });

    expect(toast.dismiss).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith(UPDATE_TOAST_ID);
    // sonner зовёт `onDismiss` и при снятии программой, не только при смахивании человеком.
    options.onDismiss();
    expect(saveUi).not.toHaveBeenCalled();
    expect(useUiStore.getState().ui.dismissedUpdate).toBeNull();

    // Включил обратно — версия не спрятана: тост снова.
    vi.mocked(toast).mockClear();
    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: true } });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('переключатель, не менявшийся, тост не трогает: чужие правки ui.json его не снимают', () => {
    wire();
    bridge.emitUpdateState(avail(INFO));

    useUiStore.setState({ ui: { ...DEFAULT_UI, appearance: 'dark' } });

    expect(toast.dismiss).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('включили переключатель, а найденного релиза нет, — тоста нет', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: false } });
    wire();

    useUiStore.setState({ ui: { ...DEFAULT_UI, checkForUpdates: true } });

    expect(toast).not.toHaveBeenCalled();
  });

  it('пока зеркало ui.json не загружено — ждёт; загрузилось — показывает', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();

    bridge.emitUpdateState(avail(INFO));
    expect(toast).not.toHaveBeenCalled();

    useUiStore.setState({ uiLoaded: true });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(lastToast().message).toBe('Parley 0.2.0 is available');
  });

  it('загрузилось зеркало с уже закрытой версией — тоста не будет: до ответа app.loadUi() он не мелькнул', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();
    bridge.emitUpdateState(avail(INFO));

    useUiStore.setState({ ui: { ...DEFAULT_UI, dismissedUpdate: '0.2.0' }, uiLoaded: true });

    expect(toast).not.toHaveBeenCalled();
  });

  it('загрузилось зеркало с выключенным переключателем — тоста не будет', () => {
    useUiStore.setState({ uiLoaded: false });
    wire();
    bridge.emitUpdateState(avail(INFO));

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

const URL_ = INFO.url;
const can = (info: UpdateInfo): UpdateState => ({ phase: 'available', ...info, canInstall: true });

/** Событие кнопки sonner: проверяется, отменил ли обработчик закрытие тоста. */
function click(button: { onClick: (event?: { preventDefault(): void }) => void }): boolean {
  let prevented = false;
  button.onClick({ preventDefault: () => (prevented = true) });
  return prevented;
}

describe('wireUpdateNotice — самообновление (спека §4.1)', () => {
  it('SU-02: заменить себя можно — «Update» и «Later»; «Update» зовёт downloadUpdate, версию не закрывает, тост не закрывает', () => {
    const saveUi = vi.spyOn(bridge.app, 'saveUi');
    wire();

    bridge.emitUpdateState(can(INFO));

    const { message, options } = lastToast();
    expect(message).toBe('Parley 0.2.0 is available');
    expect(options.action.label).toBe('Update');
    expect(options.cancel.label).toBe('Later');
    expect(click(options.action)).toBe(true);
    expect(bridge.updateCalls).toContain('download');
    expect(bridge.externalOpened).toEqual([]);
    expect(saveUi).not.toHaveBeenCalled();
    expect(useUiStore.getState().ui.dismissedUpdate).toBeNull();
  });

  it('SU-02: заменить себя нельзя — «Download» (страница релиза) и «Later», как на master', () => {
    wire();

    bridge.emitUpdateState(avail(INFO));

    const { options } = lastToast();
    expect(options.action.label).toBe('Download');
    options.action.onClick();
    expect(bridge.externalOpened).toEqual([URL_]);
    expect(bridge.updateCalls).not.toContain('download');
  });

  it('загрузка: «Downloading Parley X… N%» с одной кнопкой «Cancel», тот же id; «Cancel» зовёт cancelUpdateDownload и тост не закрывает', () => {
    wire();
    bridge.emitUpdateState(can(INFO));

    bridge.emitUpdateState({ phase: 'downloading', ...INFO, received: 250, total: 1000 });

    const { message, options } = lastToast();
    expect(message).toBe('Downloading Parley 0.2.0… 25%');
    expect(options.id).toBe(UPDATE_TOAST_ID);
    expect(options.duration).toBe(Infinity);
    expect(options.action.label).toBe('Cancel');
    // Кнопка «Later» прежнего состояния не должна остаться: sonner сливает параметры одного id.
    expect(options.cancel).toBeUndefined();
    expect(click(options.action)).toBe(true);
    expect(bridge.updateCalls).toContain('cancel');
  });

  it('загрузка без известного размера — без процента', () => {
    wire();

    bridge.emitUpdateState({ phase: 'downloading', ...INFO, received: 250, total: null });

    expect(lastToast().message).toBe('Downloading Parley 0.2.0…');
  });

  it('проверка и распаковка: «Checking Parley X…» и «Cancel»', () => {
    wire();

    bridge.emitUpdateState({ phase: 'verifying', ...INFO });

    const { message, options } = lastToast();
    expect(message).toBe('Checking Parley 0.2.0…');
    expect(options.action.label).toBe('Cancel');
    click(options.action);
    expect(bridge.updateCalls).toContain('cancel');
  });

  it('готово: «Parley X is ready», строка про остановку агентов, «Restart now» (не закрывает тост, зовёт installUpdate) и «Later»', () => {
    wire();

    bridge.emitUpdateState({ phase: 'ready', ...INFO });

    const { message, options } = lastToast();
    expect(message).toBe('Parley 0.2.0 is ready');
    expect((options as unknown as { description: string }).description).toBe(
      'Restarting stops running agents',
    );
    expect(options.action.label).toBe('Restart now');
    expect(options.cancel.label).toBe('Later');
    expect(click(options.action)).toBe(true);
    expect(bridge.updateCalls).toContain('install');
    // «Later» версию закрытой не записывает.
    options.cancel.onClick();
    expect(useUiStore.getState().ui.dismissedUpdate).toBeNull();
  });

  it("не удалось: «Couldn't update to X: <причина>», «Download» (страница релиза) и «Later»", () => {
    wire();

    bridge.emitUpdateState({ phase: 'failed', ...INFO, reason: 'checksum' });

    const { message, options } = lastToast();
    expect(message).toBe("Couldn't update to 0.2.0: the download does not match its checksum");
    expect(options.action.label).toBe('Download');
    expect(options.cancel.label).toBe('Later');
    options.action.onClick();
    expect(bridge.externalOpened).toEqual([URL_]);
  });

  it('у каждого кода отказа своя причина, непустая и английская', () => {
    const failures = [
      'network',
      'too_large',
      'checksum',
      'bad_archive',
      'disk',
      'cannot_replace',
    ] as const;
    const results = [
      'still_running',
      'no_app',
      'swap_failed',
      'restore_failed',
      'launch_failed',
      'helper',
    ] as const;
    const all = [
      ...failures.map((c) => S.update.failure[c]),
      ...results.map((c) => S.update.resultFailure[c]),
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const text of all) expect(text).toMatch(/^[\x20-\x7e]+$/);
  });

  it('состояния сменяют друг друга на месте: у всех один id', () => {
    wire();
    const states: UpdateState[] = [
      can(INFO),
      { phase: 'downloading', ...INFO, received: 1, total: 2 },
      { phase: 'verifying', ...INFO },
      { phase: 'ready', ...INFO },
      { phase: 'failed', ...INFO, reason: 'disk' },
    ];
    for (const state of states) bridge.emitUpdateState(state);

    const ids = vi.mocked(toast).mock.calls.map((call) => (call[1] as unknown as ToastOptions).id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids)).toEqual(new Set([UPDATE_TOAST_ID]));
  });

  it('смахнутый тост о версии больше не появляется, пока загрузка идёт', () => {
    wire();
    bridge.emitUpdateState(can(INFO));
    lastToast().options.onDismiss();
    vi.mocked(toast).mockClear();

    bridge.emitUpdateState({ phase: 'downloading', ...INFO, received: 1, total: 2 });
    bridge.emitUpdateState({ phase: 'ready', ...INFO });

    expect(toast).not.toHaveBeenCalled();
  });

  it('SU-01: состояние idle (проверку выключили, новой версии нет) тоста не создаёт; стоящий тост снимается', () => {
    wire();
    bridge.emitUpdateState({ phase: 'idle' });
    expect(toast).not.toHaveBeenCalled();
    expect(toast.dismiss).not.toHaveBeenCalled();

    bridge.emitUpdateState(can(INFO));
    bridge.emitUpdateState({ phase: 'idle' });
    expect(toast.dismiss).toHaveBeenCalledWith(UPDATE_TOAST_ID);
  });

  it('отмена возвращает «available» на месте', () => {
    wire();
    bridge.emitUpdateState({ phase: 'verifying', ...INFO });

    bridge.emitUpdateState(can(INFO));

    expect(lastToast().message).toBe('Parley 0.2.0 is available');
    expect(lastToast().options.action.label).toBe('Update');
  });
});

describe('wireUpdateNotice — итог после перезапуска (спека §4.3)', () => {
  it('«обновлено»: один тост «Parley updated to X»; итог берётся один раз', async () => {
    bridge.setUpdateResult({ kind: 'updated', version: '0.2.0' });

    wire();

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Parley updated to 0.2.0', expect.anything()),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(bridge.updateCalls.filter((c) => c === 'takeResult')).toHaveLength(1);
  });

  it('отказ: причина и «The previous version is still installed.»', async () => {
    bridge.setUpdateResult({ kind: 'failed', version: '0.2.0', reason: 'swap_failed' });

    wire();

    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Couldn't update to 0.2.0: the new version could not be put in place. The previous version is still installed.",
        expect.anything(),
      ),
    );
  });

  it('итога нет — тоста нет', async () => {
    wire();
    await vi.waitFor(() => expect(bridge.updateCalls).toContain('takeResult'));
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
  });

  it('после отписки до ответа тост не показывается', async () => {
    bridge.setUpdateResult({ kind: 'updated', version: '0.2.0' });
    wire()();
    await vi.waitFor(() => expect(bridge.updateCalls).toContain('takeResult'));
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
  });
});
