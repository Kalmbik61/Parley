import { projectNativeSkillConfigArgs } from './native-context.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { discoverClaudeRoles } from '../roles/claude.js';
import { buildRoleCatalog, resolveRoleChoice, RoleChoiceError, type RoleChoice, type ResolvedRoleChoice } from '../roles/catalog.js';
import { discoverCodexRoles } from '../roles/codex.js';
import { readCodexRoleContext, type CodexContextOptions } from '../roles/context.js';
import { findRunnerBinary } from './find-binary.js';
import { claudeConfigDirFor, isClaudeCode, loadProviders, type ProviderEntry } from '../providers.js';
import type { RoleCatalog } from '../roles/types.js';
import type { SessionRole, WorkSession } from './types.js';

export function agentDirs(projectPath: string, claudeHome = path.join(homedir(), '.claude')): string[] {
  return [path.join(projectPath, '.claude', 'agents'), path.join(claudeHome, 'agents')];
}
export async function listAgents(dirs: readonly string[]): Promise<string[]> {
  if (!dirs[0] || !dirs[1]) return [];
  const catalog = await discoverClaudeRoles({ cwd: path.dirname(path.dirname(dirs[0])), homeDir: homedir(), configDir: path.dirname(dirs[1]) });
  return catalog.roles.filter(role => role.source === 'claude').map(role => role.nativeAgent).sort();
}
export async function assertAgent(name: string, dirs: readonly string[]): Promise<void> {
  const known = await listAgents(dirs);
  if (known.includes(name)) return;
  throw new Error(known.length === 0
    ? `agent ${name} does not exist: neither in the project's .claude/agents/ nor in ~/.claude/agents/`
    : `agent ${name} does not exist; found: ${known.join(', ')}`);
}
export function sessionRole(session: Pick<WorkSession, 'role' | 'agent'>): SessionRole | null {
  return session.role ?? (session.agent == null ? null : { source: 'claude', name: session.agent });
}
export const roleId = (role: SessionRole | null | undefined): string | null => role ? `${role.source}:${role.name}` : null;
export function roleFromId(id: string): SessionRole {
  const colon = id.indexOf(':');
  const source = id.slice(0, colon);
  const name = id.slice(colon + 1);
  if (!['builtin', 'claude', 'codex'].includes(source) || !name) throw new Error('invalid-role');
  return { source: source as SessionRole['source'], name };
}

/** Literal native config options only, in their original order. A custom profile cannot be verified. */
function nativeConfigArgs(entry: ProviderEntry): { args: string[]; unsupported: boolean } {
  const projections: string[][] = [];
  for (const template of [entry.runner.args ?? [], entry.runner.resumeArgs ?? []]) {
    const args: string[] = [];
    for (let i = 0; i < template.length; i++) {
      const item = template[i]!;
      if (item === '-c' || item === '--config') {
        const value = template[++i];
        if (value === undefined) return { args: [], unsupported: true };
        if (!value.includes('{')) args.push('-c', value);
        else if (!['{mcpConfig}', '{developerInstructions}', '{notify}', '{skillCatalog}', '{sandbox}', 'model_reasoning_effort="{effort}"'].includes(value)) return { args: [], unsupported: true };
      } else if (!['--no-daemon', '-a', 'on-request', '--model', '{model}', '{prompt}', 'resume', '{providerSessionId}'].includes(item)) {
        // Profiles, cwd and other permission switches are not represented by config/read.
        // No guessed merge: native role selection remains unavailable for that custom runner.
        return { args: [], unsupported: true };
      }
    }
    projections.push(args);
  }
  if (JSON.stringify(projections[0]) !== JSON.stringify(projections[1])) return { args: [], unsupported: true };
  return { args: projections[0]!, unsupported: false };
}
/** Selected launch/resume template only; no fresh registry lookup or secret argument snapshot. */
export function projectSkillRunnerContext(entry: ProviderEntry, template: readonly string[]): { verified: boolean; configArgs: string[] } {
  if (entry.id !== 'codex') return { verified: false, configArgs: [] };
  const configArgs: string[] = [];
  const knownGenerated = new Set(['tui.terminal_title', 'tui.notifications', 'tui.notification_method',
    'tui.notification_condition', 'project_doc_fallback_filenames']);
  const generated = new Set(['{mcpConfig}', '{developerInstructions}', '{notify}', '{skillCatalog}', '{sandbox}', 'model_reasoning_effort="{effort}"']);
  for (let i = 0; i < template.length; i++) {
    const item = template[i]!;
    if (item === '--no-daemon' || item === '{prompt}') continue;
    if (i === 0 && item === 'resume' && template[i + 1] === '{providerSessionId}') { i++; continue; }
    if (item === '--model' && template[i + 1] === '{model}') { i++; continue; }
    if (item === '-a' && template[i + 1] === 'on-request') { i++; continue; }
    let value: string | undefined;
    if (item === '-c' || item === '--config') value = template[++i];
    else if (item.startsWith('--config=')) value = item.slice('--config='.length);
    else if (item.startsWith('-c') && item.length > 2) value = item.slice(2);
    else return { verified: false, configArgs: [] };
    if (value === undefined) return { verified: false, configArgs: [] };
    if (generated.has(value)) continue;
    const key = value.slice(0, value.indexOf('=')).trim();
    if (knownGenerated.has(key)) continue;
    if (key !== 'skills.config' && key !== 'project_root_markers') return { verified: false, configArgs: [] };
    configArgs.push('-c', value);
  }
  const projected = projectNativeSkillConfigArgs(configArgs);
  return projected === null ? { verified: false, configArgs: [] } : { verified: true, configArgs: projected };
}

