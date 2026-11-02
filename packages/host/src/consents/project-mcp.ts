/**
 * Серверы MCP из `.mcp.json` проекта перед запуском Claude (спека 2026-11-02, 7 и 7.1). Это решение о доверии к
 * исполнению кода: сервер включается только по явному решению человека, и каждая неясная ветка (файл не читается,
 * форма не та, ошибка) кончается тем, что ни один сервер не включён.
 *
 * Хост читает `.mcp.json` от папки сессии вверх до домашней папки, берёт у каждого сервера имя и отпечаток и сверяет их
 * с решением Parley (`<parleyHome>/mcp-consent.json`, ключ — realpath корня основного репозитория, поэтому worktree
 * проекта делят решение) и с собственными решениями Claude (читаются, не пишутся). Серверы без решения — повод для
 * карточки `project-mcp`. Решение попадает в запуск ключами `enabledMcpjsonServers` и `disabledMcpjsonServers` файла
 * `--settings` сессии: в проект ничего не пишется.
 */

import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Log } from '../log.js';

export interface McpServerInfo {
  name: string;
  fingerprint: string;
  summary: string;
}

/** Итог разбора: что включить, что выключить и о чём спросить человека. */
export interface ProjectMcpInspection {
  /** realpath корня основного репозитория; `''` — разбор не удался. */
  repo: string;
  /** Серверы без решения Parley и Claude (или с изменившимся отпечатком). */
  undecided: McpServerInfo[];
  /** Решения Parley: имена для `enabledMcpjsonServers` и `disabledMcpjsonServers`. */
  enabled: string[];
  disabled: string[];
}

export interface ProjectMcpDecisionEntry {
  name: string;
  fingerprint: string;
  enabled: boolean;
}

export interface McpConsentStore {
  lookup(repo: string, name: string, fingerprint: string): { enabled: boolean } | undefined;
  record(repo: string, entries: readonly ProjectMcpDecisionEntry[], by: string): void;
}

export interface ProjectMcp {
  inspect(cwd: string): Promise<ProjectMcpInspection>;
  store: McpConsentStore;
}

const SUMMARY_MAX = 200;
const NAME_MAX = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const EMPTY: ProjectMcpInspection = { repo: '', undecided: [], enabled: [], disabled: [] };

/** JSON с рекурсивно отсортированными ключами: порядок ключей в `.mcp.json` отпечаток не меняет. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Отпечаток сервера: sha256 канонического JSON ВСЕЙ записи (ключи отсортированы рекурсивно): всё, что меняет запуск,
 * в том числе `env` (`NODE_OPTIONS`) и `headers`, меняет отпечаток, и включённый сервер снова требует решения. Это только
 * хеш: значения секретов нигде не хранятся и не показываются, а `summary` — по-прежнему только команда с аргументами
 * или адрес. `null` — запись не той формы (не объект, нет ни `command`, ни `url`, `type`/`command`/`args`/`url` не тех
 * типов): такой сервер Parley не включает и не спрашивает о нём, Claude спросит сам.
 */
export function mcpFingerprint(entry: unknown): { fingerprint: string; summary: string } | null {
  if (!isRecord(entry)) return null;
  const { type, command, args, url } = entry;
  if (type !== undefined && typeof type !== 'string') return null;
  if (command !== undefined && typeof command !== 'string') return null;
  if (url !== undefined && typeof url !== 'string') return null;
  if (args !== undefined && !(Array.isArray(args) && args.every((arg) => typeof arg === 'string'))) return null;
  if (command === undefined && url === undefined) return null;
  const canonical = canonicalJson(entry);
  const summary = (command !== undefined ? [command, ...((args as string[] | undefined) ?? [])].join(' ') : (url as string)).slice(0, SUMMARY_MAX);
  return { fingerprint: createHash('sha256').update(canonical).digest('hex'), summary };
}

