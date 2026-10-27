import { loadConfig, workPaths, type McpContext, type ProviderRow, type RoleCatalog, type SessionActivity, type ToolLaunch } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { ActivityService } from '../activity/activity-service.js';
import type { WorksService } from '../works/works-service.js';

/**
 * Откуда `wait_for` узнаёт, что его вызов брошен (`McpContext.turnBoundarySince`): провайдер сессии по карте работ и её
 * живая активность. Только сессии Codex получают проверку: Claude Code сам отменяет прерванный вызов, а его
 * `UserPromptSubmit` приходит и при сообщении человека, поставленном в очередь посреди работы, — для живого вызова такая
 * «граница» была бы ложной, и `wait_for` отвечал бы `running`.
 */
export interface TurnBoundarySource {
  /** Провайдер сессии; `undefined` — работы или сессии в карте нет. */
  provider(ref: SessionRef): string | undefined;
  activity(ref: SessionRef): { activity: Pick<SessionActivity, 'turnBoundaryAt'> } | undefined;
}

/** Источник границ хода хоста: провайдер — из карты работы в памяти службы работ, активность — из службы активности. */
export const turnBoundarySource = (
  works: Pick<WorksService, 'entry'>,
  activity: Pick<ActivityService, 'get'>,
): TurnBoundarySource => ({
  provider: (ref) =>
    works.entry(ref.projectPath, ref.workId)?.map.sessions.find((session) => session.id === ref.sessionId)?.provider,
  activity: (ref) => activity.get(ref),
});

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
 *
 * Каталог ролей для `list_roles` хост даёт свой, общий с окном и кэшированный: без него исполнитель при каждом вызове сам
 * читает конфигурацию Codex (`codex app-server`, до 8 с), и вызовы агентов нагружали бы хост (спека хранилища 6.3).
 */
export async function hostToolContext(
  ref: SessionRef,
  launch: ToolLaunch,
  deps: {
    /** Строки провайдеров с входом аккаунтов и лимитами, как их видит окно; хост ещё стартует или сбой — исключение. */
    providerRows(): Promise<ProviderRow[]>;
    /** Подписка на изменение работ хоста: она будит `wait_for` вместо `fs.watch`. Возвращает отписку. */
    onWorksChange(listener: () => void): () => void;
    /** Каталог ролей для `list_roles` (кэш хоста, тот же, что у `roles.list`); нет — исполнитель читает каталог сам. */
    roleCatalog?: (cwd: string) => Promise<RoleCatalog>;
    /** Канал попыток внутри хоста: область задаёт токен, а не аргументы инструмента. */
    attempts?: (ref: SessionRef, request: unknown, signal?: AbortSignal) => Promise<unknown>;
    /** Границы хода для брошенного `wait_for` (только Codex, см. `TurnBoundarySource`); нет — вызов всегда живой. */
    turnBoundary?: TurnBoundarySource;
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
    // Исключение — «строки неизвестны»: `get_map {field: "providers"}` отдаст локальный реестр с пометкой, а не откажет целиком.
    providerRows: async () => {
      try {
        return await deps.providerRows();
      } catch {
        return null;
      }
    },
    mapChanges: deps.onWorksChange,
    ...(deps.roleCatalog === undefined ? {} : { roleCatalog: deps.roleCatalog }),
    ...(deps.attempts === undefined ? {} : { attempts: (request, signal) => deps.attempts!(ref, request, signal) }),
    // Граница хода новее начала вызова — вызов брошен (`wait_for`). Провайдер решает, есть ли проверка вообще; активность
    // читается в момент вопроса, а не при создании контекста.
    ...(deps.turnBoundary === undefined || deps.turnBoundary.provider(ref) !== 'codex'
      ? {}
      : {
          turnBoundarySince: (sinceMs) => {
            const at = deps.turnBoundary!.activity(ref)?.activity.turnBoundaryAt;
            return at != null && Date.parse(at) > sinceMs;
          },
        }),
  };
}
