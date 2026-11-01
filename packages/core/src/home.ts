import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { envValue, ENV_PREFIX, HOME_DIR, LEGACY_ENV_PREFIX, LEGACY_HOME_DIR, type Env } from './names.js';
import { isDirectorySync } from './work/state-dir.js';

// Дом Parley без хранилища работ: модуль лёгкий (fs, os, path), его берёт и мост (`@parley/core/home`), которому
// `work/store.ts` с `node:sqlite` не нужен.

/** Найденный дом и снимок входов, под которым он найден (`parleyHome`). */
let homeMemo: { snapshot: string; home: string } | undefined;

/**
 * Домашняя папка Parley (R4), первое подходящее:
 * 1. `PARLEY_HOME`; 2. `HARNAS_HOME` — этим живут тесты и второй дом;
 * 3. `~/.parley`, если он есть; 4. `~/.harnas`, если он есть — данные человека со времён имени harnas;
 * 5. иначе `~/.parley`.
 * Пустая переменная — то же, что незаданная. `env` и `userHome` подменяет тест.
 */
export function parleyHome(env: Env = process.env, userHome: string = homedir()): string {
  // Дом процесса ищут на каждой записи, чтении версии и подготовке запроса, а без переменных это два `stat`: найденное
  // помним, пока не сменились сами входы — `PARLEY_HOME`, `HARNAS_HOME`, домашний каталог и признак теста. Каталоги
  // `~/.parley` и `~/.harnas` при этом смотрятся один раз на снимок: перенос дома (`migrateHome`) идёт, пока процессы
  // его агентов не живы (спека хранилища 6.9, план 4, задача 5). Чужое окружение (`env` из теста) не запоминается.
  if (env !== process.env) return checkedHome(env, userHome);
  const snapshot = [
    env[ENV_PREFIX + 'HOME'],
    env[LEGACY_ENV_PREFIX + 'HOME'],
    env['VITEST'],
    userHome,
  ].join('\u0000');
  if (homeMemo?.snapshot === snapshot) return homeMemo.home;
  const home = checkedHome(env, userHome);
  homeMemo = { snapshot, home };
  return home;
}

/** Забывает найденный дом: после переноса `~/.harnas` → `~/.parley` (`migrateHome`) прежний ответ уже неверен. */
export function forgetParleyHome(): void {
  homeMemo = undefined;
}

function checkedHome(env: Env, userHome: string): string {
  const resolved = resolveParleyHome(env, userHome);
  refuseRealHomeUnderTest(resolved);
  return resolved;
}

function resolveParleyHome(env: Env, userHome: string): string {
  const explicit = envValue(env, 'HOME');
  if (explicit !== undefined) return explicit;
  const current = path.join(userHome, HOME_DIR);
  if (isDirectorySync(current)) return current;
  const legacy = path.join(userHome, LEGACY_HOME_DIR);
  return isDirectorySync(legacy) ? legacy : current;
}

/**
 * Предохранитель: под vitest (настоящее окружение процесса, не параметр `env`) дом не может оказаться настоящим
 * `~/.parley` или `~/.harnas` — иначе тест писал бы в данные человека (инцидент 17.10.2026). Домашний каталог берётся
 * из базы пользователей: `HOME` песочницы его не подменяет.
 */
function refuseRealHomeUnderTest(resolved: string): void {
  if (process.env['VITEST'] === undefined) return;
  const target = path.resolve(resolved);
  for (const dir of [HOME_DIR, LEGACY_HOME_DIR]) {
    const real = path.join(userInfo().homedir, dir);
    const relative = path.relative(real, target);
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (!outside)
      throw new Error(
        `A test resolved the real Parley home (${target}): the sandbox test/sandbox-home.ts is not applied — was vitest run outside the package config?`,
      );
  }
}
