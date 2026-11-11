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
import { byFamily, INLINE_MAIL_EVENT, isPointerText, takeInlineMail as coreTakeInlineMail, workPaths } from '@parley/core';
import type { McpContext } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import { EMPTY_HOOK_RESPONSE } from './decisions.js';
import type { HookRequest } from './hook-server.js';

/** Сколько хост отвечает хуку: позже — без писем. */
export const INLINE_MAIL_BUDGET_MS = 2000;
/** Меньше такого остатка бюджета письма не забираем: запись не успеет, а позже 2 с хук уже отвечен пустым. */
export const INLINE_MAIL_MIN_LEFT_MS = 100;

export interface InlineMailDeps {
  log: Log;
  /** Провайдер сессии по карте работ; `undefined` — работы или сессии нет. */
  provider(ref: SessionRef): string | undefined;
  /** Контекст исполнителя инструментов сессии (тот же, что у `/agent/tools`); `agentRevision` — запуска, которому выдан токен. */
  context(ref: SessionRef, launch: { agentRevision?: string }): Promise<McpContext>;
  /** Журнал доставок; по умолчанию — строка в `events/<сессия>.jsonl` работы. */
  journal?(ref: SessionRef, letters: number): void;
  /** Часы и забор писем подменяются тестами. */
  now?(): number;
  take?: typeof coreTakeInlineMail;
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
  const now = deps.now ?? Date.now;
  const take = deps.take ?? coreTakeInlineMail;
  return {
    handle(request) {
      const { body, ref } = request;
      if (body['hook_event_name'] !== 'UserPromptSubmit') return false;
      const prompt = body['prompt'];
      if (typeof prompt !== 'string' || !isPointerText(prompt)) return false;
      const provider = deps.provider(ref);
      if (provider === undefined || byFamily(provider, { claude: false, codex: true, qwen: true, neutral: true })) return false;

      const startedAt = now();
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
        // Хуку уже ответили (таймер, закрытие сервера, сбой ленты) или он оборван: новый ответ не дойдёт, письма не забираем.
        if (late || request.answered()) return;
        // Бюджет покрывает и сам забор: остаток уходит ожиданием записи, а мало осталось — отвечаем без писем.
        const left = INLINE_MAIL_BUDGET_MS - (now() - startedAt);
        if (left < INLINE_MAIL_MIN_LEFT_MS) return answer(null);
        const taken = take(context, ref.sessionId, left);
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

/**
 * Проводка приёмника хуков: указатель с письмами обрабатывает `inline`, а лента получает то же событие с глухим `respond`.
 * Без подмены лента отвечала бы `{}` синхронно, раньше письма, и каждое письмо указателя было бы помечено прочитанным и потеряно.
 */
export function hookWithInlineMail(inline: InlineMail, forward: (request: HookRequest) => void): (request: HookRequest) => void {
  return (request) => forward(inline.handle(request) ? { ...request, respond: () => {} } : request);
}
