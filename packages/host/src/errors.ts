import type { ErrorCode } from '@parley/protocol';

/**
 * Ошибка обработчика метода с явным кодом протокола. Без неё `server.ts`
 * заворачивает любой брошенный `Error` в `internal` — верно для неожиданных
 * сбоев, но `works.delete` (живая сессия) и `settings.set` (битое значение)
 * должны ответить `conflict` и `bad_request` соответственно (кусок 1.4).
 */
export class HostError extends Error {
  readonly code: ErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}
