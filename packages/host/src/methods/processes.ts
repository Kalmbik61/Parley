/**
 * Методы `processes.*`: подписка клиента на процессы PTY сессии (план
 * `docs/plans/2026-11-09-session-shell-processes-plan.md`, этап B).
 *
 * Монитор (`createProcessMonitor`) опрашивает `ps` одним вызовом на тик; здесь — таблица
 * «сессия → подписанные клиенты», ревизии и очистка при выходе PTY. На сессию — одна подписка на
 * монитор, сколько бы клиентов ни смотрело; последний ушёл — подписка снята.
 */

import { refKey } from '@parley/protocol';
import type { SessionProcessesSnapshot, SessionRef } from '@parley/protocol';
import type { Client } from '../client.js';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { ProcessMonitor, ProcessSnapshot } from '../pty/process-monitor.js';
import type { PtyManager } from '../pty/pty-manager.js';

export interface ProcessesMethodDeps {
  monitor: Pick<ProcessMonitor, 'subscribe' | 'refresh'>;
  pty: Pick<PtyManager, 'get' | 'on'>;
}

export interface ProcessesHandlers {
  processesSubscribe: Handler<'processes.subscribe'>;
  processesUnsubscribe: Handler<'processes.unsubscribe'>;
  /** Клиент ушёл: снимает его со всех сессий, пустые подписки на монитор закрывает. */
  dropClient(client: Client): void;
  /** Сколько клиентских подписок держит таблица (для тестов и счётчиков). */
  subscriptionCount(): number;
}

interface Entry {
  clients: Set<Client>;
  stopMonitor: () => void;
  last: SessionProcessesSnapshot | null;
}

export function createProcessesHandlers(deps: ProcessesMethodDeps): ProcessesHandlers {
  const entries = new Map<string, Entry>();
  // Одна ревизия на хост: монотонна и между пересозданиями записи сессии, так что запоздавший
  // снимок прежней подписки не перебьёт новый.
  let revision = 0;

  const unavailable = (ref: SessionRef): SessionProcessesSnapshot => ({
    ref, revision: ++revision, available: false, approximate: false, processes: [],
  });

  function publish(entry: Entry, snapshot: SessionProcessesSnapshot): void {
    entry.last = snapshot;
    // Медленный клиент пропускает снимок: следующий заменяет его целиком.
    for (const client of Array.from(entry.clients)) client.send({ event: 'processes.changed', data: snapshot });
  }

  function release(key: string): void {
    entries.get(key)?.stopMonitor();
    entries.delete(key);
  }

  // PTY вышел: старый PID не должен продолжать отображаться. Подписчики остаются — `sessions.resume`
  // заводит новый PTY на тот же ref, и монитор снова начнёт слать снимки.
  deps.pty.on('exit', (ref) => {
    const entry = entries.get(refKey(ref));
    if (entry !== undefined) publish(entry, unavailable(ref));
  });

  return {
    processesSubscribe: async (params, request) => {
      const key = refKey(params.ref);
      if (deps.pty.get(params.ref) === undefined) {
        throw new HostError('not_found', `no live PTY for session ${params.ref.sessionId}`);
      }

      let entry = entries.get(key);
      if (entry === undefined) {
        const created: Entry = { clients: new Set(), stopMonitor: () => undefined, last: null };
        created.stopMonitor = deps.monitor.subscribe(params.ref, (ref, snapshot: ProcessSnapshot | null) => {
          // `null` — опрос не удался: данных нет, а не «процессов нет».
          publish(
            created,
            snapshot === null
              ? unavailable(ref)
              : { ref, revision: ++revision, available: true, approximate: snapshot.approximate, processes: snapshot.processes },
          );
        });
        entries.set(key, created);
        entry = created;
      }
      // Повторная подписка того же клиента идемпотентна: множество не растёт.
      entry.clients.add(request.client);

      if (entry.last === null) await deps.monitor.refresh();
      return entry.last ?? unavailable(params.ref);
    },

    processesUnsubscribe: async (params, request) => {
      const key = refKey(params.ref);
      const entry = entries.get(key);
      if (entry !== undefined) {
        entry.clients.delete(request.client);
        if (entry.clients.size === 0) release(key);
      }
      return { ok: true };
    },

    dropClient: (client) => {
      for (const [key, entry] of Array.from(entries)) {
        entry.clients.delete(client);
        if (entry.clients.size === 0) release(key);
      }
    },

    subscriptionCount: () => {
      let count = 0;
      for (const entry of entries.values()) count += entry.clients.size;
      return count;
    },
  };
}
