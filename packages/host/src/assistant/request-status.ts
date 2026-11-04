/**
 * Запасной путь статуса (спека «Голос↔Ассистент» §6, T6): инструмент job `request_status`. Только чтение: возвращает
 * открытые Request разговора вызывающего job — состояние, версию, возраст и краткое резюме итога. Работа не запускается и
 * не повторяется, job и Request не создаются и не меняются.
 *
 * Разговор определяется по токену job на хосте (`jobId` → его Request → `conversationId`), а не по аргументам модели: чужой
 * разговор прочитать нельзя. Токен разговора инструмент не получает (`JOB_ONLY_TOOLS`). Собственный Request job в список не
 * входит (вопрос о статусе не ответ о самом себе), вытесненные — тоже. В тексте нет id: job пересказывает его голосом.
 */

import { normalizeHumanText } from '@parley/core/assistant';
import { ageWords, clockOf } from '@parley/core/voice-live';
import { LIVE_CONSUMER, type Requests, type RequestView } from './requests.js';

export const STATUS_MAX_REQUESTS = 8;
const TEXT_CHARS = 120;
const SUMMARY_CHARS = 200;

export type RequestStatusOutcome = { ok: true; text: string } | { ok: false; status: 409; error: string };

export interface RequestStatusReader {
  /** Вызов `request_status` от job `jobId` (его хост знает по токену). */
  status(jobId: string): RequestStatusOutcome;
}

export interface RequestStatusDeps {
  requests: Pick<Requests, 'byJob' | 'list'>;
  now?(): number;
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);
/** Одна строка без кавычек и переводов: текст человека не должен подделать строку списка. */
const oneLine = (text: string, limit: number): string => clip(normalizeHumanText(text, {}).replace(/\s+/g, ' ').replaceAll('"', "'").trim(), limit);

const STATE_WORDS: Record<string, string> = {
  queued: 'waiting in line',
  running: 'still running',
  needs_confirmation: 'finished, waits for the person to confirm a card',
  completed: 'completed, not yet spoken',
  failed: 'failed, not yet spoken',
  cancelled: 'cancelled',
};

function line(request: RequestView, at: number): string {
  const summary = oneLine(request.job.result?.answer ?? request.job.resultSummary ?? '', SUMMARY_CHARS);
  const state = STATE_WORDS[request.job.state] ?? request.job.state;
  const head = `- asked ${ageWords(at - request.createdAt)} ago, ${state} (version ${request.version}): "${oneLine(request.text, TEXT_CHARS)}"`;
  return summary === '' ? head : `${head}; result so far: ${summary}`;
}

export function createRequestStatus(deps: RequestStatusDeps): RequestStatusReader {
  const now = deps.now ?? Date.now;
  return {
    status(jobId) {
      const own = deps.requests.byJob(jobId);
      if (own === null) return { ok: false, status: 409, error: 'request_status is only available to voice requests' };
      const at = now();
      const open = deps.requests
        .list(own.conversationId, LIVE_CONSUMER)
        .filter((request) => request.requestId !== own.requestId && !request.stale)
        .slice(-STATUS_MAX_REQUESTS);
      if (open.length === 0) return { ok: true, text: `Status as of ${clockOf(at)}: there are no other open requests in this conversation.` };
      return { ok: true, text: [`Status as of ${clockOf(at)}, open requests of this conversation, oldest first:`, ...open.map((request) => line(request, at))].join('\n') };
    },
  };
}
