import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createBrowserTools } from '../browser-tools.js';
import { CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL } from '../session-tools.js';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from '../swarm-tools.js';
import { TOOLS } from '../tools.js';
import {
  GENERATOR_PINS,
  MAX_DEPTH,
  UnsupportedSchemaError,
  checkNames,
  generateDeclarations,
  inspectDescriptors,
  nameProblems,
  preflightSchema,
  openOutputNodes,
  scanOutputWidening,
  scanWidening,
  type ToolDescriptor,
} from './types.js';

const tool = (name: string, inputSchema: Record<string, unknown>): ToolDescriptor => ({ name, description: `${name} fixture`, inputSchema });
const pascal = (name: string): string => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^[a-z]/, (c) => c.toUpperCase());

/** The declared Input alias of one generated tool, comments and whitespace folded. */
function inputOf(text: string, name: string): string {
  const m = new RegExp(`^type ${pascal(name)}Input = ([\\s\\S]*?)\\ntype `, 'm').exec(text);
  return (m?.[1] ?? '<missing>').replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

/** Strict in-memory compilation plus a TypeScript-AST count of unknown/any inside *Input aliases (Record<string, unknown> counted apart). */
function compile(text: string): { diagnostics: string[]; widened: number; openRecords: number; lexerWidened: number; lexerOpen: number } {
  const file = 'gen.d.ts';
  const options: ts.CompilerOptions = { strict: true, noEmit: true, types: [], lib: ['lib.es2022.d.ts'] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) => (name === file ? ts.createSourceFile(file, text, lang, true) : original(name, lang));
  const program = ts.createProgram([file], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  const sf = program.getSourceFile(file)!;
  let widened = 0; let openRecords = 0; let lexerWidened = 0; let lexerOpen = 0;
  sf.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || !node.name.text.endsWith('Input')) return;
    const walk = (n: ts.Node): void => {
      if (n.kind === ts.SyntaxKind.UnknownKeyword || n.kind === ts.SyntaxKind.AnyKeyword) {
        const p = n.parent;
        const inOpenRecord = ts.isTypeReferenceNode(p) && p.typeName.getText(sf) === 'Record' && p.typeArguments?.length === 2 && p.typeArguments[0]!.kind === ts.SyntaxKind.StringKeyword && p.typeArguments[1] === n;
        if (inOpenRecord) openRecords++; else widened++;
      }
      n.forEachChild(walk);
    };
    walk(node.type);
    const lex = scanWidening(node.type.getText(sf));
    lexerWidened += lex.widened; lexerOpen += lex.openRecords;
  });
  return { diagnostics, widened, openRecords, lexerWidened, lexerOpen };
}

describe('generator pins', () => {
  it('are exactly the accepted T2a pins in the core package manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    for (const [name, version] of Object.entries(GENERATOR_PINS)) expect(manifest.dependencies[name], name).toBe(version);
  });
});

