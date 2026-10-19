/**
 * Settings → Providers (спека своих провайдеров, раздел 4): пилюли Claude Code, Codex, GLM, своих
 * провайдеров и «+ Add provider». Выбранная встроенная показывает карточку подключения без изменений;
 * своя или `'new'` — место под форму (`CustomProviderPanel`, задача 11).
 */

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { providerName, S } from '../../../shared/strings.js';
import { cn } from '../../lib/cn.js';
import { useProvidersStore } from '../../store/providers.js';
import { useUiStore } from '../../store/ui.js';
import { AgentIcon } from '../AgentIcon.js';
import { PILL } from '../providers/pill.js';
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
      <div role="radiogroup" aria-label={S.settings.sections.providers} className="flex flex-wrap gap-2">
        {pills.map((provider) => {
          const on = provider.id === selected;
          return (
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-provider-pill={provider.id}
              onClick={() => setSelected(provider.id)}
              className={cn(PILL, on ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7', !provider.available && 'opacity-45')}
            >
              <AgentIcon provider={provider.id} size={14} />
              <span>{providerName(provider.id, provider.label)}</span>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={selected === 'new'}
          data-provider-pill="new"
          onClick={() => setSelected('new')}
          className={cn(PILL, selected === 'new' ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7')}
        >
          <Plus aria-hidden size={14} />
          <span>{S.statusBar.addProvider}</span>
        </button>
      </div>
      {/* Форма своего провайдера (CustomProviderPanel) приходит задачей 11; здесь — только место под неё. */}
      {current !== undefined && current.custom == null ?
        <ProviderCard provider={current} onReload={reload} onRestartHost={() => useUiStore.getState().confirmRestartHost()} /> :
        <div data-custom-provider-slot={selected} />}
    </div>
  );
}
