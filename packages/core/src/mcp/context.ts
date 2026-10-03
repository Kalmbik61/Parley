import type { SkillCatalog } from '../skills/catalog.js';
import type { WorkSession } from '../work/types.js';
import path from 'node:path';
import type { RoleCatalog } from '../roles/types.js';
import { envName, envValue, LEGACY_STATE_DIR, STATE_DIR, STATE_DIRS } from '../names.js';

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
  nativeContextRevision?: string;
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
  /** Как часто перечитывать карту, если `fs.watch` промолчал. Тесты ускоряют. */
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

  return {
    projectPath: path.dirname(state),
    workId: path.basename(workDir),
    workDir,
    sessionId: envValue(env, 'SESSION_ID') ?? null,
    // Переменную пишет сам харнесс ровно со значением `1`: чужое значение —
    // не наша настройка, и звонок остаётся выключенным.
    channel: envValue(env, 'CHANNEL') === '1',
    skillNavigator: envValue(env, 'SKILL_NAVIGATOR') === '1',
    ...(envValue(env, 'NATIVE_CONTEXT_REVISION') === undefined ? {} : { nativeContextRevision: envValue(env, 'NATIVE_CONTEXT_REVISION')! }),
  };
}
