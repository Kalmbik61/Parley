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
   * Вошёл ли аккаунт подписки: `true` — да, `false` — нет, `null` — служба входа не знает. В список попадает только тот
   * аккаунт, кого она подтвердила; хост подставляет `auth.status`. Не аккаунтов (`claude`, `glm`, свои с адресом) не
   * спрашивают: состояния входа у них нет, их готовность говорит сама за себя (решение 8).
   */
  signedIn: (id: string) => boolean | null;
  /**
   * Готовность к запуску; по умолчанию — `providerReadiness` с `signedIn: true` (аккаунт уже прошёл `signedIn` выше,
   * иначе готовность отказывала бы каждому по его же входу). Подмена — для тестов, чтобы не искать `claude` в PATH.
   */
  readiness?: (entry: ProviderEntry) => Promise<ProviderReadiness>;
}

/**
 * Записи реестра того же семейства, что у `provider`, кроме него самого: вошедшие и готовые к запуску (нет `needs` и
 * `error`). Вошедшим аккаунт подписки считается по службе входа (`signedIn`); не аккаунт семейства — глобальный
 * `claude`, `glm` — вошедшим считается всегда, а решает одна готовность (решение 8, спека подписок 5.8): иначе
 * застрявшему аккаунту нечего было бы предложить, кроме других аккаунтов, а глобальный Claude Code — самая очевидная
 * замена. Провайдер без семейства (Codex) или неизвестный — пусто.
 */
export async function limitAlternatives(provider: string, deps: LimitAlternativesDeps): Promise<LimitAlternative[]> {
  const registry = await loadProviders();
  const family = registry[provider]?.family;
  if (family === undefined) return [];
  const readiness = deps.readiness ?? ((entry: ProviderEntry) => providerReadiness(entry, { signedIn: true }));
  const result: LimitAlternative[] = [];
  for (const entry of Object.values(registry)) {
    if (entry.id === provider || entry.family !== family) continue;
    if (entry.account !== undefined && deps.signedIn(entry.id) !== true) continue;
    const state = await readiness(entry);
    if (state.needs !== null || state.error !== null) continue;
    result.push({ id: entry.id, label: providerLabel(entry), limits: deps.limits.get(entry.id) });
  }
  return result;
}
