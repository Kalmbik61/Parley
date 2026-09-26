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
      if (spec.ref === undefined) throw new Error(`panelId: панель «${spec.kind}» требует ref`);
      return `${spec.kind}:${refKey(spec.ref)}`;
    }
    case 'mail':
      return `mail:${spec.workKey}`;
    case 'room': {
      if (spec.roomId === undefined) throw new Error('panelId: панель «room» требует roomId');
      return `room:${spec.workKey}:${spec.roomId}`;
    }
  }
}
