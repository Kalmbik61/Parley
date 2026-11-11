import { describe, expect, it } from 'vitest';
import { TOOLS } from '../tools.js';
import { createBrowserTools } from '../browser-tools.js';
import { CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL } from '../session-tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from '../swarm-tools.js';
import { INITIAL_COHORT, canonicalJson } from './catalog.js';
import { UnsupportedSchemaError } from './types.js';
import {
  ARG_LIMITS,
  type JsonLimits,
  StrictJsonError,
  assertJsonValue,
  canonicalStrict,
  compileInputValidator,
  freezeJson,
  isWellFormed,
  parseStrictJson,
  patternProblem,
  runtimeDialectProblems,
  serializeStrict,
  snapshotLimits,
} from './validation.js';

const SECRET = 'sk-ant-api03-SYNTHETIC-SECRET-VALUE';
const small: JsonLimits = { maxBytes: 64, maxDepth: 3, maxNodes: 8 };

const jsonCode = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    if (e instanceof StrictJsonError) return e.code;
    throw e;
  }
  return 'ok';
};
const valueCode = (v: unknown, limits: JsonLimits = ARG_LIMITS): string => jsonCode(() => assertJsonValue(v, limits));
const textCode = (t: string, limits: JsonLimits = ARG_LIMITS): string => jsonCode(() => parseStrictJson(t, limits));
const schemaOf = (name: string): Record<string, unknown> => TOOLS.find((t) => t.name === name)!.inputSchema as Record<string, unknown>;

