// Code Mode catalogue (plan T3a): fixture data only, no runtime, broker or live integration.
//
// The catalogue is derived from the tool list a session actually has (`tools/list` descriptors, as produced by
// `tools.ts`, `browser-tools.ts` and `session-tools.ts`), intersected with an explicit allowlist: the decoded methods of the
// output contract table, which a test keeps equal to the registry's `MIGRATABLE_READS` (T11 B0), or a fixture's. It does not
// import the registry: the registry stays loadable alone, and a launcher or harness that patches it is not pre-empted here. It keeps no hand-written
// schema: at build time it takes ONE deep, frozen snapshot of each descriptor and derives every hash, the revision and all
// later declarations from that snapshot. Caller mutation of the source afterwards, or of anything the catalogue returns,
// cannot change the declarations of an existing revision; rebuilding from changed source yields a new revision.
// Four things are deliberately separate fields:
//   signature  - can a declaration be generated (types.ts guard)? `unavailable` has a reason and NO guest stub;
//   migration  - is the method moved from direct to guest-callable? Disabled by default; a request is refused unless the
//                method is documented, so an unsupported or residual method (e.g. browser_action) stays direct;
//   nativePolicy - what the provider's own permission layer does with the call; `unknown` until independently proven.
//                The caller supplies it: it is fixture metadata and never proof of what a provider actually does;
//   effect     - what the method does, read from the MCP annotations.
// A method is `executable` only when all of them agree. Documentation visibility is never execution permission.

import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { READ_OUTPUT_SCHEMAS, adapterRevisionOf } from './read-output-schemas.js';
import { GENERATOR_PINS, NAMESPACE, generateDeclarations, inspectDescriptors, type ToolDescriptor } from './types.js';

/** The five initial business-read-only methods (design §3.2). The allowlist starts with them; T11 reads join it through `MIGRATABLE_READS`. */
export const INITIAL_COHORT = ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list'] as const;

export type Effect = 'read' | 'write' | 'destructive' | 'unknown';
export type NativePolicy = 'unknown' | 'allow' | 'ask' | 'deny';
export type SignatureState = { status: 'available' } | { status: 'unavailable'; reasons: string[] };
export type MigrationState = 'disabled' | 'enabled';

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/**
 * What a method promises about its result. `decoded`: the guest gets the method's `ReadResult`, checked against the schema
 * with this hash, from the adapter of this revision. `unknown`: nothing is promised.
 */
export type OutputGuarantee =
  | { readonly guarantee: 'unknown' }
  | { readonly guarantee: 'decoded'; readonly schemaSha256: string; readonly adapterRevision: string };

export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  /** Deeply frozen snapshot of the descriptor's schema taken at build time: the stable source for docs and for T3b. */
  readonly inputSchema: Record<string, unknown>;
  readonly schemaSha256: string;
  readonly descriptorSha256: string;
  readonly effect: Effect;
  /** `initial`: on this catalogue's allowlist (the name is kept from the five-method cohort); `residual`: not on it. */
  readonly cohort: 'initial' | 'residual';
  readonly signature: SignatureState;
  readonly migration: MigrationState;
  readonly nativePolicy: NativePolicy;
  /** Declared output guarantee: `decoded` for a documented method, otherwise nothing is promised. */
  readonly output: OutputGuarantee;
  /** Docs may be shown: allowlisted, read effect, declaration available. Says nothing about permission to call. */
  readonly documented: boolean;
  /** Documented, migration enabled and native policy proven `allow`. */
  readonly executable: boolean;
}

export interface Catalog {
  readonly revision: string;
  readonly namespace: string;
  /** The allowlist this catalogue was built with, sorted: the only names that can be documented, decoded or run. */
  readonly allowlist: readonly string[];
  /** Every method of the session's list, sorted by name. */
  readonly entries: readonly CatalogEntry[];
  /** Allowlisted names the session does not have (hidden by profile, no agent channel, ...). Never callable. */
  readonly absent: readonly string[];
}

export interface CatalogOptions {
  /** Native permission outcome by tool name, as supplied by the caller (fixture metadata, not proof). Missing means `unknown`. */
  readonly nativePolicy?: Readonly<Record<string, NativePolicy>>;
  /** Names whose migration is enabled (fixture mode). Missing means `disabled`. Any name that is not documented is refused with a `CatalogError`. */
  readonly migrated?: readonly string[];
  /** The allowlist (fixture mode). Missing means the decoded methods (`READ_OUTPUT_SCHEMAS`, equal to `MIGRATABLE_READS`). A non-read on it is never documented, so never run. */
  readonly allowlist?: readonly string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with sorted object keys, so a hash does not depend on property order. */
export function canonicalJson(value: unknown): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v;
  };
  return JSON.stringify(canon(value));
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
export const canonicalSha256 = (value: unknown): string => sha256(canonicalJson(value));