export interface SessionRoleCatalogOptions {
  codex?: boolean;
  /** Provider the roles are for: GLM keeps its Claude config in `~/.claude`, not in the host's `CLAUDE_CONFIG_DIR`. */
  provider?: ProviderEntry;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Internal fixture adapter, never protocol input. */
  context?: (options: CodexContextOptions) => ReturnType<typeof readCodexRoleContext>;
}
/** Current native inventory. No cached role defaults or manually merged trust/config. */
export async function sessionRoleCatalog(cwd: string, options: SessionRoleCatalogOptions = {}): Promise<RoleCatalog> {
  const homeDir = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const configDir = options.provider ? claudeConfigDirFor(options.provider, env) : env.CLAUDE_CONFIG_DIR;
  const claude = await discoverClaudeRoles({ cwd, homeDir, ...(configDir ? { configDir } : {}) });
  if (!options.codex) return buildRoleCatalog(claude);
  const registry = await loadProviders();
  const entry = registry.codex;
  const flags = entry ? nativeConfigArgs(entry) : { args: [], unsupported: true };
  let context: Awaited<ReturnType<typeof readCodexRoleContext>>;
  try {
    const command = entry && !flags.unsupported ? await findRunnerBinary(entry.runner.command, env) : null;
    context = command === null ? { verified: false, layers: [], diagnostics: [{ source: 'codex', code: 'context-unverified' }] }
      : await (options.context ?? readCodexRoleContext)({ cwd, command, configArgs: flags.args, env });
  } catch { context = { verified: false, layers: [], diagnostics: [{ source: 'codex', code: 'context-unverified' }] }; }
  const native = context.verified ? await discoverCodexRoles({ cwd, homeDir, configLayers: context.layers, ...(env.CODEX_HOME ? { codexHome: env.CODEX_HOME } : {}) })
    : { roles: [], diagnostics: context.diagnostics, partial: true };
  return buildRoleCatalog(claude, native);
}

/** Prove native option positions with the supported default template grammar only.
 * Unknown arity, option terminators and positional channel values cannot prove delivery.
 * Other providers may explicitly use the same Claude-like layer grammar for role text.
 */
function nativeRolePairs(template: readonly string[], codex: boolean): Map<string, string[]> | null {
  const valueFlags = codex
    ? new Set(['-c', '--config', '--model', '-a'])
    : new Set(['--session-id', '--resume', '--mcp-config', '--settings', '--append-system-prompt',
      '--dangerously-load-development-channels', '--model', '--effort', '--agent', '--disallowedTools']);
  const pairs = new Map<string, string[]>();
  for (let i = 0; i < template.length; i++) {
    const flag = template[i]!;
    if (codex && flag === '--no-daemon') continue;
    if (codex && i === 0 && flag === 'resume' && template[i + 1] === '{providerSessionId}') { i++; continue; }
    if (flag === '{prompt}' && i === template.length - 1) continue;
    if (!valueFlags.has(flag)) return null;
    const value = template[++i];
    if (value === undefined || value.startsWith('-')) return null;
    const key = flag === '--config' ? '-c' : flag;
    const values = pairs.get(key) ?? [];
    values.push(value);
    pairs.set(key, values);
  }
  return pairs;
}
function singleRoleValue(pairs: Map<string, string[]>, flag: string, slot: string): boolean {
  const values = pairs.get(flag);
  return values?.length === 1 && values[0] === slot;
}
function singleRoleConfig(pairs: Map<string, string[]>, slot: string, key: string): boolean {
  const values = (pairs.get('-c') ?? []).filter(value => value === slot || (value.includes('=') && value.slice(0, value.indexOf('=')).trim() === key));
  return values.length === 1 && values[0] === slot;
}

