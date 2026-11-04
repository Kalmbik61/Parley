// Общие потолки правил параметров роли `remote`. Отдельный файл: allowlist.ts и voice.ts оба читают его, а друг друга
// не импортируют.

export const REMOTE_TEXT_LIMIT_BYTES = 16 * 1024;

/** Длина строки в UTF-8 без `Buffer` и `TextEncoder` (вход протокола работает и в Hermes). */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}