export function effectOf(tool: Pick<Tool, 'annotations'>): Effect {
  const a = tool.annotations;
  if (a?.destructiveHint === true) return 'destructive';
  if (a?.readOnlyHint === true) return 'read';
  if (a?.readOnlyHint === false) return 'write';
  return 'unknown';
}

const descriptorOf = (tool: Tool): ToolDescriptor => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema as Record<string, unknown> });
const descriptorHash = (tool: Tool): string => canonicalSha256({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, annotations: tool.annotations ?? null });

/** A documented method always has an output contract: a declaration can never be generated without one. */
function outputOf(name: string, documented: boolean): OutputGuarantee {
  if (!documented) return { guarantee: 'unknown' };
  const schema = Object.hasOwn(READ_OUTPUT_SCHEMAS, name) ? READ_OUTPUT_SCHEMAS[name] : undefined;
  if (schema === undefined) throw new CatalogError(`${name}: documented without an output contract`);
  const adapterRevision = adapterRevisionOf(name);
  if (adapterRevision === undefined) throw new CatalogError(`${name}: documented without an adapter`);
  return { guarantee: 'decoded', schemaSha256: canonicalSha256(schema), adapterRevision };
}

/** Freezes every nested object and array; the input must be JSON-like (no cycles, no functions). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Why each method's signature is or is not available, from the single guard in types.ts (name rules apply across the whole list). */
function signatures(tools: readonly Tool[]): Map<string, SignatureState> {
  const problems = inspectDescriptors(tools.map(descriptorOf));
  return new Map(tools.map((t) => {
    const reasons = problems.get(t.name);
    return [t.name, deepFreeze(reasons === undefined ? { status: 'available' } : { status: 'unavailable', reasons: [...reasons] })];
  }));
}

/** Why a method has no declaration and cannot be migrated, or null when it is documented. */
function whyNotDocumented(entry: CatalogEntry | undefined): string | null {
  if (entry === undefined) return "not in this session's tool list";
  if (entry.documented) return null;
  if (entry.signature.status === 'unavailable') return `signature unavailable: ${entry.signature.reasons.join('; ')}`;
  return entry.cohort === 'residual' ? 'not in the allowlist' : `effect ${entry.effect}`;
}

export function buildCatalog(source: readonly Tool[], options: CatalogOptions = {}): Catalog {
  // One owned, frozen snapshot: everything below (hashes, signatures, revision, later declarations) reads this, never the caller's objects.
  const tools = deepFreeze(source.map((t) => structuredClone({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema, annotations: t.annotations ?? null }))) as readonly Tool[];
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new CatalogError(`duplicate tool name in the session list: ${t.name}`);
    seen.add(t.name);
  }
  const policy = new Map(Object.entries(options.nativePolicy ?? {}));
  const requested = new Set(options.migrated ?? []);
  const allowlist = Object.freeze([...new Set(options.allowlist ?? Object.keys(READ_OUTPUT_SCHEMAS))].sort());
  const allowed = new Set<string>(allowlist);
  const sigs = signatures(tools);

  const entries = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((tool): CatalogEntry => {
    const effect = effectOf(tool);
    const signature = sigs.get(tool.name)!;
    const cohort = allowed.has(tool.name) ? 'initial' : 'residual';
    const nativePolicy = policy.get(tool.name) ?? 'unknown';
    const documented = cohort === 'initial' && effect === 'read' && signature.status === 'available';
    // A request for an undocumented method is refused below; until then it is simply not effective.
    const migration: MigrationState = documented && requested.has(tool.name) ? 'enabled' : 'disabled';
    return {
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
      schemaSha256: canonicalSha256(tool.inputSchema),
      descriptorSha256: descriptorHash(tool),
      effect,
      cohort,
      signature,
      migration,
      nativePolicy,
      output: deepFreeze(outputOf(tool.name, documented)),
      documented,
      executable: documented && migration === 'enabled' && nativePolicy === 'allow',
    };
  });
  const byName = new Map(entries.map((e) => [e.name, e]));
  const refused = [...requested].flatMap((name) => {
    const why = whyNotDocumented(byName.get(name));
    return why === null ? [] : [`${name}: migration refused (${why})`];
  });
  if (refused.length > 0) throw new CatalogError(refused.join('\n'));

  const absent = allowlist.filter((name) => !seen.has(name));
  const revision = canonicalSha256({
    catalogVersion: 3,
    namespace: NAMESPACE,
    generator: GENERATOR_PINS,
    allowlist,
    absent,
    entries: entries.map((e) => ({ name: e.name, descriptor: e.descriptorSha256, effect: e.effect, cohort: e.cohort, signature: e.signature, migration: e.migration, nativePolicy: e.nativePolicy, output: e.output, documented: e.documented, executable: e.executable })),
  });
  return deepFreeze({ revision, namespace: NAMESPACE, allowlist, entries, absent });
}

