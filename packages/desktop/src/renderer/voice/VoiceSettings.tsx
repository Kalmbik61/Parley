/**
 * Вкладка Settings → Voice (спека 3.1, 6.2): переключатель (только при скачанной модели), три модели с
 * Download / Cancel / Delete и прогрессом, язык, горячая клавиша. Выбор пишет `ui.json` через `patchUi`; список
 * скачанное и прогресс — в `downloads-store` (окно, не вкладка).
 */
import { useEffect } from 'react';
import { S } from '../../shared/strings.js';
import { VOICE_MODELS, WHISPER_LANGUAGES } from '../../shared/voice-types.js';
import { useUiStore } from '../store/ui.js';
import { Button } from '../ui/button.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import { useDownloadsStore } from './downloads-store.js';

/** Список языков: Auto, English, Russian, затем остальные по алфавиту (спека 3.1). */
const LANGUAGE_OPTIONS = [
  { code: 'auto', name: S.voice.settings.auto },
  ...WHISPER_LANGUAGES.filter((language) => language.code === 'en' || language.code === 'ru').sort((a, b) => a.name.localeCompare(b.name)),
  ...WHISPER_LANGUAGES.filter((language) => language.code !== 'en' && language.code !== 'ru'),
];

export function VoiceSettings(): JSX.Element {
  const settings = useUiStore((state) => state.ui.voice);
  const patchUi = useUiStore((state) => state.patchUi);
  const { downloaded, progress, busy, refresh, download, cancel, remove } = useDownloadsStore();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patchVoice = (patch: Partial<typeof settings>): void => {
    patchUi({ voice: { ...useUiStore.getState().ui.voice, ...patch } });
  };

  const hasModel = downloaded.length > 0;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <label className="flex items-center justify-between gap-2">
        <span>{S.voice.settings.enable}</span>
        <Switch
          aria-label={S.voice.settings.enable}
          checked={settings.enabled && hasModel}
          disabled={!hasModel}
          onCheckedChange={(checked) => patchVoice({ enabled: checked })}
        />
      </label>
      {hasModel ? null : <p className="text-xs text-muted-foreground">{S.voice.settings.downloadFirst}</p>}

      <div className="flex flex-col gap-2">
        <span>{S.voice.settings.model}</span>
        {VOICE_MODELS.map((model) => {
          const text = S.voice.models[model.id];
          const isDownloaded = downloaded.includes(model.id);
          const received = progress[model.id];
          return (
            <div key={model.id} data-voice-model={model.id} className="flex min-w-0 items-center gap-2">
              <input
                type="radio"
                name="voice-model"
                aria-label={text.name}
                checked={settings.model === model.id}
                disabled={!isDownloaded}
                onChange={() => patchVoice({ model: model.id })}
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">
                  {text.name} · {S.voice.settings.sizeMb(Math.round(model.bytes / 1_000_000))}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {received !== undefined ? S.voice.settings.progress(received, model.bytes) : text.hint}
                </span>
              </span>
              {busy[model.id] === true ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void cancel(model.id)}>
                  {S.voice.settings.cancel}
                </Button>
              ) : isDownloaded ? (
                <Button type="button" variant="outline" size="sm" onClick={() => void remove(model.id)}>
                  {S.voice.settings.remove}
                </Button>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => void download(model.id)}>
                  {S.voice.settings.download}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <label className="flex flex-col gap-1">
        <span>{S.voice.settings.language}</span>
        <Select value={settings.language} onValueChange={(language) => patchVoice({ language })}>
          <SelectTrigger aria-label={S.voice.settings.language}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {LANGUAGE_OPTIONS.map((language) => (
              <SelectItem key={language.code} value={language.code}>
                {language.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <div className="flex items-center justify-between">
        <span>{S.voice.settings.shortcut}</span>
        <kbd className="text-xs text-muted-foreground">{S.voice.settings.shortcutKeys}</kbd>
      </div>
      <p className="text-xs text-muted-foreground">{S.voice.settings.hint}</p>
    </div>
  );
}
