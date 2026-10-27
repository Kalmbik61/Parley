import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadResult } from '../../../shared/voice-types.js';
import { S } from '../../../shared/strings.js';
import { TTS_VOICES } from '../../../shared/tts-types.js';
import { DEFAULT_UI } from '../../../shared/ui-types.js';
import { createFakeBridge, type FakeBridge } from '../../test-utils/fake-bridge.js';
import { chooseOption, installRadixSelectPolyfills } from '../../test-utils/radix-select.js';
import { useUiStore } from '../../store/ui.js';
import { AssistantSettings } from './AssistantSettings.js';

installRadixSelectPolyfills();

let bridge: FakeBridge;
const saved: unknown[] = [];
const text = S.assistant.settings;

beforeEach(() => {
  bridge = createFakeBridge();
  window.parley = bridge;
  bridge.setHandler('providers.list', () => ({
    providers: [
      { id: 'claude', label: 'Claude Code', available: true, models: [{ id: 'haiku', label: 'Haiku' }] },
      { id: 'glm', label: 'GLM', available: true, models: null },
      { id: 'codex', label: 'Codex', available: true, models: [{ id: 'gpt-6-luna', label: 'GPT-6 Luna' }] },
      { id: 'other', label: 'Offline one', available: false },
    ],
  }));
  saved.length = 0;
  useUiStore.setState({
    ui: { ...DEFAULT_UI },
    uiLoaded: true,
    patchUi: (patch) => {
      saved.push(patch);
      useUiStore.setState((state) => ({ ui: { ...state.ui, assistant: { ...state.ui.assistant, ...patch.assistant } } }));
    },
  });
});
afterEach(() => cleanup());

describe('AssistantSettings (спека 2026-10-14, 6.1)', () => {
  it('переключатель включает помощника через patchUi', () => {
    render(<AssistantSettings />);
    fireEvent.click(screen.getByRole('switch', { name: text.enabled }));
    expect(saved).toEqual([{ assistant: { enabled: true } }]);
  });

  it('в списке провайдеров только подключённые, первым — «First connected»', async () => {
    render(<AssistantSettings />);
    const trigger = screen.getByRole('combobox', { name: text.provider });
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([text.providerAuto, 'Claude Code', 'GLM', 'Codex']);
  });

  it('выбор провайдера сбрасывает модель', async () => {
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    await chooseOption(screen.getByRole('combobox', { name: text.provider }), 'Codex');
    expect(saved).toEqual([{ assistant: { provider: 'codex', model: null } }]);
  });

  it('список моделей — из выбранного провайдера, первым «Fast default»', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, provider: 'codex' } } });
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.calls.some((call) => call.method === 'providers.list')).toBe(true));
    const trigger = screen.getByRole('combobox', { name: text.model });
    await waitFor(() => expect(trigger).toBeTruthy());
    // Список моделей наполняется после ответа providers.list: ждём пункт, а не только вызов.
    await waitFor(() => {
      fireEvent.keyDown(trigger, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([text.modelDefault, 'GPT-6 Luna']);
    });
  });

  it('язык: System первым, за ним English и Russian; выбор пишет код или null', async () => {
    render(<AssistantSettings />);
    const trigger = screen.getByRole('combobox', { name: text.language });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const names = (await screen.findAllByRole('option')).map((option) => option.textContent);
    expect(names.slice(0, 3)).toEqual([text.languageSystem, 'English', 'Russian']);
    fireEvent.keyDown(screen.getAllByRole('option')[0]!, { key: 'Escape' });
    await chooseOption(screen.getByRole('combobox', { name: text.language }), 'Ukrainian');
    await chooseOption(screen.getByRole('combobox', { name: text.language }), text.languageSystem);
    expect(saved).toEqual([{ assistant: { language: 'uk' } }, { assistant: { language: null } }]);
  });

  it('сочетание занято — видна причина', async () => {
    bridge.app.assistantShortcut = async () => ({ accelerator: 'Alt+Space', ok: false });
    render(<AssistantSettings />);
    await waitFor(() => expect(screen.getByText(text.shortcutTaken)).toBeTruthy());
  });

  it('сочетание: клик по полю и ⌥J пишут Alt+J через patchUi', () => {
    render(<AssistantSettings />);
    const field = screen.getByTestId('shortcut-field');
    fireEvent.click(field);
    expect(screen.getByText(text.shortcutRecording)).toBeTruthy();
    fireEvent.keyDown(field, { code: 'KeyJ', altKey: true });
    expect(saved).toEqual([{ assistant: { hotkey: 'Alt+J' } }]);
    expect(screen.getByTestId('shortcut-field').textContent).toBe('⌥J');
  });

  it('запись сочетания снимает глобальный хоткей и возвращает его: мост получает true, затем false', () => {
    render(<AssistantSettings />);
    const field = screen.getByTestId('shortcut-field');
    fireEvent.click(field);
    expect(bridge.assistantShortcutSuspended).toEqual([true]);
    fireEvent.keyDown(field, { code: 'KeyJ', altKey: true });
    expect(bridge.assistantShortcutSuspended).toEqual([true, false]);
  });

  it('у GLM видна подсказка про 13 секунд', () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, provider: 'glm' } } });
    render(<AssistantSettings />);
    expect(screen.getByText(text.glmSlow)).toBeTruthy();
  });

  it('подсказка про Claude Desktop: Alt+Space и Option+Space видна, Ctrl+Shift+J нет', () => {
    const withHotkey = (hotkey: string): void =>
      useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, hotkey } } });
    withHotkey('alt + SPACE');
    const first = render(<AssistantSettings />);
    expect(screen.getByText(text.shortcutClaudeDesktop)).toBeTruthy();
    first.unmount();
    withHotkey('Option+Space');
    const second = render(<AssistantSettings />);
    expect(screen.getByText(text.shortcutClaudeDesktop)).toBeTruthy();
    second.unmount();
    withHotkey('Ctrl+Shift+J');
    render(<AssistantSettings />);
    expect(screen.queryByText(text.shortcutClaudeDesktop)).toBeNull();
  });
});

