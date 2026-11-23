/**
 * Цвет значка ветки worktree в сайдбаре: сессии одной работы, отведённые от общей базовой ветки, узнаются по общему
 * слоту из токенов `--branch-1…5` (`styles/tokens.css`). Слоты раздаёт чистая функция — `WorkCard` считает её один раз
 * на работу и отдаёт слот строкам сессий.
 *
 * Красится только общая база: у двух и более открытых (`lifecycle !== 'closed'`) worktree-сессий. Одиночная база и
 * закрытые сессии остаются вторичным цветом. Слот базы — FNV-1a 32 бит от её имени `% 5`; базы обходятся в порядке
 * сортировки строк (`a < b`, без locale), поэтому порядок сессий в карте цвета не меняет. Занятый слот — следующий
 * свободный по кругу; все пять заняты — слот по хэшу (повтор допустим).
 */

import type { WorkSession } from '@parley/core';

/** Классы цвета литералами: Tailwind 4 находит их по полным строкам в исходнике. */
export const BRANCH_COLOR_CLASS = ['text-branch-1', 'text-branch-2', 'text-branch-3', 'text-branch-4', 'text-branch-5'] as const;

const SLOTS = BRANCH_COLOR_CLASS.length;

/** FNV-1a 32 бит по кодовым единицам UTF-16 строки. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** База → слот 0…4; в карте только базы двух и более открытых worktree-сессий. */
export function branchColors(sessions: readonly WorkSession[]): ReadonlyMap<string, number> {
  const open = new Map<string, number>();
  for (const session of sessions) {
    if (session.worktree === null || session.lifecycle === 'closed') continue;
    open.set(session.worktree.base, (open.get(session.worktree.base) ?? 0) + 1);
  }
  const shared = [...open].filter(([, count]) => count >= 2).map(([base]) => base);
  shared.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const colors = new Map<string, number>();
  const taken = new Set<number>();
  for (const base of shared) {
    const hashed = fnv1a(base) % SLOTS;
    let slot = hashed;
    if (taken.size < SLOTS) {
      while (taken.has(slot)) slot = (slot + 1) % SLOTS;
    }
    taken.add(slot);
    colors.set(base, slot);
  }
  return colors;
}

/** Слот значка этой сессии; `null` — нет worktree, сессия закрыта или база не общая. */
export function sessionBranchColor(colors: ReadonlyMap<string, number>, session: WorkSession): number | null {
  if (session.worktree === null || session.lifecycle === 'closed') return null;
  return colors.get(session.worktree.base) ?? null;
}
