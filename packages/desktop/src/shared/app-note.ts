/**
 * Предел заголовка и текста уведомления macOS (спека 15.2, план «Числа»): 200 кодовых
 * точек. Режут и окно (`renderer/attention/notify.ts`), и main (`main/ipc.ts`): рендереру
 * main не верит, а окно должно отдать уже готовый текст.
 */
export const NOTE_TEXT_MAX = 200;

/**
 * Длиннее предела — первые 199 кодовых точек и «…», итог ровно 200. Счёт по кодовым
 * точкам (`Array.from`), как у `layout/tab-meta.ts#truncateTitle`: суррогатная пара не рвётся.
 */
export function clampNoteText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= NOTE_TEXT_MAX) return text;
  return `${codePoints.slice(0, NOTE_TEXT_MAX - 1).join('')}…`;
}
