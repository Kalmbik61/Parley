/**
 * Журнал «сессия готова» (спека диагностики хоста, A4): сколько прошло от запуска PTY до первого
 * признака жизни CLI. Признак — первый хук сессии или сигнал терминала `ready` у Codex (у него
 * состояние идёт по терминалу, а не по хукам). Пишется один раз после каждого старта PTY.
 *
 * В запись идут только ref, провайдер и миллисекунды — ни текстов, ни вывода терминала.
 */

import { refKey } from '@parley/protocol';
import type { SessionRef } from '@parley/protocol';
import type { Log } from '../log.js';
import type { PtyManager } from '../pty/pty-manager.js';

export interface ReadyJournal {
  /** Хук сессии получен: первый после старта PTY пишет `session.ready`. */
  onHook(ref: SessionRef): void;
  /** Снимает подписки на PTY. */
  stop(): void;
}

export interface ReadyJournalDeps {
  log: Log;
  pty: Pick<PtyManager, 'on' | 'get'>;
  /** Часы, мс эпохи — как `PtyHandle.startedAt`; в тестах подменяются. */
  now?: () => number;
}

export function createReadyJournal(deps: ReadyJournalDeps): ReadyJournal {
  const { log, pty } = deps;
  const now = deps.now ?? Date.now;
  // Сессии, которым ещё не записали готовность: старт PTY кладёт ключ, первый признак готовности или выход снимает.
  const waiting = new Set<string>();

  function markReady(ref: SessionRef): void {
    if (!waiting.delete(refKey(ref))) return;
    const handle = pty.get(ref);
    if (handle === undefined) return;
    try {
      log.info('сессия готова', {
        op: 'session.ready',
        ref,
        provider: handle.provider,
        readyMs: Math.max(0, now() - handle.startedAt),
      });
    } catch {
      // Журнал синхронный и при ENOSPC/EACCES бросает: диагностика не должна ломать путь хука и сигнала.
    }
  }

  const unsubscribers = [
    pty.on('start', (ref) => {
      waiting.add(refKey(ref));
    }),
    pty.on('exit', (ref) => {
      waiting.delete(refKey(ref));
    }),
    pty.on('signal', (ref, signal) => {
      if (signal.kind === 'ready') markReady(ref);
    }),
  ];

  return {
    onHook: markReady,
    stop() {
      for (const unsubscribe of unsubscribers) unsubscribe();
      waiting.clear();
    },
  };
}
