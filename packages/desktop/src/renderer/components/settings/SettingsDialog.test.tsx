import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { SettingsDialog } from './SettingsDialog.js';

const CONFIG = {
  prefix: 'q',
  sidebarWidth: 26,
  mouseCapture: true,
  ascii: false,
  silenceThresholdMs: 30_000,
  channelPush: true,
  messageRate: 20,
  autoLaunch: true,
  theme: 'mocha',
  fontFamily: 'Menlo',
  fontSize: 13,
};

afterEach(cleanup);

describe('SettingsDialog', () => {
  it('поле, заданное окружением, неактивно и подписано именем переменной', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: { theme: 'HARNAS_THEME' } }));

    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    await screen.findByText(/задано HARNAS_THEME/);
    const select = screen.getByDisplayValue('mocha') as HTMLSelectElement;
    expect(select.disabled).toBe(true);

    // Незаблокированное поле остаётся активным.
    const fontFamily = screen.getByDisplayValue('Menlo') as HTMLInputElement;
    expect(fontFamily.disabled).toBe(false);
  });

  it('ошибка хоста при сохранении видна под полем', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    bridge.setHandler('settings.set', () => {
      throw new Error('fontSize: ожидается целое от 8 до 32');
    });

    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    const fontSize = await screen.findByDisplayValue('13');
    fireEvent.change(fontSize, { target: { value: '99' } });
    fireEvent.blur(fontSize);

    await waitFor(() => expect(screen.getByText('fontSize: ожидается целое от 8 до 32')).toBeTruthy());
  });

  it('успешное сохранение поля убирает прежнюю ошибку и обновляет конфиг', async () => {
    const bridge = createFakeBridge();
    bridge.setHandler('settings.get', () => ({ config: CONFIG, locked: {} }));
    let attempt = 0;
    bridge.setHandler('settings.set', ({ value }) => {
      attempt += 1;
      if (attempt === 1) throw new Error('messageRate: ожидается целое больше нуля');
      return { config: { ...CONFIG, messageRate: Number(value) } };
    });

    render(<SettingsDialog open bridge={bridge} onOpenChange={() => {}} />);

    const messageRate = await screen.findByDisplayValue('20');
    fireEvent.change(messageRate, { target: { value: '0' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.getByText('messageRate: ожидается целое больше нуля')).toBeTruthy());

    fireEvent.change(messageRate, { target: { value: '7' } });
    fireEvent.blur(messageRate);
    await waitFor(() => expect(screen.queryByText('messageRate: ожидается целое больше нуля')).toBeNull());
  });
});
