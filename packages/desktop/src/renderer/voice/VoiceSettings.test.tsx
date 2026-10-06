import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S } from '../../shared/strings.js';
import { DEFAULT_UI } from '../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../test-utils/fake-bridge.js';
import { useUiStore } from '../store/ui.js';
import { useDownloadsStore } from './downloads-store.js';
import { VoiceSettings } from './VoiceSettings.js';

let bridge: FakeBridge;
let unbind: () => void = () => undefined;
const saved: unknown[] = [];

beforeEach(() => {
  bridge = createFakeBridge();
  unbind = useDownloadsStore.getState().bind(bridge.voice);
  saved.length = 0;
  useUiStore.setState({
    ui: { ...DEFAULT_UI },
    uiLoaded: true,
    patchUi: (patch) => {
      saved.push(patch);
      useUiStore.setState((state) => ({ ui: { ...state.ui, ...patch } }));
    },
  });
});
afterEach(() => {
  cleanup();
  unbind();
});

/** Строка модели: название и размер стоят в одном узле, поэтому ищем по `data-voice-model`, а не по тексту. */
const row = (id: string): HTMLElement => document.querySelector(`[data-voice-model="${id}"]`) as HTMLElement;

describe('VoiceSettings (спека 3.1, 6.2)', () => {
  it('без модели переключатель недоступен и есть подсказка', async () => {
    render(<VoiceSettings />);
    await waitFor(() => expect(screen.getByText(S.voice.settings.downloadFirst)).toBeTruthy());
    expect((screen.getByRole('switch', { name: S.voice.settings.enable }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Download → модель в списке, выбрана; переключатель включается', async () => {
    render(<VoiceSettings />);
    fireEvent.click(within(row('base')).getByRole('button', { name: S.voice.settings.download }));
    await waitFor(() => expect(within(row('base')).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    expect(useUiStore.getState().ui.voice.model).toBe('base');
    const toggle = screen.getByRole('switch', { name: S.voice.settings.enable }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    expect(useUiStore.getState().ui.voice.enabled).toBe(true);
  });

  it('Delete выбранной модели — выбор на другую скачанную; последней — голос выключен', async () => {
    bridge.setVoiceModels(['base', 'small']);
    useUiStore.setState({ ui: { ...DEFAULT_UI, voice: { enabled: true, model: 'base', language: 'auto' } } });
    render(<VoiceSettings />);
    await waitFor(() => expect(within(row('base')).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    fireEvent.click(within(row('base')).getByRole('button', { name: S.voice.settings.remove }));
    await waitFor(() => expect(useUiStore.getState().ui.voice).toMatchObject({ model: 'small', enabled: true }));
    fireEvent.click(within(row('small')).getByRole('button', { name: S.voice.settings.remove }));
    await waitFor(() => expect(useUiStore.getState().ui.voice).toMatchObject({ model: null, enabled: false }));
  });

  it('скачивание переживает размонтирование вкладки: Cancel виден снова, по завершении — Delete без перемонтирования', async () => {
    let finish: (() => void) | null = null;
    bridge.voice.downloadModel = (id) =>
      new Promise((resolve) => {
        finish = () => {
          bridge.setVoiceModels([id]);
          resolve({ ok: true });
        };
      });
    const first = render(<VoiceSettings />);
    fireEvent.click(within(row('base')).getByRole('button', { name: S.voice.settings.download }));
    await waitFor(() => expect(within(row('base')).getByRole('button', { name: S.voice.settings.cancel })).toBeTruthy());
    first.unmount();
    render(<VoiceSettings />);
    expect(within(row('base')).getByRole('button', { name: S.voice.settings.cancel })).toBeTruthy();
    finish?.();
    await waitFor(() => expect(within(row('base')).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    expect(useUiStore.getState().ui.voice.model).toBe('base');
  });

  it('прогресс скачивания виден в строке модели', async () => {
    render(<VoiceSettings />);
    // 243_800_984 — первая половина модели «small» целиком: `S.voice.settings.progress` округляет проценты вниз.
    bridge.emitVoiceProgress({ id: 'small', receivedBytes: 243_800_984, totalBytes: 487_601_967 });
    await waitFor(() => expect(within(row('small')).getByText(/^50% · 244 of 488 MB$/)).toBeTruthy());
  });
});
