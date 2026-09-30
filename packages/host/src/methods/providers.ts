import { commandInPath, loadProviders, selectableModels, supportsEffort } from '@harnas/core';
import type { Handler } from '../context.js';
import type { LimitsService } from '../limits/limits-service.js';
import type { ProviderVersions } from '../providers/versions.js';

/**
 * `available` — команда провайдера видна в PATH (или через `HARNAS_*_BIN`-оверрайд). `models`,
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
      Object.values(registry).map(async (entry) => ({
        id: entry.id,
        label: entry.label,
        available: await commandInPath(entry.runner.command),
        models: selectableModels(entry),
        effort: supportsEffort(entry),
        version: versions?.get(entry.runner.command) ?? null,
      })),
    );
    // Лимиты берутся последними и разом, уже после всех ожиданий: событие `providers.limitsChanged`,
    // пришедшее пока список собирался, окно получило раньше ответа, и ответ не должен вернуть ему
    // старое значение.
    return {
      providers: providers.map((item) => ({ ...item, limits: limits?.get(item.id) ?? null })),
    };
  };
}
