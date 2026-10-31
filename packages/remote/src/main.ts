import { envValue } from '@parley/core';
import { startBridge } from './bridge.js';

/** Коды выхода: 0 — обычная остановка, 1 — сбой запуска или работы. */
async function main(): Promise<number> {
  const bridge = await startBridge({ allowLoopbackRelay: envValue(process.env, 'REMOTE_DEV_LOOPBACK') === '1' });
  const stop = (): void => void bridge.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
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
