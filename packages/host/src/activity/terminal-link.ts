/**
 * Связка «терминал codex → активность» (спека комнат Organic, 3.6). Менеджер PTY разбирает поток
 * сессий `provider: 'codex'` в сигналы (`pty/codex-terminal.ts`), сервис активности выводит из них
 * состояние. Друг про друга они не знают — их сводит эта функция, одна на хост и на тесты.
 */

import type { PtyManager } from '../pty/pty-manager.js';
import type { ActivityService } from './activity-service.js';

/** Подписывает сервис активности на процесс и сигналы codex; возвращает отписку. */
export function linkTerminalActivity(
  pty: Pick<PtyManager, 'on' | 'get'>,
  activity: Pick<
    ActivityService,
    'terminalStarted' | 'terminalSignal' | 'terminalStopped' | 'processStarted' | 'qwenStatus'
  >,
): () => void {
  const off = [
    // Ручка уже в `get()`: событие `start` идёт после регистрации процесса. Срок экранов старта и
    // чистое состояние — у codex; у остальных `provider` другой, и хуки ведут их сами, а хосту важен лишь момент запуска:
    // от него считаются срок экрана старта и «новые» строки журнала (`processStarted`).
    // The spawn time is taken before the spawn: a Qwen journal line stamped earlier is a past process's (spec 3.4).
    pty.on('start', (ref) => {
      const handle = pty.get(ref);
      if (handle?.provider === 'codex') activity.terminalStarted(ref);
      else activity.processStarted(ref, handle?.startedAt);
    }),
    pty.on('signal', (ref, signal) => activity.terminalSignal(ref, signal)),
    // Qwen Code readiness and startup screens (OSC 7501); the pty manager reports only the current process.
    pty.on('program-status', (ref, status) => activity.qwenStatus(ref, status)),
    // Без состояния (не codex) `terminalStopped` ничего не делает.
    pty.on('exit', (ref) => activity.terminalStopped(ref)),
  ];
  return () => {
    for (const unsubscribe of off) unsubscribe();
  };
}