describe('assertJsonValue: plain JSON data only, before anything crosses IPC', () => {
  it('accepts plain data, null-prototype objects, astral strings and the safe-integer edge', () => {
    const nullProto = Object.assign(Object.create(null) as object, { a: 1 });
    for (const v of [null, true, 0, -0, 1.5, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, '', '😀', [], {}, { a: [1, { b: 'c' }] }, nullProto]) {
      expect(valueCode(v), JSON.stringify(v)).toBe('ok');
    }
  });

  it('refuses cycles in objects and arrays', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    const a: unknown[] = [];
    a.push([a]);
    expect(valueCode(o)).toBe('cycle');
    expect(valueCode(a)).toBe('cycle');
  });

  it('allows a shared, acyclic object but counts every visit, so expansion is bounded', () => {
    const shared = { x: 1 };
    expect(valueCode({ a: shared, b: shared })).toBe('ok');
    let bomb: unknown = 'x';
    for (let i = 0; i < 30; i++) bomb = [bomb, bomb];
    expect(valueCode(bomb)).toBe('nodes');
  });

  it('refuses non-finite numbers and integers beyond 2^53', () => {
    for (const n of [NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 1e21]) expect(valueCode({ n }), String(n)).toBe('number');
  });

  it('refuses functions, symbols, BigInt and undefined anywhere', () => {
    expect(valueCode(() => 1)).toBe('not-json');
    expect(valueCode({ f() { return 1; } })).toBe('not-json');
    expect(valueCode({ toJSON: () => 'x' })).toBe('not-json');
    expect(valueCode(Symbol('s'))).toBe('not-json');
    expect(valueCode({ [Symbol('k')]: 1 })).toBe('key');
    expect(valueCode(1n)).toBe('not-json');
    expect(valueCode({ a: 1n })).toBe('not-json');
    expect(valueCode(undefined)).toBe('not-json');
    expect(valueCode({ a: undefined })).toBe('not-json');
    expect(valueCode([undefined])).toBe('not-json');
  });

  it('refuses accessors without calling them', () => {
    let calls = 0;
    const obj = Object.defineProperty({}, 'a', { get: () => { calls++; return 1; }, enumerable: true });
    const arr = Object.defineProperty([0], 0, { get: () => { calls++; return 1; }, enumerable: true });
    expect(valueCode(obj)).toBe('not-json');
    expect(valueCode(arr)).toBe('not-json');
    expect(calls).toBe(0);
  });

  it('refuses proxies without running a trap', () => {
    let traps = 0;
    const handler = new Proxy({}, { get: () => { traps++; return undefined; } });
    expect(valueCode(new Proxy({ a: 1 }, handler))).toBe('not-json');
    expect(valueCode(new Proxy([1], handler))).toBe('not-json');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(valueCode(proxy)).toBe('not-json');
    expect(traps).toBe(0);
  });

  it('refuses exotic and non-plain objects', () => {
    class Point { x = 1; }
    class List extends Array {}
    const extraArray = Object.assign([1], { extra: true });
    const boxed = [new Boolean(true), new Number(1), new String('s')];
    const args = (function () { return arguments; })(); // eslint-disable-line prefer-rest-params
    for (const v of [new Date(0), new Map(), new Set(), /x/, new Uint8Array(1), new ArrayBuffer(1), new Error('e'), new Point(), List.from([1]), extraArray, Promise.resolve(), new WeakMap(), args, ...boxed]) {
      expect(valueCode(v), Object.prototype.toString.call(v)).toBe('not-json');
    }
  });

  it('refuses holes, non-enumerable properties and __proto__ own keys', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(valueCode([1, , 3])).toBe('not-json');
    expect(valueCode(new Array(3))).toBe('not-json');
    expect(valueCode(Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }))).toBe('not-json');
    expect(valueCode(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe('key');
  });

  it('refuses lone surrogates in values and keys', () => {
    expect(valueCode('\ud800')).toBe('string');
    expect(valueCode({ ['\udc00']: 1 })).toBe('key');
  });

  it('isWellFormed agrees with the ES2024 built-in', () => {
    const native = (s: string): boolean => (s as unknown as { isWellFormed(): boolean }).isWellFormed();
    for (const s of ['', 'a', '😀', '\ud83d\ude00x', '\ud800', '\udc00', 'a\ud800b', '\udc00\ud800', '\ud800\ud800\udc00', 'é\uffff']) {
      expect(isWellFormed(s), JSON.stringify(s)).toBe(native(s));
    }
  });

  it('bounds depth, nodes and bytes at the exact edge', () => {
    expect(valueCode([[['x']]], small)).toBe('ok');
    expect(valueCode([[[['x']]]], small)).toBe('depth');
    expect(valueCode([1, 2, 3, 4, 5, 6, 7], small)).toBe('ok'); // 8 nodes
    expect(valueCode([1, 2, 3, 4, 5, 6, 7, 8], small)).toBe('nodes');
    expect(jsonCode(() => serializeStrict('x'.repeat(62), small))).toBe('ok'); // 64 bytes with quotes
    expect(jsonCode(() => serializeStrict('x'.repeat(63), small))).toBe('bytes');
    expect(jsonCode(() => serializeStrict('é'.repeat(31), small))).toBe('ok'); // 62 + 2 bytes
    expect(jsonCode(() => serializeStrict('é'.repeat(32), small))).toBe('bytes');
  });

  it('stops on string bytes during the walk, before serializing a huge value', () => {
    expect(valueCode({ a: 'x'.repeat(ARG_LIMITS.maxBytes + 1) })).toBe('bytes');
    expect(valueCode(new Array(ARG_LIMITS.maxNodes + 1).fill(0))).toBe('nodes');
  });

  it('reports positions, never key names or values', () => {
    const bad = { [SECRET]: { token: SECRET, n: NaN } };
    try { assertJsonValue(bad, ARG_LIMITS); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(StrictJsonError);
      expect((e as StrictJsonError).at).toBe('${0}{1}');
      expect(JSON.stringify({ m: (e as Error).message, ...(e as object) })).not.toContain('SYNTHETIC');
    }
  });
});

