import { createElement, useEffect, useState } from 'react';
import type { SessionRole } from '@parley/core';
import type { RoleSummary, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { S } from '../../shared/strings.js';

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
    bridge.call('roles.list', { projectPath, ref: { projectPath, workId, sessionId } }).then(result => {
      if (!stale) setSummary({ key, value: result.roles.find(item => item.id === id) ?? null });
    }).catch(() => { /* Older/unavailable host: no inferred read-only flag. */ });
    return () => { stale = true; };
  }, [bridge, id, projectPath, workId, sessionId, key, revision]);
  return summary?.key === key ? summary.value : null;
}
export interface RoleChipProps { role: SessionRole | null | undefined; sessionRef?: SessionRef; bridge?: ParleyBridge; revision?: string }
export function RoleChip({ role, sessionRef, bridge, revision }: RoleChipProps): ReturnType<typeof createElement> | null {
  const current = useRoleSummary(bridge ?? window.parley, sessionRef, role, revision);
  if (!role) return null;
  return createElement('span', { 'data-role-chip': '', className: 'inline-flex min-w-0 shrink-0 items-center gap-1 truncate rounded bg-foreground/5 px-1.5 text-[10px]', title: current?.description ?? S.roles.unavailable },
    current?.readOnly ? createElement('span', { 'aria-label': S.roles.readOnly, title: S.roles.readOnly }, '🔒') : null,
    S.roles.option(current?.name ?? role.name, role.source));
}
