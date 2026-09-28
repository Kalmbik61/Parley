/**
 * `TabMetaExtras` из хранилищ (кусок 4.2) — один хук на строку вкладок: `TabStrip` зовёт его
 * один раз и отдаёт каждому `tabMeta`. 7.3a и 9.2a дописали сюда свои поля.
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
import { useBrowserStore, type BrowserTabState } from '../browser/store.js';
import { dirtyBufferKeys, useFilesStore } from '../files/store.js';
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

/** Id, заголовок и favicon вкладок браузера плоским списком: поверхностное сравнение — по значениям. */
function browserFields(tabs: Record<string, BrowserTabState>): Array<string | null> {
  return Object.entries(tabs).flatMap(([id, tab]) => [id, tab.title, tab.favicon]);
}

/**
 * attention — sessionAttention (3.2) каждой сессии снимка по её активности; dirtyTabIds — bufferKey
 * грязных буферов (7.3a). Зовёт TabStrip, один раз на строку. Ключи — массивом с поверхностным
 * сравнением: правка, которая не меняет «грязность», строки вкладок не перерисовывает.
 */
export function useTabMetaExtras(): TabMetaExtras {
  const entries = useWorksStore((state) => state.entries);
  const attention = useActivityStore(useShallow((state) => attentionBySession(entries, state.byRef)));
  const dirtyKeys = useFilesStore(useShallow((state) => dirtyBufferKeys(state.buffers)));
  // Загрузка и «назад / вперёд» страницы строки вкладок не перерисовывают — только заголовок и favicon (9.2a).
  const pageFields = useBrowserStore(useShallow((state) => browserFields(state.tabs)));
  const browser = useMemo(() => {
    const out: TabMetaExtras['browser'] = {};
    for (let i = 0; i + 2 < pageFields.length; i += 3) {
      out[pageFields[i] ?? ''] = { title: pageFields[i + 1] ?? null, favicon: pageFields[i + 2] ?? null };
    }
    return out;
  }, [pageFields]);
  return useMemo(
    () => ({ ...EMPTY_EXTRAS, attention, dirtyTabIds: new Set(dirtyKeys), browser }),
    [attention, dirtyKeys, browser],
  );
}