describe('parseStrictJson: what JSON.parse accepts or alters silently is refused', () => {
  it('parses valid JSON exactly like JSON.parse', () => {
    for (const t of ['null', ' true ', '-0', '1.5e10', '9007199254740991', '"\\ud83d\\ude00\\n\\u00e9\\/"', '[]', '{}', '{"a":[1,{"b":"c"}],"d":null}', '\t[1 ,\r\n2]']) {
      expect(parseStrictJson(t, ARG_LIMITS), t).toEqual(JSON.parse(t));
    }
  });

  it('refuses duplicate keys, which JSON.parse resolves to the last one', () => {
    expect(JSON.parse('{"a":1,"a":2}')).toEqual({ a: 2 });
    expect(textCode('{"a":1,"a":2}')).toBe('duplicate-key');
    expect(textCode('{"a":1,"\\u0061":2}')).toBe('duplicate-key');
  });

  it('refuses __proto__ keys, also when escaped', () => {
    expect(textCode('{"__proto__":{"x":1}}')).toBe('key');
    expect(textCode('{"\\u005f_proto__":1}')).toBe('key');
  });

  it('refuses lone surrogates, escaped or raw', () => {
    expect(textCode('"\\ud800"')).toBe('string');
    expect(textCode('"\\udc00x"')).toBe('string');
    expect(textCode('"\ud800"')).toBe('string');
    expect(textCode('{"\\ud800":1}')).toBe('string');
  });

  it('refuses numbers that lose precision or overflow', () => {
    for (const t of ['9007199254740992', '9007199254740993', '-9007199254740993', '1e16', '1e400', '-1e400', '[1e309]']) expect(textCode(t), t).toBe('number');
  });

  it('refuses everything outside RFC 8259', () => {
    for (const t of ['', ' ', '01', '1.', '.5', '+1', 'NaN', 'Infinity', "'a'", '[1,]', '{"a":1,}', '{a:1}', '[1] x', '// c\n1', '"\u0001"', '"\\x41"', '﻿1', 'tru', 'nul']) {
      expect(textCode(t), JSON.stringify(t)).toBe('syntax');
    }
  });

  it('checks bytes before parsing, then depth and nodes', () => {
    expect(textCode(`"${'x'.repeat(62)}"`, small)).toBe('ok');
    expect(textCode(`"${'x'.repeat(63)}"`, small)).toBe('bytes');
    expect(textCode(`{${'x'.repeat(200)}`, small)).toBe('bytes');
    expect(textCode('[[[1]]]', small)).toBe('ok');
    expect(textCode('[[[[1]]]]', small)).toBe('depth');
    expect(textCode('[1,2,3,4,5,6,7]', small)).toBe('ok');
    expect(textCode('[1,2,3,4,5,6,7,8]', small)).toBe('nodes');
  });

  it('refuses non-string input', () => {
    expect(textCode(42 as unknown as string)).toBe('not-json');
  });
});

