import { createElement, useEffect } from 'react';
import type { SessionRole } from '@parley/core';
import type { RoleSummary, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useRolesStore } from '../store/roles.js';

/**
 * Current display metadata only. Launch permissions are independently resolved by core.
 * Роли берутся из общего стора по проекту: все плашки проекта, в каком бы worktree ни стояли сессии, дают один
 * `roles.list` без `ref`. Если нужной роли в ответе нет, а у сессии есть свой worktree (`cwd` не равен `projectPath`),
 * плашка делает один запрос с `ref` и берёт каталог worktree: роль могла появиться только в ветке. Хост, ответивший
 * ошибкой, повторно не спрашивается: запрос в worktree идёт только после удачного ответа по проекту, а повтор — по TTL стора.
 */
export function useRoleSummary(bridge: ParleyBridge | undefined, sessionRef: SessionRef | undefined, role: SessionRole | null | undefined, cwd?: string): RoleSummary | null {
  const id = role ? `${role.source}:${role.name}` : null;
  const projectPath = sessionRef?.projectPath, workId = sessionRef?.workId, sessionId = sessionRef?.sessionId;
  const entry = useRolesStore(state => projectPath === undefined ? undefined : state.byKey[projectPath]);
  const worktree = cwd !== undefined && cwd !== projectPath ? cwd : undefined;
  const missing = id !== null && entry?.status === 'ready' && !entry.roles.some(item => item.id === id);
  const worktreeEntry = useRolesStore(state => worktree === undefined ? undefined : state.byKey[worktree]);
  const wantWorktree = missing && worktree !== undefined;
  useEffect(() => {
    if (!bridge || !id || projectPath === undefined) return;
    useRolesStore.getState().load(bridge, { projectPath, cwd: projectPath });
  }, [bridge, id, projectPath]);
  useEffect(() => {
    if (!bridge || !wantWorktree || projectPath === undefined || workId === undefined || sessionId === undefined || worktree === undefined) return;
    useRolesStore.getState().load(bridge, { projectPath, ref: { projectPath, workId, sessionId }, cwd: worktree });
  }, [bridge, wantWorktree, projectPath, workId, sessionId, worktree]);
  if (!id || !entry || entry.status === 'reloading') return null;
  if (entry.status === 'loading' && entry.roles.length === 0) return null;
  const found = entry.roles.find(item => item.id === id);
  if (found || worktree === undefined) return found ?? null;
  return worktreeEntry?.roles.find(item => item.id === id) ?? null;
}
export interface RoleChipProps { role: SessionRole | null | undefined; sessionRef?: SessionRef; bridge?: ParleyBridge; cwd?: string }
/**
 * Чип роли в тесной строке сжимается первым (жалоба 2026-10-07: в карточке участника комнаты имя схлопывалось, а слово
 * состояния уезжало за край). Сетка `auto minmax(0, max-content)`: 🔒 — своя колонка, она не сжимается, текст — до нуля
 * с многоточием в своём элементе (у голого текста в inline-flex многоточия нет). Наименьшая ширина чипа — поля и 🔒,
 * поэтому без `min-w-0`: замок не обрезается. Полная роль — первой строкой тултипа, описание — второй.
 */
export function RoleChip({ role, sessionRef, bridge, cwd }: RoleChipProps): ReturnType<typeof createElement> | null {
  const current = useRoleSummary(bridge ?? window.parley, sessionRef, role, cwd);
  if (!role) return null;
  const label = S.roles.option(current?.name ?? role.name, role.source);
  return createElement('span', { 'data-role-chip': '', className: 'inline-grid grid-cols-[auto_minmax(0,max-content)] items-center rounded bg-foreground/5 px-1.5 text-[10px]', title: [label, current?.description ?? S.roles.unavailable].filter(Boolean).join('\n') },
    current?.readOnly ? createElement('span', { 'aria-label': S.roles.readOnly, title: S.roles.readOnly, className: 'mr-1' }, '🔒') : null,
    createElement('span', { className: 'col-start-2 truncate' }, label));
}
