/**
 * Подписка окна на процессы PTY сессии (план `docs/plans/2026-11-09-session-shell-processes-plan.md`, этап C).
 *
 * Подписка активна, только пока `active` (вкладка на экране и сессия живая) и хост умеет
 * `processes.subscribe`; смена вкладки, `active: false` и размонтирование отписывают. Подписка живёт
 * на сокете хоста, поэтому после переподключения (`connections`) она берётся заново. Ревизия монотонна
 * лишь внутри одного запуска хоста — принятая ревизия живёт в замыкании эффекта и сбрасывается с
 * каждой новой подпиской, иначе снимки перезапущенного хоста отбрасывались бы как устаревшие.
 * Отказ подписки (в том числе `not_found`: живого PTY нет) — не ошибка: данных нет, чипа нет, в UI и
 * журнал ничего не выводится.
 */

import { useEffect, useState } from 'react';
import { refKey } from '@parley/protocol';
import type { SessionProcessesSnapshot, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { useHostSupports } from '../lib/capabilities.js';
import { useHostStore } from '../store/host.js';

export interface SessionProcessesState {
  /** `idle` — не подписаны; `loading` — подписались, снимка ещё нет; `failed` — подписка отклонена. */
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  snapshot: SessionProcessesSnapshot | null;
}

const IDLE: SessionProcessesState = { phase: 'idle', snapshot: null };

export function useSessionProcesses(bridge: ParleyBridge, ref: SessionRef, active: boolean): SessionProcessesState {
  const supported = useHostSupports('processes.subscribe');
  const connections = useHostStore((state) => state.connections);
  const connected = useHostStore((state) => state.status.state === 'connected');
  const [state, setState] = useState<SessionProcessesState>(IDLE);
  const { projectPath, workId, sessionId } = ref;

  useEffect(() => {
    if (!active || !supported || !connected) {
      setState(IDLE);
      return;
    }
    const sessionRef: SessionRef = { projectPath, workId, sessionId };
    const key = refKey(sessionRef);
    let cancelled = false;
    let lastRevision = -1;
    setState({ phase: 'loading', snapshot: null });

    const accept = (snapshot: SessionProcessesSnapshot): void => {
      if (cancelled || refKey(snapshot.ref) !== key || snapshot.revision <= lastRevision) return;
      lastRevision = snapshot.revision;
      setState({ phase: 'ready', snapshot });
    };
    const off = bridge.on('processes.changed', accept);
    bridge.call('processes.subscribe', { ref: sessionRef }).then(accept, () => {
      if (!cancelled) setState({ phase: 'failed', snapshot: null });
    });

    return () => {
      cancelled = true;
      off();
      bridge.call('processes.unsubscribe', { ref: sessionRef }).catch(() => {
        // Сокет уже закрыт или хост перезапущен: подписка умерла вместе с ним.
      });
    };
  }, [bridge, active, supported, connected, connections, projectPath, workId, sessionId]);

  return state;
}
