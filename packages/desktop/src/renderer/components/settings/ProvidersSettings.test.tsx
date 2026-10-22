/** Пилюли Settings → Providers (спека своих провайдеров, 4.2): клавиатура, имена, статус. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore, type ProviderInfo } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { xtermMock } from '../../test-utils/xterm-mock.js';
import { ProvidersSettings } from './ProvidersSettings.js';

vi.mock('@xterm/xterm', async () => (await import('../../test-utils/xterm-mock.js')).xtermModule);
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

const base = (id: string, label: string, available: boolean): ProviderInfo =>
  ({ id, label, available, family: 'claude', needs: null, keyHint: null, version: null, limits: null }) as ProviderInfo;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  xtermMock.reset();
  useUiStore.setState({ settingsProvider: null, settingsSignIn: false });
  const bridge = createFakeBridge();
  bridge.setHandler('providers.signInResize', () => ({ ok: true }));
  window.parley = bridge;
  useProvidersStore.setState({
    providers: [base('claude', 'Claude Code', true), base('codex', 'Codex', false), base('glm', 'GLM', true)],
    reload: vi.fn(async () => {}),
  } as never);
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.4.0', methods: [...REQUIRED_METHODS, 'providers.saveCustom'] }, connections: 1 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useHostStore.setState({ status: { state: 'connecting' } });
});

const radios = (): HTMLElement[] => screen.getAllByRole('radio');

describe('ProvidersSettings: пилюли', () => {
  it('в порядке Tab стоит одна пилюля — выбранная', () => {
    render(<ProvidersSettings />);
    expect(radios().map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
  });

  it('стрелки переносят фокус и выбор на соседнюю пилюлю', () => {
    render(<ProvidersSettings />);
    radios()[0]!.focus();
    fireEvent.keyDown(radios()[0]!, { key: 'ArrowRight' });
    expect(radios()[1]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios()[1]);
  });

  it('имя пилюли GLM не содержит букву значка', () => {
    render(<ProvidersSettings />);
    expect(screen.getByRole('radio', { name: 'GLM' })).toBeTruthy();
  });

  it('подключённая пилюля с точкой, «+ Add provider» с пунктирной рамкой', () => {
    render(<ProvidersSettings />);
    expect(screen.getByRole('radio', { name: 'GLM' }).querySelector('[data-connected-dot]')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Codex' }).querySelector('[data-connected-dot]')).toBeNull();
    expect(document.querySelector('[data-provider-pill="new"]')!.className).toContain('border-dashed');
  });
});

describe('ProvidersSettings: аккаунты подписки (спека подписок 4.1, 10)', () => {
  const account = (signingIn = false): ProviderInfo =>
    ({
      ...base('custom-claude-2', 'Claude Code 2', false), needs: 'sign-in',
      custom: { kind: 'claude-account', link: true, folder: '/h/.parley/providers/custom-claude-2', signedIn: false, signingIn },
    }) as ProviderInfo;
  const withAccount = (signingIn = false): void => {
    const { providers } = useProvidersStore.getState();
    useProvidersStore.setState({ providers: [...providers, account(signingIn)] });
  };

  it('аккаунт — пилюля после трёх основных, значок Claude, имя хоста', () => {
    withAccount();
    render(<ProvidersSettings />);
    expect(radios().map((radio) => radio.getAttribute('data-provider-pill'))).toEqual(['claude', 'codex', 'glm', 'custom-claude-2', 'new']);
    const pill = screen.getByRole('radio', { name: 'Claude Code 2' });
    expect(pill.querySelector('img')?.getAttribute('src')).toMatch(/claude\.svg$/);
  });

  it('клик по пилюле аккаунта открывает его форму', () => {
    withAccount();
    render(<ProvidersSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Claude Code 2' }));
    expect(document.querySelector('[data-account-form="custom-claude-2"]')).toBeTruthy();
    expect(document.querySelector('[data-custom-provider-missing]')).toBeNull();
  });

  it('Settings открыты посреди входа: выбран этот аккаунт, терминал виден сразу', () => {
    withAccount(true);
    useProvidersStore.setState({ signInOutput: { 'custom-claude-2': 'Open https://example.test\r\n' } });
    render(<ProvidersSettings />);
    expect(screen.getByRole('radio', { name: 'Claude Code 2' }).getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-sign-in-terminal]')).toBeTruthy();
    expect(xtermMock.terminals[0]!.writes).toEqual(['Open https://example.test\r\n']);
  });

  it('Settings просили открыться на другом провайдере — вход не перехватывает выбор', () => {
    withAccount(true);
    useUiStore.setState({ settingsProvider: 'glm' });
    render(<ProvidersSettings />);
    expect(screen.getByRole('radio', { name: 'GLM' }).getAttribute('aria-checked')).toBe('true');
  });
});
