/**
 * Письма вместе с указателем (план «Fewer mail turns», 3.2): на `UserPromptSubmit`, чей промпт — указатель Parley на письма
 * (`pointerText`), хост сам забирает страницу почты сессии так же, как `check_inbox` (`takeInlineMail`), и отвечает хуку
 * `additionalContext` с ней. Агент получает письма тем же ходом и не тратит ход на `check_inbox`.
 *
 * Любая неудача — ответ `{}` и ничего не помечено прочитанным: указатель остаётся прежним, агент вызовет `check_inbox`, как и
 * раньше. Сюда входят не указатель, не Claude (Codex не трогаем), пустая почта, ограда сна, устаревший агент, сбой записи и
 * ответ позже `INLINE_MAIL_BUDGET_MS`.
 */

import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { INLINE_MAIL_EVENT, isPointerText, takeInlineMail, workPaths } from '@parley/core';
import type { McpContext } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import { EMPTY_HOOK_RESPONSE } from './decisions.js';
import type { HookRequest } from './hook-server.js';

/** Сколько хост отвечает хуку: позже — без писем. */
export const INLINE_MAIL_BUDGET_MS = 2000;
/** Ожидание записи почты внутри бюджета: запись, не успевшая взять блокировку, ничего не помечает. */
const LOCK_TIMEOUT_MS = 1500;

export interface InlineMailDeps {
  log: Log;
  /** Провайдер сессии по карте работ; `undefined` — работы или сессии нет. */
  provider(ref: SessionRef): string | undefined;
  /** Контекст исполнителя инструментов сессии (тот же, что у `/agent/tools`); `agentRevision` — запуска, которому выдан токен. */
  context(ref: SessionRef, launch: { agentRevision?: string }): Promise<McpContext>;
  /** Журнал доставок; по умолчанию — строка в `events/<сессия>.jsonl` работы. */
  journal?(ref: SessionRef, letters: number): void;
}

const defaultJournal = (ref: SessionRef, letters: number): void => {
  const file = path.join(workPaths(ref.projectPath, ref.workId).events, `${ref.sessionId}.jsonl`);
  // Каталога `events/` нет — сессия без хуков: не создаём. Отметка — подсказка метрикам, без неё доставка остаётся доставкой.
  appendFile(file, `${JSON.stringify({ hook_event_name: INLINE_MAIL_EVENT, letters })}\n`, 'utf8').catch(() => {});
};

export interface InlineMail {
  /** `true` — хук принят и будет отвечен здесь; `false` — не наш случай, ответ за вызывающим. */
  handle(request: HookRequest): boolean;
}

export function createInlineMail(deps: InlineMailDeps): InlineMail {
  const journal = deps.journal ?? defaultJournal;
  return {
    handle(request) {
      const { body, ref } = request;
      if (body['hook_event_name'] !== 'UserPromptSubmit') return false;
      const prompt = body['prompt'];
      if (typeof prompt !== 'string' || !isPointerText(prompt)) return false;
      const provider = deps.provider(ref);
      if (provider === undefined || provider === 'codex') return false;

      let late = false;
      const answer = (text: string | null): void => {
        clearTimeout(timer);
        request.respond(text === null
          ? EMPTY_HOOK_RESPONSE
          : { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
      };
      const timer = setTimeout(() => {
        late = true;
        answer(null);
      }, INLINE_MAIL_BUDGET_MS);
      request.onAbandon(() => {
        late = true;
        clearTimeout(timer);
      });

      void (async () => {
        const context = await deps.context(ref, request.agentRevision === undefined ? {} : { agentRevision: request.agentRevision });
        // Ответили пустым по таймеру или хук оборван: письма не забираем.
        if (late) return;
        const taken = takeInlineMail(context, ref.sessionId, LOCK_TIMEOUT_MS);
        if (taken === null) return answer(null);
        try {
          journal(ref, taken.letters);
        } catch (error) {
          deps.log.warn('inline mail: journal line failed', { error: String(error) });
        }
        answer(taken.text);
      })().catch((error: unknown) => {
        // Устаревший агент, занятая запись, сбой хранилища: ничего не помечено, указатель сработает как раньше.
        deps.log.warn('inline mail: take failed, pointer stays', { ref, error: String(error) });
        answer(null);
      });
      return true;
    },
  };
}
