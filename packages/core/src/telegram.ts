/** Токен бота Telegram: формат, опознавание и маска для логов. Секрет сюда не попадает — только чистые функции. */

import { createHash } from 'node:crypto';

export const TELEGRAM_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

/** Числовой id бота — цифры до двоеточия. */
export function telegramBotId(token: string): string {
  const colon = token.indexOf(':');
  return colon < 0 ? token : token.slice(0, colon);
}

/** Первые 16 hex sha256: по нему видно смену токена, не раскрывая его. */
export function telegramTokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Прячет токен в тексте: в адресе API (`bot<id>:<секрет>`) и голый. */
export function maskTelegramTokens(text: string): string {
  return text
    .replace(/bot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>')
    .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, '<redacted>');
}
