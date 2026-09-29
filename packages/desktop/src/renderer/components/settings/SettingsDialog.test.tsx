/**
 * Тесты куска 1.4 плана «облик Orca» (спека 4.10, четыре секции): поля
 * терминала/агентов сохраняются как раньше (`settings.set`), «Вид» зовёт
 * `app.setAppearance` напрямую без отдельного `saveUi`, «Уведомления» зовут
 * `app.saveUi` с полным объектом `notifications`, и поля темы TUI в диалоге
 * больше нет вовсе (спека 4.9).
 *
 * `ui/tabs` (Radix) переключает секцию по `mousedown`, а не по `click`
 * (`TabsPrimitive.Trigger`), поэтому смена вкладки в тестах — `fireEvent.mouseDown`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { useUiStore } from '../../store/ui.js';
import { SettingsDialog } from './SettingsDialog.js';

const CONFIG = {
  silenceThresholdMs: 30_000,
  channelPush: true,
  messageRate: 20,
  resumeRate: 6,
  autoLaunch: true,
  fontFamily: 'Menlo',
  fontSize: 13,
  worktreeRoot: '~/.harnas/worktrees',
};

// Тест 10 куска 9.1 проверяет вызов тоста, а не его разметку.
vi.mock('sonner', () => ({ toast: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
});

/**
 * Стор `store/ui.ts` — общий на файл (кусок 2.3): «Вид»/«Уведомления» читают
 * его зеркало вместо своего `loadUi()`, поэтому `init(bridge)` — тут же, а не
 * в компоненте, и на своём зеркале сбрасывается перед каждым тестом, чтобы
 * прошлый тест не оставил, например, `appearance: 'dark'`.
 */
function openSettings(bridge: ReturnType<typeof createFakeBridge>, locked: Record<string, string> = {}): void {
  bridge.setHandler('settings.get', () => ({ config: CONFIG, locked }));
  useUiStore.setState({ ui: DEFAULT_UI, uiLoaded: false });
  useUiStore.getState().init(bridge);
  render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
}

function switchTo(section: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name: section }));
}

describe('SettingsDialog — тест 1 куска 1.4: секции спеки 4.10', () => {
  it('поля темы TUI нет ни на одной секции', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    // «Вид» — активная секция по умолчанию.
    await screen.findByText('System');
    expect(screen.queryByText('Theme')).toBeNull();

    switchTo('Terminal');
    await screen.findByDisplayValue('Menlo');
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();

    switchTo('Agents');
    await screen.findByText('Worktree root');
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();

    switchTo('Notifications');
    await screen.findByLabelText('sound');
    expect(screen.queryByText('Theme')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();
  });

  it('«Тёмная» зовёт app.setAppearance(\'dark\'), отдельного saveUi для вида нет', async () => {
    const bridge = createFakeBridge();
    const setAppearanceSpy = vi.spyOn(bridge.app, 'setAppearance');
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    fireEvent.click(await screen.findByText('Dark'));

    await waitFor(() => expect(setAppearanceSpy).toHaveBeenCalledWith('dark'));
    expect(saveUiSpy).not.toHaveBeenCalled();
  });

  it('переключатель «звук» зовёт app.saveUi({ notifications: { …, sound: false } })', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Notifications');
    const soundToggle = await screen.findByLabelText('sound');
    fireEvent.click(soundToggle);

    await waitFor(() =>
      expect(saveUiSpy).toHaveBeenCalledWith({
        notifications: { ...DEFAULT_UI.notifications, sound: false },
      }),
    );
  });

  it('тест 5 куска 4.3: в секции «Notifications» всегда видна подсказка про системные настройки', async () => {
    openSettings(createFakeBridge());
    switchTo('Notifications');
    expect(await screen.findByText('Not getting notifications? System Settings → Notifications → Harnas')).toBeTruthy();
  });

  it('«Размер шрифта» зовёт settings.set', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', ({ value }) => ({ config: { ...CONFIG, fontSize: Number(value) } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Terminal');
    const fontSize = await screen.findByDisplayValue('13');
    fireEvent.change(fontSize, { target: { value: '16' } });
    fireEvent.blur(fontSize);

    await waitFor(() =>
      expect(bridge.calls).toContainEqual({ method: 'settings.set', params: { key: 'fontSize', value: '16' } }),
    );
  });
});

describe('SettingsDialog — тест 2: поле, заданное окружением', () => {
  it('неактивно и подписано именем переменной; незаблокированное поле рядом активно', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge, { fontFamily: 'HARNAS_FONT_FAMILY' });

    switchTo('Terminal');
    await screen.findByText(/set by HARNAS_FONT_FAMILY/);
    const fontFamily = screen.getByDisplayValue('Menlo') as HTMLInputElement;
    expect(fontFamily.disabled).toBe(true);

    const fontSize = screen.getByDisplayValue('13') as HTMLInputElement;
    expect(fontSize.disabled).toBe(false);
  });
});

describe('SettingsDialog — тест 3: ошибка хоста при сохранении', () => {
  // Кусок E.1: рендерер больше не показывает error.message хоста напрямую —
  // код ошибки идёт через decodeIpcError (подставной мост шлёт { code,
  // message } без Electron-обёртки, см. shared/ipc-error.ts) в errorText(code, action).
  it('видна под полем как errorText(code), успешное сохранение убирает прежнюю ошибку и обновляет конфиг', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    let attempt = 0;
    bridge.setHandler('settings.set', ({ value }) => {
      attempt += 1;
      if (attempt === 1) throw { code: 'bad_request', message: 'messageRate: ожидается целое больше нуля' };
      return { config: { ...CONFIG, messageRate: Number(value) } };
    });

    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Agents');

    const messageRate = await screen.findByDisplayValue('20');
    fireEvent.change(messageRate, { target: { value: '0' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.getByText("Couldn't save settings: invalid request.")).toBeTruthy());

    fireEvent.change(messageRate, { target: { value: '7' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.queryByText("Couldn't save settings: invalid request.")).toBeNull());
  });
});

describe('SettingsDialog — тест 10 куска 9.1: секция Browser', () => {
  it('«Clear browser data» зовёт browser.clearData', async () => {
    const bridge = createFakeBridge();
    openSettings(bridge);

    switchTo('Browser');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear browser data' }));

    await waitFor(() => expect(bridge.browserCalls).toEqual([{ method: 'clearData', args: [] }]));
    expect(toast).not.toHaveBeenCalled();
  });

  it('отказ — тост «Couldn\'t clear browser data: failed.»', async () => {
    const bridge = createFakeBridge();
    vi.spyOn(bridge.browser, 'clearData').mockRejectedValue({ code: 'failed', message: 'disk full' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    openSettings(bridge);

    switchTo('Browser');
    fireEvent.click(await screen.findByRole('button', { name: 'Clear browser data' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't clear browser data: failed."));
    warn.mockRestore();
  });
});
