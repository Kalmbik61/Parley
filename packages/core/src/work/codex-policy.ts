/**
 * Политика одобрений и доверие к папке для запуска Codex (спека 2026-10-21, разделы 4.3 и 5.1–5.2): готовые пары
 * `-c`, которые `launch.ts` кладёт в подстановки `{approvals}` и `{trust}` шаблона запуска и `resume`. Только ключи
 * конфига, без `-a` и `--sandbox`: одни и те же пары работают и при запуске, и после `resume <id>` (решение 10).
 * В `~/.codex` ничего не пишется, `danger-full-access` и обходы одобрений Parley не назначает.
 */

import type { CodexWriteApprovals } from '../config.js';
import { tomlString } from './mcp-config.js';

/**
 * Нижняя граница версии Codex для режима `auto`: на ней спайк 0 проверил ключ `approvals_reviewer`. Ниже незнакомый
 * ключ конфига сорвал бы старт каждой сессии, поэтому там запуск идёт как `terminal` (решение 18).
 */
export const CODEX_AUTO_MIN_VERSION = '0.162.0';

/**
 * Пары `-c` политики одобрений. Роль только для чтения — `never`: записи отвергает песочница, инструменты `parley`
 * одобрены конфигом сервера, спрашивать нечего (решение 9), и режим пишущих ролей её не касается. Пишущая роль —
 * `on-request`, плюс авторевьюер Codex в режиме `auto`; в `parley` и `terminal` решает человек (карточка или терминал).
 */
export function codexPolicyArgs(role: { readOnly: boolean }, mode: CodexWriteApprovals): string[] {
  if (role.readOnly) return ['-c', 'approval_policy="never"'];
  const args = ['-c', 'approval_policy="on-request"'];
  if (mode === 'auto') args.push('-c', 'approvals_reviewer="auto_review"');
  return args;
}

/**
 * Пара `-c projects={…}`: папка проекта и cwd сессии помечены доверенными, и Codex не показывает экран доверия.
 * Второй ключ — только когда cwd отличается от проекта (worktree внутри или рядом): тогда доверие нужно и ему.
 * Пути приходят уже после `realpath` (его считает хост), строки — через `tomlString`. Флаг доверие не сохраняет:
 * файлы Codex не пишутся.
 */
export function trustArgs(keys: { project: string; cwd: string }): string[] {
  const paths = keys.cwd === keys.project ? [keys.project] : [keys.project, keys.cwd];
  const table = paths.map((folder) => `${tomlString(folder)}={trust_level="trusted"}`).join(',');
  return ['-c', `projects={${table}}`];
}
