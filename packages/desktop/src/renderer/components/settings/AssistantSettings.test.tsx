import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DownloadResult } from '../../../shared/voice-types.js';
import { S } from '../../../shared/strings.js';
import { TTS_MODELS, TTS_VOICES, type TtsModelId } from '../../../shared/tts-types.js';
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
  const SMALL: TtsModelId = 'qwen3-tts-0.6b-q8_0';
  const LARGE: TtsModelId = 'qwen3-tts-1.7b-q8_0';
  /** Скачивание, которое тест завершает сам: пока промис висит, идёт загрузка этой модели. */
  const pendingDownload = (): { finish: (id: TtsModelId, result: DownloadResult) => void } => {
    const finishers = new Map<TtsModelId, (result: DownloadResult) => void>();
    bridge.app.assistantVoiceDownload = (id) => {
      bridge.assistantVoiceCalls.push(`download:${id}`);
      return new Promise((resolve) => {
        finishers.set(id, resolve);
      });
    };
    return { finish: (id, result) => finishers.get(id)?.(result) };
  };
  const modelRow = (id: TtsModelId): HTMLElement => document.querySelector<HTMLElement>(`[data-assistant-voice-model="${id}"]`)!;
  const progressOf = (id: TtsModelId, received: number): { id: TtsModelId; receivedBytes: number; totalBytes: number } => ({
    id,
    receivedBytes: received,
    totalBytes: TTS_MODELS.find((model) => model.id === id)!.bytes,
  });

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

  it('голос недоступен (x64, сбой движка): видна строка, у обеих моделей Download не нажимается', async () => {
    bridge.setAssistantVoiceState({ state: 'unavailable', reason: 'the voice engine needs Apple Silicon' });
    bridge.app.assistantVoices = async () => TTS_VOICES.map((voice) => ({ ...voice, downloaded: false }));
    render(<AssistantSettings />);
    await waitFor(() => expect(screen.getByText(text.voiceUnavailable)).toBeTruthy());
    for (const { id } of TTS_MODELS) {
      expect((within(modelRow(id)).getByRole('button', { name: S.voice.settings.download }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('по строке на каждую модель каталога: имя и размер (1214 и 2288 MB), у каждой своя кнопка Download', async () => {
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.assistantVoiceCalls).toContain('models'));
    expect(document.querySelectorAll('[data-assistant-voice-model]')).toHaveLength(2);
    expect(modelRow(SMALL).textContent).toContain(`${text.voiceModels[SMALL]} · ${S.voice.settings.sizeMb(1214)}`);
    expect(modelRow(LARGE).textContent).toContain(`${text.voiceModels[LARGE]} · ${S.voice.settings.sizeMb(2288)}`);
    expect(text.voiceModels[SMALL]).toBe('Qwen3-TTS 0.6B CustomVoice');
    expect(text.voiceModels[LARGE]).toBe('Qwen3-TTS 1.7B CustomVoice');
    for (const { id } of TTS_MODELS) {
      expect(within(modelRow(id)).getByRole('button', { name: S.voice.settings.download })).toBeTruthy();
    }
  });

  it('G3: без весов — у обеих строк «One download for all voices.» и Download, само ничего не качается', async () => {
    render(<AssistantSettings />);
    await waitFor(() => expect(bridge.assistantVoiceCalls).toContain('voices'));
    for (const { id } of TTS_MODELS) {
      expect(modelRow(id).textContent).toContain(text.voiceModelHint);
      expect(modelRow(id).textContent).not.toContain(text.voiceModelInUse);
    }
    expect(bridge.assistantVoiceCalls.filter((call) => call.startsWith('download'))).toEqual([]);
  });

  it('E5, Download: кнопка строки качает именно её модель, прогресс виден только в этой строке', async () => {
    const download = pendingDownload();
    bridge.setAssistantVoiceModels([SMALL]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    render(<AssistantSettings />);
    fireEvent.click(await within(modelRow(LARGE)).findByRole('button', { name: S.voice.settings.download }));
    expect(bridge.assistantVoiceCalls.filter((call) => call.startsWith('download'))).toEqual([`download:${LARGE}`]);
    act(() => bridge.emitAssistantVoiceProgress(progressOf(LARGE, 1_143_890_176)));
    expect(modelRow(LARGE).textContent).toContain(S.voice.settings.progress(1_143_890_176, 2_287_780_352));
    expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.cancel })).toBeTruthy();
    expect(modelRow(SMALL).textContent).not.toContain('50%');
    expect(modelRow(SMALL).textContent).toContain(text.voiceModelInUse);
    expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy();
    // Скачивание кончилось: прогресс уходит, 1.7B становится активной.
    bridge.setAssistantVoiceModels([SMALL, LARGE]);
    await act(async () => download.finish(LARGE, { ok: true }));
    await waitFor(() => expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    expect(modelRow(LARGE).textContent).not.toContain('%');
  });

  it('событие состояния движка (ready) не стирает прогресс 1.7B, пока она качается при скачанной 0.6B', async () => {
    pendingDownload();
    bridge.setAssistantVoiceModels([SMALL]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    render(<AssistantSettings />);
    fireEvent.click(await within(modelRow(LARGE)).findByRole('button', { name: S.voice.settings.download }));
    act(() => bridge.emitAssistantVoiceProgress(progressOf(LARGE, 457_000_000)));
    const shown = S.voice.settings.progress(457_000_000, 2_287_780_352);
    expect(modelRow(LARGE).textContent).toContain(shown);
    const callsBefore = bridge.assistantVoiceCalls.filter((call) => call === 'models').length;
    act(() => bridge.setAssistantVoiceState({ state: 'ready' }));
    act(() => bridge.setAssistantVoiceState({ state: 'speaking' }));
    await waitFor(() => expect(bridge.assistantVoiceCalls.filter((call) => call === 'models').length).toBeGreaterThan(callsBefore));
    expect(modelRow(LARGE).textContent).toContain(shown);
    expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.cancel })).toBeTruthy();
  });

  it('E5: после скачивания единственной модели — «Preparing voice…» у активной строки до ready', async () => {
    const download = pendingDownload();
    render(<AssistantSettings />);
    fireEvent.click(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.download }));
    act(() => bridge.emitAssistantVoiceProgress(progressOf(SMALL, 606_767_232)));
    expect(modelRow(SMALL).textContent).toContain(S.voice.settings.progress(606_767_232, 1_213_534_464));
    bridge.setAssistantVoiceModels([SMALL]);
    await act(async () => {
      bridge.setAssistantVoiceState({ state: 'warming' });
      download.finish(SMALL, { ok: true });
    });
    await waitFor(() => expect(modelRow(SMALL).textContent).toContain(text.voicePreparing));
    expect(modelRow(LARGE).textContent).not.toContain(text.voicePreparing);
    expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy();
    act(() => bridge.setAssistantVoiceState({ state: 'ready' }));
    await waitFor(() => expect(modelRow(SMALL).textContent).not.toContain(text.voicePreparing));
    expect(modelRow(SMALL).textContent).toContain(text.voiceModelInUse);
  });

  it('прогресс скачивания, начатого до открытия настроек, кончается, когда модель появилась на диске', async () => {
    bridge.setAssistantVoiceModels([SMALL]);
    render(<AssistantSettings />);
    await waitFor(() => expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    act(() => bridge.emitAssistantVoiceProgress(progressOf(LARGE, 2_000_000_000)));
    expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.cancel })).toBeTruthy();
    bridge.setAssistantVoiceModels([SMALL, LARGE]);
    act(() => bridge.setAssistantVoiceState({ state: 'warming' }));
    await waitFor(() => expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    expect(modelRow(LARGE).textContent).not.toContain('%');
  });

  it('B1: заново открытые настройки, 0.6B докачалась при активной 1.7B — событие ready (то же состояние) стирает её прогресс и даёт Delete', async () => {
    bridge.setAssistantVoiceModels([LARGE]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    render(<AssistantSettings />);
    await waitFor(() => expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    // Скачивание началось в прошлом экземпляре окна: здесь нет записи `downloading`, прогресс пришёл только событиями.
    act(() => bridge.emitAssistantVoiceProgress(progressOf(SMALL, 1_000_000_000)));
    expect(modelRow(SMALL).textContent).toContain(S.voice.settings.progress(1_000_000_000, 1_213_534_464));
    expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.cancel })).toBeTruthy();
    bridge.setAssistantVoiceModels([SMALL, LARGE]);
    act(() => bridge.setAssistantVoiceState({ state: 'ready' }));
    await waitFor(() => expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy());
    expect(modelRow(SMALL).textContent).not.toContain('%');
    expect(modelRow(SMALL).textContent).toContain(text.voiceModelIdle);
    expect(modelRow(LARGE).textContent).toContain(text.voiceModelInUse);
  });

  it('D5, Cancel: Cancel строки отменяет скачивание именно её модели, строка возвращается к Download', async () => {
    const download = pendingDownload();
    render(<AssistantSettings />);
    fireEvent.click(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.download }));
    await act(async () => {
      fireEvent.click(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.cancel }));
    });
    expect(bridge.assistantVoiceCalls).toContain(`cancel:${LARGE}`);
    expect(bridge.assistantVoiceCalls).not.toContain(`cancel:${SMALL}`);
    await act(async () => download.finish(LARGE, { error: 'cancelled' }));
    expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.download })).toBeTruthy();
    expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.download })).toBeTruthy();
  });

  it('D5, Delete: Delete скачанной строки удаляет её модель по id, строка возвращается к Download, само ничего не качается', async () => {
    bridge.setAssistantVoiceModels([SMALL]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    bridge.app.assistantVoiceRemove = async (id) => {
      bridge.assistantVoiceCalls.push(`remove:${id}`);
      bridge.setAssistantVoiceModels([]);
      bridge.setAssistantVoiceState({ state: 'not-downloaded' });
    };
    render(<AssistantSettings />);
    const remove = await within(modelRow(SMALL)).findByRole('button', { name: S.voice.settings.remove });
    // У 1.7B нечего удалять — у неё Download.
    expect(within(modelRow(LARGE)).queryByRole('button', { name: S.voice.settings.remove })).toBeNull();
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(bridge.assistantVoiceCalls).toContain(`remove:${SMALL}`);
    await waitFor(() => expect(within(modelRow(SMALL)).getByRole('button', { name: S.voice.settings.download })).toBeTruthy());
    expect(bridge.assistantVoiceCalls.filter((call) => call.startsWith('download'))).toEqual([]);
  });

  it('«In use.» у активной модели: только 0.6B — у неё, 1.7B остаётся с «One download for all voices.»', async () => {
    bridge.setAssistantVoiceModels([SMALL]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    render(<AssistantSettings />);
    await waitFor(() => expect(modelRow(SMALL).textContent).toContain('In use.'));
    expect(modelRow(LARGE).textContent).toContain('One download for all voices.');
    expect(modelRow(LARGE).textContent).not.toContain('In use.');
  });

  it('скачаны обе: «In use.» у 1.7B, у 0.6B — «Not in use while the larger model is downloaded.», у обеих Delete', async () => {
    bridge.setAssistantVoiceModels([SMALL, LARGE]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    render(<AssistantSettings />);
    await waitFor(() => expect(modelRow(LARGE).textContent).toContain('In use.'));
    expect(modelRow(SMALL).textContent).toContain('Not in use while the larger model is downloaded.');
    expect(modelRow(SMALL).textContent).not.toContain('In use.');
    for (const { id } of TTS_MODELS) {
      expect(within(modelRow(id)).getByRole('button', { name: S.voice.settings.remove })).toBeTruthy();
    }
  });

  it('удаление 1.7B при скачанной 0.6B: «In use.» переходит к 0.6B', async () => {
    bridge.setAssistantVoiceModels([SMALL, LARGE]);
    bridge.setAssistantVoiceState({ state: 'ready' });
    bridge.app.assistantVoiceRemove = async (id) => {
      bridge.assistantVoiceCalls.push(`remove:${id}`);
      bridge.setAssistantVoiceModels([SMALL]);
      bridge.setAssistantVoiceState({ state: 'ready' });
    };
    render(<AssistantSettings />);
    const remove = await within(modelRow(LARGE)).findByRole('button', { name: S.voice.settings.remove });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(bridge.assistantVoiceCalls).toContain(`remove:${LARGE}`);
    await waitFor(() => expect(modelRow(SMALL).textContent).toContain('In use.'));
    expect(within(modelRow(LARGE)).getByRole('button', { name: S.voice.settings.download })).toBeTruthy();
  });
});
