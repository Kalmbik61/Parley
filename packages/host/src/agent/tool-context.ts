import { loadConfig, workPaths, type McpContext, type ProviderRow, type ToolLaunch } from '@parley/core';
import type { SessionRef } from '@parley/protocol';

/**
 * Контекст исполнителя инструментов сессии в процессе хоста (спека хранилища 6.3, 6.9): то, что процесс MCP узнавал из
 * окружения и настроек при старте, хост берёт у токена сессии и из своих служб.
 *
 * Область — проект, работа и сессия — даёт токен (`ref`), а не запрос: `launch` идёт в контекст первым, и даже если в нём
 * окажутся чужие поля, сказанное токеном их перекроет. Поля `agent` нет: канал агента к окну нужен браузерным
 * инструментам и `create_session`, а они остаются у процесса MCP. `channel: false`: звонок через `claude/channel` — дело
 * сервера процесса MCP (в удалённом режиме он его не объявляет), исполнителю в хосте звонить некому.
 *
 * Потолок писем и корень worktree живут в настройках, не в окружении: процесс MCP читал их при старте, исполнитель — при
 * создании, то есть на время жизни своего `launch`.
 */
export async function hostToolContext(
  ref: SessionRef,
  launch: ToolLaunch,
  deps: {
    /** Строки провайдеров с входом аккаунтов и лимитами, как их видит окно; хост ещё стартует или сбой — исключение. */
    providerRows(): Promise<ProviderRow[]>;
    /** Подписка на изменение работ хоста: она будит `wait_for` вместо `fs.watch`. Возвращает отписку. */
    onWorksChange(listener: () => void): () => void;
  },
): Promise<McpContext> {
  const { config } = await loadConfig();
  return {
    ...launch,
    projectPath: ref.projectPath,
    workId: ref.workId,
    workDir: workPaths(ref.projectPath, ref.workId).dir,
    sessionId: ref.sessionId,
    channel: false,
    messageRate: config.messageRate,
    worktreeRoot: config.worktreeRoot,
    // Исключение — «строки неизвестны»: `get_map` отдаст локальный реестр с пометкой, а не откажет целиком.
    providerRows: async () => {
      try {
        return await deps.providerRows();
      } catch {
        return null;
      }
    },
    mapChanges: deps.onWorksChange,
  };
}
