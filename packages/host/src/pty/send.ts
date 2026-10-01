/**
 * `pty.send` (спека 8.6, кусок 5.1): окно отдаёт агенту текст «сразу, но с защитой» —
 * только по явному действию человека. Хост не вставляет текст в диалог агента
 * (`blocked`), не жмёт Enter поверх черновика или ввода человека и не печатает
 * одновременно с будильником (`busy`). Автоповторов нет: исход решает человек.
 */

import { hookedSince } from '@parley/core';
import { refKey } from '@parley/protocol';
import type { SendResult, SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import { HostError } from '../errors.js';
import type { WakeService } from '../wake/wake-service.js';
import {
  CODEX_SUBMIT_DELAY_MS,
  PASTE_END,
  PASTE_START,
  codexPaste,
  codexSubmitKey,
} from './codex-input.js';
import { stripEscapes } from './draft.js';
import type { PtyManager } from './pty-manager.js';
import { typeAndSubmit } from './type-and-submit.js';

/** Предел текста `pty.send` — 64 КиБ в байтах UTF-8 (сквозные ограничения плана). */
const MAX_SEND_BYTES = 64 * 1024;

// C0 кроме \t и \n, и DEL: управляющие байты в поле ввода агента — это клавиши, а не текст.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Очистка спеки 8.6, шаг 2; пусто или > 64 КиБ — HostError('bad_request'). */
export function sanitizeForSend(text: string): string {
  const clean = stripEscapes(text.replace(/\r\n?/g, '\n')).replace(CONTROL, '');
  if (clean.length === 0) throw new HostError('bad_request', 'empty text');
  if (Buffer.byteLength(clean, 'utf8') > MAX_SEND_BYTES) {
    throw new HostError('bad_request', 'text is longer than 64 KiB');
  }
  return clean;
}

const refused = (reason: 'blocked' | 'busy' | 'no-paste-mode'): SendResult => ({
  inserted: false,
  submitted: false,
  reason,
});

/** Держит «свой Enter в полёте» по ref: второй вызов той же сессии до исхода первого — busy. */
export function createSender(deps: {
  pty: PtyManager;
  activity: ActivityService;
  wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;
}): (params: { ref: SessionRef; text: string; submit: boolean }) => Promise<SendResult> {
  // Сессии, у которых вставка с submit ждёт своего Enter: иначе Enter первого вызова
  // отправил бы и текст второго, а тост второго сказал бы «без Enter».
  const waiting = new Set<string>();

  return async ({ ref, text, submit }) => {
    const handle = deps.pty.get(ref);
    if (handle === undefined) throw new HostError('not_found', 'session is not running');
    const codex = handle.provider === 'codex';
    const clean = sanitizeForSend(text);

    // Отсюда и до pty.write — ни одного await: иначе будильник успел бы напечатать
    // указатель между проверками и вставкой.
    // Пока агент показывает диалог, вставленные символы может прочитать сам диалог —
    // это был бы автоответ, запрещённый рамкой.
    const live = deps.activity.get(ref)?.activity;
    if (live?.activity === 'blocked') return refused('blocked');
    // Ни одного хука с запуска процесса — хост не знает, что у агента на экране: у свежей
    // сессии это может быть вопрос доверия к папке, где Enter выбрал бы «Yes, proceed»
    // (fix-final-b). Отвечаем как на blocked: человек смотрит в терминал сам.
    if (!hookedSince(live, handle.startedAt)) return refused('blocked');
    const key = refKey(ref);
    if (deps.wake.inFlight(ref) || waiting.has(key)) return refused('busy');
    const paste = handle.bracketedPaste();
    // Codex — всегда вставкой: без неё поток знаков он не считает вставкой, и Enter внутри него отправил бы
    // сообщение раньше времени. Режима вставки нет — TUI ещё не поднялся, и писать в него нечего.
    if (codex ? !paste : clean.includes('\n') && !paste) return refused('no-paste-mode');

    // Черновик считается до вставки: человека или хоста от прошлой вставки без Enter.
    const hadDraft = handle.hasDraft();
    const payload = codex
      ? codexPaste(clean)
      : paste
        ? `${PASTE_START}${clean}${PASTE_END}`
        : clean;
    const attempt = typeAndSubmit(
      { pty: deps.pty, enterDelayMs: deps.wake.enterDelayMs },
      ref,
      payload,
      submit && !hadDraft,
      {
        hostDraft: true,
        // blocked приходит хуком с задержкой: запрос разрешения мог появиться за паузу.
        beforeEnter: () => deps.activity.get(ref)?.activity.activity !== 'blocked',
        // У Codex своя пауза и своя клавиша: занятому агенту — Tab (очередь), а не Enter (вмешательство в ход).
        ...(codex
          ? {
              delayMs: CODEX_SUBMIT_DELAY_MS,
              submitKey: () => codexSubmitKey(deps.activity.get(ref)?.activity.activity),
            }
          : {}),
      },
    );

    if (!submit) return { inserted: true, submitted: false, reason: null };
    if (hadDraft) return { inserted: true, submitted: false, reason: 'draft' };

    waiting.add(key);
    try {
      const outcome = await attempt.done;
      if (outcome === 'submitted') return { inserted: true, submitted: true, reason: null };
      if (outcome === 'input') return { inserted: true, submitted: false, reason: 'input' };
      if (outcome === 'blocked') return { inserted: true, submitted: false, reason: 'blocked-before-enter' };
      // Остаётся restarted: попытку отправителя никто не отменяет, а typed бывает только без submit.
      return { inserted: true, submitted: false, reason: 'restarted' };
    } finally {
      waiting.delete(key);
    }
  };
}
