/**
 * Settings → Assistant (спека 2026-10-14, 6.1): включение, провайдер и модель из подключённых, язык, глобальное
 * сочетание. Всё — в `ui.json` (`patchUi`); main по сохранению перерегистрирует хоткей и шлёт острову конфиг.
 */
import { useEffect, useState } from 'react';
import type { Result } from '@parley/protocol';
import type { AssistantShortcutStatus } from '../../../shared/island.js';
import { S } from '../../../shared/strings.js';
import { LANGUAGE_OPTIONS } from '../../../shared/voice-types.js';
import type { AssistantUi, UiFile } from '../../../shared/ui-types.js';
import { getHostClient } from '../../host-client.js';
import { useUiStore } from '../../store/ui.js';
import { Input } from '../../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';

type ProviderRow = Result<'providers.list'>['providers'][number];

/** Значения-заглушки Select для «не задано» (`null`): у Radix пустой строки в пункте быть не может. */
const AUTO = '__auto';
const DEFAULT_MODEL = '__default';
const SYSTEM_LANGUAGE = '__system';

export function AssistantSettings(): JSX.Element {
  const assistant = useUiStore((state) => state.ui.assistant);
  const patchUi = useUiStore((state) => state.patchUi);
  const bridge = getHostClient();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [shortcut, setShortcut] = useState<AssistantShortcutStatus | null>(null);
  const [hotkey, setHotkey] = useState(assistant.hotkey);

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

  const patch = (next: Partial<AssistantUi>): void =>
    patchUi({ assistant: next } as unknown as Partial<Omit<UiFile, 'version' | 'activeWorkKey'>>);
  const selected = providers.find((provider) => provider.id === assistant.provider) ?? null;
  const claudeDesktopClash = /^(alt|option)\+space$/i.test(assistant.hotkey.replace(/\s+/g, ''));
  const text = S.assistant.settings;

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
            {LANGUAGE_OPTIONS.filter(({ code }) => code !== 'auto').map(({ code, name }) => (
              <SelectItem key={code} value={code}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span>{text.shortcut}</span>
        <Input
          aria-label={text.shortcut}
          value={hotkey}
          onChange={(event) => setHotkey(event.target.value)}
          onBlur={() => {
            if (hotkey.trim() !== '') patch({ hotkey: hotkey.trim() });
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">{text.shortcutHint}</p>
      {shortcut?.ok === false ? <p className="text-xs text-destructive">{text.shortcutTaken}</p> : null}
      {claudeDesktopClash ? <p className="text-xs text-muted-foreground">{text.shortcutClaudeDesktop}</p> : null}
    </div>
  );
}
