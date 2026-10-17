/**
 * Пометка «You (via assistant)» в Chat (спека 2026-10-14, 7.4): агенту текст уходит как есть, а хост помнит, что
 * отправил помощник (`assistant.sent`). Сообщение человека в ленте — от помощника, если совпал текст без учёта
 * пробелов и время — от 5 с до записи до 2 мин после.
 */

import { useEffect, useState } from 'react';
import { normalizeSentText } from '@parley/core/assistant';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';

export const VIA_WINDOW_MS = 2 * 60_000;
const SKEW_MS = 5000;

export function viaAssistantIds(items: readonly FeedItem[], sent: ReadonlyArray<{ text: string; at: string }>): Set<string> {
  const ids = new Set<string>();
  const entries = sent.map((entry) => ({ text: normalizeSentText(entry.text), at: Date.parse(entry.at), used: false }));
  for (const item of items) {
    if (item.kind !== 'prompt') continue;
    const text = normalizeSentText(item.text);
    const at = Date.parse(item.at);
    const match = entries.find((entry) => !entry.used && entry.text === text && at >= entry.at - SKEW_MS && at - entry.at <= VIA_WINDOW_MS);
    if (match === undefined) continue;
    match.used = true;
    ids.add(item.id);
  }
  return ids;
}

export function useAssistantSent(bridge: ParleyBridge, ref: SessionRef | null, supported: boolean): Array<{ text: string; at: string }> {
  const [sent, setSent] = useState<Array<{ text: string; at: string }>>([]);
  const key = ref === null ? null : `${ref.projectPath}\u0000${ref.workId}\u0000${ref.sessionId}`;
  useEffect(() => {
    if (ref === null || !supported) return;
    let alive = true;
    const load = (): void => {
      void bridge.call('assistant.sent', { ref }).then((result) => {
        if (alive) setSent(result.items);
      }, () => {});
    };
    load();
    const off = bridge.on('assistant.changed', (state) => {
      if (state.outcome === 'sent') load();
    });
    return () => {
      alive = false;
      off();
    };
    // ref сравнивается по ключу: объект пересоздаётся на каждом рендере.
  }, [bridge, key, supported]);
  return sent;
}
