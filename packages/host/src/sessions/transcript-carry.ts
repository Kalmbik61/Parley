/**
 * Перенос разговора Claude Code между аккаунтами Anthropic (спека передачи сессии, 5.4, 5.4.1, T11): транскрипт
 * прежнего аккаунта копируется в `projects/<slug>/` папки цели, новый агент поднимается форком
 * (`--resume <id> --fork-session`), а после появления файла форка копия в папке цели удаляется. Источник в папке
 * прежнего аккаунта не трогается никогда — ни копией, ни удалением.
 */

import { cp, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { claudeProjectRoots, claudeRootFor, type ProviderEntry } from '@parley/core';

/** Id аккаунта подписки Claude, выданный окном (`custom-claude-2`, …): так узнаётся и удалённый из реестра. */
const CLAUDE_ACCOUNT_ID = /^custom-claude-\d+$/;

/**
 * Аккаунт Anthropic: глобальный Claude Code или аккаунт подписки Claude. Провайдера нет в реестре (удалён) — по id:
 * его папка с транскриптами цела (спека 5.8). Свои провайдеры с адресом (GLM, DeepSeek) — нет: подписи thinking-блоков
 * и серверные ссылки их журнала чужой API не примет.
 */
export function isClaudeAccount(provider: string, entry: ProviderEntry | undefined): boolean {
  if (entry === undefined) return CLAUDE_ACCOUNT_ID.test(provider);
  return entry.id === 'claude' || entry.account?.kind === 'claude-account';
}

/**
 * Корень истории аккаунта — куда его Claude Code пишет `projects/<slug>/<id>.jsonl`. Аккаунт подписки — своя папка
 * (`claudeRootFor` работает по id и для удалённого), глобальный — первый корень Claude Code хоста
 * (`$CLAUDE_CONFIG_DIR/projects` или `~/.claude/projects`; тесты подменяют `PARLEY_CLAUDE_PROJECTS_DIR`).
 */
export function historyRoot(provider: string): string {
  return provider === 'claude' ? (claudeProjectRoots()[0] as string) : claudeRootFor(provider);
}

async function samePath(a: string, b: string): Promise<boolean> {
  const real = async (value: string): Promise<string> => realpath(value).catch(() => path.resolve(value));
  return (await real(a)) === (await real(b));
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Каталог проекта (`slug`) в корне, где лежит `<id>.jsonl`; нет — `null`. Имя slug строит Claude Code, не мы. */
async function slugOf(root: string, id: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && (await isFile(path.join(root, entry.name, `${id}.jsonl`)))) return entry.name;
  }
  return null;
}

/** Что скопировано в папку цели; `copy: null` — корни совпадают, копировать и удалять нечего. */
export interface CarriedTranscript {
  /** Id разговора прежнего агента: им `--resume` поднимает форк. */
  from: string;
  /** Скопированный в папку цели `<from>.jsonl`; удаляется после появления файла форка. */
  copy: string | null;
}

/**
 * Копирует `<корень прежнего>/<slug>/<id>.jsonl` и каталог `<id>/` (субагенты, вывод инструментов) в
 * `<корень цели>/<slug>/`. Slug тот же: cwd сессии не меняется. Транскрипта нет — ошибка: продолжать нечего, замена
 * откатывается к пакету передачи.
 */
export async function copyTranscript(previous: string, target: string, id: string): Promise<CarriedTranscript> {
  const from = historyRoot(previous);
  const to = historyRoot(target);
  const slug = await slugOf(from, id);
  if (slug === null) throw new Error(`the transcript ${id} of ${previous} is not on disk`);
  if (await samePath(from, to)) return { from: id, copy: null };
  const dir = path.join(to, slug);
  const copy = path.join(dir, `${id}.jsonl`);
  await cp(path.join(from, slug, `${id}.jsonl`), copy, { force: true, preserveTimestamps: true });
  const folder = path.join(from, slug, id);
  try {
    if ((await stat(folder)).isDirectory()) await cp(folder, path.join(dir, id), { recursive: true, force: true, preserveTimestamps: true });
  } catch (error) {
    // Каталога разговора может не быть (без субагентов и вывода инструментов): это не сбой копии.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { from: id, copy };
}

/**
 * Копия в папке цели после форка лишняя (5.4.1, п. 1): `/resume` цели показал бы два одинаковых разговора. Удаляется
 * только `<from>.jsonl` и только когда рядом уже есть файл форка `<fork>.jsonl` и корни прежнего и цели разные.
 * Каталог `<from>/` остаётся: записи форка могут ссылаться на вывод инструментов прежних ходов. `true` — удалена.
 */
export async function removeForkCopy(previous: string, target: string, from: string, fork: string): Promise<boolean> {
  const root = historyRoot(target);
  if (await samePath(historyRoot(previous), root)) return false;
  const slug = await slugOf(root, from);
  if (slug === null || !(await isFile(path.join(root, slug, `${fork}.jsonl`)))) return false;
  await rm(path.join(root, slug, `${from}.jsonl`), { force: true });
  return true;
}

/** Убрать копию, когда форк не поднялся: разговор цели остаётся без следа переноса. */
export async function discardCopy(carried: CarriedTranscript): Promise<void> {
  if (carried.copy === null) return;
  await rm(carried.copy, { force: true });
  await rm(path.join(path.dirname(carried.copy), carried.from), { recursive: true, force: true });
}
