/**
 * Модель из диалога запуска против списка провайдера (дизайн комнат, 3.2, решение 5).
 *
 * Окно предлагает только значения списка (`providers.list.models`), а хост не пускает в команду
 * ничего сверх него: выбор вне списка — `bad_request`, CLI такое значение не получает. Пустая
 * модель, как и её отсутствие, — «по умолчанию»: без флага, модель CLI по умолчанию.
 *
 * Провайдер без списка (у `glm`, у своего в `providers.json` без поля `models`) — прежнее правило:
 * значение идёт в команду, если шаблон запуска принимает `{model}`, иначе шаблон отбрасывает его
 * сам. Неизвестный провайдер здесь не ловится: об этом скажет сам запуск. Саму проверку ведёт core
 * (`modelChoiceError`): её же зовёт `spawn_session` агента, и два входа не расходятся.
 */

import { loadProviders, modelChoiceError } from '@parley/core';
import { HostError } from '../errors.js';

/**
 * Возвращает модель для команды: `undefined` — «по умолчанию» (пусто или не выбрано). Зовётся до
 * создания записи в карте: отказ не должен оставлять `pending`-сессию, которую нечем запустить.
 */
export async function resolveModelChoice(
  provider: string,
  model: string | undefined,
): Promise<string | undefined> {
  if (model === undefined || model === '') return undefined;

  const entry = (await loadProviders())[provider];
  if (entry === undefined) return model;
  // Правило одно с `spawn_session` MCP: оно живёт в core рядом со списками (`modelChoiceError`).
  const refusal = modelChoiceError(entry, model);
  if (refusal !== null) throw new HostError('bad_request', refusal);
  return model;
}