describe('AssistantSettings: голос (план 3b, B20; #9 §6.8)', () => {
  /** Скачивание, которое тест завершает сам: пока промис висит, идёт загрузка. */
  const pendingDownload = (): { finish: (result: DownloadResult) => void } => {
    let finish: (result: DownloadResult) => void = () => undefined;
    bridge.app.assistantVoiceDownload = () => {
      bridge.assistantVoiceCalls.push('download');
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    return { finish: (result) => finish(result) };
  };
  const modelRow = (): HTMLElement => document.querySelector<HTMLElement>('[data-assistant-voice-model]')!;

  it('«Speak answers» пишет assistant.speak через patchUi', () => {
    render(<AssistantSettings />);
    fireEvent.click(screen.getByRole('switch', { name: text.speak }));
    expect(saved).toEqual([{ assistant: { speak: true } }]);
  });

  it('G4: у голосов видны род, языки и лицензия; на чистой установке выбрана Serena; выбор пишет id голоса', async () => {
    render(<AssistantSettings />);
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBe(5));
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label'))).toEqual(['Serena', 'Ryan', 'Aiden', 'Vivian', 'Ono Anna']);
    expect((screen.getByRole('radio', { name: 'Serena' }) as HTMLInputElement).checked).toBe(true);
    const serena = document.querySelector('[data-assistant-voice="qwen3-0.6b/serena"]')!;
    expect(serena.textContent).toContain(text.voiceDetails(text.voiceGender.female, 'Russian, English', 'Apache-2.0'));
    const ryan = document.querySelector('[data-assistant-voice="qwen3-0.6b/ryan"]')!;
    expect(ryan.textContent).toContain(text.voiceGender.male);
    fireEvent.click(screen.getByRole('radio', { name: 'Ryan' }));
    expect(saved).toEqual([{ assistant: { voice: 'qwen3-0.6b/ryan' } }]);
    expect(screen.getByText(text.voiceCredit)).toBeTruthy();
  });

  it('язык без голоса (uk): голосов нет, видна строка, что ответы будут текстом', async () => {
    useUiStore.setState({ ui: { ...DEFAULT_UI, assistant: { ...DEFAULT_UI.assistant, language: 'uk' } } });
    render(<AssistantSettings />);
    await waitFor(() => expect(screen.getByText(text.voiceNoLanguage)).toBeTruthy());
    expect(screen.queryAllByRole('radio')).toEqual([]);
  });

  it('голос недоступен (x64, сбой движка): видна строка, Download не нажимается', async () => {
    bridge.setAssistantVoiceState({ state: 'unavailable', reason: 'the voice engine needs Apple Silicon' });
    bridge.app.assistantVoices = async () => TTS_VOICES.map((voice) => ({ ...voice, downloaded: false }));
    render(<AssistantSettings />);
    await waitFor(() => expect(screen.getByText(text.voiceUnavailable)).toBeTruthy());
    expect((within(modelRow()).getByRole('button', { name: S.voice.settings.download }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('G3: без весов — кнопка Download с размером 1214 MB, само ничего не качается', async () => {
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.assistantVoiceCalls).toContain('voices'));
    expect(modelRow().textContent).toContain(S.voice.settings.sizeMb(1214));
    expect(within(modelRow()).getByRole('button', { name: S.voice.settings.download })).toBeTruthy();
    expect(bridge.assistantVoiceCalls).not.toContain('download');
  });

  it('E5, Download: кнопка качает веса, виден прогресс, затем «Preparing voice…» до ready', async () => {
    const download = pendingDownload();
    render(<AssistantSettings />);
    fireEvent.click(within(modelRow()).getByRole('button', { name: S.voice.settings.download }));
    expect(bridge.assistantVoiceCalls).toContain('download');
    act(() => bridge.emitAssistantVoiceProgress({ id: 'qwen3-tts-0.6b-q8_0', receivedBytes: 606_767_232, totalBytes: 1_213_534_464 }));
    expect(modelRow().textContent).toContain(S.voice.settings.progress(606_767_232, 1_213_534_464));
    await act(async () => {
      bridge.setAssistantVoiceState({ state: 'warming' });
      download.finish({ ok: true });
    });
    await waitFor(() => expect(modelRow().textContent).toContain(text.voicePreparing));
    expect(within(modelRow()).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy();
    act(() => bridge.setAssistantVoiceState({ state: 'ready' }));
    await waitFor(() => expect(modelRow().textContent).not.toContain(text.voicePreparing));
  });

  it('D5, Cancel: во время скачивания кнопка Cancel отменяет его, голос остаётся нескачанным', async () => {
    const download = pendingDownload();
    render(<AssistantSettings />);
    fireEvent.click(within(modelRow()).getByRole('button', { name: S.voice.settings.download }));
    await act(async () => {
      fireEvent.click(within(modelRow()).getByRole('button', { name: S.voice.settings.cancel }));
    });
    expect(bridge.assistantVoiceCalls).toContain('cancel');
    await act(async () => download.finish({ error: 'cancelled' }));
    expect(within(modelRow()).getByRole('button', { name: S.voice.settings.download })).toBeTruthy();
  });

  it('D5, Delete: скачанные веса удаляются, голоса снова не скачаны, само ничего не качается', async () => {
    bridge.setAssistantVoiceState({ state: 'ready' });
    bridge.app.assistantVoiceRemove = async () => {
      bridge.assistantVoiceCalls.push('remove');
      bridge.setAssistantVoiceState({ state: 'not-downloaded' });
    };
    render(<AssistantSettings />);
    const remove = await within(modelRow()).findByRole('button', { name: S.voice.settings.remove });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(bridge.assistantVoiceCalls).toContain('remove');
    await waitFor(() => expect(within(modelRow()).getByRole('button', { name: S.voice.settings.download })).toBeTruthy());
    expect(bridge.assistantVoiceCalls).not.toContain('download');
  });
});
