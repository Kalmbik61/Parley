import { INBOX_CUT_BYTES, INBOX_MAX_BYTES, INBOX_MAX_LETTERS } from '../work/context-budget.js';
import { mcpResultBytes, shrinkText } from '../work/context-pages.js';
import type { Message } from '../work/types.js';

/** Поля ответа почты рядом с `messages`: задания плана, остаток и общая подсказка. */
export interface InboxExtras {
  openAssignments?: number;
  remaining?: number;
  hint?: string;
}

/** Поля ответа для страницы: подсказки идут в порядке «остаток, обрезка, задания»; без остатка и обрезки форма прежняя. */
function pageExtras(
  remaining: number,
  cutId: string | null,
  notice: { openAssignments?: number; hint?: string },
): InboxExtras {
  const hints = [
    remaining > 0 ? `${remaining} more unread: call check_inbox again.` : null,
    cutId === null ? null : `Message ${cutId} is cut: get_map with field "message" and id "${cutId}" reads it whole.`,
    notice.hint ?? null,
  ].filter((part): part is string => part !== null);
  return {
    ...(notice.openAssignments === undefined ? {} : { openAssignments: notice.openAssignments }),
    ...(remaining > 0 ? { remaining } : {}),
    ...(hints.length === 0 ? {} : { hint: hints.join(' ') }),
  };
}

/** Бюджет страницы в символах (`JSON.stringify` ответа `{ messages, ...extras }`) вместо байтов результата MCP. */
export interface InboxCharLimit {
  chars: number;
}

/** Письмо, не влезшее первым, урезается до бюджета; экранирование JSON может раздуть текст, поэтому бюджет сужается, пока страница не влезет. */
function cutToChars<V extends { text: string }>(view: V, limit: InboxCharLimit, build: (cut: V) => string): V {
  let bytes = limit.chars;
  let cut = shrinkText(view, bytes);
  while (build(cut).length > limit.chars && bytes > 512) {
    bytes = Math.floor(bytes / 2);
    cut = shrinkText(view, bytes);
  }
  return cut;
}

/**
 * Одна страница почты: старейшие письма, пока ответ `{ state: 'message', ... }` (форма `wait_for`, `check_inbox` меньше) не
 * превысит `INBOX_MAX_BYTES` и письмо не окажется пятьдесят первым. Хотя бы одно письмо отдаётся всегда: если оно одно
 * не влезает, его текст урезается до `INBOX_CUT_BYTES`. Прочитанными помечают только `ids`.
 */
export function inboxPage<V extends { text: string }>(
  letters: readonly Message[],
  view: (message: Message) => V,
  notice: { openAssignments?: number; hint?: string },
  limit?: InboxCharLimit,
): { messages: V[]; ids: string[]; extras: InboxExtras } {
  const fits = (list: V[], more: InboxExtras): boolean => limit === undefined
    ? mcpResultBytes({ state: 'message', messages: list, ...more }) <= INBOX_MAX_BYTES
    : JSON.stringify({ messages: list, ...more }).length <= limit.chars;
  const messages: V[] = [];
  const ids: string[] = [];
  let cutId: string | null = null;
  let extras = pageExtras(letters.length, null, notice);
  for (const letter of letters) {
    if (ids.length >= INBOX_MAX_LETTERS) break;
    const left = letters.length - ids.length - 1;
    const whole = view(letter);
    const wholeExtras = pageExtras(left, cutId, notice);
    if (fits([...messages, whole], wholeExtras)) {
      messages.push(whole);
      extras = wholeExtras;
    } else if (ids.length > 0) {
      break;
    } else {
      cutId = letter.id;
      extras = pageExtras(left, cutId, notice);
      messages.push(limit === undefined
        ? shrinkText(whole, INBOX_CUT_BYTES)
        : cutToChars(whole, limit, (cut) => JSON.stringify({ messages: [cut], ...extras })));
    }
    ids.push(letter.id);
  }
  return { messages, ids, extras };
}
