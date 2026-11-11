// Code Mode strict JSON and input-schema validation (plan T3b): fixture-level contracts only, no broker or runtime.
//
// Three layers, each fail-closed and each run before anything can be dispatched:
//   1. JS values that are about to cross IPC (assertJsonValue / serializeStrict): only plain JSON data, bounded.
//   2. JSON text that crossed IPC (parseStrictJson): an own RFC 8259 parser that also rejects what JSON.parse silently
//      accepts or alters (duplicate keys, lone surrogates, unsafe integers, overflowing numbers, `__proto__` keys).
//   3. Tool arguments against the tool's authoritative input schema (compileInputValidator): a runtime dialect check of
//      its own (separate from the declaration generator's preflight in types.ts), then Ajv 8.20.0 in strict mode with
//      no coercion, no defaults, no property removal and no remote references. Open objects stay open, closed stay closed.
// Errors are bounded and carry codes, offsets and SCHEMA paths only; they never echo input values.

import { types as utilTypes } from 'node:util';
import { Ajv, type ValidateFunction } from 'ajv';
import { canonicalSha256 } from './catalog.js';
import { UnsupportedSchemaError } from './types.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonLimits {
  /** UTF-8 bytes of the serialized text. */
  readonly maxBytes: number;
  /** Container nesting: a scalar at the top is depth 0, `[]` is depth 1. */
  readonly maxDepth: number;
  /** Every value visited, including repeated visits of a shared object. Bounds work and DAG expansion. */
  readonly maxNodes: number;
}

/** Arguments of one call (design §6: 64 KiB per call). */
export const ARG_LIMITS: JsonLimits = Object.freeze({ maxBytes: 64 * 1024, maxDepth: 32, maxNodes: 10_000 });
/** The final guest result (design §6: 16 KiB). */
export const RESULT_LIMITS: JsonLimits = Object.freeze({ maxBytes: 16 * 1024, maxDepth: 32, maxNodes: 10_000 });

export type StrictJsonCode =
  | 'not-json' | 'cycle' | 'depth' | 'nodes' | 'bytes' | 'number' | 'string' | 'key' | 'syntax' | 'duplicate-key';

export class StrictJsonError extends Error {
  constructor(readonly code: StrictJsonCode, readonly at: string) {
    super(`strict JSON: ${code} at ${at}`);
    this.name = 'StrictJsonError';
  }
}

/** Keys that would change an object's prototype or could pollute one on a later merge. */
const FORBIDDEN_KEY = '__proto__';
const ESCAPES: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }));
/** Finite, and not an integer beyond 2^53 that a JSON round trip could not reproduce exactly. */
const jsonNumber = (n: number): boolean => Number.isFinite(n) && (!Number.isInteger(n) || Number.isSafeInteger(n));
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
/** No lone surrogate: in a `u` regex a valid pair is one code point, so only unpaired halves match `\p{Cs}`. */
export const isWellFormed = (s: string): boolean => !/\p{Cs}/u.test(s);

// Captured once, so later replacement of these globals cannot change what is checked or emitted.
const quote: (s: string) => string = JSON.stringify; // on a primitive string it never consults toJSON
const hasOwn = Object.hasOwn;
const defineValue = (o: object, key: string | number, value: unknown): void => {
  // Defining, not assigning: an inherited setter (prototype pollution) is never invoked.
  Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
};

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * One walk that both checks and emits: `value` must be plain JSON data within `limits`, and the returned text is built
 * from the same own data properties that were checked. JSON.stringify is never applied to an object, so neither an own
 * nor an inherited `toJSON` (prototype pollution) can make the emitted text differ from the checked value.
 * Accepts null, booleans, finite numbers, well-formed strings, dense arrays with the array prototype and no extra
 * properties, and plain objects (Object.prototype or null prototype) whose own keys are all enumerable string-keyed data
 * properties. Rejects cycles, functions, symbols (as values or keys), BigInt, undefined, accessors (never called),
 * proxies (no trap runs), boxed primitives, Date/Map/Set/RegExp/typed arrays and any other exotic object.
 * `at` paths are positions only: `[i]` for an array index and `{k}` for the k-th own key, never a key name or a value.
 * `sortKeys` emits object keys in code-unit order (the canonical form used for hashes).
 */
