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
import type { LimitsService } from '../limits/limits-service.js';
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
 */
export function createProvidersList(
  versions?: ProviderVersions,
  limits?: LimitsService,
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
        limits: item.id === 'glm' ? null : limits?.get(item.id) ?? null,
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

export const providersSetKey: Handler<'providers.setKey'> = async ({ provider, key }, request) => {
  const secret = await providerSecret(provider);
  let keyHint: string;
  try {
    keyHint = await writeSecret(secret, key);
  } catch (error) {
    if (error instanceof SecretFormatError) throw new HostError('bad_request', error.message);
    throw new HostError('internal', 'Unable to save provider key');
  }
  request.host.broadcast('providers.changed', { provider });
  return { keyHint };
};

export const providersClearKey: Handler<'providers.clearKey'> = async ({ provider }, request) => {
  const secret = await providerSecret(provider);
  try {
    await clearSecret(secret);
  } catch {
    throw new HostError('internal', 'Unable to clear provider key');
  }
  request.host.broadcast('providers.changed', { provider });
  return { ok: true };
};
