/**
 * Удержанные хуки (план 2026-10-01, Task 2, п. 2): HTTP-запрос `PermissionRequest` или
 * `PreToolUse(AskUserQuestion)` висит, пока человек не ответит в окне. Запись — по сессии и карточке.
 *
 * Ответ уходит ровно один раз и только тремя путями: решение из окна (`resolve`), снятие без решения
 * (`settle`, `settleAll` — всегда `{}`), таймаут (`{}` и колбэк `onTimeout`: карточка станет `stale`).
 * Сам выбрать `allow` этот модуль не может — тело ответа ему приносят.
 */

import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { FeedCard } from '@parley/core';
import { EMPTY_HOOK_RESPONSE, type HeldHookEvent, type HookResponse } from './decisions.js';

/** Сколько хост держит хук: столько же, сколько таймаут хука в файле настроек (решение 1). */
export const PENDING_TIMEOUT_MS = 3_600_000;

export interface HeldHook {
  ref: SessionRef;
  cardId: string;
  hookEvent: HeldHookEvent;
  /** `tool_input` тела хука целиком: вопрос возвращает его в `updatedInput`. */
  rawToolInput: Record<string, unknown>;
  kind: FeedCard['kind'];
  /** Свой предел удержания (у Codex короче часа); без него — `PENDING_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Отвечает на HTTP-запрос хука; повторный вызов приёмник игнорирует. */
  respond(json: HookResponse): void;
}

/** Что известно об удержанном хуке — без права ответить. */
export type HeldHookInfo = Omit<HeldHook, 'respond'>;

export interface PendingHooksOptions {
  timeoutMs?: number;
  /** Хук ждал дольше предела и получил `{}`; карточку пора пометить `stale`. */
  onTimeout?: (ref: SessionRef, cardId: string) => void;
}

export interface PendingHooks {
  /** Держит хук. Прежний хук той же карточки (повтор запроса) получает `{}`. */
  hold(held: HeldHook): void;
  get(ref: SessionRef, cardId: string): HeldHookInfo | undefined;
  /** Все удержанные хуки сессии (без права ответить). */
  list(ref: SessionRef): HeldHookInfo[];
  /** Отвечает удержанному хуку телом решения; `false` — такого хука нет. */
  resolve(ref: SessionRef, cardId: string, json: HookResponse): boolean;
  /** Снимает без решения (`{}`) хуки сессии: перечисленных карточек или все. */
  settle(ref: SessionRef, cardIds?: readonly string[]): string[];
  /** Забывает хук без ответа: его запрос уже закрыт другой стороной. */
  drop(ref: SessionRef, cardId: string): boolean;
  /** Выключение: `{}` всем. */
  settleAll(): void;
  size(): number;
}

interface Entry {
  held: HeldHook;
  sessionKey: string;
  timer: NodeJS.Timeout;
}

const keyOf = (sessionKey: string, cardId: string): string => `${sessionKey}\u0000${cardId}`;

export function createPendingHooks(options: PendingHooksOptions = {}): PendingHooks {
  const timeoutMs = options.timeoutMs ?? PENDING_TIMEOUT_MS;
  const entries = new Map<string, Entry>();

  /** Снимает запись и отвечает; ответ, упавший у приёмника, на соседей не влияет. */
  function finish(key: string, json: HookResponse | null): HeldHook | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    entries.delete(key);
    clearTimeout(entry.timer);
    if (json !== null) {
      try {
        entry.held.respond(json);
      } catch {
        // Ответить некому (соединение уже закрыто) — запись всё равно снята.
      }
    }
    return entry.held;
  }

  return {
    hold(held) {
      const sessionKey = refKey(held.ref);
      const key = keyOf(sessionKey, held.cardId);
      finish(key, EMPTY_HOOK_RESPONSE);
      const timer = setTimeout(() => {
        const expired = finish(key, EMPTY_HOOK_RESPONSE);
        if (expired !== undefined) options.onTimeout?.(expired.ref, expired.cardId);
      }, held.timeoutMs ?? timeoutMs);
      // Висящий хук не держит процесс хоста живым: остановку решает хост, а не таймер.
      timer.unref();
      entries.set(key, { held, sessionKey, timer });
    },
    get(ref, cardId) {
      const entry = entries.get(keyOf(refKey(ref), cardId));
      if (entry === undefined) return undefined;
      const { ref: heldRef, hookEvent, rawToolInput, kind } = entry.held;
      return { ref: heldRef, cardId, hookEvent, rawToolInput, kind };
    },
    list(ref) {
      const sessionKey = refKey(ref);
      return Array.from(entries.values())
        .filter((entry) => entry.sessionKey === sessionKey)
        .map(({ held: { ref: heldRef, cardId, hookEvent, rawToolInput, kind } }) => ({
          ref: heldRef,
          cardId,
          hookEvent,
          rawToolInput,
          kind,
        }));
    },
    resolve(ref, cardId, json) {
      return finish(keyOf(refKey(ref), cardId), json) !== undefined;
    },
    settle(ref, cardIds) {
      const sessionKey = refKey(ref);
      const settled: string[] = [];
      for (const [key, entry] of Array.from(entries)) {
        if (entry.sessionKey !== sessionKey) continue;
        if (cardIds !== undefined && !cardIds.includes(entry.held.cardId)) continue;
        finish(key, EMPTY_HOOK_RESPONSE);
        settled.push(entry.held.cardId);
      }
      return settled;
    },
    drop(ref, cardId) {
      return finish(keyOf(refKey(ref), cardId), null) !== undefined;
    },
    settleAll() {
      for (const key of Array.from(entries.keys())) finish(key, EMPTY_HOOK_RESPONSE);
    },
    size: () => entries.size,
  };
}
