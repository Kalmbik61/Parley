// Code Mode declarations (plan T3a). Declaration text comes ONLY from the PUBLIC generator entry
// `@cloudflare/codemode/tanstack-ai` (`generateTypes`), pinned in package.json. This file adds a guard around it, never a
// converter: a schema or name the pinned generator would silently weaken, rename or mis-render is refused BEFORE generation
// with its JSON path, and a post-check refuses output that was renamed or widened. Nothing is rewritten, nothing is
// filtered silently. The guard is the accepted T2a r3 contract (plan "T2a accepted record"), fixture-covered, and it is a
// bounded partial contract: it does not prove structural equivalence for arbitrary schemas.
//
// Declarations never validate input and never authorise a call. Runtime validation (T3b) and native policy are separate.
// Outputs stay `unknown` until validated DTOs exist. Type-checking the package's own declarations still needs
// `skipLibCheck: true` (upstream .d.ts mention `cloudflare:workers` and `ai`); that limitation is kept, no shim is added.

import { generateTypes } from '@cloudflare/codemode/tanstack-ai';
import type { JSONSchema, Tool } from '@tanstack/ai';

/** Namespace guest code sees the methods under. */
export const NAMESPACE = 'parley';

/** The exact generator pins (accepted T2a record). A test compares them with package.json; they feed the catalog revision. */
export const GENERATOR_PINS = {
  '@cloudflare/codemode': '0.5.6',
  '@tanstack/ai': '1.2.0',
  zod: '4.5.4',
} as const;

/** What the broker hands over: the MCP tool as declared, nothing executable. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** The method's guest-visible result (plan T6c). Absent: nothing is promised and the declaration says `unknown`. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export class UnsupportedSchemaError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Unsupported tool declarations:\n${problems.join('\n')}`);
    this.name = 'UnsupportedSchemaError';
  }
}

// ----- Admitted dialect: exactly the keywords the accepted fixtures cover -----

const ADMITTED = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf',
  'description', 'default', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROTO = new Set(['__proto__', 'constructor', 'prototype']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Below the generator's own `maxDepth` (20), past which it silently emits `unknown`. */
export const MAX_DEPTH = 16;

/** Recursive structural check. Every problem names its JSON path; nothing is dropped or rewritten. */
export function preflightSchema(schema: unknown, at: string, out: string[] = [], depth = 0): string[] {
  if (depth > MAX_DEPTH) { out.push(`${at}: nested deeper than ${MAX_DEPTH}`); return out; }
  if (!isRecord(schema)) { out.push(`${at}: schema must be an object`); return out; }
  for (const key of Object.keys(schema)) if (!ADMITTED.has(key)) out.push(`${at}: unsupported keyword "${key}"`);
  const t = schema['type'];
  const types = Array.isArray(t) ? t : t === undefined ? [] : [t];
  if (t === undefined && !has(schema, 'oneOf') && !has(schema, 'enum') && !has(schema, 'const')) out.push(`${at}: needs "type", "oneOf", "enum" or "const"`);
  if (Array.isArray(t) && (t.length === 0 || new Set(t).size !== t.length)) out.push(`${at}: "type" array must be non-empty and unique`);
  for (const item of types) if (typeof item !== 'string' || !TYPES.has(item)) out.push(`${at}: unknown type ${JSON.stringify(item)}`);
  if (has(schema, 'properties')) {
    const props = schema['properties'];
    if (!isRecord(props)) out.push(`${at}.properties: must be an object`);
    else for (const [name, sub] of Object.entries(props)) {
      if (!IDENT.test(name) || PROTO.has(name)) out.push(`${at}.properties: unsafe property name ${JSON.stringify(name)}`);
      preflightSchema(sub, `${at}.properties.${name}`, out, depth + 1);
    }
  }
  if (has(schema, 'required')) {
    const req = schema['required'];
    const props = isRecord(schema['properties']) ? schema['properties'] : {};
    if (!Array.isArray(req) || req.some((r) => typeof r !== 'string')) out.push(`${at}.required: must be an array of strings`);
    else for (const r of req) if (!has(props, r)) out.push(`${at}.required: "${r}" is not a declared property`);
  }
  if (has(schema, 'additionalProperties')) {
    const ap = schema['additionalProperties'];
    if (typeof ap !== 'boolean') preflightSchema(ap, `${at}.additionalProperties`, out, depth + 1);
  }
  if (has(schema, 'items')) preflightSchema(schema['items'], `${at}.items`, out, depth + 1);
  if (types.includes('array') && !has(schema, 'items')) out.push(`${at}: array without "items"`);
  if (has(schema, 'enum')) {
    const e = schema['enum'];
    if (!Array.isArray(e) || e.length === 0 || !e.every(isPrimitive)) out.push(`${at}.enum: must be a non-empty array of primitives`);
  }
  if (has(schema, 'const') && !isPrimitive(schema['const'])) out.push(`${at}.const: must be a primitive`);
  if (has(schema, 'oneOf')) {
    const one = schema['oneOf'];
    if (!Array.isArray(one) || one.length === 0) out.push(`${at}.oneOf: must be a non-empty array`);
    else one.forEach((sub, i) => preflightSchema(sub, `${at}.oneOf[${i}]`, out, depth + 1));
  }
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
    if (has(schema, key) && typeof schema[key] !== 'number') out.push(`${at}.${key}: must be a number`);
  }
  if (has(schema, 'pattern') && typeof schema['pattern'] !== 'string') out.push(`${at}.pattern: must be a string`);
  interactions(schema, types.filter((x): x is string => typeof x === 'string'), at, out);
  return out;
}