/** Validate both start and resume before creation; revalidate the actual channel on every launch. */
export function assertRoleDelivery(entry: ProviderEntry, choice: ResolvedRoleChoice, templates = [entry.runner.args ?? [], entry.runner.resumeArgs ?? []]): void {
  for (const template of templates) {
    if (entry.id === 'codex' && (choice.readOnly || choice.sandboxMode !== null)) {
      // Native flags can supersede sandbox_mode=-c. Refuse ambiguous custom delivery.
      // rust-v0.156.1 codex-rs/utils/cli/src/shared_options.rs: sandbox/-s,
      // dangerously-bypass-approvals-and-sandbox/yolo, approve-for-me/not-so-yolo.
      const conflict = template.some(raw => {
        const item = raw.startsWith('--config=') ? raw.slice('--config='.length) : raw.startsWith('-c') && raw !== '-c' ? raw.slice(2) : raw;
        return ['--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--approve-for-me', '--not-so-yolo'].includes(item) ||
        item.startsWith('--sandbox=') || (item.startsWith('-s') && item.length > 2) ||
        /^\s*(?:sandbox_mode\s*=|permissions(?:\.|\s*=))/.test(item);
      });
      if (conflict) throw new RoleChoiceError('role-permissions-unavailable');
    }
    const required = choice.nativeAgent !== null || choice.roleText !== '' || choice.sandboxMode !== null || choice.readOnly;
    if (!required) continue; // Plain custom runners keep their existing compatibility/warning behavior.
    const pairs = nativeRolePairs(template, entry.id === 'codex');
    if (!pairs) throw new RoleChoiceError('role-permissions-unavailable');
    // A native Claude body may use --agent alone. Any present common layer must still use its native route.
    if (template.includes('{systemPrompt}') && (entry.id === 'codex' || !singleRoleValue(pairs, '--append-system-prompt', '{systemPrompt}'))) throw new RoleChoiceError('role-permissions-unavailable');
    if (template.includes('{developerInstructions}') && (entry.id !== 'codex' || !singleRoleConfig(pairs, '{developerInstructions}', 'developer_instructions'))) throw new RoleChoiceError('role-permissions-unavailable');
    const sandbox = singleRoleConfig(pairs, '{sandbox}', 'sandbox_mode');
    if (choice.nativeAgent !== null && (!isClaudeCode(entry) || !singleRoleValue(pairs, '--agent', '{agent}'))) throw new RoleChoiceError('role-permissions-unavailable');
    if (choice.roleText && !(entry.id === 'codex'
      ? singleRoleConfig(pairs, '{developerInstructions}', 'developer_instructions')
      : singleRoleValue(pairs, '--append-system-prompt', '{systemPrompt}'))) throw new RoleChoiceError('role-permissions-unavailable');
    if (choice.sandboxMode !== null && (entry.id !== 'codex' || !sandbox)) throw new RoleChoiceError('role-permissions-unavailable');
    if (choice.readOnly && (isClaudeCode(entry)
      ? !singleRoleValue(pairs, '--disallowedTools', '{disallowedTools}')
      : entry.id !== 'codex' || !sandbox)) throw new RoleChoiceError('role-permissions-unavailable');
  }
}
export async function prepareSessionRole(cwd: string, entry: ProviderEntry, choice: RoleChoice, catalog?: RoleCatalog): Promise<ResolvedRoleChoice> {
  const current = catalog ?? (choice.roleId?.startsWith('builtin:') || !choice.roleId ? buildRoleCatalog() : await sessionRoleCatalog(cwd, { codex: choice.roleId.startsWith('codex:'), provider: entry }));
  if (choice.roleId?.startsWith('codex:') && current.diagnostics.some(item => item.source === 'codex' && (item.code === 'context-unverified' || item.code === 'unsupported-config'))) throw new RoleChoiceError('role-context-unverified');
  const resolved = resolveRoleChoice(current, isClaudeCode(entry) ? { ...choice, claudeCode: true } : choice);
  assertRoleDelivery(entry, resolved);
  return resolved;
}

export interface RoleSummary {
  id: string; name: string; description: string; source: SessionRole['source'];
  provider: string; model: string | null; effort: string | null; readOnly: boolean;
  models?: { claude: string | null; codex: string | null };
}
export interface RoleList { roles: RoleSummary[]; partial: boolean; diagnostics: Array<{ source: SessionRole['source']; code: string }> }
/** Public whitelist: never expose native prompt, path or raw config. */
export function roleSummaries(catalog: RoleCatalog): RoleList {
  return { partial: catalog.partial, diagnostics: catalog.diagnostics.map(({ source, code }) => ({ source, code })), roles: catalog.roles.map(role => {
    const safe = { ...catalog, diagnostics: [] };
    const choice = resolveRoleChoice(safe, { roleId: role.id });
    return { id: role.id, name: role.name, description: role.description, source: role.source, provider: role.provider,
      model: choice.model, effort: choice.effort, readOnly: role.readOnly,
      ...(role.source === 'builtin' ? { models: { claude: resolveRoleChoice(safe, { roleId: role.id, provider: 'claude' }).model, codex: resolveRoleChoice(safe, { roleId: role.id, provider: 'codex' }).model } } : {}),
    };
  }) };
}
