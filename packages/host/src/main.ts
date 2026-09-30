import { startupWaitFromEnv } from './activity/activity-service.js';
import { HostAlreadyRunning, SocketPathTooLong, startHost } from './host.js';
import { limitsOptionsFromEnv } from './limits/limits-service.js';
import { probeCliVersion } from './providers/versions.js';

/** Коды выхода: 0 — обычная остановка, 3 — хост уже запущен, 4 — путь сокета слишком длинный. */
async function main(): Promise<number> {
  const envIdleMs = process.env.HARNAS_HOST_IDLE_MS;
  // Версии CLI — проба `<команда> --version` на старте. E2E окна её отключает: в их окружении
  // настоящие claude и codex запускать нельзя, и подменён у них только claude.
  const probeVersions = process.env.HARNAS_SKIP_VERSION_PROBE !== '1';
  // Лимиты подписок хост перечитывает раз в 30 секунд (спека комнат Organic, 3.5). Переменная нужна
  // только E2E окна: ждать полминуты, пока в строке статуса появятся числа, тест не может.
  const limits = limitsOptionsFromEnv(process.env);
  // Срок экранов старта Codex — тоже рычаг E2E: ждать двадцать секунд экрана доверия тест не может.
  const startupWaitMs = startupWaitFromEnv(process.env);
  const options = {
    ...(envIdleMs ? { idleMs: Number(envIdleMs) } : {}),
    ...(probeVersions ? { probeVersion: probeCliVersion } : {}),
    ...(limits === undefined ? {} : { limits }),
    ...(startupWaitMs === undefined ? {} : { startupWaitMs }),
  };
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
