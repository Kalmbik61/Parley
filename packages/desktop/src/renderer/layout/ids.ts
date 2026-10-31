/**
 * Идентификаторы вкладок и узлов раскладки (спека 5.2, кусок 2.1). Адресуемые
 * виды вкладок (терминал, комната, дифф, файл) строят id из своего же ключа —
 * `openOrFocus` находит уже открытую вкладку сравнением id, а не обходом полей.
 * Только у вкладки браузера и у узлов дерева (`g-`/`s-`) естественного ключа
 * нет — им нужен `random`, подставной в тестах и `Math.random` по умолчанию.
 */

import type { BrowserOwner, FileRootSpec } from '../../shared/layout-types.js';

function randomHex(length: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += Math.floor(random() * 16).toString(16);
  return out;
}

export const tabId: {
  terminal(sessionId: string): string;
  mail(): 'mail';
  room(roomId: string): string;
  diff(sessionId: string, commit: string | null): string;
  file(root: FileRootSpec, path: string): string;
  browser(random?: () => number): string;
} = {
  terminal: (sessionId) => `terminal:${sessionId}`,
  mail: () => 'mail',
  room: (roomId) => `room:${roomId}`,
  diff: (sessionId, commit) => (commit === null ? `diff:${sessionId}` : `diff:${sessionId}:${commit}`),
  file: (root, path) =>
    root.kind === 'project' ? `file:p:${path}` : root.kind === 'external' ? `file:x:${path}` : `file:w:${root.sessionId}:${path}`,
  browser: (random = Math.random) => `browser:${randomHex(6, random)}`,
};

/**
 * `bp-<6 hex>` — страница панели браузера (спека браузера 3.10). Ключ записей `browser/store.ts`, журнала и меток
 * общий с вкладками браузера на всё окно, поэтому id случайный, а не `<хозяин>:<номер>`: `s-01` есть в каждой работе.
 */
export function panelPageId(random: () => number = Math.random): string {
  return `bp-${randomHex(6, random)}`;
}

/** Ключ хозяина панели в `WorkLayout.panels`: `session:<id>` или `room:<id>` (та же строка, что `targetKey` цели «To»). */
export function ownerKey(owner: BrowserOwner): string {
  return owner.kind === 'session' ? `session:${owner.sessionId}` : `room:${owner.roomId}`;
}

/** Хозяин по ключу панели; не ключ (чужая запись на диске) — `null`. */
export function ownerOfKey(key: string): BrowserOwner | null {
  if (key.startsWith('session:') && key.length > 'session:'.length) return { kind: 'session', sessionId: key.slice('session:'.length) };
  if (key.startsWith('room:') && key.length > 'room:'.length) return { kind: 'room', roomId: key.slice('room:'.length) };
  return null;
}

/** Вкладка вида хозяина: терминал сессии (Chat и терминал — одна вкладка) или комната. Закрыта — панель остаётся. */
export function ownerTabId(owner: BrowserOwner): string {
  return owner.kind === 'session' ? tabId.terminal(owner.sessionId) : tabId.room(owner.roomId);
}

/** `g-<6 hex>` для группы, `s-<6 hex>` для сплита. */
export function nodeId(prefix: 'g' | 's', random: () => number = Math.random): string {
  return `${prefix}-${randomHex(6, random)}`;
}
