/**
 * Сокращение середины текста по кодовым точкам: длиннее `max` — середина заменяется на «…», итог ровно `max` кодовых
 * точек. Начало (где лежит) занимает около 40 %, конец (что за папка) — около 60 %: конец пути важнее середины.
 */
export function shortenMiddle(text: string, max = 56): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6);
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`;
}
