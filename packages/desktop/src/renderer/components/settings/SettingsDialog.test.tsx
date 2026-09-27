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
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { SettingsDialog } from './SettingsDialog.js';

const CONFIG = {
  prefix: 'q',
  sidebarWidth: 26,
  mouseCapture: true,
  ascii: false,
  silenceThresholdMs: 30_000,
  channelPush: true,
  messageRate: 20,
  resumeRate: 6,
  autoLaunch: true,
  theme: 'mocha',
  fontFamily: 'Menlo',
  fontSize: 13,
  worktreeRoot: '~/.harnas/worktrees',
};

afterEach(cleanup);

function openSettings(bridge: ReturnType<typeof createFakeBridge>, locked: Record<string, string> = {}): void {
  bridge.setHandler('settings.get', () => ({ config: CONFIG, locked }));
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
    await screen.findByText('Система');
    expect(screen.queryByText('Тема')).toBeNull();

    switchTo('Терминал');
    await screen.findByDisplayValue('Menlo');
    expect(screen.queryByText('Тема')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();

    switchTo('Агенты');
    await screen.findByText('Корень worktree');
    expect(screen.queryByText('Тема')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();

    switchTo('Уведомления');
    await screen.findByLabelText('звук');
    expect(screen.queryByText('Тема')).toBeNull();
    expect(screen.queryByDisplayValue('mocha')).toBeNull();
  });

  it('«Тёмная» зовёт app.setAppearance(\'dark\'), отдельного saveUi для вида нет', async () => {
    const bridge = createFakeBridge();
    const setAppearanceSpy = vi.spyOn(bridge.app, 'setAppearance');
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    fireEvent.click(await screen.findByText('Тёмная'));

    await waitFor(() => expect(setAppearanceSpy).toHaveBeenCalledWith('dark'));
    expect(saveUiSpy).not.toHaveBeenCalled();
  });

  it('переключатель «звук» зовёт app.saveUi({ notifications: { …, sound: false } })', async () => {
    const bridge = createFakeBridge();
    const saveUiSpy = vi.spyOn(bridge.app, 'saveUi');
    openSettings(bridge);

    switchTo('Уведомления');
    const soundToggle = await screen.findByLabelText('звук');
    fireEvent.click(soundToggle);

    await waitFor(() =>
      expect(saveUiSpy).toHaveBeenCalledWith({
        notifications: { ...DEFAULT_UI.notifications, sound: false },
      }),
    );
  });

  it('«Размер шрифта» зовёт settings.set', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', ({ value }) => ({ config: { ...CONFIG, fontSize: Number(value) } }));
    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    switchTo('Терминал');
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

    switchTo('Терминал');
    await screen.findByText(/задано HARNAS_FONT_FAMILY/);
    const fontFamily = screen.getByDisplayValue('Menlo') as HTMLInputElement;
    expect(fontFamily.disabled).toBe(true);

    const fontSize = screen.getByDisplayValue('13') as HTMLInputElement;
    expect(fontSize.disabled).toBe(false);
  });
});

describe('SettingsDialog — тест 3: ошибка хоста при сохранении', () => {
  it('видна под полем, успешное сохранение убирает прежнюю ошибку и обновляет конфиг', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    let attempt = 0;
    bridge.setHandler('settings.set', ({ value }) => {
      attempt += 1;
      if (attempt === 1) throw new Error('messageRate: ожидается целое больше нуля');
      return { config: { ...CONFIG, messageRate: Number(value) } };
    });

    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);
    switchTo('Агенты');

    const messageRate = await screen.findByDisplayValue('20');
    fireEvent.change(messageRate, { target: { value: '0' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.getByText('messageRate: ожидается целое больше нуля')).toBeTruthy());

    fireEvent.change(messageRate, { target: { value: '7' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.queryByText('messageRate: ожидается целое больше нуля')).toBeNull());
  });
});
