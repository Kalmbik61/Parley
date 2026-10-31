/** Провайдера сессии нет в списке окна (удалён): общий признак для меню, баннера чата и значка сайдбара (спека 2026-10-30, 5.7). */

import { useProvidersStore } from './providers.js';

/** Пока список не пришёл или пуст, судить рано — `false`. */
export function useProviderMissing(providerId: string): boolean {
  return useProvidersStore((state) => state.loaded && state.providers.length > 0 && !state.providers.some((item) => item.id === providerId));
}