const PRIMITIVES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/** Does a literal value belong to one of the declared JSON types? `integer` admits whole numbers only. */
function matchesType(value: unknown, types: readonly string[]): boolean {
  if (types.length === 0) return true;
  if (value === null) return types.includes('null');
  if (typeof value === 'string') return types.includes('string');
  if (typeof value === 'boolean') return types.includes('boolean');
  if (typeof value === 'number') return types.includes('number') || (types.includes('integer') && Number.isInteger(value));
  return false;
}

/**
 * Keyword combinations the generator would silently weaken or turn into invalid TypeScript are refused: one shape
 * selector per node (`oneOf` alone; `const` and `enum` not together), literal values within the declared type, object,
 * array, string and number keywords only on their own type, primitive-only type arrays (no nullable objects), no
 * `additionalProperties` schema next to declared properties, and no union-valued array items (the generator writes
 * `<items>[]` without parentheses, so a union becomes `"a" | "b"[]`; known case: `browser_action.modifiers`).
 */
function interactions(schema: Record<string, unknown>, types: readonly string[], at: string, out: string[]): void {
  if (has(schema, 'const') && has(schema, 'enum')) out.push(`${at}: interacting keywords "const" and "enum"`);
  if (has(schema, 'oneOf')) {
    for (const k of ['type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems']) {
      if (has(schema, k)) out.push(`${at}: "oneOf" cannot be combined with "${k}"`);
    }
  }
  if (Array.isArray(schema['type']) && !types.every((t) => PRIMITIVES.has(t))) out.push(`${at}: type arrays may contain only primitive types`);
  if (Array.isArray(schema['enum'])) {
    for (const v of schema['enum']) if (isPrimitive(v) && !matchesType(v, types)) out.push(`${at}.enum: value ${JSON.stringify(v)} does not match type ${JSON.stringify(schema['type'])}`);
  }
  if (has(schema, 'const') && isPrimitive(schema['const']) && !matchesType(schema['const'], types)) out.push(`${at}.const: value ${JSON.stringify(schema['const'])} does not match type ${JSON.stringify(schema['type'])}`);
  const only = (keys: string[], type: string[], label: string): void => {
    for (const k of keys) if (has(schema, k) && !types.some((t) => type.includes(t))) out.push(`${at}: "${k}" needs type ${label}`);
  };
  only(['properties', 'required', 'additionalProperties'], ['object'], 'object');
  only(['items', 'minItems', 'maxItems'], ['array'], 'array');
  only(['pattern', 'minLength', 'maxLength'], ['string'], 'string');
  only(['minimum', 'maximum'], ['number', 'integer'], 'number or integer');
  const props = isRecord(schema['properties']) ? Object.keys(schema['properties']) : [];
  if (isRecord(schema['additionalProperties']) && props.length > 0) out.push(`${at}.additionalProperties: schema together with declared properties`);
  const items = schema['items'];
  if (isRecord(items)) {
    const union = (Array.isArray(items['enum']) && items['enum'].length > 1) || has(items, 'oneOf') || (Array.isArray(items['type']) && items['type'].length > 1);
    if (union) out.push(`${at}.items: union-valued array items (enum with several values, oneOf or a type array) are generated with wrong precedence`);
  }
}

// ----- Names: MCP names are kept as they are; anything the generator would rename is refused -----

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
  'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'await', 'async', 'arguments', 'eval',
  'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
]);
const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const pascal = (name: string): string => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());