/**
 * Серверы всех `.mcp.json` от `cwd` вверх до домашней папки включительно (вне домашней папки — до корня диска). У
 * одного имени побеждает ближайший файл. Файл не читается или не JSON — предупреждение и «серверов нет»: Claude
 * об этих серверах всё равно спросит сам.
 */
export async function readProjectMcpServers(cwd: string, home: string, log: Pick<Log, 'warn'>): Promise<McpServerInfo[]> {
  const servers = new Map<string, McpServerInfo>();
  const start = await realpath(cwd);
  const stop = await realpath(home).catch(() => home);
  const inside = start === stop || start.startsWith(`${stop}${path.sep}`);
  let dir = start;
  for (;;) {
    const file = path.join(dir, '.mcp.json');
    let raw: string | undefined;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
        log.warn('project MCP: .mcp.json is unreadable, no servers taken from it', { file, error: String(error) });
      }
    }
    if (raw !== undefined) {
      try {
        const data: unknown = JSON.parse(raw);
        const list = isRecord(data) ? data['mcpServers'] : undefined;
        if (!isRecord(list)) {
          log.warn('project MCP: .mcp.json has no mcpServers object, no servers taken from it', { file });
        } else {
          for (const [name, entry] of Object.entries(list)) {
            if (servers.has(name)) continue;
            const info = name.length > 0 && name.length <= NAME_MAX ? mcpFingerprint(entry) : null;
            if (info === null) {
              log.warn('project MCP: a server entry has an unknown shape, skipped (Claude will still ask)', { file, name: name.slice(0, NAME_MAX) });
              continue;
            }
            servers.set(name, { name, ...info });
          }
        }
      } catch (error) {
        log.warn('project MCP: .mcp.json is malformed, no servers taken from it (Claude will still ask)', { file, error: String(error) });
      }
    }
    if (inside && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...servers.values()];
}

/** Корень основного репозитория: для worktree — родитель общего `.git`; не репозиторий — сама папка. Всегда realpath. */
export async function repoKeyOf(cwd: string): Promise<string> {
  const real = await realpath(cwd);
  const common = await new Promise<string | null>((resolve) => {
    execFile('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: real, timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error === null ? stdout.trim() : null);
    });
  });
  if (common === null || common === '' || !path.isAbsolute(common)) return real;
  const commonReal = await realpath(common).catch(() => null);
  if (commonReal === null) return real;
  return path.basename(commonReal) === '.git' ? path.dirname(commonReal) : real;
}

interface ClaudeDecisions {
  decided: Set<string>;
  enableAll: boolean;
}

function collectDecisions(into: ClaudeDecisions, source: unknown): void {
  if (!isRecord(source)) return;
  for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
    const list = source[key];
    if (Array.isArray(list)) for (const name of list) if (typeof name === 'string') into.decided.add(name);
  }
  if (source['enableAllProjectMcpServers'] === true) into.enableAll = true;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Собственные решения Claude о серверах проекта (только чтение): три ключа в настройках пользователя, проекта и
 * локальных настроек проекта и запись проекта в файле состояния Claude. Решение Claude сильнее флага `--settings` (спайк T5, 7.1),
 * поэтому о таком сервере Parley не спрашивает и ключами не перебивает.
 */
export function readClaudeDecisions(input: { repo: string; cwd: string; configDir: string; claudeJson: string }): ClaudeDecisions {
  const out: ClaudeDecisions = { decided: new Set(), enableAll: false };
  collectDecisions(out, readJson(path.join(input.configDir, 'settings.json')));
  for (const root of new Set([input.repo, input.cwd])) {
    collectDecisions(out, readJson(path.join(root, '.claude', 'settings.json')));
    collectDecisions(out, readJson(path.join(root, '.claude', 'settings.local.json')));
  }
  const state = readJson(input.claudeJson);
  const projects = isRecord(state) ? state['projects'] : undefined;
  if (isRecord(projects)) for (const key of new Set([input.repo, input.cwd])) collectDecisions(out, projects[key]);
  return out;
}