describe('runtime schema dialect: unsupported schemas fail closed before Ajv sees them', () => {
  it('admits the five authoritative initial schemas', () => {
    for (const name of INITIAL_COHORT) expect(runtimeDialectProblems(schemaOf(name)), name).toEqual([]);
  });

  const refused: [string, unknown][] = [
    ['format (Ajv would ignore it silently)', { type: 'string', format: 'email' }],
    ['$ref', { type: 'object', properties: { a: { $ref: '#/definitions/x' } } }],
    ['$schema', { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object' }],
    ['$id', { $id: 'https://example.invalid/s', type: 'object' }],
    ['allOf', { allOf: [{ type: 'string' }] }],
    ['anyOf', { anyOf: [{ type: 'string' }] }],
    ['not', { type: 'string', not: { const: 'a' } }],
    ['if/then', { type: 'string', if: { const: 'a' }, then: { maxLength: 1 } }],
    ['patternProperties', { type: 'object', patternProperties: { '^a': { type: 'string' } } }],
    ['prefixItems', { type: 'array', prefixItems: [{ type: 'string' }] }],
    ['uniqueItems', { type: 'array', items: { type: 'string' }, uniqueItems: true }],
    ['dependentRequired', { type: 'object', dependentRequired: { a: ['b'] } }],
    ['nested unknown keyword', { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string', contentEncoding: 'base64' } } } } }],
    ['tuple items', { type: 'array', items: [{ type: 'string' }] }],
    ['boolean subschema', { type: 'object', properties: { a: true } }],
    ['unknown type', { type: 'date' }],
    ['empty type list', { type: [] }],
    ['repeated type', { type: ['string', 'string'] }],
    ['no type, enum, const or oneOf', { description: 'x' }],
    ['fractional minLength', { type: 'string', minLength: 1.5 }],
    ['negative maxItems', { type: 'array', items: { type: 'string' }, maxItems: -1 }],
    ['non-finite maximum', { type: 'number', maximum: 'big' }],
    ['invalid unicode pattern', { type: 'string', pattern: '\\p{Nope}' }],
    ['empty enum', { enum: [] }],
    ['empty oneOf', { oneOf: [] }],
    ['repeated required', { type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'a'] }],
    ['__proto__ property', JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')],
    ['array schema', [{ type: 'string' }]],
  ];
  it.each(refused)('refuses %s', (_label, schema) => {
    expect(runtimeDialectProblems(schema).length).toBeGreaterThan(0);
    expect(() => compileInputValidator(schema)).toThrow(UnsupportedSchemaError);
  });

  it('refuses nesting deeper than 16 with the path', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 17; i++) schema = { type: 'object', properties: { a: schema } };
    expect(runtimeDialectProblems(schema).join('\n')).toContain('nested deeper than 16');
  });

  it('refuses a schema that is not plain JSON data', () => {
    expect(() => compileInputValidator({ type: 'object', properties: { a: { type: 'string', pattern: /x/ } } })).toThrow(UnsupportedSchemaError);
    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.properties = { self: cyclic };
    expect(() => compileInputValidator(cyclic)).toThrow(UnsupportedSchemaError);
  });

  it('refuses what Ajv strict mode rejects even inside the dialect', () => {
    // A string keyword on a number type is accepted by the dialect check and refused by strict types.
    expect(runtimeDialectProblems({ type: 'number', maxLength: 3 })).toEqual([]);
    expect(() => compileInputValidator({ type: 'number', maxLength: 3 })).toThrow(UnsupportedSchemaError);
  });

  it('compiles from a private copy: later changes to the caller schema do not change validation', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } as Record<string, unknown>;
    const v = compileInputValidator(schema);
    (schema.properties as Record<string, unknown>).b = { type: 'string' };
    schema.additionalProperties = true;
    expect(v.validateValue({ b: 'x' }).ok).toBe(false);
  });
});

type Case = [args: unknown, keyword: string | null];
/** Fixtures against the five actual schemas; keyword null means valid. */
const FIXTURES: Record<(typeof INITIAL_COHORT)[number], Case[]> = {
  get_map: [
    [{}, null],
    [{ session: 's-01', field: 'goal' }, null],
    [{ room: 'r-1', field: 'messages', kind: 'decision', cursor: 'c', maxBytes: 2048 }, null],
    [{ maxBytes: 262144 }, null],
    [{ maxBytes: 2047 }, 'minimum'],
    [{ maxBytes: 262145 }, 'maximum'],
    [{ maxBytes: 2048.5 }, 'type'],
    [{ maxBytes: '4096' }, 'type'],
    [{ field: 'nope' }, 'enum'],
    [{ kind: 'Note' }, 'enum'],
    [{ session: 1 }, 'type'],
    [{ session: 's-01', token: SECRET }, 'additionalProperties'],
    [[], 'type'],
    [null, 'type'],
  ],
  read_room: [
    [{ room: 'r-1' }, null],
    [{ room: 'r-1', limit: 2.5, cursor: 'c', maxBytes: 65536 }, null],
    [{ room: 'r-1', extra: SECRET }, null],
    [{}, 'required'],
    [{ limit: 5 }, 'required'],
    [{ room: 1 }, 'type'],
    [{ room: 'r-1', limit: '5' }, 'type'],
    [{ room: 'r-1', maxBytes: 1 }, 'minimum'],
  ],
  read_guide: [
    [{}, null],
    [{ topic: 'plans' }, null],
    [{ topic: 'Plans' }, 'enum'],
    [{ topic: SECRET }, 'enum'],
    [{ topic: 'plans', extra: 1 }, 'additionalProperties'],
  ],
  list_roles: [
    [{}, null],
    [{ anything: [1, { b: SECRET }] }, null],
    [[], 'type'],
    ['x', 'type'],
  ],
  backlog_list: [
    [{}, null],
    [{ filter: 'all', text: 'x'.repeat(4096) }, null],
    [{ text: '😀'.repeat(4096) }, null],
    [{ text: 'x'.repeat(4097) }, 'maxLength'],
    [{ text: '😀'.repeat(4097) }, 'maxLength'],
    [{ filter: 'ALL' }, 'enum'],
    [{ filter: null }, 'type'],
    [{ text: SECRET, other: SECRET }, 'additionalProperties'],
  ],
};