/** Per-tool name problems: the tool each one is about (a type-name collision names both tools). */
export function nameProblems(names: readonly string[]): { tool: string; message: string }[] {
  const out: { tool: string; message: string }[] = [];
  const seenTypes = new Map<string, string>();
  const seenNames = new Set<string>();
  for (const name of names) {
    if (seenNames.has(name)) out.push({ tool: name, message: `tool "${name}": duplicate name` });
    seenNames.add(name);
    if (!NAME.test(name)) out.push({ tool: name, message: `tool "${name}": name must be lower snake case` });
    if (RESERVED.has(name) || name.startsWith('__')) out.push({ tool: name, message: `tool "${name}": reserved or unsafe name` });
    for (const typeName of [`${pascal(name)}Input`, `${pascal(name)}Output`]) {
      const other = seenTypes.get(typeName);
      if (other !== undefined && other !== name) {
        const message = `tool "${name}": type name ${typeName} collides with tool "${other}"`;
        out.push({ tool: name, message }, { tool: other, message });
      }
      seenTypes.set(typeName, name);
    }
  }
  return out;
}

export function checkNames(names: readonly string[]): string[] {
  return nameProblems(names).map((p) => p.message);
}

/**
 * Why each tool's signature cannot be generated, keyed by tool name; tools with no problem are absent. This is the single
 * place support is decided: `generateDeclarations` refuses exactly the inputs this reports on.
 */
export function inspectDescriptors(descriptors: readonly ToolDescriptor[]): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const add = (tool: string, message: string): void => { problems.set(tool, [...(problems.get(tool) ?? []), message]); };
  for (const p of nameProblems(descriptors.map((d) => d.name))) add(p.tool, p.message);
  for (const d of descriptors) {
    if (d.inputSchema['type'] !== 'object') add(d.name, `tool "${d.name}": input schema must have type "object"`);
    for (const message of preflightSchema(d.inputSchema, `${d.name}.inputSchema`)) add(d.name, message);
    if (d.outputSchema !== undefined) for (const message of preflightSchema(d.outputSchema, `${d.name}.outputSchema`)) add(d.name, message);
  }
  return problems;
}

// ----- Generation with pre- and post-checks -----

/**
 * Open objects without declared properties (no `additionalProperties`, or `true`) mean "any properties" in JSON Schema;
 * the generator renders them as `Record<string, unknown>`. That is faithful, not widening, so the post-check allows exactly
 * as many of those as the schema has such nodes and no other `unknown`/`any`.
 */
export function openEmptyObjects(schema: unknown): number {
  if (!isRecord(schema)) return 0;
  const props = isRecord(schema['properties']) ? schema['properties'] : null;
  const ap = schema['additionalProperties'];
  const self = schema['type'] === 'object' && (props === null || Object.keys(props).length === 0) && (ap === undefined || ap === true) ? 1 : 0;
  const children = [
    ...(props === null ? [] : Object.values(props)),
    ...(isRecord(ap) ? [ap] : []),
    ...(has(schema, 'items') ? [schema['items']] : []),
    ...(Array.isArray(schema['oneOf']) ? schema['oneOf'] : []),
  ];
  return self + children.reduce<number>((sum, child) => sum + openEmptyObjects(child), 0);
}

type Token = { kind: 'ident' | 'punct'; text: string };

/** Minimal TypeScript lexer for generated declarations: drops comments and string literals, keeps identifiers and punctuation. */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
      tokens.push({ kind: 'punct', text: 'literal' });
      i = j + 1;
      continue;
    }
    const ident = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(i));
    if (ident) { tokens.push({ kind: 'ident', text: ident[0] }); i += ident[0].length; continue; }
    tokens.push({ kind: 'punct', text: c });
    i++;
  }
  return tokens;
}

/**
 * `unknown`/`any` in type position: an identifier token not followed by `?` or `:` (those are property keys). Counts the
 * faithful `Record<string, unknown>` separately. String literals and comments never count.
 */
export function scanWidening(body: string): { widened: number; openRecords: number } {
  const t = tokenize(body);
  let widened = 0;
  let openRecords = 0;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.kind !== 'ident' || (tok.text !== 'unknown' && tok.text !== 'any')) continue;
    const next = t[i + 1]?.text;
    if (next === '?' || next === ':') continue;
    const isOpenRecord = tok.text === 'unknown' && t[i - 4]?.text === 'Record' && t[i - 3]?.text === '<' && t[i - 2]?.text === 'string' && t[i - 1]?.text === ',' && next === '>';
    if (isOpenRecord) openRecords++;
    else widened++;
  }
  return { widened, openRecords };
}

const INPUT_TYPE = /^type (\w+)Input = ([\s\S]*?)(?=^type \w+(?:Input|Output) = |^declare const )/gm;
const OUTPUT_TYPE = /^type (\w+)Output = ([\s\S]*?)(?=^type \w+(?:Input|Output) = |^declare const )/gm;

