/**
 * Уровни effort для окна (нормалайзер модели и effort 2026-10-06, 5.1 и 5.3): те же правила, что `effortsFor` в core,
 * но по строке ответа `providers.list` — рантайм core окну не нужен. Диалог новой сессии и меню чата берут уровни
 * отсюда, и это тот же список, по которому хост проверит выбор (`resolveModelEffort`).
 */

import type { EffortOption, ModelOption } from '@parley/protocol';
import { appI18n } from '../../shared/app-locale.js';
import { effortLabels } from '../../shared/catalogs/workspace.js';
import { S } from '../../shared/strings.js';

/**
 * Прежние три уровня — `LEGACY_EFFORTS` core: так отвечают старый хост (`effort: true`, у моделей нет `efforts`),
 * свой список моделей без уровней и провайдер без списка.
 */
export const LEGACY_EFFORTS: readonly EffortOption[] = [
  { id: 'low', get label() { return S.dialogs.newSession.effortLow; } },
  { id: 'medium', get label() { return S.dialogs.newSession.effortMedium; } },
  { id: 'high', get label() { return S.dialogs.newSession.effortHigh; } },
];

/** Что окну нужно знать о провайдере — поля строки `providers.list`. */
export interface EffortSource {
  models?: readonly ModelOption[] | null;
  effort?: boolean;
}

/** Уровни одной модели: поля `efforts` нет (свой список, старый хост) — прежние три; `null` — effort у модели нет. */
function levelsOf(model: ModelOption | undefined): readonly EffortOption[] | null {
  const efforts = model?.efforts;
  if (efforts === undefined) return LEGACY_EFFORTS;
  if (efforts === null || appI18n.locale === 'en') return efforts;
  return efforts.map((option) => {
    const labels = effortLabels.get(option.id);
    return labels !== undefined && option.label === labels[0] ? { ...option, label: labels[1] } : option;
  });
}

/**
 * Уровни выбора для модели; `model: null` — «Default»: уровни, общие для всех моделей провайдера с непустым списком,
 * в порядке первой из них. `null` — выбора effort нет: провайдер effort не принимает (`effort` не `true`, в том числе
 * ответа ещё нет), у модели уровней нет или общих нет. Пустой список окно показывает так же, как `null`: явного
 * уровня у такой модели хост всё равно не примет.
 */
export function effortChoices(info: EffortSource | undefined, model: string | null): readonly EffortOption[] | null {
  if (info?.effort !== true) return null;
  const list = info.models ?? [];
  if (list.length === 0) return LEGACY_EFFORTS;
  if (model !== null) {
    const levels = levelsOf(list.find((option) => option.id === model));
    return levels === null || levels.length === 0 ? null : levels;
  }
  const sets = list
    .map((option) => levelsOf(option))
    .filter((levels): levels is readonly EffortOption[] => levels !== null && levels.length > 0);
  const [first, ...rest] = sets;
  if (first === undefined) return null;
  const shared = first.filter((level) => rest.every((levels) => levels.some((other) => other.id === level.id)));
  return shared.length === 0 ? null : shared;
}