describe('input validators on the five actual schemas', () => {
  for (const name of INITIAL_COHORT) {
    it(`${name}: exact JSON Schema semantics for values and for text`, () => {
      const v = compileInputValidator(schemaOf(name));
      for (const [args, keyword] of FIXTURES[name]) {
        const label = `${name} ${JSON.stringify(args).slice(0, 60)}`;
        for (const r of [v.validateValue(args), v.validateText(JSON.stringify(args))]) {
          if (keyword === null) {
            expect(r, label).toEqual({ ok: true, text: JSON.stringify(args), value: args });
          } else {
            expect(r.ok, label).toBe(false);
            if (r.ok) continue;
            expect(r.failure.kind, label).toBe('schema');
            if (r.failure.kind !== 'schema') continue;
            expect(r.failure.issues.map((i) => i.keyword), label).toContain(keyword);
            expect(JSON.stringify(r), label).not.toContain('SYNTHETIC');
          }
        }
      }
    });
  }

  it('applies no default, removes no property and coerces nothing', () => {
    const backlog = compileInputValidator(schemaOf('backlog_list'));
    const empty = Object.freeze({});
    expect(backlog.validateValue(empty)).toEqual({ ok: true, text: '{}', value: {} });
    expect(empty).toEqual({});
    const room = compileInputValidator(schemaOf('read_room'));
    const open = Object.freeze({ room: 'r-1', extra: 1 });
    const r = room.validateValue(open);
    expect(r.ok && r.value).toEqual({ room: 'r-1', extra: 1 });
    expect(room.validateValue({ room: 'r-1', limit: '5' }).ok).toBe(false);
    expect(room.validateValue({ room: 'r-1', limit: true }).ok).toBe(false);
  });

  it('refuses non-JSON arguments in the JSON layer before schema checks', () => {
    const v = compileInputValidator(schemaOf('list_roles'));
    const cyclic: Record<string, unknown> = {};
    cyclic.c = cyclic;
    const cases: [unknown, string][] = [[cyclic, 'cycle'], [{ n: NaN }, 'number'], [{ f: () => SECRET }, 'not-json'], [{ b: 1n }, 'not-json'], [new Date(), 'not-json'], [JSON.parse('{"__proto__":{}}'), 'key']];
    for (const [args, code] of cases) {
      const r = v.validateValue(args);
      expect(r).toMatchObject({ ok: false, failure: { kind: 'json', code } });
      expect(JSON.stringify(r)).not.toContain('SYNTHETIC');
    }
    expect(v.validateText('{"a":1,"a":2}')).toMatchObject({ ok: false, failure: { kind: 'json', code: 'duplicate-key' } });
    expect(v.validateText(`{"t":"${SECRET}","t":1}`)).not.toHaveProperty('failure.at', expect.stringContaining('SYNTHETIC'));
  });

  it('bounds call arguments at 64 KiB exactly, before and after serialization', () => {
    const v = compileInputValidator(schemaOf('list_roles'));
    const at = (n: number) => ({ a: 'x'.repeat(n) }); // serialized: n + 8 bytes
    expect(v.validateValue(at(65536 - 8)).ok).toBe(true);
    expect(v.validateValue(at(65536 - 7))).toMatchObject({ ok: false, failure: { kind: 'json', code: 'bytes' } });
    expect(v.validateText(JSON.stringify(at(65536 - 8))).ok).toBe(true);
    expect(v.validateText(JSON.stringify(at(65536 - 7)))).toMatchObject({ ok: false, failure: { kind: 'json', code: 'bytes' } });
  });

  it('stops at the first schema error (bounded work) and reports at most 8 issues', () => {
    const props = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, { type: 'string' }]));
    const v = compileInputValidator({ type: 'object', properties: props, required: Object.keys(props) });
    const r = v.validateValue({});
    expect(r).toMatchObject({ ok: false, failure: { kind: 'schema', issuesTruncated: false } });
    if (!r.ok && r.failure.kind === 'schema') expect(r.failure.issues).toHaveLength(1);
  });
});