/**
 * `unknown`/`any` in type position of a generated output: the `[key: string]: unknown` of a deliberately open node is counted
 * apart, and everything else is widening (a `Record<string, unknown>` included: an output schema spells its open nodes out).
 */
export function scanOutputWidening(body: string): { widened: number; openIndexes: number } {
  const t = tokenize(body);
  let widened = 0;
  let openIndexes = 0;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.kind !== 'ident' || (tok.text !== 'unknown' && tok.text !== 'any')) continue;
    const next = t[i + 1]?.text;
    if (next === '?' || next === ':') continue;
    const index = t.slice(Math.max(0, i - 6), i).map((x) => x.text).join(' ');
    if (tok.text === 'unknown' && index === '[ key : string ] :') openIndexes++;
    else widened++;
  }
  return { widened, openIndexes };
}

/** Deliberately open nodes of an output schema: each renders as exactly one `[key: string]: unknown`. */
export function openOutputNodes(schema: unknown): number {
  if (!isRecord(schema)) return 0;
  const props = isRecord(schema['properties']) ? Object.values(schema['properties']) : [];
  const ap = schema['additionalProperties'];
  const one = Array.isArray(schema['oneOf']) ? schema['oneOf'] : [];
  const children = [...props, ...(isRecord(ap) ? [ap] : []), ...(has(schema, 'items') ? [schema['items']] : []), ...one];
  return (ap === true ? 1 : 0) + children.reduce<number>((sum, child) => sum + openOutputNodes(child), 0);
}

/**
 * Declarations for exactly these descriptors, or an `UnsupportedSchemaError` listing every problem with its path. There is
 * no filtering: the caller decides which tools to pass (see `inspectDescriptors`). Declaration-only: the generator gets no
 * `execute`. A descriptor without an output schema promises nothing and its output must render as `unknown`; one with an output
 * schema must render with no `unknown`/`any` except the counted open nodes of that schema.
 */
export function generateDeclarations(descriptors: readonly ToolDescriptor[]): string {
  const found = inspectDescriptors(descriptors);
  if (found.size > 0) throw new UnsupportedSchemaError([...found.values()].flat());

  const tools: Tool[] = descriptors.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema as JSONSchema, ...(d.outputSchema === undefined ? {} : { outputSchema: d.outputSchema as JSONSchema }) }));
  const text = generateTypes(tools, NAMESPACE);

  const post: string[] = [];
  if (!text.includes(`declare const ${NAMESPACE}: {`)) post.push(`namespace "${NAMESPACE}" missing`);
  const methodLines = text.match(/^\t[a-z0-9_]+: \(input: \w+Input\) => Promise<\w+Output>;$/gm) ?? [];
  if (methodLines.length !== descriptors.length) post.push(`expected ${descriptors.length} methods, found ${methodLines.length}`);
  for (const d of descriptors) {
    const p = pascal(d.name);
    if (!text.includes(`\t${d.name}: (input: ${p}Input) => Promise<${p}Output>;`)) post.push(`tool "${d.name}": method missing or renamed`);
    if (d.outputSchema === undefined && !text.includes(`type ${p}Output = unknown`)) post.push(`tool "${d.name}": output is not unknown`);
  }
  const allowedOpen = new Map(descriptors.map((d) => [pascal(d.name), openEmptyObjects(d.inputSchema)]));
  for (const match of text.matchAll(INPUT_TYPE)) {
    const { widened, openRecords } = scanWidening(match[2]!);
    if (widened > 0 || openRecords !== (allowedOpen.get(match[1]!) ?? 0)) post.push(`type ${match[1]}Input: widened to unknown/any`);
  }
  const declaredOutputs = new Map(descriptors.filter((d) => d.outputSchema !== undefined).map((d) => [pascal(d.name), openOutputNodes(d.outputSchema)]));
  const seenOutputs = new Set<string>();
  for (const match of text.matchAll(OUTPUT_TYPE)) {
    const open = declaredOutputs.get(match[1]!);
    if (open === undefined) continue;
    seenOutputs.add(match[1]!);
    const { widened, openIndexes } = scanOutputWidening(match[2]!);
    if (widened > 0 || openIndexes !== open) post.push(`type ${match[1]}Output: widened to unknown/any`);
  }
  for (const name of declaredOutputs.keys()) if (!seenOutputs.has(name)) post.push(`type ${name}Output: missing`);
  if (post.length > 0) throw new UnsupportedSchemaError(post.map((p) => `post-check: ${p}`));
  return text;
}