function walk(value: unknown, limits: JsonLimits, sortKeys: boolean): string {
  let nodes = 0;
  let bytes = 0; // UTF-8 bytes of strings and keys seen so far: a lower bound of the serialized size
  const ancestors = new Set<object>();
  const visit = (v: unknown, depth: number, at: string): string => {
    if (++nodes > limits.maxNodes) throw new StrictJsonError('nodes', at);
    if (v === null) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') {
      if (!jsonNumber(v)) throw new StrictJsonError('number', at);
      return Object.is(v, -0) ? '0' : String(v);
    }
    if (typeof v === 'string') {
      if (!isWellFormed(v)) throw new StrictJsonError('string', at);
      if ((bytes += utf8Bytes(v)) > limits.maxBytes) throw new StrictJsonError('bytes', at);
      return quote(v);
    }
    if (typeof v !== 'object') throw new StrictJsonError('not-json', at);
    if (utilTypes.isProxy(v)) throw new StrictJsonError('not-json', at);
    if (ancestors.has(v)) throw new StrictJsonError('cycle', at);
    if (depth + 1 > limits.maxDepth) throw new StrictJsonError('depth', at);
    const proto = Object.getPrototypeOf(v);
    // Cheap size guard for arrays. Reflect.ownKeys still materializes every key of an object before the count check;
    // fine for data built in this process, worth revisiting if this is ever applied to a live untrusted object.
    if (Array.isArray(v) && v.length > limits.maxNodes) throw new StrictJsonError('nodes', at);
    const keys = Reflect.ownKeys(v);
    if (keys.length > limits.maxNodes + 1) throw new StrictJsonError('nodes', at);
    ancestors.add(v);
    let out: string;
    if (Array.isArray(v)) {
      if (proto !== Array.prototype) throw new StrictJsonError('not-json', at);
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= v.length) throw new StrictJsonError('not-json', at);
      }
      out = '[';
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (d === undefined) throw new StrictJsonError('not-json', `${at}[${i}]`); // hole
        if (!hasOwn(d, 'value')) throw new StrictJsonError('not-json', `${at}[${i}]`); // accessor
        out += (i === 0 ? '' : ',') + visit(d.value, depth + 1, `${at}[${i}]`);
      }
      out += ']';
    } else {
      if (proto !== Object.prototype && proto !== null) throw new StrictJsonError('not-json', at);
      const entries: [string, unknown, number][] = [];
      let k = 0;
      for (const key of keys) {
        if (typeof key !== 'string') throw new StrictJsonError('key', at);
        if (key === FORBIDDEN_KEY) throw new StrictJsonError('key', at);
        if (!isWellFormed(key)) throw new StrictJsonError('key', at);
        if ((bytes += utf8Bytes(key)) > limits.maxBytes) throw new StrictJsonError('bytes', at);
        const d = Object.getOwnPropertyDescriptor(v, key)!;
        if (!hasOwn(d, 'value') || !d.enumerable) throw new StrictJsonError('not-json', at);
        entries[entries.length] = [key, d.value, k++];
      }
      if (sortKeys) entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      out = '{';
      for (let j = 0; j < entries.length; j++) {
        const [key, child, index] = entries[j]!;
        out += (j === 0 ? '' : ',') + quote(key) + ':' + visit(child, depth + 1, `${at}{${index}}`);
      }
      out += '}';
    }
    ancestors.delete(v);
    return out;
  };
  return visit(value, 0, '$');
}

/** Throws unless `value` is plain JSON data within `limits` (see `walk`). */
export function assertJsonValue(value: unknown, limits: JsonLimits): asserts value is JsonValue {
  walk(value, limits, false);
}

/** The text of exactly the checked own data, with the byte check on that text. */
export function serializeStrict(value: unknown, limits: JsonLimits): string {
  const text = walk(value, limits, false);
  if (utf8Bytes(text) > limits.maxBytes) throw new StrictJsonError('bytes', '$');
  return text;
}

/** Canonical (sorted-key) strict text, for hashes that must not depend on key order or on any toJSON. */
export function canonicalStrict(value: unknown, limits: JsonLimits): string {
  const text = walk(value, limits, true);
  if (utf8Bytes(text) > limits.maxBytes) throw new StrictJsonError('bytes', '$');
  return text;
}