describe('the validated text is the single source of truth (s-292 D1/D2)', () => {
  const room = () => compileInputValidator(schemaOf('read_room'));
  const withPollution = (target: object, key: string, desc: PropertyDescriptor, fn: () => void): void => {
    Object.defineProperty(target, key, { ...desc, configurable: true });
    try { fn(); } finally { delete (target as Record<string, unknown>)[key]; }
  };

  it('returns a frozen copy, never the caller object; changing the caller object later changes nothing', () => {
    const args = { room: 'r-1', extra: { list: [1, 2] } };
    const r = room().validateValue(args);
    if (!r.ok) throw new Error('expected ok');
    expect(r.value).not.toBe(args);
    expect(Object.isFrozen(r) && Object.isFrozen(r.value) && Object.isFrozen((r.value as { extra: { list: unknown[] } }).extra.list)).toBe(true);
    args.room = 'x'.repeat(100_000);
    args.extra.list.push(3);
    (args as Record<string, unknown>).more = 1;
    expect(r.text).toBe('{"room":"r-1","extra":{"list":[1,2]}}');
    expect(r.value).toEqual({ room: 'r-1', extra: { list: [1, 2] } });
    expect(() => { (r.value as { room: string }).room = 'x'; }).toThrow(TypeError);
  });

  it('validateText returns the input text unchanged and a frozen value', () => {
    const text = '{"room":"r-1", "limit":2}';
    const r = room().validateText(text);
    expect(r).toEqual({ ok: true, text, value: { room: 'r-1', limit: 2 } });
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });

  it('an inherited Object.prototype.toJSON cannot change the emitted text', () => {
    withPollution(Object.prototype, 'toJSON', { value() { return { room: 'evil-overlong-room-name' }; }, writable: true }, () => {
      const r = room().validateValue({ room: 'r-25' });
      expect(r).toMatchObject({ ok: true, text: '{"room":"r-25"}' });
      expect(serializeStrict({ a: [1, { b: 'c' }] }, ARG_LIMITS)).toBe('{"a":[1,{"b":"c"}]}');
    });
  });

  it('an inherited Array.prototype.toJSON cannot change the emitted text', () => {
    withPollution(Array.prototype, 'toJSON', { value() { return 'evil'; }, writable: true }, () => {
      expect(serializeStrict({ a: [1, [2]] }, ARG_LIMITS)).toBe('{"a":[1,[2]]}');
      const v = compileInputValidator(schemaOf('list_roles'));
      expect(v.validateValue({ a: [1] })).toMatchObject({ ok: true, text: '{"a":[1]}' });
    });
  });

  it('an inherited setter is never invoked while parsing', () => {
    let calls = 0;
    withPollution(Object.prototype, 'room', { set() { calls++; } }, () => {
      const r = room().validateText('{"room":"r-1"}');
      expect(r.ok && Object.hasOwn(r.value as object, 'room')).toBe(true);
      expect(parseStrictJson('[{"room":"x"}]', ARG_LIMITS)).toEqual([{ room: 'x' }]);
    });
    withPollution(Array.prototype, '0', { set() { calls++; } }, () => {
      expect(Object.hasOwn(parseStrictJson('[7]', ARG_LIMITS) as object, '0')).toBe(true);
    });
    expect(calls).toBe(0);
  });

  it('an inherited "value" does not make an accessor look like data, and the getter is not called', () => {
    let calls = 0;
    // Built before the pollution: with an inherited `value`, defining an accessor would itself throw.
    const obj = Object.defineProperty({}, 'room', { get: () => { calls++; return 'r-1'; }, enumerable: true });
    const arr = Object.defineProperty([0], 0, { get: () => { calls++; return 1; }, enumerable: true });
    withPollution(Object.prototype, 'value', { value: 'r-1', writable: true }, () => {
      expect(valueCode(obj)).toBe('not-json');
      expect(valueCode(arr)).toBe('not-json');
    });
    expect(calls).toBe(0);
  });

  it('escape lookup ignores inherited properties (W1)', () => {
    withPollution(Object.prototype, 'x', { value: 'X', writable: true }, () => {
      expect(textCode('"\\x41"')).toBe('syntax');
      expect(parseStrictJson('"\\n"', ARG_LIMITS)).toBe('\n');
    });
  });

  it('text and value always agree: revalidating the emitted text yields the same value', () => {
    for (const name of INITIAL_COHORT) {
      const v = compileInputValidator(schemaOf(name));
      for (const [args, keyword] of FIXTURES[name]) {
        if (keyword !== null) continue;
        const a = v.validateValue(args);
        const b = a.ok ? v.validateText(a.text) : a;
        expect(b, name).toEqual(a);
      }
    }
  });

  it('canonicalStrict sorts keys and equals the catalogue canonical form on plain data', () => {
    const v = { b: [1, { d: 1, c: 2 }], a: 'x' };
    expect(canonicalStrict(v, ARG_LIMITS)).toBe('{"a":"x","b":[1,{"c":2,"d":1}]}');
    expect(canonicalStrict(v, ARG_LIMITS)).toBe(canonicalJson(v));
  });

  it('freezeJson returns the exact text and a deeply frozen parsed copy', () => {
    const src = { a: [{ b: 1 }] };
    const r = freezeJson(src, ARG_LIMITS);
    expect(r).toEqual({ text: '{"a":[{"b":1}]}', value: src });
    expect(Object.isFrozen((r.value as { a: object[] }).a[0])).toBe(true);
    expect(Object.isFrozen(src)).toBe(false);
  });
});

