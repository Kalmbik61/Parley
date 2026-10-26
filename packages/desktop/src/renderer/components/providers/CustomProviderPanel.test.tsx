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
import { ACCOUNT_TILES } from './custom-presets.js';

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
    expect(screen.getByRole('button', { name: /^Kimi/ }).querySelector('img')?.getAttribute('src')).toMatch(/kimi\.svg$/);
    expect(screen.getByRole('button', { name: /^Own address/ }).querySelector('img')?.getAttribute('src')).toMatch(/parley\.svg$/);
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

describe('CustomProviderPanel: правки ревью задач 10–12', () => {
  const loopback = (): ProviderInfo =>
    custom({
      id: 'custom-local', label: 'Local', keyHint: null, available: true,
      custom: { ...custom().custom!, preset: null, baseUrl: 'http://localhost:8080', folder: '/Users/me/.parley/providers/custom-local' },
    });

  it('адрес на localhost без ключа: Check доступна и показывает ответ', async () => {
    useProvidersStore.setState({ providers: [loopback()], reload } as never);
    bridge.setHandler('providers.check', () => ({
      check: { state: 'ok', at: '2026-10-19T09:30:00.000Z' },
    }) as Result<'providers.check'>);
    render(<CustomProviderPanel providerId="custom-local" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    const button = screen.getByRole('button', { name: S.customProviders.check }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(bridge.calls[0]).toMatchObject({ method: 'providers.check', params: { provider: 'custom-local' } }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Test request OK');
  });

  it('https-адрес без ключа: Check по-прежнему недоступна', () => {
    useProvidersStore.setState({ providers: [custom({ keyHint: null })], reload } as never);
    render(<CustomProviderPanel providerId="custom-kimi" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect((screen.getByRole('button', { name: S.customProviders.check }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('хост не подключён: нейтральная строка, а не «хост слишком старый»', () => {
    useHostStore.setState({ status: { state: 'connecting' } });
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(screen.getByText(S.customProviders.hostNotConnected)).toBeTruthy();
    expect(screen.queryByText(S.customProviders.restartRequired)).toBeNull();
    expect(screen.queryByRole('button', { name: S.customProviders.restartHost })).toBeNull();
  });

  it('смена плана/региона заменяет адрес, модели и окно контекста', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Qwen/ }));
    expect(field(S.customProviders.addressField).value).toContain('coding-intl.dashscope');
    fireEvent.change(screen.getByLabelText(S.customProviders.endpointField), { target: { value: 'token-plan' } });
    expect(field(S.customProviders.addressField).value).toContain('token-plan.ap-southeast-1');
    expect(field(S.customProviders.slotOpus).value).toBe('qwen3.8-max');
    expect(field(S.customProviders.slotHaiku).value).toBe('qwen3.6-flash');
  });

  it('у своего адреса выбор способа отправки ключа меняет auth в saveCustom', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-own' }));
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Own address/ }));
    fireEvent.change(field(S.customProviders.nameField), { target: { value: 'Own' } });
    fireEvent.change(field(S.customProviders.addressField), { target: { value: 'http://localhost:9000' } });
    fireEvent.change(screen.getByLabelText(S.customProviders.authField), { target: { value: 'api-key' } });
    fireEvent.click(screen.getByRole('checkbox', { name: S.customProviders.oneModel }));
    fireEvent.change(screen.getByLabelText(S.customProviders.oneModelField), { target: { value: 'm1' } });
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.save }));
    await waitFor(() => expect(bridge.calls[0]).toMatchObject({ method: 'providers.saveCustom', params: { auth: 'api-key' } }));
  });

  it('после удачного Save поле ключа пусто', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-kimi' }));
    bridge.setHandler('providers.setKey', () => ({ keyHint: '••••a1b2' }));
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Kimi/ }));
    fireEvent.change(field(S.customProviders.keyField), { target: { value: 'sk-secret-a1b2' } });
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.save }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    await waitFor(() => expect(field(S.customProviders.keyField).value).toBe(''));
  });

  it('сбой setKey после saveCustom: повторный Save не создаёт дубль (id уже известен)', async () => {
    let first = true;
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-kimi' }));
    bridge.setHandler('providers.setKey', () => {
      if (first) {
        first = false;
        throw encodeIpcError({ code: 'internal', message: 'boom sk-secret-a1b2' });
      }
      return { keyHint: '••••a1b2' };
    });
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Kimi/ }));
    fireEvent.change(field(S.customProviders.keyField), { target: { value: 'sk-secret-a1b2' } });
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.save }));
    expect((await screen.findByRole('alert')).textContent).toContain('save the key');
    expect(field(S.customProviders.keyField).value).toBe('sk-secret-a1b2');
    fireEvent.click(screen.getByRole('button', { name: S.customProviders.save }));
    await waitFor(() => expect(bridge.calls.filter((call) => call.method === 'providers.saveCustom')).toHaveLength(2));
    expect(bridge.calls.filter((call) => call.method === 'providers.saveCustom').map((call) => (call.params as { id: string | null }).id)).toEqual([null, 'custom-kimi']);
  });

  it('плитка «Own address» и вендора несёт значок Parley', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    for (const tile of document.querySelectorAll('[data-vendor-tile]')) expect(tile.querySelector('[data-agent-icon]')).not.toBeNull();
  });
});


