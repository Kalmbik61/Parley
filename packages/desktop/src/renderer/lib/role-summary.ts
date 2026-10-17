import { createElement, useEffect, useState } from 'react';
import type { SessionRole } from '@parley/core';
import type { Result, RoleSummary, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';

/** Столько ответ `roles.list` годится для новых плашек; как и на хосте, правку роли видно не позже этой паузы. */
const ROLES_TTL_MS = 30_000;
const rolesCache = new WeakMap<object, Map<string, { at: number; value: Promise<Result<'roles.list'>> }>>();

/**
 * Плашка роли есть у каждой сессии в сайдбаре, и все они монтируются разом: запрос на плашку давал пачку
 * одинаковых вызовов (на хосте — по процессу Codex на каждый). Одинаковый ключ — сессия и ревизия запуска —
 * делит один вызов; кэш на мост, чтобы разные соединения не делили ответы.
 */
function loadRoles(bridge: ParleyBridge, projectPath: string, workId: string, sessionId: string, revision: string): Promise<Result<'roles.list'>> {
  let cache = rolesCache.get(bridge);
  if (!cache) rolesCache.set(bridge, cache = new Map());
  const key = `${projectPath}\0${workId}\0${sessionId}\0${revision}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ROLES_TTL_MS) return hit.value;
  const entry = { at: now, value: bridge.call('roles.list', { projectPath, ref: { projectPath, workId, sessionId } }) };
  cache.set(key, entry);
  const map = cache;
  entry.value.catch(() => { if (map.get(key) === entry) map.delete(key); });
  return entry.value;
}

/** Current display metadata only. Launch permissions are independently resolved by core. */
export function useRoleSummary(bridge: ParleyBridge | undefined, sessionRef: SessionRef | undefined, role: SessionRole | null | undefined, revision = ''): RoleSummary | null {
  const [summary, setSummary] = useState<{ key: string; value: RoleSummary | null } | null>(null);
  const id = role ? `${role.source}:${role.name}` : null;
  const projectPath = sessionRef?.projectPath, workId = sessionRef?.workId, sessionId = sessionRef?.sessionId;
  const key = `${projectPath}\0${workId}\0${sessionId}\0${id}\0${revision}`;
  useEffect(() => {
    setSummary(null);
    if (!bridge || !id || projectPath === undefined || workId === undefined || sessionId === undefined) return;
    let stale = false;
    loadRoles(bridge, projectPath, workId, sessionId, revision).then(result => {
      if (!stale) setSummary({ key, value: result.roles.find(item => item.id === id) ?? null });
    }).catch(() => { /* Older/unavailable host: no inferred read-only flag. */ });
    return () => { stale = true; };
  }, [bridge, id, projectPath, workId, sessionId, key, revision]);
  return summary?.key === key ? summary.value : null;
}
export interface RoleChipProps { role: SessionRole | null | undefined; sessionRef?: SessionRef; bridge?: ParleyBridge; revision?: string }
/**
 * Чип роли в тесной строке сжимается первым (жалоба 2026-10-07: в карточке участника комнаты имя схлопывалось, а слово
 * состояния уезжало за край). Сетка `auto minmax(0, max-content)`: 🔒 — своя колонка, она не сжимается, текст — до нуля
 * с многоточием в своём элементе (у голого текста в inline-flex многоточия нет). Наименьшая ширина чипа — поля и 🔒,
 * поэтому без `min-w-0`: замок не обрезается. Полная роль — первой строкой тултипа, описание — второй.
 */
export function RoleChip({ role, sessionRef, bridge, revision }: RoleChipProps): ReturnType<typeof createElement> | null {
  const current = useRoleSummary(bridge ?? window.parley, sessionRef, role, revision);
  if (!role) return null;
  const label = S.roles.option(current?.name ?? role.name, role.source);
  return createElement('span', { 'data-role-chip': '', className: 'inline-grid grid-cols-[auto_minmax(0,max-content)] items-center rounded bg-foreground/5 px-1.5 text-[10px]', title: [label, current?.description ?? S.roles.unavailable].filter(Boolean).join('\n') },
    current?.readOnly ? createElement('span', { 'aria-label': S.roles.readOnly, title: S.roles.readOnly, className: 'mr-1' }, '🔒') : null,
    createElement('span', { className: 'col-start-2 truncate' }, label));
}
