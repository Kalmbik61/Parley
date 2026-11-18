/**
 * Сведения о сборке окна: короткий SHA, дата коммита и правки отслеживаемых файлов.
 * `electron.vite.config.ts` узнаёт их у git при сборке и кладёт в бандл как `__PARLEY_BUILD__`.
 */
export interface BuildInfo {
  commit: string | null;
  commitDate: string | null;
  dirty: boolean;
}

declare const __PARLEY_BUILD__: unknown;

const NONE: BuildInfo = { commit: null, commitDate: null, dirty: false };

/** Значение из бандла, если форма верная; чужое или отсутствующее — нули. */
export function readBuildInfo(raw: unknown): BuildInfo {
  if (typeof raw !== 'object' || raw === null) return NONE;
  const { commit, commitDate, dirty } = raw as Record<string, unknown>;
  return {
    commit: typeof commit === 'string' && commit !== '' ? commit : null,
    commitDate: typeof commitDate === 'string' && commitDate !== '' ? commitDate : null,
    dirty: dirty === true,
  };
}

export const BUILD_INFO: BuildInfo = readBuildInfo(typeof __PARLEY_BUILD__ === 'undefined' ? undefined : __PARLEY_BUILD__);

/** Путь внутри домашнего каталога — `~/…`, сам каталог — `~`, прочее как есть. */
export function tildify(path: string, home: string): string {
  const base = home.length > 1 ? home.replace(/\/+$/, '') : home;
  if (base === '' || base === '/') return path;
  if (path === base) return '~';
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}
