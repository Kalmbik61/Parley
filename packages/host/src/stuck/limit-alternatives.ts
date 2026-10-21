/**
 * Источник альтернатив для письма о лимите (спека подписок 4.4, 5.8): другие вошедшие аккаунты того же CLI, на
 * которые ведущий может завести замену застрявшему. Хост только собирает список; решает человек, и замену ведущий
 * заводит `create_session` лишь после его согласия.
 */

import {
  loadProviders,
  providerLabel,
  providerReadiness,
  type LimitAlternative,
  type ProviderEntry,
  type ProviderLimits,
  type ProviderReadiness,
} from '@parley/core';

export interface LimitAlternativesDeps {
  /** Лимиты аккаунтов: `null` в `limits` альтернативы — хост их не знает. */
  limits: { get(providerId: string): ProviderLimits | null };
  /**
   * Вошёл ли аккаунт: `true` — да, `false` — нет, `null` — служба входа не знает. На этапе 1 службы входа нет и всегда
   * `null`: в список попадает только тот, кого она подтвердила.
   */
  signedIn: (id: string) => boolean | null;
  /** Готовность к запуску; по умолчанию — `providerReadiness`. Подмена — для тестов, чтобы не искать `claude` в PATH. */
  readiness?: (entry: ProviderEntry) => Promise<ProviderReadiness>;
}

/**
 * Записи реестра того же семейства, что у `provider`, кроме него самого: аккаунт вошёл (`signedIn`) и готов к
 * запуску (нет `needs` и `error`). Провайдер без семейства (Codex) или неизвестный — пусто.
 */
export async function limitAlternatives(provider: string, deps: LimitAlternativesDeps): Promise<LimitAlternative[]> {
  const registry = await loadProviders();
  const family = registry[provider]?.family;
  if (family === undefined) return [];
  const readiness = deps.readiness ?? ((entry: ProviderEntry) => providerReadiness(entry));
  const result: LimitAlternative[] = [];
  for (const entry of Object.values(registry)) {
    if (entry.id === provider || entry.family !== family || deps.signedIn(entry.id) !== true) continue;
    const state = await readiness(entry);
    if (state.needs !== null || state.error !== null) continue;
    result.push({ id: entry.id, label: providerLabel(entry), limits: deps.limits.get(entry.id) });
  }
  return result;
}