describe('limits are an owned snapshot (s-294 C)', () => {
  it('mutating the caller limits after compile changes neither behaviour nor identity', () => {
    const limits = { maxBytes: 10, maxDepth: 4, maxNodes: 10 };
    const v = compileInputValidator(schemaOf('list_roles'), limits);
    const hash = v.schemaSha256;
    expect(v.validateValue({ a: 'long value' }).ok).toBe(false);
    limits.maxBytes = 100;
    limits.maxDepth = 100;
    expect(v.validateValue({ a: 'long value' }).ok).toBe(false);
    expect(v.validateText('{"a":"long value"}').ok).toBe(false);
    expect(v.limits).toEqual({ maxBytes: 10, maxDepth: 4, maxNodes: 10 });
    expect(Object.isFrozen(v.limits)).toBe(true);
    expect(v.schemaSha256).toBe(hash);
  });

  it('mutating the caller schema after compile changes neither behaviour nor hash', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } as Record<string, unknown>;
    const v = compileInputValidator(schema);
    const hash = v.schemaSha256;
    schema.additionalProperties = true;
    expect(v.validateValue({ b: 1 }).ok).toBe(false);
    expect(v.schemaSha256).toBe(hash);
  });

  it('refuses limits that are not positive safe integers', () => {
    for (const bad of [{ maxBytes: 0, maxDepth: 1, maxNodes: 1 }, { maxBytes: 1.5, maxDepth: 1, maxNodes: 1 }, { maxBytes: 1, maxDepth: NaN, maxNodes: 1 }, { maxBytes: 1, maxDepth: 1 }]) {
      expect(() => compileInputValidator({ type: 'object' }, bad as JsonLimits)).toThrow(UnsupportedSchemaError);
    }
    expect(snapshotLimits(ARG_LIMITS)).toEqual(ARG_LIMITS);
  });
});

