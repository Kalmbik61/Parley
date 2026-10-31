import { envValue } from '@parley/core/names';
import { startBridge } from './bridge.js';
import type { RunningBridge } from './bridge.js';

/** Коды выхода: 0 — обычная остановка, 1 — сбой запуска или работы (в том числе «мост уже запущен»). */
async function main(): Promise<number> {
  // Обработчики — до запуска: сигнал посреди старта не обрывает процесс с недособранными файлами, а останавливает мост
  // сразу после запуска.
  let bridge: RunningBridge | null = null;
  let stopRequested = false;
  const stop = (): void => {
    stopRequested = true;
    if (bridge) void bridge.stop();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  bridge = await startBridge({ allowLoopbackRelay: envValue(process.env, 'REMOTE_DEV_LOOPBACK') === '1' });
  if (stopRequested) void bridge.stop();
  await bridge.closed;
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
