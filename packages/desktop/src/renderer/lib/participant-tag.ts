/**
 * Подпись участника переписки в ленте «вся почта работы»: известная сессия —
 * `S03 (Codex)`, человек — `Вы`, системное письмо хоста — `Система`, удалённая
 * сессия — `S02 (удалена)`, чужой id — как есть. Перенос `participantTag` из
 * `tui/src/room-view.ts` (дизайн комнаты §4), расширенный на `human`/`system`
 * из карты v2 (`Message.from` их допускает, `room-view.ts` — старого образца
 * и о них не знает).
 *
 * Модель сессии приходит уже посчитанной (`LiveMetrics.model` из
 * `store/activity.ts`), а не резолвером по id, как в оригинале: рендерер тянет
 * из `@harnas/core` только типы (`import type`) — рантайм `model-badge.ts`
 * идёт через `providers.ts`, который на верхнем уровне модуля трогает
 * `node:fs`, а песочница окна (`contextIsolation`, `sandbox`, без
 * `nodeIntegration` — `main/window.ts`) рантайм core не пропускает. Тот же
 * приём — в `lib/participant.ts` (`sessionTag`) и `lib/dot-state.ts`
 * (`displayStatus`).
 */

import type { WorkMap } from '@harnas/core';
import { sessionTag } from './participant.js';

// Те же литералы, что `HUMAN`/`SYSTEM` в `core/work/types.ts` — импортировать
// оттуда можно только тип, значения пришлось продублировать (см. комментарий
// выше).
const HUMAN = 'human';
const SYSTEM = 'system';
/** `<synthetic>` — служебная пометка Claude Code, не модель (`core/counters.ts`). */
const SYNTHETIC_MODEL = '<synthetic>';

/** Семейства Claude, у которых версия в подписи сохраняется (дизайн комнаты, 4). */
const CLAUDE_VERSIONED = /^claude-(opus|sonnet|haiku|fable)\b(.*)$/;
const GPT_VERSIONED = /^gpt\b(.*)$/;
/** Хвост вида `20251001`: дата сборки модели, а не часть версии. */
const DATE_SUFFIX = /^\d{8}$/;
/** Столько символов незнакомого имени модели видно, прежде чем его обрезать. */
const MAX_RAW = 12;

/** Числа версии из хвоста id модели, дата на конце отбрасывается. */
function versionOf(rest: string): string {
  const segments = rest.split('-').filter((segment) => segment !== '');
  const last = segments[segments.length - 1];
  const numbered = last !== undefined && DATE_SUFFIX.test(last) ? segments.slice(0, -1) : segments;
  return numbered.join('.');
}

/**
 * Имя модели с версией — перенос `modelName` из `core/model-badge.ts`
 * (значением, по той же причине, что и выше). `modelBadge` (короткий бейдж
 * без версии) сюда не переносится: он рендереру не нужен, а версия в подписи
 * участника нужна — иначе `S01 (Opus)` и `S03 (Opus)` разных версий было бы
 * не различить.
 */
function modelName(model: string | null): string | null {
  if (model === null || model === SYNTHETIC_MODEL) return null;

  const normalized = model.toLowerCase();
  if (normalized.includes('codex')) return 'Codex';

  const claude = CLAUDE_VERSIONED.exec(normalized);
  if (claude !== null) {
    const family = claude[1] as string;
    const label = `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
    const version = versionOf(claude[2] as string);
    return version === '' ? label : `${label} ${version}`;
  }

  const gpt = GPT_VERSIONED.exec(normalized);
  if (gpt !== null) {
    const rest = (gpt[1] as string).replace(/^-/, '');
    return rest === '' ? 'GPT' : `GPT-${rest}`;
  }

  return model.length > MAX_RAW ? `${model.slice(0, MAX_RAW)}…` : model;
}

/**
 * Подпись участника: известная сессия — `S03 (Codex)`, где имя модели берётся
 * из `models`, а если модель неизвестна (сессия ещё не писала) — подпись
 * провайдера из `providers.list`, а если и там провайдера нет — его сырой id.
 * Удалённая сессия — `S02 (удалена)`, чужой id — как есть.
 */
export function participantTag(
  map: WorkMap,
  id: string,
  model: string | null,
  providers: Array<{ id: string; label: string }>,
): string {
  if (id === HUMAN) return 'Вы';
  if (id === SYSTEM) return 'Система';

  const session = map.sessions.find((candidate) => candidate.id === id);
  if (session === undefined) {
    return (map.work.deletedSessions ?? []).includes(id) ? `${sessionTag(id)} (удалена)` : id;
  }
  const providerLabel = providers.find((entry) => entry.id === session.provider)?.label ?? session.provider;
  const name = modelName(model) ?? providerLabel;
  return `${sessionTag(id)} (${name})`;
}
