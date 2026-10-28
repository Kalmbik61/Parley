/**
 * Settings → Assistant (спека 2026-10-14, 6.1): включение, провайдер и модель из подключённых, язык, глобальное
 * сочетание. Всё — в `ui.json` (`patchUi`); main по сохранению перерегистрирует хоткей и шлёт острову конфиг.
 *
 * Голос (план 3b, B20; #9 §6.8): «Speak answers», голоса каталога для языка помощника с родом, языками и лицензией,
 * веса — как модели Whisper во вкладке Voice: Download с прогрессом, Cancel, Delete (D5), своя строка на каждую
 * модель (0.6B и 1.7B); говорит самая большая из скачанных (`activeTtsModel`). Само ничего не качается (G3); после
 * скачивания до `ready` — `Preparing voice…` (Р7).
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Result } from '@parley/protocol';
import { systemAssistantLanguage } from '../../../shared/assistant-language.js';
import type { AssistantShortcutStatus, TtsEngineState } from '../../../shared/island.js';
import { S } from '../../../shared/strings.js';
import { activeTtsModel, DEFAULT_VOICE, TTS_MODELS, type AssistantVoice, type TtsModelId } from '../../../shared/tts-types.js';
import { LANGUAGE_OPTIONS, type DownloadResult } from '../../../shared/voice-types.js';
import type { AssistantUi, UiFile } from '../../../shared/ui-types.js';
import { getHostClient } from '../../host-client.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';
import { ShortcutField } from './ShortcutField.js';

type ProviderRow = Result<'providers.list'>['providers'][number];

/** Значения-заглушки Select для «не задано» (`null`): у Radix пустой строки в пункте быть не может. */
const AUTO = '__auto';
const DEFAULT_MODEL = '__default';
const SYSTEM_LANGUAGE = '__system';

function languageNames(codes: readonly string[]): string {
  return codes.map((code) => LANGUAGE_OPTIONS.find((option) => option.code === code)?.name ?? code).join(', ');
}

