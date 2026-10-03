import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { readCodexNativeContext, type CodexContextOptions, type CodexNativeContext } from '../roles/context.js';
import type { CodexConfigLayer, CodexNativeSkillEvidence } from './codex.js';
import { resolveSkillCatalog, type SkillCatalog } from './catalog.js';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export interface CodexSkillContext { layers: CodexConfigLayer[]; evidence: CodexNativeSkillEvidence }
/** HIGH-to-LOW native layers are projected LOW-to-HIGH. No guessed trust/config merge. */
export async function projectCodexSkillContext(cwd: string, response: CodexNativeContext): Promise<CodexSkillContext | null> {
  const { config, requirements, skills } = response;
  if (!record(requirements) || !Object.hasOwn(requirements, 'requirements') || requirements.requirements !== null ||
    !record(config) || !Array.isArray(config.layers) || config.layers.length > 128 ||
    !record(skills) || !Array.isArray(skills.data) || skills.data.length !== 1) return null;
  let canonical: string;
  try { canonical = await realpath(cwd); } catch { return null; }
  const inventory = skills.data[0];
  if (!record(inventory) || inventory.cwd !== canonical || !Array.isArray(inventory.skills) ||
    inventory.skills.length > 20000 || !Array.isArray(inventory.errors) || inventory.errors.length > 0) return null;
  const evidence: CodexNativeSkillEvidence = { cwd: canonical, verified: true, skills: [] };
  const rows: Array<CodexNativeSkillEvidence['skills'][number]> = [];
  const identities = new Map<string, boolean>();
  for (const skill of inventory.skills) {
    if (!record(skill) || typeof skill.name !== 'string' || typeof skill.path !== 'string' ||
      !path.isAbsolute(skill.path) || typeof skill.enabled !== 'boolean' || typeof skill.scope !== 'string') return null;
    // Plugin/extra/system/admin routes remain unavailable; no blanket root promotion.
    if (skill.pluginId !== undefined && skill.pluginId !== null) continue;
    if (skill.scope !== 'user' && skill.scope !== 'repo') continue;
    let document: string;
    try { document = await realpath(skill.path); } catch { return null; }
    if (document !== skill.path) return null;
    const source = skill.scope === 'repo' ? 'project' : 'user';
    const identity = JSON.stringify([document, skill.name, source]);
    const previous = identities.get(identity);
    if (previous !== undefined && previous !== skill.enabled) return null;
    if (previous === undefined) rows.push({ path: document, name: skill.name, source, enabled: skill.enabled });
    identities.set(identity, skill.enabled);
  }
  evidence.skills = rows;
  const layers: CodexConfigLayer[] = [];
  for (const layer of [...config.layers].reverse()) {
    if (!record(layer) || !record(layer.name)) return null;
    const disabled = layer.disabledReason !== undefined && layer.disabledReason !== null;
    if (disabled) {
      if (typeof layer.disabledReason !== 'string') return null;
      // Human selectors remain authoritative even if that native source is disabled.
      if (layer.name.type !== 'user' && layer.name.type !== 'sessionFlags') continue;
    }
    if (typeof layer.version !== 'string' || !record(layer.config)) return null;
    const type = layer.name.type;
    let source: CodexConfigLayer['source'];
    let configFolder: string | undefined;
    if (type === 'user' || type === 'system') {
      if (typeof layer.name.file !== 'string' || !path.isAbsolute(layer.name.file) ||
        (type === 'user' && layer.name.profile !== undefined && layer.name.profile !== null)) return null;
      source = type === 'user' ? 'User' : 'System'; configFolder = path.dirname(layer.name.file);
    } else if (type === 'project') {
      if (typeof layer.name.dotCodexFolder !== 'string' || !path.isAbsolute(layer.name.dotCodexFolder)) return null;
      source = 'Project'; configFolder = layer.name.dotCodexFolder;
    } else if (type === 'sessionFlags') source = 'SessionFlags';
    else if (type === 'packagedDefaults') continue;
    else return null;
    // No raw config escapes this adapter, only human skill policy and native root markers.
    const data: Record<string, unknown> = {};
    if (Object.hasOwn(layer.config, 'skills')) data.skills = layer.config.skills;
    if (Object.hasOwn(layer.config, 'project_root_markers')) data.project_root_markers = layer.config.project_root_markers;
    layers.push({ source, ...(configFolder ? { configFolder } : {}), data, provenance: 'human', ...(disabled ? { disabled: true } : {}) });
  }
  return { layers, evidence };
}
export interface SkillContextOptions extends CodexContextOptions {
  homeDir?: string;
  codexHome?: string;
  /** Isolated adapter fixture only; never wire input. */
  read?: typeof readCodexNativeContext;
}
export async function readCodexSkillCatalog(options: SkillContextOptions): Promise<SkillCatalog | null> {
  const response = await (options.read ?? readCodexNativeContext)(options, true);
  if (response === null) return null;
  const context = await projectCodexSkillContext(options.cwd, response);
  if (context === null) return null;
  return resolveSkillCatalog({ provider: 'codex', cwd: options.cwd,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }), configLayers: context.layers, nativeEvidence: context.evidence });
}
