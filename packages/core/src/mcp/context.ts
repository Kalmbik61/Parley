import path from 'node:path';

/**
 * Кто звонит и куда писать. Сервер живёт по одному процессу на сессию и узнаёт
 * это из окружения, поэтому агенту не нужно представляться (спецификация,
 * раздел 4).
 */
export interface McpContext {
  /** Корень проекта: пути артефактов в карте отсчитываются от него. */
  projectPath: string;
  workId: string;
  /** `<проект>/.harnas/works/<work-id>/` — то, что пришло в `HARNAS_WORK_DIR`. */
  workDir: string;
  /** `null` — сессия не создана харнессом: доступен только `get_map`. */
  sessionId: string | null;
  /** Как часто перечитывать карту, если `fs.watch` промолчал. Тесты ускоряют. */
  pollMs?: number;
}

const value = (env: NodeJS.ProcessEnv, name: string): string | null => {
  const raw = env[name];
  return raw === undefined || raw === '' ? null : raw;
};

/**
 * Разбирает окружение сервера. Каталог работы обязан лежать в раскладке
 * `<проект>/.harnas/works/<work-id>/`: из неё берётся корень проекта, а по нему
 * проверяются пути артефактов. Чужой каталог — ошибка при старте, а не запись
 * карты неизвестно куда.
 */
export function contextFromEnv(env: NodeJS.ProcessEnv = process.env): McpContext {
  const raw = value(env, 'HARNAS_WORK_DIR');
  if (raw === null) throw new Error('не задан HARNAS_WORK_DIR — каталог работы неизвестен');

  const workDir = path.resolve(raw);
  const works = path.dirname(workDir);
  const harnas = path.dirname(works);
  if (path.basename(works) !== 'works' || path.basename(harnas) !== '.harnas') {
    throw new Error(`HARNAS_WORK_DIR=${workDir} не похож на .harnas/works/<work-id>`);
  }

  return {
    projectPath: path.dirname(harnas),
    workId: path.basename(workDir),
    workDir,
    sessionId: value(env, 'HARNAS_SESSION_ID'),
  };
}
