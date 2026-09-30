/**
 * Агент по умолчанию (спека 6.6): `ui.json.lastProvider`, иначе `claude`; если его нет
 * среди доступных — первый доступный. Одно правило на диалог новой работы (1.7) и на диалог «New session or
 * room» (1.5), иначе ⌘N и ⌘T предлагали бы разных агентов.
 */

export interface ProviderOption {
  id: string;
  label: string;
  available: boolean;
  /**
   * Модели для выбора при запуске — `providers.list.models`: `id` идёт в `--model`, `label` — подпись окна. Нет поля,
   * `null` или пусто — контрола нет, модель CLI по умолчанию (спека окна 2026-09-29, решение 5).
   */
  models?: ReadonlyArray<{ id: string; label: string }> | null;
  /** Принимает ли провайдер усилие при запуске; нет поля — как `false`, контрол спрятан. */
  effort?: boolean;
}

export function defaultProvider(providers: readonly ProviderOption[], lastProvider: string | null): string | null {
  const available = providers.filter((provider) => provider.available);
  const wanted = lastProvider ?? 'claude';
  return (available.find((provider) => provider.id === wanted) ?? available[0])?.id ?? null;
}
