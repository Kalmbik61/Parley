/**
 * Методы `pty.*`: терминал живых сессий.
 *
 * `pty.output` идёт только клиентам, которые сделали `pty.attach` именно этой
 * сессии — `PtyManager` эмитит `output` для любого куска вывода независимо от
 * того, смотрит на него кто-то или нет, а какому клиенту его реально послать,
 * решает таблица подписок здесь (план, кусок 1.6, ревью п.3).
 */

import { refKey } from '@harnas/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { Client } from '../client.js';
import type { Handler, NotificationHandler } from '../context.js';
import { HostError } from '../errors.js';
import type { PtyManager } from '../pty/pty-manager.js';

export interface PtyMethodDeps {
  pty: PtyManager;
  activity: ActivityService;
}

export interface PtyHandlers {
  ptyAttach: Handler<'pty.attach'>;
  ptyDetach: Handler<'pty.detach'>;
  ptyInput: NotificationHandler<'pty.input'>;
  ptyResize: NotificationHandler<'pty.resize'>;
}

/**
 * Заводит обработчики `pty.*` вместе с таблицей «сессия → подписанные клиенты».
 * Таблица живёт в замыкании фабрики, а не в модульной переменной: у каждого
 * `startHost` (в частности, в тестах — их много на один процесс) должна быть
 * своя, а не общая на весь процесс.
 */
export function createPtyHandlers(deps: PtyMethodDeps): PtyHandlers {
  const attached = new Map<string, Set<Client>>();

  deps.pty.on('output', (ref, data) => {
    const key = refKey(ref);
    const clients = attached.get(key);
    if (clients === undefined || clients.size === 0) return;

    for (const client of Array.from(clients)) {
      const delivered = client.send({ event: 'pty.output', data: { ref, data } });
      if (!delivered) {
        // Клиент не успевает читать (буфер сокета выше порога) — поток ему
        // останавливается: заново получит его только после нового `pty.attach`.
        clients.delete(client);
        client.send({ event: 'pty.resync', data: { ref } });
      }
    }
  });

  // Сессии больше нет — подписчики этой сессии не нужны и другой такой ref
  // (тот же projectPath+workId+sessionId) уже не появится.
  deps.pty.on('exit', (ref) => {
    attached.delete(refKey(ref));
  });

  return {
    ptyAttach: async (params, request) => {
      const handle = deps.pty.get(params.ref);
      if (handle === undefined) {
        throw new HostError('not_found', `нет живого PTY для сессии ${params.ref.sessionId}`);
      }

      const key = refKey(params.ref);
      let clients = attached.get(key);
      if (clients === undefined) {
        clients = new Set();
        attached.set(key, clients);
      }
      clients.add(request.client);

      deps.activity.markSeen(params.ref);
      return deps.pty.snapshot(params.ref);
    },

    ptyDetach: async (params, request) => {
      attached.get(refKey(params.ref))?.delete(request.client);
      return { ok: true };
    },

    ptyInput: (params) => {
      deps.pty.input(params.ref, params.data);
      deps.activity.markSeen(params.ref);
    },

    ptyResize: (params) => {
      deps.pty.resize(params.ref, params.cols, params.rows);
    },
  };
}
