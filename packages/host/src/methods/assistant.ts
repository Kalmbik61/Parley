/** Методы помощника (спека 2026-10-14, 6.5): ход идёт в фоне, исход — событием `assistant.changed`. */

import type { AnyHandler, Handler } from '../context.js';
import type { AssistantService } from '../assistant/assistant-service.js';

export function createAssistantHandlers(service: AssistantService): Record<string, AnyHandler> {
  const ask: Handler<'assistant.ask'> = async (params) => {
    void service.ask(params);
    return { ok: true };
  };
  const cancel: Handler<'assistant.cancel'> = async () => {
    service.cancel();
    return { ok: true };
  };
  const decide: Handler<'assistant.decide'> = (params) => service.decide(params.proposalId, params.decision);
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
  return {
    'assistant.ask': ask as AnyHandler,
    'assistant.cancel': cancel as AnyHandler,
    'assistant.decide': decide as AnyHandler,
    'assistant.reset': reset as AnyHandler,
    'assistant.state': state as AnyHandler,
    'assistant.sent': sent as AnyHandler,
    'assistant.configure': configure as AnyHandler,
  };
}