describe('admitted shapes generate exact declarations', () => {
  const positives: [string, Record<string, unknown>, string][] = [
    ['required_and_optional', { type: 'object', properties: { a: { type: 'string', pattern: '^s-\\d+$', minLength: 1, maxLength: 9 }, b: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['a'], additionalProperties: false }, '{ a: string; b?: number; }'],
    ['enum_const_nullable', { type: 'object', properties: { e: { type: 'string', enum: ['x', 'y'] }, c: { const: 1 }, n: { type: ['string', 'null'] } }, required: ['e', 'c'] }, '{ e: "x" | "y"; c: 1; n?: string | null; }'],
    ['oneof_string_or_array', { type: 'object', properties: { to: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 3 }] } } }, '{ to?: string | string[]; }'],
    ['nested_objects_arrays', { type: 'object', properties: { steps: { type: 'array', minItems: 1, items: { type: 'object', properties: { step: { type: 'string' }, status: { type: 'string', enum: ['pending', 'done'] }, tags: { type: 'array', items: { type: 'string' } } }, required: ['step', 'status'], additionalProperties: false } } }, required: ['steps'] }, '{ steps: { step: string; status: "pending" | "done"; tags?: string[]; }[]; }'],
    ['record_values', { type: 'object', properties: { env: { type: 'object', additionalProperties: { type: 'string' } } } }, '{ env?: { [key: string]: string; }; }'],
    ['empty_object', { type: 'object', properties: {}, additionalProperties: false }, '{}'],
    ['default_boolean', { type: 'object', properties: { f: { type: 'boolean', default: false } } }, '{ f?: boolean; }'],
    ['open_empty_object', { type: 'object', properties: {} }, 'Record<string, unknown>'],
    ['nested_open_object', { type: 'object', properties: { meta: { type: 'object' } }, required: ['meta'] }, '{ meta: Record<string, unknown>; }'],
    // String literals "unknown"/"any" are values and property keys named so are keys: neither is a widened type.
    ['enum_literals_unknown_any', { type: 'object', properties: { e: { type: 'string', enum: ['unknown', 'any'] } }, required: ['e'] }, '{ e: "unknown" | "any"; }'],
    ['property_keys_unknown_any', { type: 'object', properties: { unknown: { type: 'string' }, any: { type: 'number' } }, additionalProperties: false }, '{ unknown?: string; any?: number; }'],
    ['integer_enum', { type: 'object', properties: { n: { type: 'integer', enum: [1, 2] } } }, '{ n?: 1 | 2; }'],
    // Non-union array items stay admitted.
    ['items_single_enum', { type: 'object', properties: { v: { type: 'array', items: { enum: ['a'] } } } }, '{ v?: "a"[]; }'],
    ['nested_arrays', { type: 'object', properties: { v: { type: 'array', items: { type: 'array', items: { type: 'string' } } } } }, '{ v?: string[][]; }'],
    ['oneof_null_branch', { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'null' }] } } }, '{ v?: string | null; }'],
    ['nullable_enum', { type: 'object', properties: { v: { type: ['string', 'null'], enum: ['a', null] } } }, '{ v?: "a" | null; }'],
    // oneOf alone may carry description/default siblings.
    ['oneof_with_description', { type: 'object', properties: { v: { description: 'either', default: 'x', oneOf: [{ type: 'string' }, { type: 'number' }] } } }, '{ v?: string | number; }'],
    ['shared_subschema', (() => { const s = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }; return { type: 'object', properties: { a: s, b: { type: 'array', items: s } } }; })(), '{ a?: { id: string; }; b?: { id: string; }[]; }'],
  ];

  for (const [name, schema, expected] of positives) {
    it(`${name}`, () => {
      const toolName = `fx_${name}`;
      const text = generateDeclarations([tool(toolName, schema)]);
      expect(inputOf(text, toolName)).toBe(expected);
      const c = compile(text);
      expect(c.diagnostics).toEqual([]);
      expect(c.widened).toBe(0);
      expect(c.widened).toBe(c.lexerWidened);
      expect(c.openRecords).toBe(c.lexerOpen);
    });
  }

  it('keeps every output unknown and declares nothing executable', () => {
    const text = generateDeclarations([tool('fx_out', { type: 'object', properties: {} })]);
    expect(text).toContain('type FxOutOutput = unknown');
    expect(text).toContain('declare const parley: {');
    expect(text).not.toMatch(/execute/i);
  });
});