describe('CustomProviderPanel: аккаунты подписки (спека подписок 4.1)', () => {
  const accountRow = (patch: Partial<ProviderInfo> = {}): ProviderInfo =>
    ({
      id: 'custom-claude-2', label: 'Claude Code 2', available: false, family: 'claude', needs: 'sign-in', version: '2.1.306', limits: null,
      custom: { kind: 'claude-account', link: true, folder: '/Users/me/.parley/providers/custom-claude-2', signedIn: false, signingIn: false },
      ...patch,
    }) as ProviderInfo;
  const tiles = (): string[] => [...document.querySelectorAll('[data-vendor-tile]')].map((el) => el.getAttribute('data-vendor-tile')!);

  beforeEach(() => setHost([...METHODS, 'providers.signIn']));

  it('ACCOUNT_TILES: Claude Code и Codex, строка про подписку; Codex до этапа 3 — comingSoon', () => {
    expect(ACCOUNT_TILES.map((tile) => tile.id)).toEqual(['claude-account', 'codex-account']);
    expect(ACCOUNT_TILES[0]).toMatchObject({ label: 'Another Claude Code account', billing: 'Your own subscription, signed in from Parley' });
    expect(ACCOUNT_TILES[0]!.comingSoon).toBeUndefined();
    expect(ACCOUNT_TILES[1]).toMatchObject({ label: 'Another Codex account', comingSoon: true });
  });

  it('две плитки аккаунтов стоят первыми, дальше вендоры и «Own address»', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(tiles()).toEqual(['claude-account', 'codex-account', 'kimi', 'minimax', 'qwen', 'deepseek', 'openrouter', 'own']);
    const claude = document.querySelector('[data-vendor-tile="claude-account"]')!;
    expect(claude.textContent).toContain('Another Claude Code account');
    expect(claude.textContent).toContain('Your own subscription, signed in from Parley');
  });

  it('плитка Codex есть, но неактивна и говорит «Coming soon»', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    const codex = document.querySelector('[data-vendor-tile="codex-account"]') as HTMLButtonElement;
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain('Another Codex account');
    expect(codex.textContent).toContain(S.accounts.comingSoon);
    fireEvent.click(codex);
    expect(document.querySelector('[data-account-form]')).toBeNull();
  });

  it('плитка Claude Code открывает форму аккаунта вместо формы адреса', () => {
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(document.querySelector('[data-vendor-tile="claude-account"]')!);
    expect(document.querySelector('[data-account-form="new"]')).toBeTruthy();
    expect(screen.queryByLabelText(S.customProviders.addressField)).toBeNull();
    expect((screen.getByLabelText(S.accounts.nameField) as HTMLInputElement).placeholder).toBe('Claude Code 2');
  });

  it('хост без providers.signIn (старый): плитка неактивна и просит перезапуск', () => {
    setHost(METHODS);
    render(<CustomProviderPanel providerId="new" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    const claude = document.querySelector('[data-vendor-tile="claude-account"]') as HTMLButtonElement;
    expect(claude.disabled).toBe(true);
    expect(claude.textContent).toContain(S.accounts.needsRestart);
  });

  it('сохранённый аккаунт показывает форму аккаунта, а не форму адреса', () => {
    useProvidersStore.setState({ providers: [accountRow()], reload } as never);
    render(<CustomProviderPanel providerId="custom-claude-2" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(document.querySelector('[data-account-form="custom-claude-2"]')).toBeTruthy();
    expect(screen.queryByLabelText(S.customProviders.addressField)).toBeNull();
    expect(document.querySelector('[data-custom-provider-missing]')).toBeNull();
  });

  it('Save нового аккаунта: onSaved(id) родителя', async () => {
    bridge.setHandler('providers.saveCustom', () => ({ id: 'custom-claude-2' }));
    const onSaved = vi.fn();
    render(<CustomProviderPanel providerId="new" onSaved={onSaved} onDeleted={vi.fn()} />);
    fireEvent.click(document.querySelector('[data-vendor-tile="claude-account"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('custom-claude-2'));
  });

  it('запись своего провайдера без kind (хост до подписок) по-прежнему открывается формой адреса', () => {
    render(<CustomProviderPanel providerId="custom-kimi" onSaved={vi.fn()} onDeleted={vi.fn()} />);
    expect(document.querySelector('[data-custom-provider-form="custom-kimi"]')).toBeTruthy();
    expect(document.querySelector('[data-account-form]')).toBeNull();
  });
});
