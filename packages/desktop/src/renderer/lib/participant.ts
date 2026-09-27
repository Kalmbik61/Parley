/**
 * Подпись сессии в строке сайдбара и в уведомлениях: короткий номер (`s-03` →
 * `S03`) плюс ярлык. `sessionTag` перенесена из `@harnas/core`
 * (`work/thread.ts`) значением, а не импортом типа: рендерер в песочнице
 * (`contextIsolation`, `sandbox`, без `nodeIntegration` — `window.ts`) не
 * может тянуть рантайм core — тот на верхнем уровне модуля трогает `node:fs`
 * и `node:url` (`work/mcp-config.ts`). Импорт типов из `@harnas/core` стирается
 * сборкой и безопасен, импорт значений — нет.
 */

/** Номер в id вида `s-01`, `s-12`; чужая форма id не трогается (дизайн комнаты, 4). */
const SESSION_ID = /^s-(\d+)$/;

/** Короткий номер сессии: `s-01` → `S01`. */
export function sessionTag(id: string): string {
  const match = SESSION_ID.exec(id);
  return match === null ? id : `S${match[1]}`;
}

/** `S03 бэкенд` — то, что видно в строке дерева сессий. */
export function sessionRowLabel(sessionId: string, label: string): string {
  const tag = sessionTag(sessionId);
  return label === '' ? tag : `${tag} ${label}`;
}

/** Заголовок уведомления: `S03 ждёт ответа` — тег, без ярлыка (тот — в тексте письма). */
export function noticeTitle(sessionId: string, suffix: string): string {
  return `${sessionTag(sessionId)} ${suffix}`;
}
