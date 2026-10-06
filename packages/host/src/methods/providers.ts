import {
  clearSecret,
  loadProviders,
  providerReadiness,
  readSecret,
  SecretFormatError,
  secretHint,
  selectableModels,
  supportsEffort,
  writeSecret,
} from '@parley/core';
import type { SecretId } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { GlmCheckService } from '../limits/glm-check.js';
import type { LimitsService } from '../limits/limits-service.js';
import { ZaiQuotaError } from '../limits/zai-quota.js';
import type { ProviderVersions } from '../providers/versions.js';

/**
 * `available` — провайдер готов к запуску: команда видна в PATH (или через `PARLEY_*_BIN`-оверрайд
 * (прежний `HARNAS_*_BIN` тоже)), а для GLM подходят версия CLI и сохранённый ключ. `models`,
 * `effort` и `version` — для диалога запуска и строки статуса окна (дизайн комнат, 3.2): что
 * провайдер принимает при запуске решает его шаблон в реестре, версия — проба на старте хоста.
 * Первый ответ ждёт эту пробу (её таймаут короткий), иначе окно, подключившееся сразу за хостом,
 * получило бы пустые версии и до перезапуска их не увидело.
 *
 * `limits` — лимиты подписки провайдера (спека комнат Organic, 3.5); `null`, если данных нет. Их
 * первое чтение хост не ждёт: не готово — придёт событием `providers.limitsChanged`.
 *
 * `check` — исход последней явной проверки сохранённого ключа (`providers.check`), только у провайдера
 * с ключом; читается локально, без сети, и только для нынешнего ключа.
 */
export function createProvidersList(
  versions?: ProviderVersions,
  limits?: LimitsService,
  glmCheck?: GlmCheckService,
): Handler<'providers.list'> {
  return async () => {
    const registry = await loadProviders();
    await versions?.ready;
    const providers = await Promise.all(
      Object.values(registry).map(async (entry) => {
        let key: string | null = null;
        if (entry.runner.secret !== undefined) {
          try {
            key = await readSecret(entry.runner.secret);
          } catch {
            throw new HostError('internal', 'Unable to read provider key');
          }
        }
        const readiness = await providerReadiness(entry, {
          keyPresent: key !== null,
          probeVersion: (command) => versions?.fresh(command) ?? Promise.resolve(null),
        });
        return {
          id: entry.id,
          label: entry.label,
          available: readiness.needs === null && readiness.error === null,
          needs: readiness.needs,
          ...(entry.runner.secret === undefined ? {} : { keyHint: key === null ? null : secretHint(key) }),
          family: entry.family ?? null,
          models: selectableModels(entry),
          effort: supportsEffort(entry),
          ...(entry.runner.secret === undefined || glmCheck === undefined ? {} : { check: await glmCheck.current(key) }),
        };
      }),
    );
    // Лимиты берутся последними и разом, уже после всех ожиданий: событие `providers.limitsChanged`,
    // пришедшее пока список собирался, окно получило раньше ответа, и ответ не должен вернуть ему
    // старое значение.
    return {
      providers: providers.map((item) => ({
        ...item,
        // GLM's fresh probe refreshes the shared command before either family's row reads it.
        version: versions?.get(registry[item.id]!.runner.command) ?? null,
        limits: limits?.get(item.id) ?? null,
      })),
    };
  };
}

/** A provider id cannot select an arbitrary field in the secret store. */
async function providerSecret(provider: string): Promise<SecretId> {
  const registry = await loadProviders();
  const entry = Object.hasOwn(registry, provider) ? registry[provider] : undefined;
  if (entry?.id !== provider || entry.runner.secret !== 'zai') {
    throw new HostError('bad_request', 'Provider does not support a saved key');
  }
  return entry.runner.secret;
}

export function createProvidersSetKey(limits?: LimitsService, glmCheck?: GlmCheckService): Handler<'providers.setKey'> {
  return async ({ provider, key }, request) => {
    const secret = await providerSecret(provider);
    let keyHint: string;
    try {
      keyHint = await writeSecret(secret, key);
    } catch (error) {
      if (error instanceof SecretFormatError) throw new HostError('bad_request', error.message);
      throw new HostError('internal', 'Unable to save provider key');
    }
    limits?.invalidateGlm();
    // Сохранённый заново ключ проверяется заново: прежний исход забывается вместе с файлом.
    await glmCheck?.forget();
    request.host.broadcast('providers.changed', { provider });
    return { keyHint };
  };
}

export const providersSetKey = createProvidersSetKey();

export function createProvidersClearKey(limits?: LimitsService, glmCheck?: GlmCheckService): Handler<'providers.clearKey'> {
  return async ({ provider }, request) => {
    const secret = await providerSecret(provider);
    try {
      await clearSecret(secret);
    } catch {
      throw new HostError('internal', 'Unable to clear provider key');
    }
    limits?.invalidateGlm();
    // Удалённый ключ уносит и исход своей проверки: отпечаток не должен пережить сам ключ.
    await glmCheck?.forget();
    request.host.broadcast('providers.changed', { provider });
    return { ok: true };
  };
}

export const providersClearKey = createProvidersClearKey();

/**
 * Явная проверка сохранённого ключа (Check again в карточке GLM и сохранение ключа). Сначала локально —
 * CLI нужной версии и ключ, тем же `providerReadiness`, что у `providers.list`; только готовому
 * провайдеру — тестовое сообщение Z.ai. Не готов — `null` без сети: чего не хватает, окно видит в
 * `providers.list.needs`.
 */
export function createProvidersCheck(
  versions: ProviderVersions | undefined,
  glmCheck: GlmCheckService,
): Handler<'providers.check'> {
  return async ({ provider }) => {
    const registry = await loadProviders();
    const entry = Object.hasOwn(registry, provider) ? registry[provider] : undefined;
    if (entry?.id !== provider || entry.runner.secret !== 'zai') {
      throw new HostError('bad_request', 'Provider does not support a key check');
    }
    let key: string | null;
    try {
      key = await readSecret(entry.runner.secret);
    } catch {
      throw new HostError('internal', 'Unable to read provider key');
    }
    await versions?.ready;
    const readiness = await providerReadiness(entry, {
      keyPresent: key !== null,
      probeVersion: (command) => versions?.fresh(command) ?? Promise.resolve(null),
    });
    if (key === null || readiness.needs !== null || readiness.error !== null) return { check: null };
    return { check: await glmCheck.run(key) };
  };
}

export function createProvidersRefreshLimits(limits: LimitsService): Handler<'providers.refreshLimits'> {
  return async () => {
    try {
      await limits.refresh(true);
    } catch (error) {
      throw new HostError('internal', 'Unable to refresh GLM quota', {
        provider: 'glm', reason: error instanceof ZaiQuotaError ? error.reason : 'unavailable',
      });
    }
    return { ok: true };
  };
}