describe('vetted pattern subset (W3): structure, not timing', () => {
  const catalogPatterns = (): string[] => {
    const found: string[] = [];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x !== null && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === 'pattern' && typeof v === 'string') found.push(v); walk(v); }
    };
    for (const t of [...TOOLS, ...createBrowserTools({ url: 'http://127.0.0.1:1', token: 'x' }, {}).tools, CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL, CREATE_SWARM_TOOL, SWARM_ADD_TOOL]) walk(t.inputSchema);
    return found;
  };

  it('admits every pattern in the actual catalogue (41 across the 49 tools of a full agent launch at this base)', () => {
    const all = catalogPatterns();
    // 36 at c15017db plus exactly five new ones, one each in plan_progress, plan_tasks, backlog_take, report and browser_close
    expect(all).toHaveLength(41);
    for (const p of new Set(all)) expect(patternProblem(p), p).toBeNull();
    for (const name of INITIAL_COHORT) expect(JSON.stringify(schemaOf(name))).not.toContain('"pattern"');
  });

  const refused: [string, string][] = [
    ['^(a+)+$', 'quantified group'],
    ['(a+)+$', 'not anchored with ^'],
    ['a+', 'not anchored with ^'],
    ['^(a|a)*$', 'quantified group'],
    ['^(?:a|b)+$', 'quantified group'],
    ['^a+a+$', 'more than one unbounded quantifier'],
    ['^\\d*\\d*$', 'more than one unbounded quantifier'],
    ['^a{2,}b+$', 'more than one unbounded quantifier'],
    ['^(a)\\1$', 'escape'],
    ['^(?=a)a$', 'lookaround or named group'],
    ['^(?<n>a)$', 'lookaround or named group'],
    ['^a{1,1000}$', 'quantifier'],
    ['^a{1,129}$', 'bound'],
    ['^a{0,64}b{0,64}$', 'too many bounded choices'],
    ['^a+?$', 'lazy or possessive quantifier'],
    ['^[[a]]$', 'nested class'],
    ['^\\p{L}+$', 'escape'],
    ['^\\bword$', 'escape'],
    ['^a$b', '$ before the end'],
    ['^(?:(a))$', 'nested group'],
    ['^a|b$', 'alternation outside a group'],
    ['^(a', 'unterminated group'],
  ];
  it.each(refused)('refuses %s (%s)', (p, why) => {
    expect(patternProblem(p)).toBe(why);
    expect(runtimeDialectProblems({ type: 'string', pattern: p }).join('\n')).toContain('outside the vetted pattern subset');
    expect(() => compileInputValidator({ type: 'string', pattern: p })).toThrow(UnsupportedSchemaError);
  });

  it('admits the protocol and sample anchored patterns', () => {
    for (const p of ['^[a-z][a-z0-9_]{0,63}$', '^[0-9a-f]{64}$', '^cm1\\.[0-9a-f]{64}$', '^[A-Za-z0-9._:-]{1,128}$', '^(?:[a-f0-9]{40}|[a-f0-9]{64})$', '^(s-[0-9]+|engine)$', '^/', '^\\/', '^m-\\d{3,}$']) {
      expect(patternProblem(p), p).toBeNull();
    }
  });
});
