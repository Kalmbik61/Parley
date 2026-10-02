/**
 * Ответ удержанному хуку на решение человека из окна (план 2026-10-01, решение 4; формы проверены на
 * стенде, `evidence/p2b-hook-decisions` и `p4-questions-plan`). Чистая функция: ни часов, ни состояния.
 *
 * Рамка (Review Focus 5): `allow`/`deny` рождается только здесь и только из `FeedDecision`, который
 * пришёл запросом `feed.decide`. Всё, что хост отвечает хуку сам, — пустой `{}` (`EMPTY_HOOK_RESPONSE`).
 */

import type { FeedDecision } from '@parley/core';

/** Какой хук удержан: разрешение и план — `PermissionRequest`, вопрос агента — `PreToolUse`. */
export type HeldHookEvent = 'PermissionRequest' | 'PreToolUse';

/** Тело ответа хуку — JSON-объект. */
export type HookResponse = Record<string, unknown>;

/** «Без решения»: CLI ведёт себя так, будто хука не было, — диалог остаётся в терминале. */
export const EMPTY_HOOK_RESPONSE: HookResponse = Object.freeze({}) as HookResponse;

export interface HeldHookContext {
  hookEvent: HeldHookEvent;
  /** `tool_input` из тела удержанного хука целиком — не усечённый `toolInput` карточки. */
  rawToolInput: Record<string, unknown>;
  /** `permission_suggestions` карточки как есть: их уносит «Allow and don't ask again». */
  suggestions: readonly unknown[];
}

/** Режим после «Approve, auto-accept edits»: та же форма `setMode`, что проверена на стенде в p2b. */
const ACCEPT_EDITS = { type: 'setMode', mode: 'acceptEdits', destination: 'session' } as const;

function permissionOutput(decision: Record<string, unknown>): HookResponse {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

/**
 * JSON ответа удержанному хуку. Решение не того вида, что удержанный хук (вопрос на
 * `PermissionRequest`, разрешение на `PreToolUse`), — `{}`: такой ответ ничего за человека не решает.
 */
export function hookDecisionResponse(held: HeldHookContext, decision: FeedDecision): HookResponse {
  if (held.hookEvent === 'PermissionRequest') {
    if (decision.kind === 'permission') {
      if (decision.behavior === 'deny') {
        return permissionOutput({
          behavior: 'deny',
          ...(decision.message !== undefined ? { message: decision.message } : {}),
        });
      }
      return permissionOutput({
        behavior: 'allow',
        ...(decision.always === true ? { updatedPermissions: [...held.suggestions] } : {}),
      });
    }
    if (decision.kind === 'plan') {
      // «Approve, approve each edit» — просто allow (гипотеза: режим остаётся ручным; кусок 4 проверит).
      return permissionOutput({
        behavior: 'allow',
        ...(decision.choice === 'auto-accept' ? { updatedPermissions: [{ ...ACCEPT_EDITS }] } : {}),
      });
    }
    return EMPTY_HOOK_RESPONSE;
  }
  if (decision.kind === 'question') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...held.rawToolInput, answers: { ...decision.answers } },
      },
    };
  }
  return EMPTY_HOOK_RESPONSE;
}
