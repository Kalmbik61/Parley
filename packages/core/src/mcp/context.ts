import type { SkillCatalog } from '../skills/catalog.js';
import type { ResourceLimits } from '../work/resource-policy.js';
import type { AttemptChannelRequest, WorkSession } from '../work/types.js';
import path from 'node:path';
import type { RoleCatalog } from '../roles/types.js';
import { envName, envValue, LEGACY_STATE_DIR, STATE_DIR, STATE_DIRS } from '../names.js';
import { AGENT_TOKEN_ENV, AGENT_URL_ENV, type AgentChannel, type ToolProfile } from '../work/mcp-config.js';
import type { ProviderRow } from './provider-rows.js';
import type { MapChanges } from './watch-map.js';

/**
 * Кто звонит и куда писать. Сервер живёт по одному процессу на сессию и узнаёт
 * это из окружения, поэтому агенту не нужно представляться (спецификация,
 * раздел 4).
 */
export interface McpContext {
  /** Корень проекта: пути артефактов в карте отсчитываются от него. */
  projectPath: string;
  /** Internal fixture inventory adapter; never environment or protocol input. */
  roleCatalog?: (cwd: string) => Promise<RoleCatalog>;
  /** Immutable launch environment snapshot. Absence is safely disabled for legacy sessions. */
  skillNavigator?: boolean;
  /** Родной список скиллов этого запуска сокращён (снимок запуска, как и `skillNavigator`). */
  skillListReduced?: boolean;
  nativeContextRevision?: string;
  /** Профиль инструментов запуска (снимок окружения): `short` прячет три инструмента памяти; нет — полный набор. */
  toolProfile?: ToolProfile;
  /** Internal isolated adapter fixture; never protocol/environment input. */
  skillCatalog?: (session: WorkSession, cwd: string) => Promise<SkillCatalog | null>;
  workId: string;
  /** `<проект>/.parley/works/<work-id>/` (или прежний `.harnas`) — то, что пришло в `PARLEY_WORK_DIR`. */
  workDir: string;
  /** `null` — сессия не создана харнессом: доступен только `get_map`. */
  sessionId: string | null;
  /**
   * Будить ли свою сессию звонком через channel (разговор агентов, 4.2).
   * Включает харнесс переменной `PARLEY_CHANNEL`, когда запустил агента с
   * флагом канала; без сессии звонить всё равно некому.
   */
  channel: boolean;
  /**
   * Канал агента к браузеру окна (спека браузера 3.7): адрес эндпоинта хоста и токен сессии. Нет — инструмент
   * `browser_open` не объявляется (сессия до обновления или хост без эндпоинта).
   */
  agent?: AgentChannel;
  /** Внутренний канал попыток для исполнителя в хосте; в окружении и протоколе его нет. */
  attempts?: (request: AttemptChannelRequest, signal?: AbortSignal) => Promise<unknown>;
  /** Как часто сверять версию работы в базе: карта перечитывается, только когда версия сменилась (спека хранилища 6.9). Тесты ускоряют. */
  pollMs?: number;
  /**
   * Потолок писем этой сессии за скользящий час (разговор агентов, 4.7). В
   * окружении его нет: `server.ts` берёт значение из настроек при старте.
   */
  messageRate?: number;
  /**
   * Корень worktree для `spawn_session { worktree: true }` (спецификация 8.1).
   * В окружении его тоже нет — `server.ts` берёт из настроек, как и `messageRate`.
   */
  worktreeRoot?: string;
  /**
   * Пороги бюджета работы и комнаты (`work/resource-policy.ts`). В окружении их нет, и подставить их агенту нечем:
   * без этого поля сервер читает настройки заново перед каждым допуском, чтобы изменение человека действовало сразу.
   * Поле нужно тестам и встраиванию.
   */
  resourceLimits?: ResourceLimits;
  /**
   * Строки провайдеров для `get_map {field: "providers"}` из своего процесса (спека хранилища 6.9): исполнитель в хосте знает
   * вход аккаунтов и лимиты сам, и спрашивать у себя по HTTP через `agent` ему незачем. `null` — строки неизвестны: каталог
   * отдаётся локальным, с пометкой. Нет поля — строки спрашиваются у хоста по каналу `agent`. В окружении его нет.
   */
  providerRows?: (signal: AbortSignal) => Promise<ProviderRow[] | null>;
  /**
   * Внешний источник «карта изменилась» для `wait_for` (спека хранилища 6.9, этап 1): хост знает о каждой записи карты
   * и будит ожидание сразу. Нет поля — ожидание узнаёт запись по тику опроса версии работы. В окружении его нет.
   */
  mapChanges?: MapChanges;
}

/**
 * Канал агента из окружения: только под новыми именами, только `http://127.0.0.1:<порт>/agent/browser` и токен из
 * 64 hex. Иное — не наша настройка, и канала нет: сервер не пойдёт по чужому адресу с токеном сессии.
 */
function agentFromEnv(env: NodeJS.ProcessEnv): AgentChannel | undefined {
  const url = env[AGENT_URL_ENV];
  const token = env[AGENT_TOKEN_ENV];
  if (typeof url !== 'string' || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/agent/browser') return undefined;
  return { url, token };
}

/**
 * Разбирает окружение сервера. Каталог работы обязан лежать в раскладке
 * `<проект>/.parley/works/<work-id>/` — или в прежней `<проект>/.harnas/works/<work-id>/`, с которой
 * запущены старые сессии: из неё берётся корень проекта, а по нему проверяются пути артефактов.
 * Чужой каталог — ошибка при старте, а не запись карты неизвестно куда.
 *
 * Переменные читаются под обоими именами (`PARLEY_*`, запасные `HARNAS_*`): сохранённый конфиг
 * MCP старой сессии задаёт только прежние.
 */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): McpContext {
  const raw = envValue(env, 'WORK_DIR');
  if (raw === undefined)
    throw new Error('PARLEY_WORK_DIR is not set — the workspace directory is unknown');

  const workDir = path.resolve(raw);
  const works = path.dirname(workDir);
  const state = path.dirname(works);
  if (path.basename(works) !== 'works' || !STATE_DIRS.includes(path.basename(state))) {
    throw new Error(
      `${envName(env, 'WORK_DIR')}=${workDir} does not look like ${STATE_DIR}/works/<work-id> (or ${LEGACY_STATE_DIR}/works/<work-id>)`,
    );
  }

  const agent = agentFromEnv(env);
  return {
    projectPath: path.dirname(state),
    workId: path.basename(workDir),
    workDir,
    sessionId: envValue(env, 'SESSION_ID') ?? null,
    // Переменную пишет сам харнесс ровно со значением `1`: чужое значение —
    // не наша настройка, и звонок остаётся выключенным.
    channel: envValue(env, 'CHANNEL') === '1',
    skillNavigator: envValue(env, 'SKILL_NAVIGATOR') === '1',
    ...(envValue(env, 'SKILL_LIST_REDUCED') === '1' ? { skillListReduced: true } : {}),
    ...(envValue(env, 'NATIVE_CONTEXT_REVISION') === undefined ? {} : { nativeContextRevision: envValue(env, 'NATIVE_CONTEXT_REVISION')! }),
    // Только точное `short`: чужое значение — не наша настройка, и сервер объявляет полный набор.
    ...(envValue(env, 'TOOL_PROFILE') === 'short' ? { toolProfile: 'short' as const } : {}),
    ...(agent === undefined ? {} : { agent }),
  };
}
