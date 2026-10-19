/** Выбор вендора и форма своего провайдера (спека своих провайдеров, 4.3). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Result } from '@parley/protocol';
import { encodeIpcError } from '../../../shared/ipc-error.js';
import { S } from '../../../shared/strings.js';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore, type ProviderInfo } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { CustomProviderPanel } from './CustomProviderPanel.js';

const METHODS = [...REQUIRED_METHODS, 'providers.setKey', 'providers.clearKey', 'providers.check', 'providers.saveCustom', 'providers.deleteCustom'];
const custom = (patch: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: 'custom-kimi', label: 'Kimi', available: true, family: 'claude', needs: null, keyHint: '••••a1b2', version: '2.1.303', limits: null,
  custom: {
    preset: 'kimi', baseUrl: 'https://api.moonshot.ai/anthropic', auth: 'bearer',
    models: { opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' },
    contextWindow: 1_000_000, linkClaude: true, folder: '/Users/me/.parley/providers/custom-kimi',
  },
  ...patch,
});
let bridge: ReturnType<typeof createFakeBridge>;
let reload: ReturnType<typeof vi.fn>;
const setHost = (methods: string[]): void =>
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.4.0', methods }, connections: 1 });
beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  reload = vi.fn(async () => {});
  useProvidersStore.setState({ providers: [custom()], reload } as never);
  setHost(METHODS);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useHostStore.setState({ status: { state: 'connecting' } });
});

const field = (name: string): HTMLInputElement => screen.getByLabelText(name) as HTMLInputElement;

describe('CustomProviderPanel: новый провайдер', () => {
  it('плитки Kimi, MiniMax, Qwen, DeepSeek, OpenRouter, Own address; Kimi подставляет адрес и модели', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    const tiles = screen.getAllByRole('button').map((button) => button.textContent ?? '');
    for (const name of ['Kimi', 'MiniMax', 'Qwen', 'DeepSeek', 'OpenRouter', 'Own address'])
      expect(tiles.some((text) => text.startsWith(name))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Kimi/ }));
    expect(field(S.customProviders.nameField).value).toBe('Kimi');
    expect(field(S.customProviders.addressField).value).toBe('https://api.moonshot.ai/anthropic');
    expect(field(S.customProviders.slotSonnet).value).toBe('kimi-k3[1m]');
  });

  it('Save: saveCustom → setKey (если ключ введён) → onSaved(id); ключ в параметры saveCustom не попадает', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-kimi' }));
    bridge.setHandler('providers.setKey', () => ({ keyHint: '••••a1b2' }));
    const onSaved = vi.fn();
    render(<CustomProviderPanel providerId="new" onSaved={onSaved} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Kimi/ }));
    fireEvent.change(field(S.customProviders.keyField), { target: { value: 'sk-secret-a1b2' } });
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.save }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('custom-kimi'));
    expect(bridge.calls.map((call) => call.method)).toEqual(['providers.saveCustom', 'providers.setKey']);
    expect(JSON.stringify(bridge.calls[0]!.params)).not.toContain('sk-secret');
    expect(bridge.calls[1]!.params).toEqual({ provider: 'custom-kimi', key: 'sk-secret-a1b2' });
    expect(reload).toHaveBeenCalled();
  });

  it('ошибка хоста — текстом под формой, ключ в тексте не появляется', async () => {
    bridge.setHandler('providers.saveCustom', () => {
      throw encodeIpcError({ code: 'bad_request', message: 'bad key sk-secret-a1b2' });
    });
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Kimi/ }));
    fireEvent.change(field(S.customProviders.keyField), { target: { value: 'sk-secret-a1b2' } });
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.save }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('save the provider');
    expect(document.body.textContent).not.toContain('sk-secret');
  });

  it('Save недоступен, пока в черновике есть ошибка (нет ключа)', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Kimi/ }));
    expect((screen.getByRole('button', { name: S.customProviders.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('галочка «Bring from Claude Code» включена и показывает подпись про ссылки', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Own address/ }));
    expect(screen.getByRole('checkbox', { name: S.customProviders.linkClaude }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(S.customProviders.linkClaudeNote)).toBeTruthy();
  });

  it('One model for all slots: показывает одно поле', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Own address/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: S.customProviders.oneModel }));
    expect(screen.queryByLabelText(S.customProviders.slotOpus)).toBeNull();
    expect(screen.getByLabelText(S.customProviders.oneModelField)).toBeTruthy();
  });
});

describe('CustomProviderPanel: существующий провайдер', () => {
  it('показывает папку провайдера и ключ маской с Replace/Remove', () => {
    render(<CustomProviderPanel providerId="custom-kimi" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByText(/\/Users\/me\/\.parley\/providers\/custom-kimi/)).toBeTruthy();
    expect(screen.getByText('Key ••••a1b2')).toBeTruthy();
    expect(screen.getByRole('button', { name: S.customProviders.replace })).toBeTruthy();
    expect(screen.getByRole('button', { name: S.customProviders.remove })).toBeTruthy();
  });

  it('Check зовёт providers.check и показывает CheckLine', async () => {
    bridge.setHandler('providers.check', () => ({
      check: { state: 'failed', reason: 'authentication', httpStatus: 401, at: '2026-10-19T09:30:00.000Z' },
    }) as Result<'providers.check'>);
    render(<CustomProviderPanel providerId="custom-kimi" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.check }));
    expect(await screen.findByText(S.customProviders.checkHint.authentication)).toBeTruthy();
    expect(bridge.calls[0]).toMatchObject({ method: 'providers.check', params: { provider: 'custom-kimi' } });
  });

  it('Delete спрашивает подтверждение; «also delete folder» выключен по умолчанию (К6)', async () => {
    bridge.setHandler('providers.deleteCustom', () => ({ ok: true }));
    const onDeleted = vi.fn();
    render(<CustomProviderPanel providerId="custom-kimi" onSaved={vi.fn()} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.deleteProvider }));
    expect(bridge.calls).toHaveLength(0);
    const folder = screen.getByRole('checkbox', { name: S.customProviders.deleteFolder });
    expect(folder.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.deleteConfirmButton }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(bridge.calls[0]).toMatchObject({ method: 'providers.deleteCustom', params: { id: 'custom-kimi', removeFolder: false } });
  });
});

describe('CustomProviderPanel: старый хост', () => {
  it('без providers.saveCustom форма недоступна и говорит перезапустить хост', () => {
    setHost(REQUIRED_METHODS as string[]);
    const confirm = vi.spyOn(useUiStore.getState(), 'confirmRestartHost');
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByText(S.customProviders.restartRequired)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Kimi/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.restartHost }));
    expect(confirm).toHaveBeenCalled();
  });
});
