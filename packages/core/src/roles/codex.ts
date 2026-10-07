import path from 'node:path';
import { readTomlDocument } from '../skills/frontmatter.js';
import { compareRoleText, ROLE_DOCUMENT_MAX_BYTES, roleTraversal } from './claude.js';
import type { CodexRole, RoleCatalog, RoleDiscoveryLimits, SandboxMode } from './types.js';

export interface CodexRoleLayer {
  /** Native config_folder(), in the CLI's effective low-to-high order. */
  configFolder: string;
  disabled?: boolean;
  /**
   * From this native layer's parsed agents table: explicit false proves no declared roles.
   * True is unsupported in v1; omission keeps inventory partial, never guessed complete.
   * This resolver never uses config_file name hints.
   */
  hasDeclaredRoles?: boolean;
}
export interface CodexRoleOptions {
  cwd: string;
  homeDir: string;
  codexHome?: string;
  /** Caller supplies the active native stack after project trust/requirements, bound to cwd. */
  configLayers?: readonly CodexRoleLayer[];
  limits?: RoleDiscoveryLimits;
}
const allowed = new Set([
  'name',
  'description',
  'developer_instructions',
  'model',
  'model_reasoning_effort',
  'sandbox_mode',
  'nickname_candidates',
]);
const sandboxes: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

// Rust str::trim uses Unicode White_Space: includes NEL, excludes FEFF; no internal collapse.
const trimNative = (value: string): string =>
  value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');

export async function discoverCodexRoles(options: CodexRoleOptions): Promise<RoleCatalog> {
  const result: RoleCatalog = { roles: [], diagnostics: [], partial: false };
  const traversal = roleTraversal('codex', result, options.limits);
  if (!(await traversal.context(options.cwd, options.homeDir))) return result;
  const layers = options.configLayers ?? [
    { configFolder: path.resolve(options.codexHome ?? path.join(options.homeDir, '.codex')) },
    { configFolder: path.join(options.cwd, '.codex') },
  ];
  if (options.configLayers === undefined)
    traversal.report({ code: 'context-unverified', path: options.cwd });
  const roles = new Map<string, CodexRole>();
  if (layers.length > 128) traversal.report({ code: 'discovery-limit', count: layers.length });
  for (const layer of layers.slice(0, 128)) {
    if (layer.disabled) continue;
    if (!path.isAbsolute(layer.configFolder)) {
      traversal.report({ code: 'missing-context' });
      continue;
    }
    if (options.configLayers !== undefined && typeof layer.hasDeclaredRoles !== 'boolean')
      traversal.report({ code: 'context-unverified', path: layer.configFolder });
    if (layer.hasDeclaredRoles) {
      traversal.report({ code: 'unsupported-config', path: layer.configFolder });
      continue;
    }
    const inLayer = new Map<
      string,
      Omit<CodexRole, 'description'> & { description: string | null }
    >();
    for (const { canonical } of await traversal.files(
      path.join(layer.configFolder, 'agents'),
      '.toml',
      true,
    )) {
      const parsed = await readTomlDocument(canonical, ROLE_DOCUMENT_MAX_BYTES);
      if (parsed.status === 'invalid') {
        traversal.report({ ...parsed.diagnostic, path: canonical });
        continue;
      }
      const data = parsed.data;
      const name = typeof data.name === 'string' ? trimNative(data.name) : '';
      if (name === '') {
        traversal.report({ code: 'invalid-name', path: canonical });
        continue;
      }
      const invalid = (): void => traversal.report({ code: 'invalid-policy', path: canonical });
      if (
        typeof data.developer_instructions !== 'string' ||
        !trimNative(data.developer_instructions)
      ) {
        invalid();
        continue;
      }
      if (
        data.description !== undefined &&
        (typeof data.description !== 'string' || !trimNative(data.description))
      ) {
        invalid();
        continue;
      }
      if (data.model !== undefined && (typeof data.model !== 'string' || !trimNative(data.model))) {
        invalid();
        continue;
      }
      if (
        data.model_reasoning_effort !== undefined &&
        (typeof data.model_reasoning_effort !== 'string' ||
          !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(
            data.model_reasoning_effort,
          ))
      ) {
        invalid();
        continue;
      }
      if (
        data.sandbox_mode !== undefined &&
        !sandboxes.includes(data.sandbox_mode as SandboxMode)
      ) {
        invalid();
        continue;
      }
      if (
        data.nickname_candidates !== undefined &&
        (!Array.isArray(data.nickname_candidates) ||
          !data.nickname_candidates.length ||
          data.nickname_candidates.some(
            (value) =>
              typeof value !== 'string' ||
              !trimNative(value) ||
              !/^[A-Za-z0-9 _-]+$/.test(trimNative(value)),
          ) ||
          new Set(
            data.nickname_candidates.map((value) =>
              typeof value === 'string' ? trimNative(value) : '',
            ),
          ).size !== data.nickname_candidates.length)
      ) {
        invalid();
        continue;
      }
      // Other native config fields may carry requirements we cannot safely project onto main sessions.
      if (Object.keys(data).some((key) => !allowed.has(key))) {
        traversal.report({ code: 'unsupported-config', path: canonical });
        continue;
      }
      if (inLayer.has(name)) {
        traversal.report({ code: 'duplicate-role', path: canonical });
        continue;
      }
      const sandboxMode = (data.sandbox_mode as SandboxMode | undefined) ?? null;
      inLayer.set(name, {
        id: `codex:${name}`,
        source: 'codex',
        name,
        description: typeof data.description === 'string' ? trimNative(data.description) : null,
        provider: 'codex',
        readOnly: sandboxMode === 'read-only',
        path: canonical,
        prompt: data.developer_instructions,
        model: typeof data.model === 'string' ? data.model : null,
        effort:
          typeof data.model_reasoning_effort === 'string' ? data.model_reasoning_effort : null,
        sandboxMode,
      });
    }
    for (const [name, role] of inLayer) {
      // Native merge inherits metadata only. Winning config_file supplies ALL main-session fields.
      const description = role.description ?? roles.get(name)?.description;
      if (description === undefined) {
        traversal.report({ code: 'invalid-policy', path: role.path });
        continue;
      }
      roles.set(name, { ...role, description });
    }
  }
  result.roles = [...roles.values()].sort((a, b) => compareRoleText(a.id, b.id));
  return result;
}
