import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramStatus } from '@parley/protocol';
import type { ParleyConfig } from '@parley/core';
import { S } from '../../../shared/strings.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { TelegramSettings } from './TelegramSettings.js';

const text = S.settings.telegram;
const METHODS = new Set(['telegram.status']);

const base: TelegramStatus = {
  enabled: true,
  token: 'set',
  botUsername: 'parley_bot',
  hint: '••••abcd',
  owner: null,
  pendingLink: null,
  polling: 'ok',
  error: null,
  lastUpdateAt: null,
};
const linked: TelegramStatus = { ...base, owner: { username: 'vasya', linkedAt: '2026-10-20T10:00:00.000Z' } };

let bridge: FakeBridge;
const save = vi.fn(async () => undefined);

function config(patch: Partial<ParleyConfig> = {}): ParleyConfig {
  return {
    telegramEnabled: true,
    telegramNeedsYou: true,
    telegramFinished: false,
    telegramMail: true,
    telegramCards: true,
    ...patch,
  } as ParleyConfig;
}

function mount(status: TelegramStatus, cfg = config(), methods = METHODS): void {
  bridge.setHandler('telegram.status', () => status);
  render(<TelegramSettings bridge={bridge} config={cfg} locked={{}} save={save} hostMethods={methods} />);
}

beforeEach(() => {
  bridge = createFakeBridge();
  save.mockClear();
});
afterEach(() => cleanup());

describe('TelegramSettings', () => {
  it('раздела нет, если хост не знает telegram.status', () => {
    mount(base, config(), new Set());
    expect(screen.queryByTestId('telegram-section')).toBeNull();
  });

  it.each<[string, TelegramStatus, string, ParleyConfig?]>([
    ['выключено', base, text.statusOff, config({ telegramEnabled: false })],
    ['нет токена', { ...base, token: 'none', botUsername: null, hint: null }, text.statusNotSetUp],
    ['токен без привязки', base, text.notLinked('parley_bot', '••••abcd')],
    ['привязан', linked, text.linked('@vasya', 'Oct 20, 2026')],
    ['привязан без логина', { ...base, owner: { username: null, linkedAt: '2026-10-20T10:00:00.000Z' } }, text.linkedNoName('Oct 20, 2026')],
    ['ошибка', { ...base, polling: 'error', error: 'boom' }, text.error('boom')],
    ['перехвачен другим Parley', { ...base, polling: 'conflict' }, text.conflict],
  ])('строка состояния: %s', async (_name, status, expected, cfg) => {
    mount(status, cfg);
    await waitFor(() => expect(screen.getByTestId('telegram-status').textContent).toBe(expected));
  });

  it('при конфликте есть кнопка перехвата, она зовёт telegram.takeOver', async () => {
    bridge.setHandler('telegram.takeOver', () => ({ ok: true }));
    mount({ ...base, polling: 'conflict' });
    fireEvent.click(await screen.findByTestId('telegram-take-over'));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'telegram.takeOver')).toBe(true));
  });

  it('Check зовёт telegram.setToken с введённым токеном и очищает поле', async () => {
    bridge.setHandler('telegram.setToken', () => ({ botUsername: 'parley_bot', hint: '••••abcd' }));
    mount({ ...base, token: 'none', botUsername: null, hint: null });
    const input = (await screen.findByTestId('telegram-token')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '123456:AAAA' } });
    fireEvent.click(screen.getByTestId('telegram-check'));
    await waitFor(() => expect(input.value).toBe(''));
    expect(bridge.calls.find((call) => call.method === 'telegram.setToken')?.params).toEqual({ token: '123456:AAAA' });
  });

  it('Link показывает код, ссылку и SVG-картинку', async () => {
    bridge.setHandler('telegram.link', () => ({ code: 'XY12', expiresAt: '2026-10-20T11:00:00.000Z', deepLink: 'https://t.me/parley_bot?start=XY12' }));
    mount(base);
    fireEvent.click(await screen.findByTestId('telegram-link'));
    expect((await screen.findByTestId('telegram-code')).textContent).toBe('XY12');
    expect(screen.getByTestId('telegram-deeplink').textContent).toBe('https://t.me/parley_bot?start=XY12');
    await waitFor(() => expect(screen.getByTestId('telegram-qr').querySelector('svg')).not.toBeNull());
  });

  it('по истечении expiresAt код пропадает и виден текст «code expired»', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      bridge.setHandler('telegram.link', () => ({ code: 'XY12', expiresAt, deepLink: 'https://t.me/parley_bot?start=XY12' }));
      mount(base);
      fireEvent.click(await screen.findByTestId('telegram-link'));
      expect((await screen.findByTestId('telegram-code')).textContent).toBe('XY12');
      await act(async () => {
        vi.advanceTimersByTime(61_000);
      });
      expect(screen.queryByTestId('telegram-code')).toBeNull();
      expect(screen.getByTestId('telegram-code-expired').textContent).toBe(text.codeExpired);
    } finally {
      vi.useRealTimers();
    }
  });

  it('при выключенном Send to Telegram остальное приглушено, но кнопки работают', async () => {
    bridge.setHandler('telegram.unlink', () => ({ ok: true }));
    bridge.setHandler('telegram.clearToken', () => ({ ok: true }));
    mount(linked, config({ telegramEnabled: false }));
    const body = await screen.findByTestId('telegram-body');
    expect(body.className).toContain('opacity-60');
    expect(body.className).not.toContain('pointer-events-none');
    fireEvent.click(screen.getByTestId('telegram-unlink'));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'telegram.unlink')).toBe(true));
    fireEvent.click(screen.getByTestId('telegram-remove'));
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'telegram.clearToken')).toBe(true));
  });

  it('событие telegram.changed с owner переключает на Linked и открывает четыре переключателя', async () => {
    mount(base);
    await screen.findByTestId('telegram-link');
    expect(screen.queryByTestId('telegram-finished')).toBeNull();
    act(() => bridge.emit('telegram.changed', linked));
    expect(screen.getByTestId('telegram-status').textContent).toBe(text.linked('@vasya', 'Oct 20, 2026'));
    for (const id of ['needs-you', 'finished', 'mail', 'cards']) expect(screen.getByTestId(`telegram-${id}`)).toBeTruthy();
  });

  it('переключатель Finished сохраняет telegramFinished = true', async () => {
    mount(linked);
    fireEvent.click(await screen.findByTestId('telegram-finished'));
    expect(save).toHaveBeenCalledWith('telegramFinished', 'true');
  });

  it('Send to Telegram выключен: строка Off, переключателей нет', async () => {
    mount(linked, config({ telegramEnabled: false }));
    await waitFor(() => expect(screen.getByTestId('telegram-status').textContent).toBe(text.statusOff));
    expect(screen.queryByTestId('telegram-finished')).toBeNull();
  });

  it('переключатель Send to Telegram зовёт save', async () => {
    mount(base);
    fireEvent.click(await screen.findByTestId('telegram-enabled'));
    expect(save).toHaveBeenCalledWith('telegramEnabled', 'false');
  });
});
