import type { AppLocale } from '@parley/core/i18n';
import type { HostText } from './host-text.js';
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

  private readonly display?: HostText;

  constructor(code: ErrorCode, message: string | HostText, data?: Record<string, unknown>) {
    super(typeof message === 'string' ? message : message.english);
    if (typeof message !== 'string') this.display = message;
    this.name = 'HostError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }

  displayMessage(locale?: AppLocale): string {
    return this.display?.in(locale) ?? this.message;
  }
}
