/**
 * Транскрипт субагента — его лента `feed.snapshot { ref, agentId }` (план 2026-10-01, кусок 4b; панель агентов,
 * спека 2026-10-07, 5.1). Общий для карточки в ленте и экрана агента в панели. Состояние держит вызывающий (лента — по
 * `id` карточки, чтобы пережить размонтирование строки виртуальным списком). Показанный транскрипт перечитывается без
 * «loading», а ошибка перечитывания оставляет прежние элементы. Пока агент работает и транскрипт показан, он
 * перечитывается при росте `toolCount` не чаще `periodMs`; на конец агента — ещё раз.
 */

import { useEffect, useRef } from 'react';
import type { FeedAgent, FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';

/** Сколько последних элементов транскрипта показывается. */
export const TRANSCRIPT_TAIL = 200;

export type Transcript = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: FeedItem[] };

/** Обновление транскрипта; `null` — свёрнут. */
export type TranscriptUpdate = (was: Transcript | null) => Transcript | null;

export function requestTranscript(bridge: ParleyBridge, ref: SessionRef, agentId: string, set: (update: TranscriptUpdate) => void): void {
  set((was) => (was?.state === 'ready' ? was : { state: 'loading' }));
  bridge.call('feed.snapshot', { ref, agentId }).then(
    (snapshot) => set((was) => (was === null ? was : { state: 'ready', items: snapshot.items })),
    (error: unknown) => {
      console.warn('[parley] feed.snapshot agent', decodeIpcError(error).message);
      set((was) => (was === null || was.state === 'ready' ? was : { state: 'error' }));
    },
  );
}

export function useLiveTranscript(
  agent: Pick<FeedAgent, 'agentId' | 'status' | 'toolCount'>,
  shown: boolean,
  reload: () => void,
  periodMs = 3000,
): void {
  const seen = useRef({ count: agent.toolCount, status: agent.status });
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useEffect(() => {
    const was = seen.current;
    seen.current = { count: agent.toolCount, status: agent.status };
    if (!shown || agent.agentId === null) return;
    if (was.status === 'running' && agent.status !== 'running') {
      clearTimeout(timer.current);
      timer.current = undefined;
      lastAt.current = Date.now();
      reloadRef.current();
      return;
    }
    if (agent.status !== 'running' || agent.toolCount === was.count || timer.current !== undefined) return;
    const wait = lastAt.current + periodMs - Date.now();
    if (wait <= 0) {
      lastAt.current = Date.now();
      reloadRef.current();
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      lastAt.current = Date.now();
      reloadRef.current();
    }, wait);
  }, [agent.agentId, agent.status, agent.toolCount, shown, periodMs]);

  useEffect(() => () => clearTimeout(timer.current), []);
}
