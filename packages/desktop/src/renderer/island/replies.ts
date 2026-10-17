/**
 * Последний ответ агента для строк Done на острове. Сессия закончила ход — один разовый `feed.snapshot` на ключ Done
 * (`doneKey`: сессия и конец хода) и в строку идёт текст последнего ответа модели после последнего промпта человека.
 * Лента могла ещё не принять финальный текст (хук `Stop` и запись журнала приходят чуть позже активности) — тогда
 * один повтор через `REPLY_RETRY_MS`; ошибка вызова повторов не заводит, строка остаётся без текста.
 *
 * На ленты остров не подписывается (см. шапку `requests.ts`): только разовые снимки. Ключи, которых больше нет среди
 * Done (посмотрели в Parley, снова заработала, Clear), `prune` выкидывает вместе с текстом, а ответ снимка,
 * ушедшего после этого, отбрасывается.
 */

import { create } from 'zustand';
import type { FeedItem } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { IslandBridge } from '../../shared/island.js';

/** Пауза перед единственным повтором снимка, если текста ответа в ленте ещё не было. */
export const REPLY_RETRY_MS = 1500;

/**
 * Текст последнего ответа модели после последнего промпта человека (нет промпта — последний ответ вообще):
 * пробелы и переносы схлопнуты в один пробел, края срезаны. Нет ответа или он пуст — `null`.
 */
export function lastReply(items: readonly FeedItem[]): string | null {
  const afterPrompt = items.findLastIndex((item) => item.kind === 'prompt');
  const reply = items.slice(afterPrompt + 1).findLast((item) => item.kind === 'text');
  const text = reply?.kind === 'text' ? reply.text.replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text;
}

interface IslandRepliesState {
  /** Текст ответа по `doneKey`; `null` — снимок снят, а ответа нет. Ключа нет — снимок ещё идёт или не заказывался. */
  texts: Record<string, string | null>;
  bind(call: IslandBridge['call'] | null): void;
  fetch(ref: SessionRef, doneKey: string): void;
  prune(keep: ReadonlySet<string>): void;
}

let call: IslandBridge['call'] | null = null;
/** Ключи, по которым снимок уже заказан: второй заказ по тому же ключу — пустое место. */
const requested = new Set<string>();

export const useIslandReplies = create<IslandRepliesState>((set) => {
  /** `retry` — это и есть повтор: после него новых повторов нет. */
  const load = async (ref: SessionRef, doneKey: string, retry: boolean): Promise<void> => {
    const current = call;
    if (current === null) return;
    let text: string | null = null;
    let failed = false;
    try {
      text = lastReply((await current('feed.snapshot', { ref, scope: 'attention' })).items);
    } catch {
      failed = true;
    }
    // Ключ ушёл из Done, пока снимок шёл, — ответ устарел.
    if (!requested.has(doneKey)) return;
    set((state) => ({ texts: { ...state.texts, [doneKey]: text } }));
    if (text !== null || failed || retry) return;
    setTimeout(() => {
      if (requested.has(doneKey)) void load(ref, doneKey, true);
    }, REPLY_RETRY_MS);
  };

  return {
    texts: {},
    bind: (next) => {
      call = next;
    },
    fetch: (ref, doneKey) => {
      if (call === null || requested.has(doneKey)) return;
      requested.add(doneKey);
      void load(ref, doneKey, false);
    },
    prune: (keep) => {
      for (const key of [...requested]) if (!keep.has(key)) requested.delete(key);
      set((state) => {
        const entries = Object.entries(state.texts);
        const kept = entries.filter(([key]) => keep.has(key));
        return kept.length === entries.length ? state : { texts: Object.fromEntries(kept) };
      });
    },
  };
});
