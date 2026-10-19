/**
 * Папка своего провайдера `~/.parley/providers/<id>/` (спека своих провайдеров 2026-10-17, разделы 5.4 и 6.2):
 * посев файла состояния Claude Code, ссылки на настройки Claude Code человека, перенос доверия к папке и хвоста ключа.
 * Всё, что Parley здесь пишет, лежит в папке провайдера в доме Parley; в `~/.claude` и в файле состояния
 * человека — только чтение. Ссылки трогаются только как ссылки (через `lstat`): настоящие файлы и папки
 * провайдера — копии и то, что создано в его сессиях, — не удаляются и не заменяются никогда.
 */

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { customProviderDir, isValidCustomProviderId, type CustomProviderRecord } from './custom-providers.js';
import { parleyHome } from './work/store.js';

/** Что подтягивается ссылками из папки Claude Code человека (спека 5.4). */
export const LINKED_CLAUDE_ITEMS = ['CLAUDE.md', 'skills', 'agents'] as const;

const CLAUDE_JSON = '.claude.json';

/** Папка настроек Claude Code человека: `CLAUDE_CONFIG_DIR` хоста или `~/.claude`. */
export function userClaudeConfigDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env['CLAUDE_CONFIG_DIR']?.trim();
  return fromEnv ? fromEnv : path.join(home, '.claude');
}

/** Файл состояния Claude Code человека; только для чтения (спека 6.2). */
export function userClaudeJsonPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env['CLAUDE_CONFIG_DIR']?.trim();
  return fromEnv ? path.join(fromEnv, CLAUDE_JSON) : path.join(home, CLAUDE_JSON);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const lstatOrNull = (target: string) => lstat(target).catch(() => null);
const statOk = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

/** Читает JSON-объект: `missing` — файла нет, `broken` — не разобрался или не объект/не обычный файл (не трогаем). */
async function readObject(
  file: string,
  options: { follow?: boolean } = {},
): Promise<{ state: 'ok'; data: Record<string, unknown> } | { state: 'missing' | 'broken' }> {
  // `follow` — только для файла человека (чтение): симлинк на него (менеджеры дотфайлов) не ломает перенос доверия.
  const info = await (options.follow === true ? stat(file) : lstat(file)).catch(() => null);
  if (info === null) return { state: 'missing' };
  if (!info.isFile()) return { state: 'broken' };
  try {
    const data: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isRecord(data) ? { state: 'ok', data } : { state: 'broken' };
  } catch {
    return { state: 'broken' };
  }
}

/** Атомарная запись (tmp рядом + `rename`), права 0600. */
async function writeObject(file: string, data: Record<string, unknown>): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Перечитать файл и слить правку; `mutate` возвращает false, если менять нечего. Битый файл не трогается. */
async function mergeIntoClaudeJson(
  file: string,
  mutate: (data: Record<string, unknown>) => boolean,
  options: { create: boolean },
): Promise<boolean> {
  const current = await readObject(file);
  if (current.state === 'broken') return false;
  if (current.state === 'missing' && !options.create) return false;
  const data = current.state === 'ok' ? current.data : {};
  if (!mutate(data)) return false;
  await writeObject(file, data);
  return true;
}

/** Файл в папке провайдера: из какой папки Claude Code Parley ставил ссылки в прошлый раз (чтобы узнать свои ссылки после смены источника). */
const LINK_SOURCE_FILE = '.parley-link-source';

/** Ссылка «наша» только если ведёт ровно на `<известная папка Claude Code>/<относительный путь>`; ссылку пользователя на другой источник не трогаем (спека 5.4). */
function looksLikeOurLink(target: string, rel: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === path.join(root, rel));
}

/** Ставит, переставляет или убирает одну ссылку. Настоящую запись на этом имени не трогает. */
async function reconcileLink(link: string, source: string, rel: string, roots: readonly string[], want: boolean): Promise<void> {
  const info = await lstatOrNull(link);
  const sourceAlive = want && (await statOk(source));
  if (info !== null) {
    if (!info.isSymbolicLink()) return; // настоящая запись побеждает
    const current = await readlink(link).catch(() => null);
    if (current === null) return; // ссылку убрал параллельный запуск того же провайдера
    if (sourceAlive && current === source && (await statOk(link))) return;
    const dangling = !(await statOk(link));
    if (!(dangling || looksLikeOurLink(current, rel, roots))) return; // чужая живая ссылка
    await rm(link, { force: true }); // rm снимает саму ссылку и не заходит в цель
  }
  if (sourceAlive) {
    try {
      await symlink(source, link);
    } catch (error) {
      // Параллельный запуск того же провайдера успел раньше: запись на месте — не ошибка.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await lstatOrNull(link)) === null) throw error;
    }
  }
}

