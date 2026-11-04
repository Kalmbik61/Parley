import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../../shared/strings.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { useUiStore } from '../../store/ui.js';
import { VoiceProviderSection } from './VoiceProviderSection.js';

const TEXT = S.settings.voiceProvider;
let bridge: FakeBridge;

function settings(locked: Record<string, string>): never {
  return { config: { voiceDailyMinutes: 30 }, locked } as never;
}

beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  bridge.setHandler('voiceProvider.get', () => ({ keySet: false, secretHint: null }));
  useUiStore.setState({ ui: { ...DEFAULT_UI }, uiLoaded: true });
});
afterEach(() => cleanup());

const setCalls = (): unknown[] => bridge.calls.filter((call) => call.method === 'settings.set');

describe('VoiceProviderSection', () => {
  it('дневной лимит: на blur сохраняется только изменённое значение', async () => {
    bridge.setHandler('settings.get', () => settings({}));
    bridge.setHandler('settings.set', () => ({}) as never);
    render(<VoiceProviderSection />);
    const field = (await screen.findByTestId('voice-provider-minutes')) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('30'));
    fireEvent.blur(field);
    expect(setCalls()).toHaveLength(0);
    fireEvent.change(field, { target: { value: '45' } });
    fireEvent.blur(field);
    await waitFor(() => expect(setCalls()).toHaveLength(1));
    fireEvent.blur(field);
    expect(setCalls()).toHaveLength(1);
  });

  it('дневной лимит заблокирован env-оверрайдом — поле отключено', async () => {
    bridge.setHandler('settings.get', () => settings({ voiceDailyMinutes: 'PARLEY_VOICE_DAILY_MINUTES' }));
    render(<VoiceProviderSection />);
    const field = (await screen.findByTestId('voice-provider-minutes')) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe('30'));
    expect(field.disabled).toBe(true);
  });

  it('сбой чтения настроек — своя строка, не «could not save»', async () => {
    bridge.setHandler('settings.get', () => {
      throw new Error('boom');
    });
    render(<VoiceProviderSection />);
    expect(await screen.findByText(TEXT.loadError)).toBeTruthy();
    expect(screen.queryByText(TEXT.saveError)).toBeNull();
  });
});
