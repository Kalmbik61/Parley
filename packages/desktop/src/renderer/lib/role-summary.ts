import { createElement, useEffect, useRef } from 'react';
import type { SessionRole } from '@parley/core';
import type { RoleSummary, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';
import { useRolesStore } from '../store/roles.js';

/**
 * Current display metadata only. Launch permissions are independently resolved by core.
 * Роли берутся из общего стора по рабочему каталогу (`cwd`, по умолчанию `projectPath` сессии): пачка плашек
 * одного каталога даёт один `roles.list`. Смена `revision` после монтирования перечитывает роли принудительно,
 * и пока идёт перезагрузка, хук отдаёт `null` — замок старой ревизии не висит; обновление по TTL роли не прячет.
 */
export function useRoleSummary(bridge: ParleyBridge | undefined, sessionRef: SessionRef | undefined, role: SessionRole | null | undefined, revision = '', cwd?: string): RoleSummary | null {
  const id = role ? `${role.source}:${role.name}` : null;
  const projectPath = sessionRef?.projectPath, workId = sessionRef?.workId, sessionId = sessionRef?.sessionId;
  const dir = cwd ?? projectPath;
  const entry = useRolesStore(state => dir === undefined ? undefined : state.byCwd[dir]);
  const seen = useRef(revision);
  useEffect(() => {
    if (!bridge || !id || projectPath === undefined || workId === undefined || sessionId === undefined || dir === undefined) return;
    const force = seen.current !== revision;
    seen.current = revision;
    useRolesStore.getState().load(bridge, { projectPath, ...(cwd === undefined ? {} : { ref: { projectPath, workId, sessionId } }), cwd: dir, ...(force ? { force: true } : {}) });
  }, [bridge, id, projectPath, workId, sessionId, dir, revision]);
  if (!id || !entry || entry.status === 'reloading') return null;
  if (entry.status === 'loading' && entry.roles.length === 0) return null;
  return entry.roles.find(item => item.id === id) ?? null;
}
export interface RoleChipProps { role: SessionRole | null | undefined; sessionRef?: SessionRef; bridge?: ParleyBridge; revision?: string; cwd?: string }
/**
 * Чип роли в тесной строке сжимается первым (жалоба 2026-10-07: в карточке участника комнаты имя схлопывалось, а слово
 * состояния уезжало за край). Сетка `auto minmax(0, max-content)`: 🔒 — своя колонка, она не сжимается, текст — до нуля
 * с многоточием в своём элементе (у голого текста в inline-flex многоточия нет). Наименьшая ширина чипа — поля и 🔒,
 * поэтому без `min-w-0`: замок не обрезается. Полная роль — первой строкой тултипа, описание — второй.
 */
export function RoleChip({ role, sessionRef, bridge, revision, cwd }: RoleChipProps): ReturnType<typeof createElement> | null {
  const current = useRoleSummary(bridge ?? window.parley, sessionRef, role, revision, cwd);
  if (!role) return null;
  const label = S.roles.option(current?.name ?? role.name, role.source);
  return createElement('span', { 'data-role-chip': '', className: 'inline-grid grid-cols-[auto_minmax(0,max-content)] items-center rounded bg-foreground/5 px-1.5 text-[10px]', title: [label, current?.description ?? S.roles.unavailable].filter(Boolean).join('\n') },
    current?.readOnly ? createElement('span', { 'aria-label': S.roles.readOnly, title: S.roles.readOnly, className: 'mr-1' }, '🔒') : null,
    createElement('span', { className: 'col-start-2 truncate' }, label));
}
