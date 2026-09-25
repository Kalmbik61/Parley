import { HostAlreadyRunning, SocketPathTooLong, startHost } from './host.js';

/** Коды выхода: 0 — обычная остановка, 3 — хост уже запущен, 4 — путь сокета слишком длинный. */
async function main(): Promise<number> {
  const envIdleMs = process.env.HARNAS_HOST_IDLE_MS;
  const options = envIdleMs ? { idleMs: Number(envIdleMs) } : {};
  try {
    const running = await startHost(options);
    await running.closed;
    return 0;
  } catch (error) {
    if (error instanceof HostAlreadyRunning) return 3;
    if (error instanceof SocketPathTooLong) return 4;
    throw error;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
