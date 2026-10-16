/**
 * Методы `pty.*`: терминал живых сессий.
 *
 * `pty.output` идёт только клиентам, которые сделали `pty.attach` именно этой
 * сессии — `PtyManager` эмитит `output` для любого куска вывода независимо от
 * того, смотрит на него кто-то или нет, а какому клиенту его реально послать,
 * решает таблица подписок здесь (план, кусок 1.6, ревью п.3).
 */

import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { Client } from '../client.js';
import type { Handler, NotificationHandler } from '../context.js';
import { HostError } from '../errors.js';
import type { Log } from '../log.js';
import type { PtyManager } from '../pty/pty-manager.js';
import { createSender } from '../pty/send.js';
import type { SessionsService } from '../sessions/sessions-service.js';
import type { WakeService } from '../wake/wake-service.js';
import type { WorksService } from '../works/works-service.js';

export interface PtyMethodDeps {
  pty: PtyManager;
  activity: ActivityService;
  works: WorksService;   // activity.seen: есть ли сессия в снимке работ хоста
  wake: Pick<WakeService, 'inFlight' | 'enterDelayMs'>;   // pty.send: busy и пауза Enter
  sessions?: Pick<SessionsService, 'exclusive'>;   // pty.send: пока идёт смена модели или effort, не печатает
  log?: Log;   // журнал хоста: отброшенный медленный клиент потока (`pty.clientDropped`)
}

export interface PtyHandlers {
  ptyAttach: Handler<'pty.attach'>;
  ptyDetach: Handler<'pty.detach'>;
  ptySend: Handler<'pty.send'>;
  ptyInput: NotificationHandler<'pty.input'>;
  ptyResize: NotificationHandler<'pty.resize'>;
  activitySeen: NotificationHandler<'activity.seen'>;
  /** Сколько подписок на поток терминалов держат клиенты: сумма размеров множеств в таблице `attached`. */
  attachedCount(): number;
  /** Подписан ли на поток сессии хотя бы один клиент. */
  isAttached(ref: SessionRef): boolean;
  /** Клиент ушёл: снимает его со всех сессий в `attached` и `waiting`, пустые множества убирает из карт. */
  dropClient(client: Client): void;
}

/**
 * Заводит обработчики `pty.*` вместе с таблицей «сессия → подписанные клиенты».
 * Таблица живёт в замыкании фабрики, а не в модульной переменной: у каждого
 * `startHost` (в частности, в тестах — их много на один процесс) должна быть
 * своя, а не общая на весь процесс.
 */
export function createPtyHandlers(deps: PtyMethodDeps): PtyHandlers {
  const attached = new Map<string, Set<Client>>();
  // Подписчики, чей процесс вышел: ждут нового PTY на тот же ref (`sessions.resume`), чтобы
  // получить `pty.resync` и переподключиться сами — без этого открытая вкладка молчала бы.
  const waiting = new Map<string, Set<Client>>();
  // Один отправитель на хост: «свой Enter в полёте» по сессии должен быть общим для всех
  // клиентов, иначе два окна обошли бы busy.
  const { sessions } = deps;
  const send = createSender({
    ...deps,
    ...(sessions === undefined ? {} : { switching: (ref: SessionRef) => sessions.exclusive.held(ref) }),
  });

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
        // Журнал задержек (спека диагностики, A4): отброс клиента — вероятная причина «Chat/терминал отстал».
        if (deps.log !== undefined) {
          deps.log.info('клиент PTY отброшен', {
            op: 'pty.clientDropped',
            ref,
            client: client.name,
            queuedBytes: client.writableLength(),
          });
        }
        client.send({ event: 'pty.resync', data: { ref } });
      }
    }
  });

  // Процесс вышел, но ref может ожить: `sessions.resume` заводит новый PTY на тот же
  // projectPath+workId+sessionId. Вывода мёртвому PTY нет — подписчики переходят в ожидание.
  // Ожидание не растёт без меры: на мёртвый ref новый `pty.attach` не пройдёт (not_found),
  // так что ждут только те, кто был подписан в момент выхода, пока их не снимет `pty.detach`
  // или оживление.
  deps.pty.on('exit', (ref) => {
    const key = refKey(ref);
    const clients = attached.get(key);
    attached.delete(key);
    if (clients === undefined || clients.size === 0) return;
    const pending = waiting.get(key) ?? new Set<Client>();
    for (const client of clients) pending.add(client);
    waiting.set(key, pending);
  });

  // Новый PTY на ref — ждущим `pty.resync`: окно само берёт снимок нового процесса через
  // `pty.attach`. Из ожидания их снимаем сразу; закрытому клиенту send просто не доставит,
  // и держать его дальше не будем.
  deps.pty.on('start', (ref) => {
    const key = refKey(ref);
    const clients = waiting.get(key);
    if (clients === undefined) return;
    waiting.delete(key);
    for (const client of clients) client.send({ event: 'pty.resync', data: { ref } });
  });

  return {
    ptyAttach: async (params, request) => {
      const handle = deps.pty.get(params.ref);
      if (handle === undefined) {
        throw new HostError('not_found', `no live PTY for session ${params.ref.sessionId}`);
      }

      const key = refKey(params.ref);
      let clients = attached.get(key);
      if (clients === undefined) {
        clients = new Set();
        attached.set(key, clients);
      }
      clients.add(request.client);

      // «Просмотрено» здесь не ставим (спека 3.2): подключённая, но невидимая вкладка
      // и окно не в фокусе не должны гасить «не просмотрено». Его ставит activity.seen.
      return deps.pty.snapshot(params.ref);
    },

    ptyDetach: async (params, request) => {
      const key = refKey(params.ref);
      attached.get(key)?.delete(request.client);
      const pending = waiting.get(key);
      pending?.delete(request.client);
      if (pending?.size === 0) waiting.delete(key);
      return { ok: true };
    },

    // Отвечает после ожидания своего Enter (около enterDelayMs), исход — в SendResult.
    ptySend: (params, { host }) => send(params, host.log),

    ptyInput: (params) => {
      deps.pty.input(params.ref, params.data);
      deps.activity.markSeen(params.ref);
    },

    ptyResize: (params) => {
      deps.pty.resize(params.ref, params.cols, params.rows);
    },

    activitySeen: (params) => {
      // Уведомление приходит от клиента: состояние по ref, которого хост не знает, не
      // пишем. Ответа у уведомления нет, поэтому неизвестная сессия — тихий пропуск.
      const { projectPath, workId, sessionId } = params.ref;
      const entry = deps.works.entry(projectPath, workId);
      if (entry?.map.sessions.some((session) => session.id === sessionId) !== true) return;
      deps.activity.markSeen(params.ref);
    },

    attachedCount: () => {
      let count = 0;
      for (const clients of attached.values()) count += clients.size;
      return count;
    },

    isAttached: (ref) => (attached.get(refKey(ref))?.size ?? 0) > 0,

    // Закрытый клиент без `pty.detach` иначе жил бы в таблицах до выхода процесса или нового вывода
    // (и раздувал `attachedCount`, хотя смотреть на поток некому).
    dropClient: (client) => {
      for (const table of [attached, waiting]) {
        for (const [key, clients] of table) {
          clients.delete(client);
          if (clients.size === 0) table.delete(key);
        }
      }
    },
  };
}