/**
 * Declarations for documented methods, generated on demand by the guarded public generator from the catalogue's own frozen
 * snapshot. A method that is not documented (unavailable signature, outside the allowlist, absent, non-read) never gets a
 * declaration, so it cannot become a callable guest stub.
 */
export function declarationsFor(catalog: Catalog, names: readonly string[]): string {
  const byName = new Map(catalog.entries.map((e) => [e.name, e]));
  const problems: string[] = [];
  const descriptors: ToolDescriptor[] = [];
  for (const name of names) {
    const entry = byName.get(name);
    const why = whyNotDocumented(entry);
    if (entry === undefined) problems.push(`${name}: ${why}`);
    else if (why !== null) problems.push(`${name}: no declaration (${why})`);
    // The generator gets its own mutable copy; the frozen snapshot stays untouched.
    else descriptors.push({ name: entry.name, description: entry.description, inputSchema: structuredClone(entry.inputSchema), outputSchema: structuredClone(READ_OUTPUT_SCHEMAS[entry.name]!) });
  }
  if (problems.length > 0) throw new CatalogError(problems.join('\n'));
  return generateDeclarations(descriptors);
}

// ----- Versioned implementation inventory (docs/research/.../implementation-inventory.json) -----

export type ToolSource = 'core' | 'navigator' | 'browser' | 'session';

export interface InventoryInput {
  /** Commit the lists were enumerated at; recorded, not computed. */
  readonly baseCommit: string;
  /** `createToolRunner(...).list()` with no profile, then with `toolProfile: 'short'`, and the navigator tools it adds. */
  readonly core: readonly Tool[];
  readonly coreShort: readonly Tool[];
  readonly navigator: readonly Tool[];
  /** Added by `createParleyServer` only with an agent channel. */
  readonly browser: readonly Tool[];
  readonly session: readonly Tool[];
}

const serializedSha256 = (tools: readonly Tool[]): string => sha256(JSON.stringify(tools));

/** Pure function of the lists: the checked-in JSON must equal it, so a new, removed or changed tool fails a test. */
export function buildImplementationInventory(input: InventoryInput) {
  const list = (...parts: (readonly Tool[])[]) => {
    const tools = parts.flat();
    return { count: tools.length, names: tools.map((t) => t.name), serializedSha256: serializedSha256(tools) };
  };
  const sourced: [ToolSource, readonly Tool[]][] = [['core', input.core], ['navigator', input.navigator], ['browser', input.browser], ['session', input.session]];
  const all = sourced.flatMap(([source, tools]) => tools.map((tool) => ({ source, tool })));
  const duplicates = all.map((x) => x.tool.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (duplicates.length > 0) throw new CatalogError(`duplicate tool names across lists: ${duplicates.join(', ')}`);
  const shortNames = new Set(input.coreShort.map((t) => t.name));
  const signature = signatures(all.map((x) => x.tool));
  const tools = all.map(({ source, tool }) => {
    const sig = signature.get(tool.name)!;
    return {
      name: tool.name,
      source,
      schemaSha256: canonicalSha256(tool.inputSchema),
      descriptorSha256: descriptorHash(tool),
      effect: effectOf(tool),
      annotations: tool.annotations ?? null,
      inFull: true,
      inShort: source !== 'core' || shortNames.has(tool.name),
      requiresAgentChannel: source === 'browser' || source === 'session',
      requiresNavigator: source === 'navigator',
      cohort: (INITIAL_COHORT as readonly string[]).includes(tool.name) ? 'initial' : 'residual',
      signature: sig.status === 'available' ? { status: 'available' } : { status: 'unavailable', reasons: sig.reasons },
      disposition: 'direct',
      migration: 'disabled',
      nativePolicy: 'unknown',
    };
  });
  return {
    schemaVersion: 1,
    generator: GENERATOR_PINS,
    implementation: { baseCommit: input.baseCommit },
    allowlist: [...INITIAL_COHORT],
    lists: {
      fullNoAgent: list(input.core),
      shortNoAgent: list(input.coreShort),
      fullNoAgentNavigator: list(input.core, input.navigator),
      shortNoAgentNavigator: list(input.coreShort, input.navigator),
      fullAgent: list(input.core, input.browser, input.session),
      shortAgent: list(input.coreShort, input.browser, input.session),
      fullAgentNavigator: list(input.core, input.navigator, input.browser, input.session),
      shortAgentNavigator: list(input.coreShort, input.navigator, input.browser, input.session),
    },
    tools,
  };
}