describe('declared outputs (plan T6c)', () => {
  const closed = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const withOutput = (outputSchema: Record<string, unknown>) => ({ ...tool('fx_out', { type: 'object', properties: {} }), outputSchema });
  const OPEN = { type: 'object', additionalProperties: true };

  it('renders the schema, with its open nodes counted, and compiles', () => {
    const text = generateDeclarations([withOutput(closed({ a: { type: 'string' }, unknownFields: OPEN }))]);
    expect(text).not.toContain('type FxOutOutput = unknown');
    expect(text).toMatch(/type FxOutOutput = \{[\s\S]*a: string;[\s\S]*\[key: string\]: unknown;/);
    expect(compile(text).diagnostics).toEqual([]);
  });

  it('a method without a schema still promises nothing, next to one with a schema', () => {
    const text = generateDeclarations([withOutput(closed({ a: { type: 'string' } })), tool('fx_plain', { type: 'object', properties: {} })]);
    expect(text).toContain('type FxPlainOutput = unknown');
    expect(text).not.toContain('type FxOutOutput = unknown');
  });

  it('preflights the output schema like an input, naming its path: union array items, nullable objects, unknown keywords', () => {
    const refused = (schema: Record<string, unknown>, match: RegExp): void => {
      expect(() => generateDeclarations([withOutput(schema)])).toThrow(UnsupportedSchemaError);
      expect(() => generateDeclarations([withOutput(schema)])).toThrow(match);
    };
    refused(closed({ a: { type: 'array', items: { oneOf: [{ type: 'null' }, { type: 'string' }] } } }), /fx_out\.outputSchema\.properties\.a\.items: union-valued/);
    refused(closed({ a: { type: ['object', 'null'], properties: {} } }), /fx_out\.outputSchema\.properties\.a/);
    refused(closed({ a: { type: 'string', format: 'date' } }), /fx_out\.outputSchema\.properties\.a: unsupported keyword "format"/);
  });

  it('refuses widening the schema did not spell out: an open object without additionalProperties renders as a Record', () => {
    expect(() => generateDeclarations([withOutput(closed({ a: { type: 'object' } }))])).toThrow(/type FxOutOutput: widened to unknown\/any/);
  });

  it('counts open nodes exactly as the generator renders them', () => {
    const schema = { oneOf: [closed({ ok: { const: true }, unknownFields: OPEN, list: { type: 'array', items: OPEN } }), closed({ ok: { const: false }, result: { type: 'object', properties: { isError: { const: true } }, required: ['isError'], additionalProperties: true } })] };
    expect(openOutputNodes(schema)).toBe(3);
    const text = generateDeclarations([withOutput(schema)]);
    const body = /^type FxOutOutput = ([\s\S]*?)(?=^declare const )/m.exec(text)![1]!;
    expect(scanOutputWidening(body)).toEqual({ widened: 0, openIndexes: 3 });
    expect(compile(text).diagnostics).toEqual([]);
  });

  it('the lexer tells an open index from widening: comments, literals and property names do not count', () => {
    expect(scanOutputWidening('{ /** unknown any */ a: "unknown" | \'any\'; unknown?: string; any: number; [key: string]: unknown; }')).toEqual({ widened: 0, openIndexes: 1 });
    expect(scanOutputWidening('{ b: unknown; c: any; d: Record<string, unknown>; [other: string]: unknown; }')).toEqual({ widened: 4, openIndexes: 0 });
  });
});

describe('unsupported shapes are refused before generation, with their path', () => {
  const deep = (): Record<string, unknown> => { let x: Record<string, unknown> = { type: 'string' }; for (let i = 0; i < 25; i++) x = { type: 'object', properties: { n: x } }; return x; };
  const negatives: [string, Record<string, unknown>, RegExp][] = [
    ['ref_in_oneof_in_items', { type: 'object', properties: { a: { type: 'array', items: { oneOf: [{ type: 'string' }, { $ref: '#/$defs/X' }] } } } }, /a\.items\.oneOf\[1\]: unsupported keyword "\$ref"/],
    ['recursive_ref', { type: 'object', properties: { node: { $ref: '#' } } }, /node: unsupported keyword "\$ref"/],
    ['allof_nested', { type: 'object', properties: { o: { type: 'object', allOf: [{ type: 'object' }] } } }, /o: unsupported keyword "allOf"/],
    ['anyof', { type: 'object', properties: { v: { anyOf: [{ type: 'string' }] } } }, /v: unsupported keyword "anyOf"/],
    ['not', { type: 'object', properties: { v: { not: { type: 'string' } } } }, /v: unsupported keyword "not"/],
    ['if_then', { type: 'object', properties: { a: { type: 'string' } }, if: { required: ['a'] }, then: { required: ['a'] } }, /unsupported keyword "if"/],
    ['pattern_properties', { type: 'object', patternProperties: { '^x-': { type: 'string' } } }, /unsupported keyword "patternProperties"/],
    ['prefix_items', { type: 'object', properties: { t: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'string' } } } }, /t: unsupported keyword "prefixItems"/],
    ['tuple_items_array', { type: 'object', properties: { t: { type: 'array', items: [{ type: 'string' }] } } }, /t\.items: schema must be an object/],
    ['unknown_type', { type: 'object', properties: { d: { type: 'decimal' } } }, /d: unknown type "decimal"/],
    ['no_type_deep', { type: 'object', properties: { o: { type: 'object', properties: { x: {} } } } }, /o\.properties\.x: needs "type"/],
    ['enum_of_objects', { type: 'object', properties: { e: { enum: [{ a: 1 }] } } }, /e\.enum: must be a non-empty array of primitives/],
    ['required_missing_property', { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] }, /required: "b" is not a declared property/],
    ['array_without_items', { type: 'object', properties: { l: { type: 'array' } } }, /l: array without "items"/],
    ['format_keyword', { type: 'object', properties: { u: { type: 'string', format: 'uri' } } }, /u: unsupported keyword "format"/],
    ['proto_property', JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}') as Record<string, unknown>, /unsafe property name "__proto__"/],
    ['constructor_property', { type: 'object', properties: { constructor: { type: 'string' } } }, /unsafe property name "constructor"/],
    ['quoted_property', { type: 'object', properties: { 'a-b': { type: 'string' } } }, /unsafe property name "a-b"/],
    ['top_level_not_object', { type: 'string' }, /input schema must have type "object"/],
    // const/enum, additionalProperties, type mismatches
    ['const_with_enum', { type: 'object', properties: { v: { type: 'string', const: 'x', enum: ['x', 'y'] } } }, /v: interacting keywords "const" and "enum"/],
    ['typed_property_with_additional_schema', { type: 'object', properties: { n: { type: 'number' } }, additionalProperties: { type: 'string' } }, /additionalProperties: schema together with declared properties/],
    ['enum_value_type_mismatch', { type: 'object', properties: { v: { type: 'string', enum: [1] } } }, /v\.enum: value 1 does not match type/],
    ['integer_enum_fraction', { type: 'object', properties: { v: { type: 'integer', enum: [1.5] } } }, /v\.enum: value 1\.5 does not match type/],
    ['const_type_mismatch', { type: 'object', properties: { v: { type: 'string', const: 1 } } }, /v\.const: value 1 does not match type/],
    ['pattern_on_number', { type: 'object', properties: { v: { type: 'number', pattern: 'x' } } }, /v: "pattern" needs type string/],
    ['items_on_string', { type: 'object', properties: { v: { type: 'string', items: { type: 'string' } } } }, /v: "items" needs type array/],
    ['properties_on_array', { type: 'object', properties: { v: { type: 'array', items: { type: 'string' }, properties: {} } } }, /v: "properties" needs type object/],
    // oneOf siblings
    ['oneof_with_type', { type: 'object', properties: { v: { type: 'string', oneOf: [{ type: 'string' }] } } }, /v: "oneOf" cannot be combined with "type"/],
    ['oneof_structural_siblings_top', { type: 'object', properties: { must: { type: 'string' } }, required: ['must'], oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] }, /inputSchema: "oneOf" cannot be combined with "properties"/],
    ['oneof_structural_siblings_nested', { type: 'object', properties: { o: { type: 'object', properties: { must: { type: 'string' } }, required: ['must'], oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }] } } }, /o: "oneOf" cannot be combined with "required"/],
    // nullable objects
    ['type_array_with_object', { type: 'object', properties: { v: { type: ['object', 'null'], properties: {} } } }, /v: type arrays may contain only primitive types/],
    ['nullable_object_nested', { type: 'object', properties: { o: { type: ['object', 'null'], properties: { n: { type: 'string' } } } } }, /o: type arrays may contain only primitive types/],
    ['nullable_object_in_items', { type: 'object', properties: { l: { type: 'array', items: { type: 'object', properties: { o: { type: ['object', 'null'], properties: {} } } } } } }, /l\.items\.properties\.o: type arrays may contain only primitive types/],
    // union array items at every nesting level (the generator would print "a" | "b"[])
    ['union_enum_items', { type: 'object', properties: { xs: { type: 'array', items: { enum: ['a', 'b'] } } } }, /xs\.items: union-valued array items/],
    ['union_oneof_items', { type: 'object', properties: { xs: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } } } }, /xs\.items: union-valued array items/],
    ['union_nullable_items', { type: 'object', properties: { xs: { type: 'array', items: { type: ['string', 'null'] } } } }, /xs\.items: union-valued array items/],
    ['union_items_nested_in_oneof', { type: 'object', properties: { v: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }] } } }, /v\.oneOf\[1\]\.items: union-valued array items/],
    ['union_items_inner_array', { type: 'object', properties: { m: { type: 'array', items: { type: 'array', items: { enum: [1, 2] } } } } }, /m\.items\.items: union-valued array items/],
    ['deep_nesting', deep(), /nested deeper than 16/],
  ];

  for (const [name, schema, expected] of negatives) {
    it(`${name}`, () => {
      let error: unknown;
      try { generateDeclarations([tool(`fx_${name}`, schema)]); } catch (e) { error = e; }
      expect(error).toBeInstanceOf(UnsupportedSchemaError);
      expect((error as Error).message).toMatch(expected);
    });
  }

  it('reports every problem of one schema, not only the first', () => {
    const problems = preflightSchema({ type: 'object', properties: { a: { type: 'decimal' }, b: { $ref: '#' } } }, 'x');
    expect(problems).toEqual(['x.properties.a: unknown type "decimal"', 'x.properties.b: unsupported keyword "$ref"', 'x.properties.b: needs "type", "oneOf", "enum" or "const"']);
  });

  it('allows depth exactly MAX_DEPTH and refuses one more', () => {
    const nest = (levels: number): Record<string, unknown> => { let x: Record<string, unknown> = { type: 'string' }; for (let i = 0; i < levels; i++) x = { type: 'object', properties: { n: x } }; return x; };
    expect(preflightSchema(nest(MAX_DEPTH), 'x')).toEqual([]);
    expect(preflightSchema(nest(MAX_DEPTH + 1), 'x')).toHaveLength(1);
  });
});