export function AssistantSettings(): JSX.Element {
  const assistant = useUiStore((state) => state.ui.assistant);
  const patchUi = useUiStore((state) => state.patchUi);
  const bridge = getHostClient();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [shortcut, setShortcut] = useState<AssistantShortcutStatus | null>(null);
  const [voices, setVoices] = useState<AssistantVoice[]>([]);
  const [voiceState, setVoiceState] = useState<TtsEngineState | null>(null);
  /** Скачанные модели весов; говорит самая большая из них. */
  const [models, setModels] = useState<TtsModelId[]>([]);
  /** Модели, чей вызов `download` из этого окна ещё не вернулся. */
  const [downloading, setDownloading] = useState<ReadonlySet<TtsModelId>>(new Set());
  /** Скачано байт по моделям; нет записи — прогресса нет. Приходит и к заново открытым настройкам, пока загрузка идёт в main. */
  const [received, setReceived] = useState<ReadonlyMap<TtsModelId, number>>(new Map());

  useEffect(() => {
    let alive = true;
    void bridge.call('providers.list', {}).then((result) => {
      if (alive) setProviders(result.providers.filter((provider) => provider.available));
    });
    return () => {
      alive = false;
    };
  }, [bridge]);
  useEffect(() => {
    void bridge.app.assistantShortcut().then(setShortcut);
  }, [bridge, assistant.enabled, assistant.hotkey]);

  const refreshVoice = useCallback((): void => {
    void bridge.app.assistantVoices().then(setVoices);
    void bridge.app.assistantVoiceModels().then((ids) => {
      setModels(ids);
      // Модель уже на диске — прогресс её скачивания кончился (в том числе начатого до открытия этих настроек).
      setReceived((previous) => {
        const kept = [...previous].filter(([id]) => !ids.includes(id));
        return kept.length === previous.size ? previous : new Map(kept);
      });
    });
    void bridge.app.assistantVoiceState().then(setVoiceState);
  }, [bridge]);
  useEffect(() => {
    // Состояние движка меняют скачивание, удаление, прогрев и отказ worker: каждый раз перечитываем и отметки «скачан».
    // Прогресс по событию состояния не сбрасываем: при скачанной 0.6B движок уже `ready`, а 1.7B ещё качается.
    const offState = bridge.app.onAssistantVoiceState(() => refreshVoice());
    const offProgress = bridge.app.onAssistantVoiceProgress((progress) =>
      setReceived((previous) => new Map(previous).set(progress.id, progress.receivedBytes)),
    );
    refreshVoice();
    return () => {
      offState();
      offProgress();
    };
  }, [bridge, refreshVoice]);

  const setDownloadingModel = (id: TtsModelId, on: boolean): void =>
    setDownloading((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const clearProgress = (id: TtsModelId): void =>
    setReceived((previous) => {
      const next = new Map(previous);
      next.delete(id);
      return next;
    });
  const downloadVoice = async (id: TtsModelId): Promise<void> => {
    setDownloadingModel(id, true);
    const result: DownloadResult = await bridge.app.assistantVoiceDownload(id).catch(() => ({ error: 'network' }) as const);
    // Прогресс строки кончается вместе с её вызовом: успех, ошибка или отмена.
    setDownloadingModel(id, false);
    clearProgress(id);
    refreshVoice();
    if ('ok' in result) return;
    if (result.error === 'disk_full') toast(S.voice.diskFull(Math.ceil(result.needBytes / 1_000_000)));
    else if (result.error === 'corrupted') toast(S.voice.downloadCorrupted);
    else if (result.error === 'network') toast(S.voice.downloadFailed);
  };
  const cancelVoice = async (id: TtsModelId): Promise<void> => {
    await bridge.app.assistantVoiceCancel(id);
    clearProgress(id);
  };
  const removeVoice = async (id: TtsModelId): Promise<void> => {
    await bridge.app.assistantVoiceRemove(id);
    refreshVoice();
  };

  const patch = (next: Partial<AssistantUi>): void =>
    patchUi({ assistant: next } as unknown as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>);
  const selected = providers.find((provider) => provider.id === assistant.provider) ?? null;
  const claudeDesktopClash = /^(alt|option)\+space$/i.test(assistant.hotkey.replace(/\s+/g, ''));
  const text = S.assistant.settings;
  const language = assistant.language ?? systemAssistantLanguage(navigator.language);
  const languageVoices = voices.filter((voice) => voice.languages.includes(language));
  const selectedVoice = assistant.voice ?? DEFAULT_VOICE;
  const activeModel = activeTtsModel(models);
  const modelHint = (id: TtsModelId, totalBytes: number): string => {
    const bytes = received.get(id);
    if (bytes !== undefined) return S.voice.settings.progress(bytes, totalBytes);
    if (id === activeModel) return voiceState?.state === 'warming' ? text.voicePreparing : text.voiceModelInUse;
    return models.includes(id) ? text.voiceModelIdle : text.voiceModelHint;
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-center justify-between gap-2">
        <span>{text.enabled}</span>
        <Switch aria-label={text.enabled} checked={assistant.enabled} onCheckedChange={(checked) => patch({ enabled: checked })} />
      </label>
      <p className="text-xs text-muted-foreground">{text.enabledHint}</p>

      <label className="flex flex-col gap-1">
        <span>{text.provider}</span>
        <Select
          value={assistant.provider ?? AUTO}
          onValueChange={(value) => patch({ provider: value === AUTO ? null : value, model: null })}
        >
          <SelectTrigger aria-label={text.provider}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO}>{text.providerAuto}</SelectItem>
            {providers.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {assistant.provider === 'glm' ? <p className="text-xs text-muted-foreground">{text.glmSlow}</p> : null}

      <label className="flex flex-col gap-1">
        <span>{text.model}</span>
        <Select
          value={assistant.model ?? DEFAULT_MODEL}
          onValueChange={(value) => patch({ model: value === DEFAULT_MODEL ? null : value })}
        >
          <SelectTrigger aria-label={text.model}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL}>{text.modelDefault}</SelectItem>
            {(selected?.models ?? []).map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span>{text.language}</span>
        <Select
          value={assistant.language ?? SYSTEM_LANGUAGE}
          onValueChange={(value) => patch({ language: value === SYSTEM_LANGUAGE ? null : value })}
        >
          <SelectTrigger aria-label={text.language}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={SYSTEM_LANGUAGE}>{text.languageSystem}</SelectItem>
            {LANGUAGE_OPTIONS.map(({ code, name }) => (
              <SelectItem key={code} value={code}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span>{text.shortcut}</span>
        <ShortcutField
          value={assistant.hotkey}
          label={text.shortcut}
          onChange={(hotkey) => patch({ hotkey })}
          onRecording={(on) => bridge.app.assistantShortcutSuspend(on)}
        />
      </label>
      <p className="text-xs text-muted-foreground">{text.shortcutHint}</p>
      {shortcut?.ok === false ? <p className="text-xs text-destructive">{text.shortcutTaken}</p> : null}
      {claudeDesktopClash ? <p className="text-xs text-muted-foreground">{text.shortcutClaudeDesktop}</p> : null}

      <label className="flex items-center justify-between gap-2">
        <span>{text.speak}</span>
        <Switch aria-label={text.speak} checked={assistant.speak} onCheckedChange={(checked) => patch({ speak: checked })} />
      </label>

      <div className="flex flex-col gap-2">
        <span>{text.voice}</span>
        {languageVoices.map((voice) => (
          <div key={voice.id} data-assistant-voice={voice.id} className="flex min-w-0 items-center gap-2">
            <input
              type="radio"
              name="assistant-voice"
              aria-label={voice.name}
              checked={selectedVoice === voice.id}
              onChange={() => patch({ voice: voice.id })}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{voice.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {text.voiceDetails(text.voiceGender[voice.gender], languageNames(voice.languages), voice.licence)}
              </span>
            </span>
          </div>
        ))}
        {voices.length > 0 && languageVoices.length === 0 ? (
          <p className="text-xs text-muted-foreground">{text.voiceNoLanguage}</p>
        ) : null}
        {TTS_MODELS.map((model) => (
          <div key={model.id} data-assistant-voice-model={model.id} className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">
                {text.voiceModels[model.id]} · {S.voice.settings.sizeMb(Math.round(model.bytes / 1_000_000))}
              </span>
              <span className="truncate text-xs text-muted-foreground">{modelHint(model.id, model.bytes)}</span>
            </span>
            {downloading.has(model.id) || received.has(model.id) ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void cancelVoice(model.id)}>
                {S.voice.settings.cancel}
              </Button>
            ) : models.includes(model.id) ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void removeVoice(model.id)}>
                {S.voice.settings.remove}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={voiceState?.state === 'unavailable'}
                onClick={() => void downloadVoice(model.id)}
              >
                {S.voice.settings.download}
              </Button>
            )}
          </div>
        ))}
      </div>
      {voiceState?.state === 'unavailable' ? <p className="text-xs text-muted-foreground">{text.voiceUnavailable}</p> : null}
      <p className="text-xs text-muted-foreground">{text.voiceCredit}</p>
    </div>
  );
}
