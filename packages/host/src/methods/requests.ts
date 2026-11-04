/**
 * Методы Request голосовых поручений (спека «Голос↔Ассистент», §4 и §9): остров отправляет поручение с доверенным
 * `origin: 'island'`, читает открытые и недоставленные итоги и отмечает доставку. Только локальные: в remote-списках
 * их нет, а `jobs.submit` телефона по-прежнему ставит `mobile` (`voice.ts`).
 */

import type { AnyHandler, Handler } from '../context.js';
import type { Requests } from '../assistant/requests.js';

export function createRequestHandlers(requests: Requests | undefined): Record<string, AnyHandler> {
  if (requests === undefined) return {};
  const submit: Handler<'requests.submit'> = async (params) => requests.submit(params);
  const list: Handler<'requests.list'> = async (params) => ({ requests: requests.list(params.conversationId, params.consumer) });
  const ack: Handler<'requests.ack'> = async (params) => requests.ack(params.requestId, params.consumer, params.revision);
  return { 'requests.submit': submit as AnyHandler, 'requests.list': list as AnyHandler, 'requests.ack': ack as AnyHandler };
}