/**
 * The single source of truth for crossing a boundary: serialize the checked own data, parse that text strictly, and
 * return the exact text with a deeply frozen value parsed from it. Later changes to the caller's object, and any
 * inherited toJSON or setter, cannot change either.
 */
export function freezeJson(value: unknown, limits: JsonLimits): { readonly text: string; readonly value: JsonValue } {
  const text = serializeStrict(value, limits);
  return { text, value: deepFreeze(parseStrictJson(text, limits)) };
}

/**
 * RFC 8259 parser for text that crossed IPC. Beyond JSON.parse it rejects: duplicate keys, `__proto__` keys, lone
 * surrogates (escaped or raw), integer values beyond 2^53 (silent precision loss), numbers that overflow to ±Infinity,
 * depth/node/byte overruns and trailing content. The byte check runs before any parsing. Decimal fractions are rounded
 * to the nearest double, as in any JSON parser.
 */
export function parseStrictJson(text: string, limits: JsonLimits): JsonValue {
  if (typeof text !== 'string') throw new StrictJsonError('not-json', 'offset 0');
  if (utf8Bytes(text) > limits.maxBytes) throw new StrictJsonError('bytes', 'offset 0');
  let i = 0;
  let nodes = 0;
  const fail = (code: StrictJsonCode): never => { throw new StrictJsonError(code, `offset ${i}`); };
  const ws = (): void => { while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++; };
  const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
  const parseString = (): string => {
    i++; // opening quote
    let out = '';
    for (;;) {
      if (i >= text.length) fail('syntax');
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; break; }
      if (c < 0x20) fail('syntax');
      if (c !== 0x5c) { out += text[i]; i++; continue; }
      const e = text[i + 1];
      if (e !== undefined && hasOwn(ESCAPES, e)) { out += ESCAPES[e]; i += 2; continue; }
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('syntax');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      fail('syntax');
    }
    if (!isWellFormed(out)) fail('string');
    return out;
  };
  const parseValue = (depth: number): JsonValue => {
    if (++nodes > limits.maxNodes) fail('nodes');
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      if (depth + 1 > limits.maxDepth) fail('depth');
      i++;
      if (c === '[') {
        const arr: JsonValue[] = [];
        ws();
        if (text[i] === ']') { i++; return arr; }
        for (;;) {
          defineValue(arr, arr.length, parseValue(depth + 1));
          ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return arr; }
          fail('syntax');
        }
      }
      const obj: { [key: string]: JsonValue } = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('syntax');
        const key = parseString();
        if (key === FORBIDDEN_KEY) fail('key');
        if (seen.has(key)) fail('duplicate-key');
        seen.add(key);
        ws();
        if (text[i] !== ':') fail('syntax');
        i++;
        defineValue(obj, key, parseValue(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('syntax');
      }
    }
    if (c === '"') return parseString();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m === null) return fail('syntax');
    const n = Number(m[0]);
    if (!jsonNumber(n)) fail('number');
    i += m[0].length;
    return n;
  };
  const value = parseValue(0);
  ws();
  if (i !== text.length) fail('syntax');
  return value;
}

// ----- Runtime schema dialect (separate from the generator preflight in types.ts) -----

/** Version of the runtime dialect and validator configuration; part of the API revision. */
export const RUNTIME_DIALECT_VERSION = 1;
export const VALIDATOR_PIN = Object.freeze({ package: 'ajv', version: '8.20.0' });

const RUNTIME_KEYWORDS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf',
  'description', 'default', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
]);
const RUNTIME_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const SCHEMA_MAX_DEPTH = 16;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const nonNegInt = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * Problems that make a schema unsupported at runtime, each with its schema path. Only these keywords are understood;
 * anything else (including `format`, `$ref`, `allOf`, `anyOf`, `not`, `if`, `patternProperties`, `prefixItems`, boolean
 * subschemas) is refused, because Ajv would ignore or reinterpret some of them silently. Semantics the generator cannot
 * express but JSON Schema defines exactly (union-valued items, nullable types) are allowed here.
 */
