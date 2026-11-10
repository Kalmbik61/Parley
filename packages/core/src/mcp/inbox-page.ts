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

/**
 * Одна страница почты: старейшие письма, пока ответ `{ state: 'message', ... }` (форма `wait_for`, `check_inbox` меньше) не
 * превысит `INBOX_MAX_BYTES` и письмо не окажется пятьдесят первым. Хотя бы одно письмо отдаётся всегда: если оно одно
 * не влезает, его текст урезается до `INBOX_CUT_BYTES`. Прочитанными помечают только `ids`.
 */
export function inboxPage<V extends { text: string }>(
  letters: readonly Message[],
  view: (message: Message) => V,
  notice: { openAssignments?: number; hint?: string },
): { messages: V[]; ids: string[]; extras: InboxExtras } {
  const messages: V[] = [];
  const ids: string[] = [];
  let cutId: string | null = null;
  let extras = pageExtras(letters.length, null, notice);
  for (const letter of letters) {
    if (ids.length >= INBOX_MAX_LETTERS) break;
    const left = letters.length - ids.length - 1;
    const whole = view(letter);
    const wholeExtras = pageExtras(left, cutId, notice);
    if (mcpResultBytes({ state: 'message', messages: [...messages, whole], ...wholeExtras }) <= INBOX_MAX_BYTES) {
      messages.push(whole);
      extras = wholeExtras;
    } else if (ids.length > 0) {
      break;
    } else {
      cutId = letter.id;
      messages.push(shrinkText(whole, INBOX_CUT_BYTES));
      extras = pageExtras(left, cutId, notice);
    }
    ids.push(letter.id);
  }
  return { messages, ids, extras };
}
