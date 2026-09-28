/**
 * Агент по умолчанию (спека 6.6): `ui.json.lastProvider`, иначе `claude`; если его нет
 * среди доступных — первый доступный. Одно правило на форму новой работы и `NewSessionDialog`
 * (кусок 3.5), иначе ⌘N и ⌘T предлагали бы разных агентов.
 */

export interface ProviderOption {
  id: string;
  label: string;
  available: boolean;
}

export function defaultProvider(providers: readonly ProviderOption[], lastProvider: string | null): string | null {
  const available = providers.filter((provider) => provider.available);
  const wanted = lastProvider ?? 'claude';
  return (available.find((provider) => provider.id === wanted) ?? available[0])?.id ?? null;
}