async function reconcileItems(
  dir: string,
  claudeDir: string,
  folder: 'skills' | 'agents',
  want: boolean,
  roots: readonly string[],
  warn: (message: string) => void,
): Promise<void> {
  const target = path.join(dir, folder);
  const source = path.join(claudeDir, folder);
  const targetInfo = await lstatOrNull(target);
  if (targetInfo !== null && !targetInfo.isDirectory()) {
    warn(`custom provider: ${target} is not a folder, links are skipped`);
    return;
  }
  const sourceInfo = want ? await stat(source).catch(() => null) : null;
  const names = sourceInfo?.isDirectory() ? (await readdir(source)).filter((name) => !name.startsWith('.')) : [];
  if (targetInfo === null) {
    if (names.length === 0) return;
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  for (const name of names) {
    await reconcileLink(path.join(target, name), path.join(source, name), path.join(folder, name), roots, true);
  }
  // Лишние ссылки: оригинал исчез (висячая), источник сменился или галочка выключена.
  for (const name of await readdir(target)) {
    if (names.includes(name)) continue;
    await reconcileLink(path.join(target, name), path.join(source, name), path.join(folder, name), roots, false);
  }
}

export interface PrepareOptions {
  /** Папка настроек Claude Code человека, откуда берутся ссылки (`userClaudeConfigDir`). */
  claudeConfigDir: string;
  home?: string;
  /** Куда сообщать о пропущенном (по умолчанию молча). */
  warn?: (message: string) => void;
}

/**
 * Готовит папку провайдера перед запуском (спека 5.4, 6.2): папка 0700, `projects/`, посев
 * `hasCompletedOnboarding` слиянием и сверка ссылок. Идемпотентна.
 */
export async function prepareCustomProviderDir(record: CustomProviderRecord, options: PrepareOptions): Promise<void> {
  const dir = customProviderDir(record.id, options.home ?? parleyHome());
  const warn = options.warn ?? (() => undefined);
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory()) throw new Error(`Custom provider folder is not a directory: ${dir}`);
  await mkdir(path.join(dir, 'projects'), { recursive: true, mode: 0o700 });

  await mergeIntoClaudeJson(
    path.join(dir, CLAUDE_JSON),
    (data) => {
      if (data['hasCompletedOnboarding'] !== undefined) return false;
      data['hasCompletedOnboarding'] = true;
      return true;
    },
    { create: true },
  );

  const want = record.linkClaude;
  const sourceFile = path.join(dir, LINK_SOURCE_FILE);
  const previous = (await readFile(sourceFile, 'utf8').catch(() => null))?.trim() || null;
  const roots = previous === null ? [options.claudeConfigDir] : [options.claudeConfigDir, previous];
  for (const item of LINKED_CLAUDE_ITEMS) {
    if (item === 'CLAUDE.md') {
      await reconcileLink(path.join(dir, item), path.join(options.claudeConfigDir, item), item, roots, want);
    } else {
      await reconcileItems(dir, options.claudeConfigDir, item, want, roots, warn);
    }
  }
  if (previous !== options.claudeConfigDir && (want || previous !== null)) {
    await writeFile(sourceFile, `${options.claudeConfigDir}\n`, { mode: 0o600 });
  }
}

/**
 * Удаляет папку провайдера целиком. Путь строго `<home>/providers/<id>` с корректным id; `rm` не заходит в
 * цели ссылок, источники в `~/.claude` остаются целыми.
 */
export async function removeCustomProviderDir(id: string, home = parleyHome()): Promise<void> {
  const providers = path.resolve(home, 'providers');
  const dir = path.resolve(providers, id);
  if (!isValidCustomProviderId(id) || path.dirname(dir) !== providers) {
    throw new Error(`Refusing to remove a folder for provider id: ${id}`);
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * Переносит доверие к рабочей папке из файла состояния человека (только чтение) в такой же файл провайдера
 * (спека 6.2, К18). `true` — записали. Нет папки провайдера, нет доверия или оно уже есть — `false`.
 */
export async function mirrorProjectTrust(
  id: string,
  cwd: string,
  options: { userClaudeJson: string; home?: string },
): Promise<boolean> {
  const dir = customProviderDir(id, options.home ?? parleyHome());
  if ((await lstatOrNull(dir))?.isDirectory() !== true) return false;
  const user = await readObject(options.userClaudeJson, { follow: true });
  if (user.state !== 'ok' || !isRecord(user.data['projects'])) return false;
  const projects = user.data['projects'];
  // Claude Code ключует `projects` реальным путём процесса: ищем под обоими написаниями, пишем под реальным (Review Focus 1).
  const resolved = path.resolve(cwd);
  const session = await realpath(resolved).catch(() => resolved);
  let trusted = false;
  for (const start of new Set([session, resolved])) {
    for (let current = start; ; current = path.dirname(current)) {
      const entry = projects[current];
      if (isRecord(entry) && entry['hasTrustDialogAccepted'] === true) {
        trusted = true;
        break;
      }
      if (path.dirname(current) === current) break;
    }
  }
  if (!trusted) return false;
  return mergeIntoClaudeJson(
    path.join(dir, CLAUDE_JSON),
    (data) => {
      const own = isRecord(data['projects']) ? data['projects'] : {};
      const entry = isRecord(own[session]) ? own[session] : {};
      if (entry['hasTrustDialogAccepted'] === true) return false;
      data['projects'] = { ...own, [session]: { ...entry, hasTrustDialogAccepted: true } };
      return true;
    },
    { create: true },
  );
}

/**
 * Режим `api-key`: Claude Code спрашивает про ключ, пока его хвост не записан в `customApiKeyResponses`
 * (спека 6.2, К17). Ключ — `approved = [последние 20 символов]`; `null` убирает поле. Остальные поля не
 * трогаются; нет папки или нет файла при `null` — ничего не создаётся.
 */
export async function syncApiKeyApproval(id: string, key: string | null, home = parleyHome()): Promise<void> {
  const dir = customProviderDir(id, home);
  if ((await lstatOrNull(dir))?.isDirectory() !== true) return;
  await mergeIntoClaudeJson(
    path.join(dir, CLAUDE_JSON),
    (data) => {
      if (key === null) {
        if (!('customApiKeyResponses' in data)) return false;
        delete data['customApiKeyResponses'];
        return true;
      }
      const next = { approved: [key.slice(-20)], rejected: [] as string[] };
      if (JSON.stringify(data['customApiKeyResponses']) === JSON.stringify(next)) return false;
      data['customApiKeyResponses'] = next;
      return true;
    },
    { create: key !== null },
  );
}
