/**
 * Settings → Assistant → «Voice provider (API)»: голос OpenAI для озвучки, ключ и дневной лимит. Ключ уходит хосту
 * (`voiceProvider.setKey`) и в окне не хранится: поле очищается, показывается только подсказка. «Ready» — после успешного
 * `check`; при ошибке — текст по коду причины. Голос — `assistant.apiVoice` в ui.json.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Result } from '@parley/protocol';
import { OPENAI_VOICES } from '../../../shared/tts-types.js';
import { S } from '../../../shared/strings.js';
import type { UiFile } from '../../../shared/ui-types.js';
import { getHostClient } from '../../host-client.js';
import { useUiStore } from '../../store/ui.js';
import { Button } from '../../ui/button.js';
import { Input } from '../../ui/input.js';
import { maskedHint } from '../providers/check-line.js';

const TEXT = S.settings.voiceProvider;

export function VoiceProviderSection(): JSX.Element {
  const bridge = getHostClient();
  const apiVoice = useUiStore((store) => store.ui.assistant.apiVoice);
  const patchUi = useUiStore((store) => store.patchUi);
  const [state, setState] = useState<Result<'voiceProvider.get'> | null>(null);
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<Result<'voiceProvider.check'> | null>(null);
  const [saved, setSaved] = useState(false);
  const [minutes, setMinutes] = useState<string | null>(null);
  /** Значение, которое уже лежит в настройках: на blur сохраняем только изменённое. */
  const [savedMinutes, setSavedMinutes] = useState<string | null>(null);
  const [minutesLocked, setMinutesLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await bridge.call('voiceProvider.get', {}));
      const settings = await bridge.call('settings.get', {});
      const loaded = String(settings.config.voiceDailyMinutes);
      setMinutes(loaded);
      setSavedMinutes(loaded);
      setMinutesLocked(settings.locked.voiceDailyMinutes !== undefined);
    } catch {
      setError(TEXT.loadError);
    }
  }, [bridge]);
  useEffect(() => void load(), [load]);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error && err.message !== '' ? err.message : TEXT.saveError);
    }
  };
  const save = (): Promise<void> =>
    run(async () => {
      setState(await bridge.call('voiceProvider.setKey', { key }));
      setKey('');
      setOutcome(null);
      setSaved(true);
    });
  const check = (): Promise<void> =>
    run(async () => {
      setChecking(true);
      setSaved(false);
      try {
        setOutcome(await bridge.call('voiceProvider.check', {}));
      } finally {
        setChecking(false);
      }
    });
  const remove = (): Promise<void> =>
    run(async () => {
      setState(await bridge.call('voiceProvider.clearKey', {}));
      setOutcome(null);
      setSaved(false);
    });
  const saveMinutes = (): Promise<void> => {
    if (minutes === null || minutes === savedMinutes) return Promise.resolve();
    return run(async () => {
      await bridge.call('settings.set', { key: 'voiceDailyMinutes', value: minutes });
      setSavedMinutes(minutes);
    });
  };

  const hint = state?.secretHint == null ? null : maskedHint(state.secretHint);
  return (
    <div className="flex flex-col gap-2" data-testid="voice-provider">
      <h3 className="text-sm font-medium">{TEXT.title}</h3>
      <p className="text-xs text-muted-foreground">{TEXT.hint}</p>
      <div role="radiogroup" aria-label={TEXT.voiceLabel} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {OPENAI_VOICES.map((voice) => (
          <label key={voice} className="flex items-center gap-1">
            <input
              type="radio"
              name="assistant-api-voice"
              data-testid={`assistant-api-voice-${voice}`}
              checked={apiVoice === voice}
              onChange={() => patchUi({ assistant: { apiVoice: voice } } as unknown as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>)}
            />
            <span className="capitalize">{voice}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <span className="font-medium">{TEXT.tile}</span>
        {hint !== null ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          data-testid="voice-provider-key"
          aria-label={TEXT.keyLabel}
          placeholder={TEXT.keyPlaceholder}
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <Button type="button" variant="outline" size="sm" data-testid="voice-provider-save" disabled={key.trim() === ''} onClick={() => void save()}>
          {TEXT.save}
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="voice-provider-check" disabled={checking || state?.keySet !== true} onClick={() => void check()}>
          {checking ? TEXT.checking : TEXT.check}
        </Button>
        {state?.keySet === true ? (
          <Button type="button" variant="outline" size="sm" data-testid="voice-provider-remove" onClick={() => void remove()}>
            {TEXT.remove}
          </Button>
        ) : null}
      </div>
      <div role="status" className="text-xs" data-testid="voice-provider-status">
        {outcome === null ? (
          saved && hint !== null ? <p className="text-muted-foreground">{TEXT.saved(hint)}</p> : null
        ) : outcome.ok ? (
          <p className="text-muted-foreground">{TEXT.ready(hint ?? '')}</p>
        ) : (
          <p className="text-destructive">{TEXT.failed[outcome.code] ?? TEXT.failed.unknown}</p>
        )}
        {error !== null ? <p className="text-destructive">{error}</p> : null}
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>{TEXT.dailyLabel}</span>
        <Input
          type="number"
          min={1}
          max={600}
          className="w-24"
          data-testid="voice-provider-minutes"
          disabled={minutes === null || minutesLocked}
          value={minutes ?? ''}
          onChange={(event) => setMinutes(event.target.value)}
          onBlur={() => void saveMinutes()}
        />
      </label>
    </div>
  );
}
