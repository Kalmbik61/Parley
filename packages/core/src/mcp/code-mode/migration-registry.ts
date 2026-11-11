// Code Mode migration registry (plan T7b, T11 B0). Data and pure functions, with no runtime import beyond a hash: a launcher can load this
// without the contracts, the broker or the gate. It says, for every tool a session can originally have, what it does (`effect`), whether
// it is still direct and which task owns its removal, and which reads may migrate at all (`migratable`, the guest allowlist). Nothing here
// authorizes a call: the catalogue's allowlist is the decoded-method table, which a test keeps equal to `MIGRATABLE_READS`, and the broker
// and the gate decide every call.
//
// `PROVEN` is empty. A method leaves the direct list only after its own proof (T6/T7 for the five, T11-<name> for the rest), one at a
// time; a tool that is not listed here blocks a replacement launch rather than being hidden. Design §3.1, inventory T3a-refresh.

import { createHash } from 'node:crypto';

/** What a method does, from its MCP annotations (`effectOf` in catalog.ts; a test binds every entry to the accepted inventory). */
export type RegistryEffect = 'read' | 'write' | 'destructive';

export interface RegistryEntry {
  readonly name: string;
  /** One of the five initial reads (`INITIAL_COHORT`). */
  readonly cohort: boolean;
  readonly effect: RegistryEffect;
  /** The bounded task that removes this method from the direct list. */
  readonly removal: string;
}

export interface MigrationRegistry {
  readonly entries: readonly RegistryEntry[];
  /** The guest allowlist: methods that may be documented, decoded and, once proven, run in `code_execute`. Reads only. */
  readonly migratable: readonly string[];
  /** Methods whose migration is proven: they leave the direct list. */
  readonly proven: readonly string[];
}

/** The five reads, kept here as data so this module imports nothing: a test binds them to `INITIAL_COHORT`. */
const COHORT: readonly string[] = ['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room'];

/**
 * The guest allowlist: the five, then each T11 read once its R batch lands (append one name per method). A read is listed here only with
 * its decoder in `read-adapter-table.ts` and its output contract in `read-output-schemas.ts`. Never a write: the registry refuses one.
 */
export const MIGRATABLE_READS: readonly string[] = Object.freeze([...COHORT, 'memory_read', 'search_history', 'attempt_status', 'plan_tasks']);

/** Every other method of the T3a-refresh inventory, each with its own T11 task. */
const DIRECT: readonly string[] = [
  'add_to_room', 'attempt_status', 'attempt_submit', 'attempt_verify', 'backlog_suggest', 'backlog_take', 'browser_action', 'browser_close', 'browser_console',
  'browser_cookies', 'browser_downloads', 'browser_evaluate', 'browser_navigate', 'browser_network', 'browser_open', 'browser_resize', 'browser_screenshot',
  'browser_snapshot', 'browser_storage', 'browser_tabs', 'browser_wait_for', 'check_inbox', 'close_session', 'create_room', 'create_session', 'create_swarm',
  'find_skill', 'get_capacity', 'memory_read', 'plan_progress', 'plan_submit', 'plan_tasks', 'plan_update', 'plan_verify', 'propose_completion', 'propose_decision',
  'publish_agent_plan', 'remember', 'report', 'request_agent_switch', 'search_history', 'send_message', 'set_room_mode', 'swarm_add', 'wait_for',
];

/** The annotated reads and destructive methods of the inventory; every other method is a write. */
const READS: readonly string[] = [
  ...COHORT, 'attempt_status', 'browser_console', 'browser_downloads', 'browser_network', 'browser_screenshot', 'browser_snapshot', 'browser_tabs',
  'browser_wait_for', 'find_skill', 'get_capacity', 'memory_read', 'plan_tasks', 'search_history',
];
const DESTRUCTIVE: readonly string[] = ['browser_cookies', 'browser_evaluate', 'browser_storage', 'close_session'];

