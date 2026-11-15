import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { UpdateResult } from '../shared/bridge.js';
import { parseResult } from './update-helper.js';
import { besideApp, parseStagingName, type Bundle } from './update-target.js';

/**
 * Самообновление: старт окна (спека self-update §4.3, §5.6). Выполняется только там, где заменить себя можно (§5.2),
 * и до создания окон. Три действия:
 *
 * 1. Итог замены рядом с приложением читается и удаляется; если он называет запущенную версию, прежнее приложение
 *    `.old` убирается в фоне.
 * 2. Каталоги подготовки рядом с приложением: удаляется только каталог, чей pid из имени не жив (или свой) и в
 *    котором нет файла `handoff`. Переданный сценарию каталог не удаляется никогда: по мёртвому pid нельзя понять,
 *    что закончился и дочерний `mv` или `rm` убитого сценария (риск 7).
 * 3. Каталог загрузок в доме Parley очищается целиком.
 *
 * Решения — синхронные (до окон нужен готовый итог), удаление деревьев идёт в фоне, ошибки уходят в журнал и наружу
 * не бросаются.
 */

/** Файл передачи: с его появлением каталог подготовки принадлежит сценарию замены (§5.4). */
export const HANDOFF_FILE = 'handoff';

export interface StartupFs {
  /** Содержимое файла; `null`, если файла нет. */
  readText(file: string): string | null;
  /** Удаляет файл; ошибка — исключение. */
  removeFile(file: string): void;
  /** Имена в каталоге; `[]`, если каталога нет. */
  list(dir: string): string[];
  /** Что лежит по пути (без перехода по ссылке): каталог, что-то иное или ничего. Неясная ошибка — `other`. */
  kind(target: string): 'dir' | 'other' | null;
  /** Рекурсивное удаление без перехода по ссылкам; отсутствие пути — не ошибка. */
  removeTree(target: string): Promise<void>;
}

export interface StartupDeps {
  /** Приложение, из которого запущено окно (U1). */
  bundle: Bundle;
  /** Версия запущенной сборки. */
  version: string;
  /** Pid этого процесса main. */
  pid: number;
  isAlive(pid: number): boolean;
  /** Каталог загрузок в доме Parley (`<parleyHome>/desktop/updates`): его содержимое удаляется. */
  downloadsDir: string;
  fs: StartupFs;
  log(message: string, error?: unknown): void;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Файловые операции старта на настоящей файловой системе. */
export const nodeStartupFs: StartupFs = {
  readText(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  },
  removeFile(file) {
    unlinkSync(file);
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  },
  kind(target) {
    try {
      return lstatSync(target).isDirectory() ? 'dir' : 'other';
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? null : 'other';
    }
  },
  removeTree(target) {
    return rm(target, { recursive: true, force: true });
  },
};

/** Жив ли процесс: `EPERM` значит, что он есть, но чужой. Pid вне допустимого диапазона — не жив. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

/**
 * Старт окна. Возвращает итог замены для тоста (`updated` — запущена версия из итога; `failed` — замена не удалась и
 * запущена другая версия) или `null`. Удаление `.old`, каталогов подготовки и загрузок идёт в фоне.
 */
export function runUpdateStartup(deps: StartupDeps): UpdateResult | null {
  const { bundle, fs, log } = deps;
  const beside = besideApp(bundle);

  const background = (target: string): void => {
    let removal: Promise<void>;
    try {
      removal = fs.removeTree(target);
    } catch (error) {
      log(`self-update: cannot remove ${target}`, error);
      return;
    }
    removal.catch((error: unknown) => log(`self-update: cannot remove ${target}`, error));
  };

  // 1. Итог: читается и удаляется; чужая форма — как отсутствие.
  let result: UpdateResult | null = null;
  try {
    const text = fs.readText(beside.result);
    if (text !== null) {
      result = parseResult(text);
      try {
        fs.removeFile(beside.result);
      } catch (error) {
        log(`self-update: cannot remove ${beside.result}`, error);
      }
    }
  } catch (error) {
    log(`self-update: cannot read ${beside.result}`, error);
  }

  let toast: UpdateResult | null = null;
  if (result && result.version === deps.version) {
    // `swapped` или `launch_failed`: приложение всё-таки запущено новой версией. Иной отказ с той же версией —
    // не наш случай: тоста нет, `.old` не трогается.
    if (result.kind === 'updated' || result.reason === 'launch_failed') {
      toast = { kind: 'updated', version: result.version };
      background(beside.old);
    }
  } else if (result && result.kind === 'failed') {
    toast = result;
  }

  // 2. Каталоги подготовки рядом с приложением.
  let names: string[] = [];
  try {
    names = fs.list(bundle.parent);
  } catch (error) {
    log(`self-update: cannot list ${bundle.parent}`, error);
  }
  for (const name of names) {
    const parsed = parseStagingName(name, bundle.name);
    if (!parsed) continue;
    const dir = path.join(bundle.parent, name);
    try {
      if (fs.kind(dir) !== 'dir') continue;
      if (parsed.pid !== deps.pid && deps.isAlive(parsed.pid)) continue;
      if (fs.kind(path.join(dir, HANDOFF_FILE)) !== null) continue;
    } catch (error) {
      log(`self-update: cannot inspect ${dir}`, error);
      continue;
    }
    background(dir);
  }

  // 3. Каталог загрузок: всё содержимое.
  try {
    if (fs.kind(deps.downloadsDir) === 'dir') {
      for (const name of fs.list(deps.downloadsDir)) background(path.join(deps.downloadsDir, name));
    }
  } catch (error) {
    log(`self-update: cannot clear ${deps.downloadsDir}`, error);
  }

  return toast;
}
