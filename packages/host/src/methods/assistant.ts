/** Методы помощника (спека 2026-10-14, 6.5): ход идёт в фоне, исход — событием `assistant.changed`. */

import type { AnyHandler, Handler } from '../context.js';
import type { AssistantService } from '../assistant/assistant-service.js';
import type { Jobs } from '../assistant/jobs.js';

export function createAssistantHandlers(service: AssistantService, jobs?: Jobs): Record<string, AnyHandler> {
  const ask: Handler<'assistant.ask'> = async (params) => {
    void service.ask(params);
    return { ok: true };
  };
  const cancel: Handler<'assistant.cancel'> = async () => {
    service.cancel();
    return { ok: true };
  };
  // Окно решает карточку тем же ядром, что Telegram и телефон; канал называется явно.
  const decide: Handler<'assistant.decide'> = (params) => service.decide(params.proposalId, params.decision, params.action, 'island');
  const decideCard: Handler<'cards.decide'> = (params) => service.decideCard(params, 'mobile');
  const reissue: Handler<'assistant.reissue'> = async (params) => service.reissue(params.proposalId);
  const reset: Handler<'assistant.reset'> = async () => {
    service.reset();
    return { ok: true };
  };
  const state: Handler<'assistant.state'> = async () => service.state();
  const configure: Handler<'assistant.configure'> = async (params) => {
    service.configure(params);
    return { ok: true };
  };
  const sent: Handler<'assistant.sent'> = async (params) => ({ items: await service.sent(params.ref) });
  const ackInline: Handler<'jobs.ackInline'> = async (params) => {
    if (jobs === undefined) return { ok: false, deliveredInline: false, reason: 'not_found' };
    return jobs.ackInline(params.jobId, params.revision);
  };
  return {
    'cards.decide': decideCard as AnyHandler,
    'jobs.ackInline': ackInline as AnyHandler,
    'assistant.ask': ask as AnyHandler,
    'assistant.cancel': cancel as AnyHandler,
    'assistant.decide': decide as AnyHandler,
    'assistant.reissue': reissue as AnyHandler,
    'assistant.reset': reset as AnyHandler,
    'assistant.state': state as AnyHandler,
    'assistant.sent': sent as AnyHandler,
    'assistant.configure': configure as AnyHandler,
  };
}
