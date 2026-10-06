/**
 * Модель и effort из диалога запуска против каталога провайдера (дизайн комнат, 3.2; спека нормалайзера, 5.3).
 *
 * Окно предлагает только значения каталога (`providers.list.models` и их `efforts`), а хост не пускает в команду
 * ничего сверх него: пара вне каталога — `bad_request`, CLI такое значение не получает. Пустое значение, как и
 * его отсутствие, — «по умолчанию»: без флага, CLI берёт своё.
 *
 * Правило одно с `spawn_session` MCP — `resolveModelEffort` в core: провайдер без своего списка, флаг без
 * подстановки в шаблоне, модель без уровней — всё решает он. Каталог Codex из `codex-models.json` подставляет
 * `loadProviders`, поэтому окно, хост и MCP проверяют выбор по одному списку. Неизвестный провайдер здесь не
 * ловится: об этом скажет сам запуск.
 */

import { loadProviders, resolveModelEffort, type ModelEffortChoice } from '@parley/core';
import { HostError } from '../errors.js';

/**
 * Разрешённый выбор для карты и команды: полей «по умолчанию» в нём нет. Зовётся до создания записи в карте:
 * отказ не должен оставлять `pending`-сессию, которую нечем запустить.
 */
export async function resolveModelChoice(
  provider: string,
  model?: string,
  effort?: string,
): Promise<ModelEffortChoice> {
  const choice: ModelEffortChoice = {
    ...(model === undefined || model === '' ? {} : { model }),
    ...(effort === undefined || effort === '' ? {} : { effort }),
  };
  if (choice.model === undefined && choice.effort === undefined) return choice;

  const entry = (await loadProviders())[provider];
  if (entry === undefined) return choice;
  const resolved = resolveModelEffort(entry, choice);
  if ('error' in resolved) throw new HostError('bad_request', resolved.error);
  return resolved.choice;
}
