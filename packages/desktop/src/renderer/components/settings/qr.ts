import { toString } from 'qrcode';

/** SVG-строка QR-кода для ссылки привязки Telegram (без canvas — работает и в jsdom). */
export function qrSvg(text: string): Promise<string> {
  return toString(text, { type: 'svg', margin: 1 });
}
