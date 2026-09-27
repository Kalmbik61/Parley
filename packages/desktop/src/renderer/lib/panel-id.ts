/**
 * Идентификатор панели dockview (кусок 2.1 плана окна, спека 4.4): один и тот
 * же адрес — терминал, почта, комната, изменения — всегда даёт один и тот же
 * id, поэтому «открыть уже открытую сессию» значит сфокусировать её панель, а
 * не плодить дубликат (тесты 1 и 2 куска).
 *
 * `workKey` здесь — та же функция, что и в `tree-order.ts` (там же живут
 * `treeOrder`/`sessionOrders`, которым он тоже нужен): в плане куска она
 * описана как отдельная с `\u0000`-разделителем, но в коде этапа 1 уже есть
 * рабочий `workKey` с пробелом, которым размечены `lastSessionByWork` и
 * подсветка сайдбара. Заводить второй несовместимый ключ для того же смысла
 * значило бы держать два непересекающихся пространства ключей на одни и те
 * же работы — реэкспорт вместо этого одного достаточно.
 */

import { refKey, type SessionRef } from '@harnas/protocol';
import { workKey } from './tree-order.js';

export { workKey };

export type PanelKind = 'terminal' | 'mail' | 'room' | 'changes';

export interface PanelSpec {
  kind: PanelKind;
  ref?: SessionRef;
  workKey: string;
  roomId?: string;
}

/** `'terminal:<refKey>'`, `'mail:<workKey>'`, `'room:<workKey>:<roomId>'`, `'changes:<refKey>'`. */
export function panelId(spec: PanelSpec): string {
  switch (spec.kind) {
    case 'terminal':
    case 'changes': {
      if (spec.ref === undefined) throw new Error(`panelId: panel "${spec.kind}" requires ref`);
      return `${spec.kind}:${refKey(spec.ref)}`;
    }
    case 'mail':
      return `mail:${spec.workKey}`;
    case 'room': {
      if (spec.roomId === undefined) throw new Error('panelId: panel "room" requires roomId');
      return `room:${spec.workKey}:${spec.roomId}`;
    }
  }
}

/**
 * Обратное к `panelId`: описание панели из её id. Параметры, которые dockview
 * отдаёт через `getParameters()`, в живом окне приходили без `workKey`, и
 * ⌘D находил «нет сессий без панели». id же детерминирован и содержит всё
 * нужное, поэтому источником истины для описания служит он.
 */
export function specFromPanelId(id: string): PanelSpec | null {
  const colon = id.indexOf(':');
  if (colon === -1) return null;
  const kind = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (kind === 'terminal' || kind === 'changes') {
    const parts = rest.split('\u0000');
    if (parts.length !== 3) return null;
    const [projectPath, workId, sessionId] = parts as [string, string, string];
    return { kind, ref: { projectPath, workId, sessionId }, workKey: workKey(projectPath, workId) };
  }
  if (kind === 'mail') return { kind, workKey: rest };
  if (kind === 'room') {
    const last = rest.lastIndexOf(':');
    if (last === -1) return null;
    return { kind, workKey: rest.slice(0, last), roomId: rest.slice(last + 1) };
  }
  return null;
}