interface StoreFile {
  version: 1;
  repos: Record<string, Record<string, { fingerprint: string; enabled: boolean; decidedAt: string; by: string }>>;
}

/** Решения Parley: память — источник истины, файл — атомарная копия; битый файл — пустой (человека спросят снова). */
export function createMcpConsentStore(home: string, log: Pick<Log, 'warn'>): McpConsentStore {
  const file = path.join(home, 'mcp-consent.json');
  let state: StoreFile = { version: 1, repos: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(parsed) && parsed['version'] === 1 && isRecord(parsed['repos'])) {
      for (const [repo, names] of Object.entries(parsed['repos'])) {
        if (!isRecord(names)) continue;
        for (const [name, record] of Object.entries(names)) {
          if (isRecord(record) && typeof record['fingerprint'] === 'string' && typeof record['enabled'] === 'boolean') {
            (state.repos[repo] ??= {})[name] = {
              fingerprint: record['fingerprint'],
              enabled: record['enabled'],
              decidedAt: typeof record['decidedAt'] === 'string' ? record['decidedAt'] : '',
              by: typeof record['by'] === 'string' ? record['by'] : '',
            };
          }
        }
      }
    } else {
      log.warn('project MCP: consent file has an unexpected shape, starting empty');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('project MCP: consent file is damaged, starting empty', { error: String(error) });
    state = { version: 1, repos: {} };
  }

  const save = (): void => {
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, file);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    } catch (error) {
      log.warn('project MCP: consent file was not written', { error: String(error) });
    }
  };

  return {
    lookup(repo, name, fingerprint) {
      const record = state.repos[repo]?.[name];
      // Другой отпечаток — решение о другом сервере: вопрос задаётся заново.
      return record !== undefined && record.fingerprint === fingerprint ? { enabled: record.enabled } : undefined;
    },
    record(repo, entries, by) {
      const at = new Date().toISOString();
      const names = (state.repos[repo] ??= {});
      for (const entry of entries) names[entry.name] = { fingerprint: entry.fingerprint, enabled: entry.enabled, decidedAt: at, by };
      save();
    },
  };
}

export interface ProjectMcpOptions {
  /** Папка Parley с `mcp-consent.json`. */
  home: string;
  /** Домашняя папка человека: верхняя граница поиска `.mcp.json`. */
  userHome: string;
  /** Папка настроек Claude и файл его состояния (пути считает вызывающий): только чтение. */
  claudeConfigDir: string;
  claudeJson: string;
  log: Pick<Log, 'warn'>;
}

export function createProjectMcp(options: ProjectMcpOptions): ProjectMcp {
  const store = createMcpConsentStore(options.home, options.log);
  return {
    store,
    async inspect(cwd) {
      try {
        const real = await realpath(cwd);
        const servers = await readProjectMcpServers(real, options.userHome, options.log);
        if (servers.length === 0) return { ...EMPTY };
        const repo = await repoKeyOf(real);
        const claude = readClaudeDecisions({ repo, cwd: real, configDir: options.claudeConfigDir, claudeJson: options.claudeJson });
        const result: ProjectMcpInspection = { repo, undecided: [], enabled: [], disabled: [] };
        for (const server of servers) {
          // Решение Claude сильнее флага: о таком сервере не спрашиваем и ключами не перебиваем.
          if (claude.enableAll || claude.decided.has(server.name)) continue;
          const decision = store.lookup(repo, server.name, server.fingerprint);
          if (decision === undefined) result.undecided.push(server);
          else (decision.enabled ? result.enabled : result.disabled).push(server.name);
        }
        return result;
      } catch (error) {
        // Неясная ветка кончается тем, что ничего не включено: Claude спросит сам.
        options.log.warn('project MCP: inspection failed, no server enabled by Parley', { cwd, error: String(error) });
        return { ...EMPTY };
      }
    },
  };
}