describe('names are kept or refused, never renamed', () => {
  it.each([
    ['reserved word', ['delete'], /reserved or unsafe/],
    ['prototype name', ['constructor'], /reserved or unsafe/],
    ['inherited Object method', ['toString'], /lower snake case|reserved or unsafe/],
    ['__proto__', ['__proto__'], /lower snake case|reserved or unsafe/],
    ['dunder prefix', ['__x'], /lower snake case|reserved or unsafe/],
    ['dash', ['get-map'], /lower snake case/],
    ['camel case', ['getMap'], /lower snake case/],
    ['digit start', ['1map'], /lower snake case/],
    ['duplicate', ['get_map', 'get_map'], /duplicate name/],
  ])('%s', (_label, names, expected) => {
    expect(checkNames(names).some((p) => expected.test(p))).toBe(true);
  });

  it('accepts distinct lower snake case names, including ones that merely contain another', () => {
    expect(checkNames(['get_map', 'get_map_output', 'x', 'x_input'])).toEqual([]);
  });

  it('attributes a duplicate name to its tool (a Pascal type-name collision cannot arise between distinct lower snake names)', () => {
    const problems = nameProblems(['ab', 'ab']);
    expect(new Set(problems.map((p) => p.tool))).toEqual(new Set(['ab']));
    expect(nameProblems(['a_b', 'ab', 'a_b_c', 'a_bc']).filter((p) => p.message.includes('collides'))).toEqual([]);
  });

  it('refuses generation when any name is unsafe, naming the tool', () => {
    expect(() => generateDeclarations([tool('__proto__', { type: 'object', properties: {} })])).toThrow(/tool "__proto__"/);
    expect(() => generateDeclarations([tool('constructor', { type: 'object', properties: {} })])).toThrow(/reserved or unsafe/);
  });

  it('attributes problems to the right tool without filtering the rest', () => {
    const found = inspectDescriptors([tool('ok_tool', { type: 'object', properties: {} }), tool('bad_tool', { type: 'object', properties: { f: { $ref: '#' } } })]);
    expect([...found.keys()]).toEqual(['bad_tool']);
    expect(() => generateDeclarations([tool('ok_tool', { type: 'object', properties: {} }), tool('bad_tool', { type: 'object', properties: { f: { $ref: '#' } } })])).toThrow(UnsupportedSchemaError);
  });
});

