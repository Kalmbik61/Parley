/**
 * Методы телефона поверх ядра помощника и голосовой сессии (план голоса, B3): jobs, голосовая сессия, расход.
 * Телефон не выбирает источник поручения: он всегда `mobile`. Ответы job — проекция без логов и argv. SDP-ответ и ключ
 * OpenAI в журнал не пишутся: обработчики ничего не логируют.
 */

import { projectPhoneJob } from '@parley/protocol/remote';
import type { VoiceUsage } from '@parley/protocol/remote';
import type { AnyHandler, Handler } from '../context.js';
import type { Jobs } from '../assistant/jobs.js';
import type { VoiceSessionService } from '../voice/voice-session-service.js';
import { liveSessionConfig } from '../voice/voice-prompt.js';

export interface VoiceDeps {
  service: VoiceSessionService;
  /** Расход за сутки по локальному времени Mac. */
  usage(): VoiceUsage;
}

export function createVoiceHandlers(jobs: Jobs | undefined, voice: VoiceDeps | undefined): Record<string, AnyHandler> {
  const handlers: Record<string, AnyHandler> = {};
  if (jobs !== undefined) {
    const submit: Handler<'jobs.submit'> = async (params) =>
      jobs.submitJob({ origin: 'mobile', text: params.text, idempotencyKey: params.idempotencyKey, correlation: params.correlation });
    const get: Handler<'jobs.get'> = async (params) => ({ job: projectPhoneJob(jobs.getJob(params.jobId)) });
    const cancel: Handler<'jobs.cancel'> = async (params) => ({ job: projectPhoneJob(jobs.cancelJob(params.jobId)) });
    handlers['jobs.submit'] = submit as AnyHandler;
    handlers['jobs.get'] = get as AnyHandler;
    handlers['jobs.cancel'] = cancel as AnyHandler;
  }
  if (voice !== undefined) {
    // Остров (локальный клиент) получает инструкции и клиентскую делегацию. Телефон (`remote`) моста делегаций не имеет:
    // с `delegation: client` его вопросы повисли бы без ответа, поэтому он остаётся на прежнем конфиге до перехода на мост.
    const prepare: Handler<'voice.session.prepare'> = (params, request) =>
      request.client.role === 'remote' ? voice.service.prepare(params.sdp) : voice.service.prepare(params.sdp, liveSessionConfig());
    const close: Handler<'voice.session.close'> = async (params) => ({ closed: await voice.service.close(params.voiceSessionId) });
    const usage: Handler<'voice.usage.get'> = async () => voice.usage();
    handlers['voice.session.prepare'] = prepare as AnyHandler;
    handlers['voice.session.close'] = close as AnyHandler;
    handlers['voice.usage.get'] = usage as AnyHandler;
  }
  return handlers;
}
