import { envValue } from '@parley/core';
import { startupWaitFromEnv } from './activity/activity-service.js';
import { HostAlreadyRunning, SocketPathTooLong, startHost } from './host.js';
import { glmCheckOptionsFromEnv } from './limits/glm-check.js';
import { limitsOptionsFromEnv } from './limits/limits-service.js';
import { probeCodexCatalog } from './providers/codex-catalog.js';
import { probeCliVersion } from './providers/versions.js';

/** Коды выхода: 0 — обычная остановка, 3 — хост уже запущен, 4 — путь сокета слишком длинный. */
async function main(): Promise<number> {
  const envIdleMs = envValue(process.env, 'HOST_IDLE_MS');
  // Версии CLI (`<команда> --version`) и каталог Codex (`codex debug models`) — пробы на старте. E2E окна их
  // отключает: в их окружении настоящие claude и codex запускать нельзя, и подменён у них только claude.
  const probeVersions = envValue(process.env, 'SKIP_VERSION_PROBE') !== '1';
  // Лимиты подписок хост перечитывает раз в 30 секунд (спека комнат Organic, 3.5). Переменная нужна
  // только E2E окна: ждать полминуты, пока в строке статуса появятся числа, тест не может.
  const limits = limitsOptionsFromEnv(process.env);
  // Проверка ключа Z.ai — тоже рычаг E2E: окну в тестах нельзя слать тестовое сообщение в настоящий Z.ai.
  const glmCheck = glmCheckOptionsFromEnv(process.env);
  // Срок экранов старта Codex — тоже рычаг E2E: ждать двадцать секунд экрана доверия тест не может.
  const startupWaitMs = startupWaitFromEnv(process.env);
  // Срок ожидания хуков Codex — рычаг E2E: ждать пятнадцать секунд подсказки тест не может.
  const hookGraceRaw = Number(envValue(process.env, 'CODEX_HOOK_GRACE_MS'));
  const codexHookGraceMs = Number.isInteger(hookGraceRaw) && hookGraceRaw >= 100 && hookGraceRaw <= 600_000 ? hookGraceRaw : undefined;
  const options = {
    // `migrateMaps` (перевод карт v2 на журналы, задача 7 карты-журнала) здесь НЕ включён: `methods/backlog.ts`,
    // `methods/journal.ts` и E2E окна читают `map.json` сырым файлом и не поймут v3. Включается в задаче 10, когда
    // каждый читатель карты идёт через `readMap`/`assembleMap`.
    ...(envIdleMs ? { idleMs: Number(envIdleMs) } : {}),
    ...(probeVersions ? { probeVersion: probeCliVersion, probeCodexCatalog } : {}),
    ...(limits === undefined ? {} : { limits }),
    ...(glmCheck === undefined ? {} : { glmCheck }),
    ...(startupWaitMs === undefined ? {} : { startupWaitMs }),
    ...(codexHookGraceMs === undefined ? {} : { codexHookGraceMs }),
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