describe('widening scan', () => {
  it('flags real keywords and ignores literals, comments and property keys', () => {
    const probe = scanWidening('{ /** unknown any */ a: "unknown" | \'any\'; unknown?: string; any: number; b: unknown; c: any[]; d: Record<string, unknown>; }');
    expect(probe).toEqual({ widened: 2, openRecords: 1 });
  });
});

describe('the real Parley tool lists', () => {
  const real: ToolDescriptor[] = [...TOOLS, ...createBrowserTools({ url: 'http://127.0.0.1:1', token: 'x' }, {}).tools, CREATE_SESSION_TOOL, REQUEST_AGENT_SWITCH_TOOL, CREATE_SWARM_TOOL, SWARM_ADD_TOOL].map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> }));

  it('generates for the initial five and for every tool except two known cases: the browser_action enum array and the report uniqueItems keyword', () => {
    const found = inspectDescriptors(real);
    expect([...found.keys()].sort()).toEqual(['browser_action', 'report']);
    expect(found.get('browser_action')!.join('\n')).toContain('browser_action.inputSchema.properties.modifiers.items: union-valued array items');
    // report: the only problem is the keyword the generator cannot model; nothing is approximated or dropped
    expect(found.get('report')).toEqual(['report.inputSchema.properties.backlog: unsupported keyword "uniqueItems"']);
    for (const name of ['get_map', 'read_room', 'read_guide', 'list_roles', 'backlog_list']) expect(found.has(name), name).toBe(false);
    const supported = real.filter((d) => !found.has(d.name));
    const text = generateDeclarations(supported);
    for (const d of supported) expect(text).toContain(`\t${d.name}: (input: ${pascal(d.name)}Input) => Promise<${pascal(d.name)}Output>;`);
    expect(compile(text).diagnostics).toEqual([]);
  });

  it('refuses the whole list when browser_action or report is included: there is no silent filtering', () => {
    expect(() => generateDeclarations(real)).toThrow(/browser_action\.inputSchema\.properties\.modifiers\.items/);
    expect(() => generateDeclarations(real)).toThrow(/report\.inputSchema\.properties\.backlog: unsupported keyword "uniqueItems"/);
    expect(() => generateDeclarations(real.filter((d) => d.name !== 'browser_action'))).toThrow(/report\.inputSchema/);
  });
});