const effectOfName = (name: string): RegistryEffect => (READS.includes(name) ? 'read' : DESTRUCTIVE.includes(name) ? 'destructive' : 'write');
const entry = (name: string, cohort: boolean): RegistryEntry => Object.freeze({ name, cohort, effect: effectOfName(name), removal: cohort ? 'T6/T7' : `T11-${name}` });

/** The registry this build ships. Nothing is proven yet. */
export const MIGRATION_REGISTRY: MigrationRegistry = Object.freeze({
  entries: Object.freeze([...COHORT.map((n) => entry(n, true)), ...DIRECT.map((n) => entry(n, false))].sort((a, b) => (a.name < b.name ? -1 : 1))),
  migratable: MIGRATABLE_READS,
  proven: Object.freeze([]),
});

export const registryRevision = (registry: MigrationRegistry): string =>
  createHash('sha256').update(JSON.stringify({ entries: registry.entries, migratable: registry.migratable, proven: registry.proven })).digest('hex');

export const REGISTRY_REVISION = registryRevision(MIGRATION_REGISTRY);

/** The registry's migratable names that it also enters as reads. A name it does not enter, or enters as anything else, is not one. */
export function migratableReads(registry: MigrationRegistry): ReadonlySet<string> {
  const effects = new Map(registry.entries.map((e) => [e.name, e.effect] as const));
  return new Set(registry.migratable.filter((name) => effects.get(name) === 'read'));
}

/**
 * Sticky: true from the first build whose allowlist ships a non-read, and never false again after, in any later build. A held record
 * may have been written by any build that ran before this one, so whether it can name a write is never read from the current build
 * alone (s-296, m-7366). No write has shipped: T11 adds reads only.
 */
export const WRITES_EVER_SHIPPED = false;

/**
 * Can a guest run of this registry, or of an earlier build, have executed a non-read? The launcher passes it to `selectExposure`, so an
 * unreadable record blocks once it is true. Only this data decides it, never a script, an env value or a setting (m-7267).
 */
export function writesExist(registry: MigrationRegistry): boolean {
  return WRITES_EVER_SHIPPED || registry.migratable.some((name) => !migratableReads(registry).has(name));
}

export type ReplacementProblem = 'uninventoried-tool' | 'invalid-registry' | 'partition';

export type ReplacementCheck =
  | { readonly ok: true; readonly migrated: readonly string[]; readonly direct: readonly string[] }
  | { readonly ok: false; readonly problem: ReplacementProblem };

function registryValid(registry: MigrationRegistry, original: ReadonlySet<string>): boolean {
  const names = new Set<string>();
  for (const e of registry.entries) {
    if (names.has(e.name)) return false;
    names.add(e.name);
  }
  if (new Set(registry.migratable).size !== registry.migratable.length) return false;
  // The allowlist is reads only: a write, a destructive method or a name the registry does not enter makes the whole registry invalid.
  const reads = migratableReads(registry);
  if (reads.size !== registry.migratable.length) return false;
  const proven = new Set(registry.proven);
  if (proven.size !== registry.proven.length) return false;
  // Only a migratable read can be proven by this registry, and only one this launch really has.
  return registry.proven.every((m) => original.has(m) && reads.has(m));
}

/**
 * Can this launch's original tool list run as replacement, and how does it split? Pure, so a launcher can ask before it writes the
 * decision: a mismatch is then classic with a reason, and the same check in the MCP process is only the backstop for version skew.
 */
export function checkReplacement(originalNames: readonly string[], registry: MigrationRegistry = MIGRATION_REGISTRY): ReplacementCheck {
  const original = new Set(originalNames);
  if (!registryValid(registry, original)) return { ok: false, problem: 'invalid-registry' };
  // A name twice in the list cannot be split into two disjoint sets that add up to the list.
  if (original.size !== originalNames.length) return { ok: false, problem: 'partition' };
  const known = new Set(registry.entries.map((e) => e.name));
  if (originalNames.some((n) => !known.has(n))) return { ok: false, problem: 'uninventoried-tool' };
  const proven = new Set(registry.proven);
  const migrated = originalNames.filter((n) => proven.has(n));
  const direct = originalNames.filter((n) => !proven.has(n));
  return { ok: true, migrated, direct };
}
