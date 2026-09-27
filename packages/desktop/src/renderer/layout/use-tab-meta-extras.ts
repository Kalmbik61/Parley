/**
 * `TabMetaExtras` из хранилищ (кусок 4.2) — один хук на строку вкладок: `TabStrip` зовёт его
 * один раз и отдаёт каждому `tabMeta`. 7.3 и 9.2 дописывают сюда свои поля.
 *
 * Структурное разделение (решение контролёра куска 4.2): хост шлёт `activity.changed` на
 * каждое изменение метрик сессии, а внимание от метрик не зависит. Селектор с поверхностным
 * сравнением отдаёт прежний словарь, пока значения `Attention` по refKey не изменились, — и
 * строки вкладок на метрики не перерисовываются.
 */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { WorkEntry } from '@harnas/core';
import { refKey } from '@harnas/protocol';
import { sessionAttention, type Attention } from '../attention/derive.js';
import { useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useWorksStore } from '../store/works.js';
import { EMPTY_EXTRAS, type TabMetaExtras } from './tab-meta.js';

function attentionBySession(entries: WorkEntry[], byRef: Record<string, ActivityEntry>): Record<string, Attention> {
  const out: Record<string, Attention> = {};
  for (const entry of entries) {
    for (const session of entry.map.sessions) {
      const key = refKey({ projectPath: entry.projectPath, workId: entry.map.work.id, sessionId: session.id });
      out[key] = sessionAttention(session, byRef[key]?.activity ?? null);
    }
  }
  return out;
}

/** attention — sessionAttention (3.2) каждой сессии снимка по её активности. Зовёт TabStrip, один раз на строку. */
export function useTabMetaExtras(): TabMetaExtras {
  const entries = useWorksStore((state) => state.entries);
  const attention = useActivityStore(useShallow((state) => attentionBySession(entries, state.byRef)));
  return useMemo(() => ({ ...EMPTY_EXTRAS, attention }), [attention]);
}
