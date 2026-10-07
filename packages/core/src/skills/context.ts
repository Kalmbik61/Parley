import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCodexNativeContext, type CodexContextOptions, type CodexNativeContext } from '../roles/context.js';
import { readCodexSkillPolicy, type DiscoveryDiagnostic } from './codex.js';
import type { SkillCatalog } from './catalog.js';
import type { NativeSkill } from './types.js';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
type CodexSource = Exclude<NativeSkill['source'], 'claude.ai'>;
const MAX_NATIVE_SKILLS = 20000;
/** Записей, которые читаются с диска одновременно: сотни навыков не должны исчерпать дескрипторы. */
const BATCH = 32;

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const sourceOf = (scope: string, pluginId: unknown): CodexSource =>
  typeof pluginId === 'string' ? 'plugin' : scope === 'repo' ? 'project' : scope === 'user' ? 'user'
    : scope === 'system' ? 'system' : scope === 'admin' ? 'admin' : 'extra';

/** Одна запись `skills/list`, уже проверенная по форме. */
interface ListedSkill { name: string; description: string; path: string; source: CodexSource }

/**
 * Документ навыка: путь записи — файл или папка с `SKILL.md`. `file` — путь, где навык нашёл Codex (рядом с ним Codex
 * читает и `agents/openai.yaml`), `canonical` — тот же файл без симлинков; не файл или нет его — `null`.
 */
async function documentOf(listed: string): Promise<{ file: string; canonical: string } | null> {
  try {
    const file = (await stat(listed)).isDirectory() ? path.join(listed, 'SKILL.md') : listed;
    const canonical = await realpath(file);
    return (await stat(canonical)).isFile() ? { file, canonical } : null;
  } catch { return null; }
}

/**
 * Каталог `find_skill` у Codex — это состав, который отдал сам Codex (`skills/list`): подтверждение доступности даёт
 * он, обход диска не нужен. Любой ответ не той формы — `null` (безопасная сторона: родной список остаётся).
 * Выключенные навыки пропускаются (родной список их тоже не показывает), непустой `errors` — навыки, которых Codex
 * не загрузил сам, их нет и в его списке.
 */
export async function projectCodexListCatalog(cwd: string, response: CodexNativeContext): Promise<SkillCatalog | null> {
  const { requirements, skills } = response;
  if (!record(requirements) || !Object.hasOwn(requirements, 'requirements') || requirements.requirements !== null ||
    !record(skills) || !Array.isArray(skills.data) || skills.data.length !== 1) return null;
  let canonical: string;
  try { canonical = await realpath(cwd); } catch { return null; }
  const inventory = skills.data[0];
  if (!record(inventory) || inventory.cwd !== canonical || !Array.isArray(inventory.skills) ||
    inventory.skills.length > MAX_NATIVE_SKILLS || !Array.isArray(inventory.errors)) return null;
  const listed: ListedSkill[] = [];
  for (const skill of inventory.skills) {
    if (!record(skill) || typeof skill.name !== 'string' || skill.name === '' || skill.name.includes('\0') ||
      typeof skill.description !== 'string' || typeof skill.path !== 'string' || !path.isAbsolute(skill.path) ||
      typeof skill.enabled !== 'boolean' || typeof skill.scope !== 'string' ||
      (skill.pluginId !== undefined && skill.pluginId !== null && typeof skill.pluginId !== 'string') ||
      (skill.interface !== undefined && !record(skill.interface)) ||
      (skill.shortDescription !== undefined && typeof skill.shortDescription !== 'string')) return null;
    if (!skill.enabled) continue;
    const short = [(skill.interface as Record<string, unknown> | undefined)?.shortDescription, skill.shortDescription].find(hasText);
    listed.push({ name: skill.name, path: skill.path, source: sourceOf(skill.scope, skill.pluginId),
      description: hasText(skill.description) ? skill.description : short ?? '' });
  }
  const skillsOut: NativeSkill[] = [];
  const diagnostics: DiscoveryDiagnostic[] = [];
  const identities = new Set<string>();
  for (let from = 0; from < listed.length; from += BATCH) {
    const batch = listed.slice(from, from + BATCH);
    const resolved = await Promise.all(batch.map(async item => {
      const document = await documentOf(item.path);
      if (document === null) return null;
      const policy = await readCodexSkillPolicy(path.join(path.dirname(document.file), 'agents/openai.yaml'));
      return { document: document.canonical, disabled: policy.status === 'valid' && policy.allowImplicitInvocation === false };
    }));
    batch.forEach((item, index) => {
      const found = resolved[index]!;
      if (found === null) { diagnostics.push({ provider: 'codex', source: item.source, path: item.path, code: 'unreadable' }); return; }
      // Идентичность — пара (канонический путь, имя): точные повторы схлопываются, одноимённые из разных папок остаются.
      const identity = JSON.stringify([found.document, item.name]);
      if (identities.has(identity)) return;
      identities.add(identity);
      skillsOut.push({ provider: 'codex', documentKind: 'skill', name: item.name, description: item.description, source: item.source,
        path: found.document, modelAvailable: !found.disabled, unavailableReason: found.disabled ? 'implicit-invocation-disabled' : null });
    });
  }
  return { provider: 'codex', skills: skillsOut, diagnostics, partial: false };
}

export interface SkillContextOptions extends CodexContextOptions {
  /** Isolated adapter fixture only; never wire input. */
  read?: typeof readCodexNativeContext;
}
export async function readCodexSkillCatalog(options: SkillContextOptions): Promise<SkillCatalog | null> {
  const response = await (options.read ?? readCodexNativeContext)(options, true);
  if (response === null) return null;
  return projectCodexListCatalog(options.cwd, response);
}
