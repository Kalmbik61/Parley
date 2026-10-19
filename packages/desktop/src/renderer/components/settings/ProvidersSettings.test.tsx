/** Пилюли Settings → Providers (спека своих провайдеров, 4.2): клавиатура, имена, статус. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { REQUIRED_METHODS } from '../../lib/capabilities.js';
import { createFakeBridge } from '../../test-utils/fake-bridge.js';
import { useHostStore } from '../../store/host.js';
import { useProvidersStore, type ProviderInfo } from '../../store/providers.js';
import { ProvidersSettings } from './ProvidersSettings.js';

const base = (id: string, label: string, available: boolean): ProviderInfo =>
  ({ id, label, available, family: 'claude', needs: null, keyHint: null, version: null, limits: null }) as ProviderInfo;

beforeEach(() => {
  window.parley = createFakeBridge();
  useProvidersStore.setState({
    providers: [base('claude', 'Claude Code', true), base('codex', 'Codex', false), base('glm', 'GLM', true)],
    reload: vi.fn(async () => {}),
  } as never);
  useHostStore.setState({ status: { state: 'connected', hostVersion: '0.4.0', methods: [...REQUIRED_METHODS, 'providers.saveCustom'] }, connections: 1 });
});
afterEach(() => {
  cleanup();
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
