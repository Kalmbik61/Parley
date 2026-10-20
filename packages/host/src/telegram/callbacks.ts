/** Данные inline-кнопок: `pc1:<shortId>:<code>` (карточка ленты/комнаты) и `pa1:<proposalId>:send|cancel` (карточка помощника). */

export type Callback = { family: 'pc1'; shortId: string; code: string } | { family: 'pa1'; proposalId: string; code: 'send' | 'cancel' };

export const CALLBACK_CODES = {
  allow: 'a',
  allowAlways: 'A',
  deny: 'd',
  other: 'o',
  planAuto: 'p',
  planManual: 'm',
  accept: 'y',
  returnNote: 'r',
  option: (index: number): string => `q${index}`,
} as const;

export function parseCallback(data: string): Callback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [family, id, code] = parts as [string, string, string];
  if (id.length === 0 || code.length === 0) return null;
  if (family === 'pc1') return { family: 'pc1', shortId: id, code };
  if (family === 'pa1' && (code === 'send' || code === 'cancel')) return { family: 'pa1', proposalId: id, code };
  return null;
}

/** `'q3'` → 3, иначе `null`. */
export function optionIndex(code: string): number | null {
  const match = /^q(\d+)$/.exec(code);
  return match === null ? null : Number(match[1]);
}
