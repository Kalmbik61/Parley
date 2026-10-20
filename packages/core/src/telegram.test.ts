import { describe, expect, it } from 'vitest';
import {
  TELEGRAM_TOKEN_RE,
  maskTelegramTokens,
  telegramBotId,
  telegramTokenFingerprint,
} from './telegram.js';

const SECRET = 'A'.repeat(35);
const TOKEN = `123456:${SECRET}`;

describe('токен Telegram', () => {
  it('регулярка принимает настоящий формат и отвергает короткий', () => {
    expect(TELEGRAM_TOKEN_RE.test(TOKEN)).toBe(true);
    expect(TELEGRAM_TOKEN_RE.test('12345:abc')).toBe(false);
  });
  it('id бота — цифры до двоеточия', () => {
    expect(telegramBotId(TOKEN)).toBe('123456');
  });
  it('отпечаток — 16 hex и стабилен', () => {
    const print = telegramTokenFingerprint(TOKEN);
    expect(print).toMatch(/^[0-9a-f]{16}$/);
    expect(telegramTokenFingerprint(TOKEN)).toBe(print);
    expect(telegramTokenFingerprint(`123456:${'B'.repeat(35)}`)).not.toBe(print);
  });
  it('маска прячет токен в адресе API', () => {
    const masked = maskTelegramTokens(`GET https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(masked).not.toContain('123456:AAAA');
    expect(masked).toContain('bot<redacted>');
  });
  it('маска прячет голый токен', () => {
    expect(maskTelegramTokens(`token is ${TOKEN} ok`)).toBe('token is <redacted> ok');
  });
  it('текст без токена не меняется', () => {
    expect(maskTelegramTokens('ничего секретного: 12:34')).toBe('ничего секретного: 12:34');
  });
});
