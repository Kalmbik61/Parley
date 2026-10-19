import {
  clearSecret,
  syncApiKeyApproval,
  loadProviders,
  providerReadiness,
  readSecret,
  SecretFormatError,
  secretHint,
  selectableModels,
  supportsEffort,
  writeSecret,
} from '@parley/core';
import type { ProviderEntry, SecretId } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { GlmCheckService } from '../limits/glm-check.js';
import type { LimitsService } from '../limits/limits-service.js';
import { ZaiQuotaError } from '../limits/zai-quota.js';
import type { CustomCheckService } from '../providers/custom-check.js';
import { serialized } from './custom-providers.js';
import type { CodexCatalog } from '../providers/codex-catalog.js';
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
 *
 * `models` у `codex` — из `loadProviders`: каталог самого CLI (`codex debug models`) из `codex-models.json`, пока
 * `providers.json` не задаёт свой список (спека нормалайзера, 5.2). Первую пробу ответ не ждёт: новый каталог
 * придёт событием `providers.changed`, а устаревший список просит обновить в фоне (`refreshIfStale`).
 * `argsOverridden` — `args` провайдера взяты из `providers.json`: окно объясняет этим пропавший выбор модели или
 * effort.
 */
export function createProvidersList(
  versions?: ProviderVersions,
  limits?: LimitsService,
  glmCheck?: GlmCheckService,
  catalog?: Pick<CodexCatalog, 'refreshIfStale'>,
  customCheck?: CustomCheckService,
): Handler<'providers.list'> {
  return async () => {
    catalog?.refreshIfStale();
    const registry = await loadProviders();
    await versions?.ready;
    const probes = new Map<string, Promise<string | null>>();
    const probeVersion = (command: string): Promise<string | null> => {
      let result = probes.get(command);
      if (result === undefined) {
        result = versions?.fresh(command) ?? Promise.resolve(null);
        probes.set(command, result);
      }
      return result;
    };
    const providers = await Promise.all(
      Object.values(registry).map(async (entry) => {
        if (versions?.get(entry.runner.command) === null) await probeVersion(entry.runner.command);
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
          probeVersion,
        });
        // Исход последней проверки: у своего провайдера — из его службы, у GLM — из `glmCheck`.
        const check =
          entry.runner.secret === undefined
            ? undefined
            : entry.custom !== undefined
              ? customCheck?.current(entry.id, key)
              : glmCheck === undefined
                ? undefined
                : await glmCheck.current(key);
        return {
          id: entry.id,
          label: entry.label,
          available: readiness.needs === null && readiness.error === null,
          needs: readiness.needs,
          ...(entry.runner.secret === undefined ? {} : { keyHint: key === null ? null : secretHint(key) }),
          family: entry.family ?? null,
          models: selectableModels(entry),
          effort: supportsEffort(entry),
          argsOverridden: entry.argsOverridden === true,
          ...(check === undefined ? {} : { check }),
          // Описание своего провайдера (спека 5.1): папка — runner.configDir; ключа здесь нет.
          ...(entry.custom === undefined || entry.runner.configDir === undefined ? {} : {
            custom: {
              preset: entry.custom.preset,
              baseUrl: entry.custom.baseUrl,
              auth: entry.custom.auth,
              models: { ...entry.custom.models },
              contextWindow: entry.custom.contextWindow,
              linkClaude: entry.custom.linkClaude,
              folder: entry.runner.configDir,
            },
          }),
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
async function providerSecret(provider: string): Promise<{ secret: SecretId; entry: ProviderEntry }> {
  const registry = await loadProviders();
  const entry = Object.hasOwn(registry, provider) ? registry[provider] : undefined;
  if (entry?.id !== provider || entry.runner.secret === undefined) {
    throw new HostError('bad_request', 'Provider does not support a saved key');
  }
  return { secret: entry.runner.secret, entry };
}

export function createProvidersSetKey(
  limits?: LimitsService,
  glmCheck?: GlmCheckService,
  customCheck?: CustomCheckService,
): Handler<'providers.setKey'> {
  return async ({ provider, key }, request) => {
    const { secret, entry } = await providerSecret(provider);
    // Ключ своего провайдера пишется в той же очереди, что saveCustom/deleteCustom, и запись проверяется заново
    // внутри неё: параллельное удаление не оставит ключ без провайдера (финальная рецензия).
    const save = async (): Promise<string> => {
      if (entry.custom !== undefined) await providerSecret(provider);
      try {
        return await writeSecret(secret, key);
      } catch (error) {
        if (error instanceof SecretFormatError) throw new HostError('bad_request', error.message);
        throw new HostError('internal', 'Unable to save provider key');
      }
    };
    const keyHint = entry.custom !== undefined ? await serialized(save) : await save();
    if (entry.custom !== undefined) customCheck?.forget(entry.id);
    else {
      limits?.invalidateGlm();
      // Сохранённый заново ключ проверяется заново: прежний исход забывается вместе с файлом.
      await glmCheck?.forget();
    }
    request.host.broadcast('providers.changed', { provider });
    return { keyHint };
  };
}

export const providersSetKey = createProvidersSetKey();

export function createProvidersClearKey(
  limits?: LimitsService,
  glmCheck?: GlmCheckService,
  customCheck?: CustomCheckService,
): Handler<'providers.clearKey'> {
  return async ({ provider }, request) => {
    const { secret, entry } = await providerSecret(provider);
    if (entry.custom !== undefined) {
      await serialized(async () => {
        await providerSecret(provider);
        try {
          await clearSecret(secret);
        } catch {
          throw new HostError('internal', 'Unable to clear provider key');
        }
        // Режим api-key: Claude Code помнит хвост ключа в своей папке; без ключа этой записи быть не должно (К17).
        try {
          await syncApiKeyApproval(entry.id, null);
        } catch {
          throw new HostError('internal', 'Unable to clear provider key approval');
        }
      });
      customCheck?.forget(entry.id);
    } else {
      try {
        await clearSecret(secret);
      } catch {
        throw new HostError('internal', 'Unable to clear provider key');
      }
      limits?.invalidateGlm();
      // Удалённый ключ уносит и исход своей проверки: отпечаток не должен пережить сам ключ.
      await glmCheck?.forget();
    }
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
  glmCheck: GlmCheckService | undefined,
  customCheck?: CustomCheckService,
): Handler<'providers.check'> {
  return async ({ provider }) => {
    const registry = await loadProviders();
    const entry = Object.hasOwn(registry, provider) ? registry[provider] : undefined;
    const isCustom = entry?.custom !== undefined;
    if (
      entry?.id !== provider ||
      entry.runner.secret === undefined ||
      (isCustom ? customCheck === undefined : entry.runner.secret !== 'zai' || glmCheck === undefined)
    ) {
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
    if (readiness.needs !== null || readiness.error !== null) return { check: null };
    if (isCustom) return { check: await customCheck!.run(entry, key) };
    if (key === null) return { check: null };
    return { check: await glmCheck!.run(key) };
  };
}

export function createProvidersRefreshLimits(limits: LimitsService, versions?: ProviderVersions): Handler<'providers.refreshLimits'> {
  return async () => {
    try {
      await Promise.all([
        limits.refresh(true),
        (async () => {
          if (versions === undefined) return;
          await versions.ready;
          const registry = await loadProviders();
          await Promise.all([...new Set(Object.values(registry).map(entry => entry.runner.command))].map(command => versions.fresh(command)));
        })(),
      ]);
    } catch (error) {
      throw new HostError('internal', 'Unable to refresh GLM quota', {
        provider: 'glm', reason: error instanceof ZaiQuotaError ? error.reason : 'unavailable',
      });
    }
    return { ok: true };
  };
}