export function runtimeDialectProblems(schema: unknown, at = '#', out: string[] = [], depth = 0): string[] {
  if (depth > SCHEMA_MAX_DEPTH) { out.push(`${at}: nested deeper than ${SCHEMA_MAX_DEPTH}`); return out; }
  if (!isRecord(schema)) { out.push(`${at}: schema must be an object`); return out; }
  for (const key of Object.keys(schema)) if (!RUNTIME_KEYWORDS.has(key)) out.push(`${at}: unsupported keyword "${key}"`);
  if (own(schema, 'type')) {
    const t = schema['type'];
    const list = Array.isArray(t) ? t : [t];
    if (list.length === 0 || new Set(list).size !== list.length || !list.every((x) => typeof x === 'string' && RUNTIME_TYPES.has(x))) out.push(`${at}/type: unsupported type`);
  } else if (!own(schema, 'oneOf') && !own(schema, 'enum') && !own(schema, 'const')) {
    out.push(`${at}: needs "type", "oneOf", "enum" or "const"`);
  }
  if (own(schema, 'properties')) {
    const props = schema['properties'];
    if (!isRecord(props)) out.push(`${at}/properties: must be an object`);
    else for (const [name, sub] of Object.entries(props)) {
      if (name === FORBIDDEN_KEY) out.push(`${at}/properties: forbidden property name`);
      runtimeDialectProblems(sub, `${at}/properties/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, out, depth + 1);
    }
  }
  if (own(schema, 'required')) {
    const r = schema['required'];
    if (!Array.isArray(r) || !r.every((x) => typeof x === 'string') || new Set(r).size !== r.length) out.push(`${at}/required: must be unique strings`);
  }
  if (own(schema, 'additionalProperties')) {
    const ap = schema['additionalProperties'];
    if (typeof ap !== 'boolean') runtimeDialectProblems(ap, `${at}/additionalProperties`, out, depth + 1);
  }
  if (own(schema, 'items')) runtimeDialectProblems(schema['items'], `${at}/items`, out, depth + 1);
  if (own(schema, 'oneOf')) {
    const one = schema['oneOf'];
    if (!Array.isArray(one) || one.length === 0) out.push(`${at}/oneOf: must be a non-empty array`);
    else one.forEach((sub, k) => runtimeDialectProblems(sub, `${at}/oneOf/${k}`, out, depth + 1));
  }
  if (own(schema, 'enum') && (!Array.isArray(schema['enum']) || schema['enum'].length === 0)) out.push(`${at}/enum: must be a non-empty array`);
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) if (own(schema, key) && !nonNegInt(schema[key])) out.push(`${at}/${key}: must be a non-negative integer`);
  for (const key of ['minimum', 'maximum']) if (own(schema, key) && !(typeof schema[key] === 'number' && Number.isFinite(schema[key]))) out.push(`${at}/${key}: must be a finite number`);
  if (own(schema, 'pattern')) {
    const p = schema['pattern'];
    if (typeof p !== 'string') out.push(`${at}/pattern: must be a string`);
    else {
      try { new RegExp(p, 'u'); } catch { out.push(`${at}/pattern: not a valid unicode regular expression`); }
      const why = patternProblem(p);
      if (why !== null) out.push(`${at}/pattern: outside the vetted pattern subset (${why})`);
    }
  }
  if (own(schema, 'description') && typeof schema['description'] !== 'string') out.push(`${at}/description: must be a string`);
  return out;
}

// ----- Vetted pattern subset -----

/** Upper bound of one bounded quantifier, and of the product of all bounded choices (incl. alternation branches). */
export const PATTERN_MAX_BOUND = 128;
export const PATTERN_MAX_CHOICES = 1024;
const ESCAPABLE = new Set(['d', 'D', 'w', 'W', 's', 'S', '\\', '/', '.', '-', '^', '$', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);

/**
 * Guest strings reach schema `pattern`s, and Ajv runs them on V8's backtracking engine. Instead of timing, a pattern is
 * admitted only when its structure bounds backtracking: anchored with `^` (one start position); atoms are literals, `.`,
 * flat character classes and the escapes in ESCAPABLE (no back-references, lookarounds, `\b`, `\p`, `\u`); groups are
 * one level deep, may hold alternation, and are never quantified; quantifiers are `?`, `{n}`, `{n,m}` (m ≤ 128) and at
 * most ONE unbounded `*`, `+` or `{n,}` in the whole pattern; no lazy quantifiers; `$` only at the very end; and the
 * product of all bounded choices and alternation branches is ≤ 1024. With one start position and a single unbounded
 * quantifier, the matcher tries O(n) split points for each of ≤ 1024 bounded configurations, i.e. linear in the input
 * up to that constant. This is a structural argument over this subset, not a proof about V8 in general.
 * Returns null when admitted, or a short reason.
 */
export function patternProblem(p: string): string | null {
  if (!p.startsWith('^')) return 'not anchored with ^';
  let i = 1;
  let unbounded = 0;
  let choices = 1;
  const atom = (): string | null => {
    const c = p[i];
    if (c === '[') {
      i++;
      if (p[i] === '^') i++;
      let n = 0;
      while (i < p.length && (p[i] !== ']' || n === 0)) {
        if (p[i] === '[') return 'nested class';
        if (p[i] === '\\') { if (!ESCAPABLE.has(p[i + 1] ?? '')) return 'escape'; i++; }
        i++;
        n++;
      }
      if (p[i] !== ']') return 'unterminated class';
      i++;
      return null;
    }
    if (c === '\\') {
      if (!ESCAPABLE.has(p[i + 1] ?? '')) return 'escape';
      i += 2;
      return null;
    }
    if (c === undefined || '()|*+?{}$^'.includes(c)) return 'atom expected';
    i++;
    return null;
  };
  const quantifier = (): string | null => {
    const c = p[i];
    let bounded = 1;
    if (c === '*' || c === '+') { unbounded++; i++; }
    else if (c === '?') { bounded = 2; i++; }
    else if (c === '{') {
      const m = /^\{(\d{1,3})(,(\d{1,3})?)?\}/.exec(p.slice(i));
      if (m === null) return 'quantifier';
      const lo = Number(m[1]);
      if (m[2] === undefined) bounded = 1;
      else if (m[3] === undefined) unbounded++;
      else {
        const hi = Number(m[3]);
        if (hi < lo || hi > PATTERN_MAX_BOUND) return 'bound';
        bounded = hi - lo + 1;
      }
      if (lo > PATTERN_MAX_BOUND) return 'bound';
      i += m[0].length;
    } else return null;
    if (p[i] === '?' || p[i] === '+') return 'lazy or possessive quantifier';
    choices *= bounded;
    return null;
  };
  const sequence = (inGroup: boolean): string | null => {
    while (i < p.length) {
      const c = p[i];
      if (c === '|' || c === ')') return inGroup ? null : 'alternation outside a group';
      if (c === '$') return i === p.length - 1 && !inGroup ? null : '$ before the end';
      if (c === '(') {
        if (inGroup) return 'nested group';
        i++;
        if (p.startsWith('?:', i)) i += 2;
        else if (p[i] === '?') return 'lookaround or named group';
        let branches = 1;
        for (;;) {
          const why = sequence(true);
          if (why !== null) return why;
          if (p[i] === '|') { branches++; i++; continue; }
          if (p[i] === ')') { i++; break; }
          return 'unterminated group';
        }
        choices *= branches;
        if (i < p.length && '*+?{'.includes(p[i]!)) return 'quantified group';
        continue;
      }
      const why = atom() ?? quantifier();
      if (why !== null) return why;
    }
    return inGroup ? 'unterminated group' : null;
  };
  const why = sequence(false);
  if (why !== null) return why;
  if (unbounded > 1) return 'more than one unbounded quantifier';
  if (choices > PATTERN_MAX_CHOICES) return 'too many bounded choices';
  return null;
}

// ----- Input validators -----

export interface ValidationIssue {
  /** JSON pointer into the SCHEMA (never into the data), bounded. */
  readonly schemaPath: string;
  readonly keyword: string;
}

export type ValidationFailure =
  | { readonly kind: 'json'; readonly code: StrictJsonCode; readonly at: string }
  /** `issuesTruncated`: issues were dropped or a schema path was shortened (marked with `…`). */
  | { readonly kind: 'schema'; readonly issues: readonly ValidationIssue[]; readonly issuesTruncated: boolean };

/**
 * On success: the exact text to send and a deeply frozen value parsed from that text. Both are what was validated; the
 * caller's original object is never returned, so changing it afterwards cannot change what is dispatched.
 */
export type ValidationOutcome =
  | { readonly ok: true; readonly text: string; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: ValidationFailure };

export interface InputValidator {
  /** Hash of the private schema copy the validator was compiled from. */
  readonly schemaSha256: string;
  /** The frozen limits snapshot taken at compile time. */
  readonly limits: JsonLimits;
  /** Validates a JS value (before it crosses IPC): serialize own data → strict parse → schema on the parsed copy. */
  validateValue(value: unknown): ValidationOutcome;
  /** Parses strictly and validates JSON text (after it crossed IPC); `text` in the outcome is the input unchanged. */
  validateText(text: string): ValidationOutcome;
}

const MAX_ISSUES = 8;
const bounded = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Ajv options: strict, no coercion, no defaults, no removal, no formats, no remote schemas, unicode patterns; stop at the first error. */
const AJV_OPTIONS = Object.freeze({
  strict: true, strictTypes: true, strictTuples: true, strictRequired: false, allowUnionTypes: true,
  allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false,
  validateFormats: false, unicodeRegExp: true, addUsedSchema: false, inlineRefs: false, messages: false,
});

const SCHEMA_LIMITS: JsonLimits = Object.freeze({ maxBytes: 1024 * 1024, maxDepth: 64, maxNodes: 100_000 });

/** An owned, frozen copy of caller limits; each must be a positive safe integer. */
export function snapshotLimits(limits: JsonLimits): JsonLimits {
  const read = (k: keyof JsonLimits): number => {
    const v = (limits as unknown as Record<string, unknown>)[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new UnsupportedSchemaError([`limits.${k}: must be a positive safe integer`]);
    return v;
  };
  return Object.freeze({ maxBytes: read('maxBytes'), maxDepth: read('maxDepth'), maxNodes: read('maxNodes') });
}

/**
 * Compiles a validator for one authoritative input schema. Unsupported dialect fails closed with UnsupportedSchemaError
 * before Ajv sees the schema; Ajv then compiles a private copy parsed from the schema's strict text, in strict mode (a
 * compile error is also fail-closed). Limits are snapshotted: nothing the caller owns is read after this returns.
 */
export function compileInputValidator(schema: unknown, limits: JsonLimits = ARG_LIMITS): InputValidator {
  const own = snapshotLimits(limits);
  let owned: Record<string, unknown>;
  try { owned = parseStrictJson(serializeStrict(schema, SCHEMA_LIMITS), SCHEMA_LIMITS) as Record<string, unknown>; } catch (e) {
    throw new UnsupportedSchemaError([`#: schema is not plain JSON (${e instanceof StrictJsonError ? e.code : 'error'})`]);
  }
  const problems = runtimeDialectProblems(owned);
  if (problems.length > 0) throw new UnsupportedSchemaError(problems);
  const schemaSha256 = canonicalSha256(owned);
  let validate: ValidateFunction;
  try {
    validate = new Ajv(AJV_OPTIONS).compile(owned);
  } catch (e) {
    throw new UnsupportedSchemaError([`#: rejected by the strict validator (${bounded((e as Error).message, 200)})`]);
  }
  const check = (text: string, value: JsonValue): ValidationOutcome => {
    if (validate(value)) return Object.freeze({ ok: true as const, text, value: deepFreeze(value) });
    const errors = validate.errors ?? [];
    const kept = errors.slice(0, MAX_ISSUES);
    const issues = kept.map((e) => Object.freeze({ schemaPath: bounded(e.schemaPath), keyword: e.keyword }));
    const issuesTruncated = errors.length > kept.length || kept.some((e) => e.schemaPath.length > 160);
    return deepFreeze({ ok: false as const, failure: { kind: 'schema' as const, issues, issuesTruncated } });
  };
  const jsonFailure = (e: unknown): ValidationOutcome => {
    if (e instanceof StrictJsonError) return deepFreeze({ ok: false as const, failure: { kind: 'json' as const, code: e.code, at: bounded(e.at, 80) } });
    throw e;
  };
  return Object.freeze({
    schemaSha256,
    limits: own,
    validateValue(value: unknown): ValidationOutcome {
      let text: string;
      let parsed: JsonValue;
      try { text = serializeStrict(value, own); parsed = parseStrictJson(text, own); } catch (e) { return jsonFailure(e); }
      return check(text, parsed);
    },
    validateText(text: string): ValidationOutcome {
      let parsed: JsonValue;
      try { parsed = parseStrictJson(text, own); } catch (e) { return jsonFailure(e); }
      return check(text, parsed);
    },
  });
}
