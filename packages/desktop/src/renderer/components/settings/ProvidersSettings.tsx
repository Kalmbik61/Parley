/**
 * Settings → Providers (спека своих провайдеров, раздел 4): пилюли Claude Code, Codex, GLM, своих
 * провайдеров и «+ Add provider». Выбранная встроенная показывает карточку подключения без изменений;
 * своя или `'new'` — выбор вендора и форма (`CustomProviderPanel`).
 */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { providerName, S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { useProvidersStore } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { AgentIcon } from '../AgentIcon.js';
import { radioGroupKeyDown } from '../dialogs/radio-keys.js';
import { PILL } from '../providers/pill.js';
import { CustomProviderPanel } from '../providers/CustomProviderPanel.js';
import { ProviderCard } from '../providers/ProviderCard.js';

const CORE_IDS = ['claude', 'codex', 'glm'] as const;

export function ProvidersSettings(): JSX.Element {
  const providers = useProvidersStore((state) => state.providers);
  const reload = useProvidersStore((state) => state.reload);
  const requested = useUiStore((state) => state.settingsProvider);
  const [selected, setSelected] = useState<string | 'new'>(requested ?? 'claude');
  useEffect(() => {
    if (requested !== null) setSelected(requested);
  }, [requested]);

  const customs = providers.filter((provider) => provider.custom != null);
  const pills = [
    ...CORE_IDS.map((id) => providers.find((provider) => provider.id === id) ??
      { id, label: providerName(id, id), available: false, version: null, limits: null }),
    ...customs,
  ];
  const current = selected === 'new' ? undefined : pills.find((provider) => provider.id === selected);

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={S.settings.sections.providers} onKeyDown={radioGroupKeyDown} className="flex flex-wrap gap-2">
        {pills.map((provider) => {
          const on = provider.id === selected;
          return (
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              data-provider-pill={provider.id}
              onClick={() => setSelected(provider.id)}
              className={cn(PILL, on ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7', !provider.available && 'opacity-45')}
            >
              {/* Буква значка без бренда (`GLM` → «G») не должна попадать в имя кнопки. */}
              <span aria-hidden="true" className="inline-flex">
                <AgentIcon provider={provider.id} size={14} />
              </span>
              <span>{providerName(provider.id, provider.label)}</span>
              {provider.available ? <span aria-hidden="true" data-connected-dot className="size-1.5 rounded-full bg-emerald-500" /> : null}
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={selected === 'new'}
          tabIndex={selected === 'new' ? 0 : -1}
          data-provider-pill="new"
          onClick={() => setSelected('new')}
          className={cn(PILL, selected === 'new' ? 'border-ring bg-neutral-100 font-semibold' : 'border-dashed border-border hover:bg-foreground/7')}
        >
          <Plus aria-hidden size={14} />
          <span>{S.statusBar.addProvider}</span>
        </button>
      </div>
      {current !== undefined && current.custom == null ?
        <ProviderCard provider={current} onReload={reload} onRestartHost={() => useUiStore.getState().confirmRestartHost()} /> :
        <CustomProviderPanel
          key={selected}
          providerId={selected}
          onSaved={(id) => setSelected(id)}
          onDeleted={() => setSelected('claude')}
        />}
    </div>
  );
}
