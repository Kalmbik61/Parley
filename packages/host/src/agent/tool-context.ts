import { loadConfig, workPaths, type McpContext, type ProviderRow, type RoleCatalog, type ToolLaunch } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import type { WorksService } from '../works/works-service.js';

/**
 * Сигнал изменения работ для `wait_for` (`mapChanges`): хост будит ожидание по событию службы работ, а не по `fs.watch`.
 * Возвращает подписку в виде, который ждёт `hostToolContext` (`onWorksChange`). Запись одних писем `onChange` не зовёт
 * (спека rooms.mail 6.7), и без `onMail` агент, ждущий письма, не проснулся бы на него; смешанная запись зовёт оба,
 * ожидание же от лишнего пробуждения только перечитывает почту.
 */
export function mapChangeSignal(works: Pick<WorksService, 'onChange' | 'onMail'>): (listener: () => void) => () => void {
  return (listener) => {
    const offChange = works.onChange(() => listener());
    const offMail = works.onMail(() => listener());
    return () => {
      offChange();
      offMail();
    };
  };
}

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
    ...(deps.roleCatalog === undefined ? {} : { roleCatalog: deps.roleCatalog }),
    ...(deps.attempts === undefined ? {} : { attempts: (request, signal) => deps.attempts!(ref, request, signal) }),
  };
}
