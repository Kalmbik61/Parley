/**
 * Идентификаторы вкладок и узлов раскладки (спека 5.2, кусок 2.1). Адресуемые
 * виды вкладок (терминал, комната, дифф, файл) строят id из своего же ключа —
 * `openOrFocus` находит уже открытую вкладку сравнением id, а не обходом полей.
 * Только у вкладки браузера и у узлов дерева (`g-`/`s-`) естественного ключа
 * нет — им нужен `random`, подставной в тестах и `Math.random` по умолчанию.
 */

import type { FileRootSpec } from '../../shared/layout-types.js';

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
  file: (root, path) => (root.kind === 'project' ? `file:p:${path}` : `file:w:${root.sessionId}:${path}`),
  browser: (random = Math.random) => `browser:${randomHex(6, random)}`,
};

/** `g-<6 hex>` для группы, `s-<6 hex>` для сплита. */
export function nodeId(prefix: 'g' | 's', random: () => number = Math.random): string {
  return `${prefix}-${randomHex(6, random)}`;
}
