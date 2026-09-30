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
  activity: Pick<ActivityService, 'terminalStarted' | 'terminalSignal' | 'terminalStopped'>,
): () => void {
  const off = [
    // Ручка уже в `get()`: событие `start` идёт после регистрации процесса. Срок экранов старта и
    // чистое состояние — только у codex; у остальных `provider` другой, и хуки ведут их сами.
    pty.on('start', (ref) => {
      if (pty.get(ref)?.provider === 'codex') activity.terminalStarted(ref);
    }),
    pty.on('signal', (ref, signal) => activity.terminalSignal(ref, signal)),
    // Без состояния (не codex) `terminalStopped` ничего не делает.
    pty.on('exit', (ref) => activity.terminalStopped(ref)),
  ];
  return () => {
    for (const unsubscribe of off) unsubscribe();
  };
}
