/**
 * Сессии удаляемого (или уже удалённого) своего провайдера (спека 2026-10-30, 5.8): число, из них живых, список до 10 и
 * «Continue on…» у каждой. Считается в окне: `works.list` присылает слитую по всем проектам картину, так что метод хоста
 * не нужен. Закрытые сессии не считаются — продолжать на другом провайдере нечего.
 */

import { useMemo } from 'react';
import type { SessionRef } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import { openSwitchAgent } from '../../store/switch-agent.js';
import { useWorksStore } from '../../store/works.js';
import { Button } from '../../ui/button.js';

const LIST_MAX = 10;

export function ProviderSessions({ providerId }: { providerId: string }): JSX.Element | null {
  const entries = useWorksStore((state) => state.entries);
  const rows = useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.map.sessions
          .filter((session) => session.provider === providerId && session.lifecycle !== 'closed')
          .map((session) => ({
            ref: { projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id } satisfies SessionRef,
            label: session.label,
            workTitle: entry.map.work.title,
            lifecycle: session.lifecycle,
          })),
      ),
    [entries, providerId],
  );
  if (rows.length === 0) return null;
  const live = rows.filter((row) => row.lifecycle === 'active').length;
  return (
    <div className="space-y-1.5" data-provider-sessions={rows.length}>
      <p className="text-xs">{S.customProviders.sessionsUse(rows.length, live)}</p>
      <ul className="space-y-1">
        {rows.slice(0, LIST_MAX).map((row) => (
          <li key={`${row.ref.projectPath}\u0000${row.ref.workId}\u0000${row.ref.sessionId}`} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">
              {row.label} <span className="text-muted-foreground">· {row.workTitle} · {row.lifecycle}</span>
            </span>
            <Button type="button" size="xs" variant="outline" onClick={() => openSwitchAgent(row.ref)}>
              {S.customProviders.continueOn}
            </Button>
          </li>
        ))}
      </ul>
      {rows.length > LIST_MAX ? <p className="text-xs text-muted-foreground">{S.customProviders.sessionsMore(rows.length - LIST_MAX)}</p> : null}
    </div>
  );
}
