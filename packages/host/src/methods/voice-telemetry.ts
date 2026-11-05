/**
 * Методы локальной телеметрии голоса (спека «Голос↔Ассистент» §11, T6): остров записывает измеренное (`record`), приёмка
 * читает (`list`). Только локальные: в remote-списках их нет.
 */

import type { AnyHandler, Handler } from '../context.js';
import type { VoiceTelemetry } from '../voice/telemetry.js';

export function createVoiceTelemetryHandlers(telemetry: VoiceTelemetry | undefined): Record<string, AnyHandler> {
  if (telemetry === undefined) return {};
  const record: Handler<'voice.telemetry.record'> = async (params) => {
    telemetry.record(params);
    return { ok: true };
  };
  const list: Handler<'voice.telemetry.list'> = async (params) => ({ rows: telemetry.list(params.limit) });
  return { 'voice.telemetry.record': record as AnyHandler, 'voice.telemetry.list': list as AnyHandler };
}
