// The output contract of the five initial read methods (plan T6c): the guest's declaration, the runtime check and the decoders
// must say the same thing. Values come from the REAL handlers over a temporary work; nothing here reaches a live work.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRoleCatalog } from '../../roles/catalog.js';
import { addBacklogItem } from '../../work/backlog.js';
import { addSession, transitionSession } from '../../work/map.js';
import { addRoom } from '../../work/rooms.js';
import { createWork, updateMap, workPaths } from '../../work/store.js';
import { HUMAN, type RoomPlan } from '../../work/types.js';
import type { McpContext } from '../context.js';
import { TOOLS, createToolRunner } from '../tools.js';
import { createOutputContract } from './broker.js';
import { buildCatalog, declarationsFor } from './catalog.js';
import { admitCall, compileCallValidators, computeApiRevision } from './contracts.js';
import { INVALID_OUTPUT_CODES, decodeBacklogList, decodeGetMap, decodeListRoles, decodeReadGuide, decodeReadRoom } from './read-adapters.js';
import { ADAPTER_FILE_SHA256, READ_ADAPTER_FILES, READ_OUTPUT_SCHEMAS, adapterRevisionFrom, adapterRevisionOf } from './read-output-schemas.js';
import { READ_DECODERS } from './read-adapter-table.js';
import { MIGRATABLE_READS } from './migration-registry.js';
import { openOutputNodes, preflightSchema, scanOutputWidening } from './types.js';
import { compileInputValidator, runtimeDialectProblems } from './validation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every schema node, with its path. */
function walk(schema: unknown, at: string, visit: (node: Record<string, unknown>, at: string) => void): void {
  if (!isRecord(schema)) return;
  visit(schema, at);
  if (isRecord(schema['properties'])) for (const [k, v] of Object.entries(schema['properties'])) walk(v, `${at}.${k}`, visit);
  if (isRecord(schema['additionalProperties'])) walk(schema['additionalProperties'], `${at}.*`, visit);
  if (isRecord(schema['items'])) walk(schema['items'], `${at}[]`, visit);
  if (Array.isArray(schema['oneOf'])) schema['oneOf'].forEach((m, i) => walk(m, `${at}|${i}`, visit));
}

describe('adapter pin and table', () => {
  it('each pin is the sha256 of its adapter file: a decoder edit is red until its file\'s pin moves, which moves apiRevision', () => {
    for (const [file, pin] of Object.entries(ADAPTER_FILE_SHA256)) {
      expect(createHash('sha256').update(readFileSync(path.join(here, file))).digest('hex'), file).toBe(pin);
    }
    for (const [method, files] of Object.entries(READ_ADAPTER_FILES)) {
      expect(adapterRevisionOf(method), method).toBe(files.map((f) => `${f}@${ADAPTER_FILE_SHA256[f]}`).join('+'));
    }
    expect(adapterRevisionOf('wait_for')).toBeUndefined();
    expect(adapterRevisionOf('toString')).toBeUndefined();
  });

  it('the five keep the B0 revision form byte for byte: one file, no join (T11 B0.2)', () => {
    for (const name of ['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room']) {
      expect(READ_ADAPTER_FILES[name], name).toEqual(['read-adapters.ts']);
      expect(adapterRevisionOf(name), name).toBe('read-adapters.ts@da6b22b222ee6dcfa47fb1873081aea98b213c4842a40d8eb74cdb12c2d70405');
    }
  });

  it('every method lists its own file first, then read-adapters.ts, which every decoder runs; the files are exactly the pinned ones', () => {
    for (const [method, files] of Object.entries(READ_ADAPTER_FILES)) {
      expect(Object.isFrozen(files), method).toBe(true);
      expect(files.at(-1), method).toBe('read-adapters.ts');
      expect(new Set(files).size, method).toBe(files.length);
      expect(files.length === 1 || (files.length === 2 && files[0] !== 'read-adapters.ts'), method).toBe(true);
    }
    expect(new Set(Object.values(READ_ADAPTER_FILES).flat())).toEqual(new Set(Object.keys(ADAPTER_FILE_SHA256)));
  });

  describe('a revision covers every file the decoding runs (fixture tables, T11 B0.2)', () => {
    const files = { fixture_read: ['read-adapters/fixture-read.ts', 'read-adapters.ts'], get_map: ['read-adapters.ts'] };
    const pins = { 'read-adapters/fixture-read.ts': 'own-1', 'read-adapters.ts': 'shared-1' };
    const rev = (m: string, p: Record<string, string> = pins, f: Record<string, string[]> = files) => (Object.hasOwn(f, m) ? adapterRevisionFrom(f[m]!, p) : undefined);

    it('joins each file\'s pin in list order', () => {
      expect(rev('fixture_read')).toBe('read-adapters/fixture-read.ts@own-1+read-adapters.ts@shared-1');
      expect(rev('get_map')).toBe('read-adapters.ts@shared-1');
    });

    it('a read-adapters.ts pin edit moves every method; an own-file pin edit moves only its method', () => {
      const shared = { ...pins, 'read-adapters.ts': 'shared-2' };
      expect(rev('fixture_read', shared)).not.toBe(rev('fixture_read'));
      expect(rev('get_map', shared)).not.toBe(rev('get_map'));
      const own = { ...pins, 'read-adapters/fixture-read.ts': 'own-2' };
      expect(rev('fixture_read', own)).not.toBe(rev('fixture_read'));
      expect(rev('get_map', own)).toBe(rev('get_map'));
    });

    it('a file without a pin, an empty list or an unknown method has no revision', () => {
      expect(rev('fixture_read', { 'read-adapters/fixture-read.ts': 'own-1' })).toBeUndefined();
      expect(rev('fixture_read', { 'read-adapters.ts': 'shared-1' })).toBeUndefined();
      expect(rev('fixture_read', pins, { fixture_read: [] })).toBeUndefined();
      expect(rev('send_message')).toBeUndefined();
      expect(rev('hasOwnProperty')).toBeUndefined();
    });
  });

  it('schemas, adapter files, decoders and the allowlist name the same methods', () => {
    const decoded = Object.keys(READ_OUTPUT_SCHEMAS).sort();
    expect(Object.keys(READ_ADAPTER_FILES).sort()).toEqual(decoded);
    expect(Object.keys(READ_DECODERS).sort()).toEqual(decoded);
    expect([...MIGRATABLE_READS].sort()).toEqual(decoded);
    expect(Object.isFrozen(READ_DECODERS)).toBe(true);
    expect(Object.isFrozen(READ_ADAPTER_FILES)).toBe(true);
    expect(Object.isFrozen(ADAPTER_FILE_SHA256)).toBe(true);
  });

  it('holds exactly the allowlisted reads, deeply frozen', () => {
    expect(Object.keys(READ_OUTPUT_SCHEMAS).sort()).toEqual([...MIGRATABLE_READS].sort());
    expect(Object.isFrozen(READ_OUTPUT_SCHEMAS)).toBe(true);
    for (const schema of Object.values(READ_OUTPUT_SCHEMAS)) walk(schema, '', (node) => expect(Object.isFrozen(node)).toBe(true));
  });

  it('declares exactly the decoders\' invalid-output codes', () => {
    for (const schema of Object.values(READ_OUTPUT_SCHEMAS)) {
      const failure = (schema['oneOf'] as Record<string, Record<string, Record<string, unknown>>>[])[1]!;
      const invalid = (failure['properties']!['error']!['oneOf'] as Record<string, Record<string, Record<string, unknown>>>[])[1]!;
      expect(invalid['properties']!['code']!['enum']).toEqual([...INVALID_OUTPUT_CODES]);
    }
  });
});

describe('static shape of the schemas', () => {
  it.each(Object.keys(READ_OUTPUT_SCHEMAS))('%s: the guard and the runtime dialect admit it, and it is compiled by the strict validator', (method) => {
    const schema = READ_OUTPUT_SCHEMAS[method]!;
    expect(preflightSchema(schema, method)).toEqual([]);
    expect(runtimeDialectProblems(schema)).toEqual([]);
    expect(() => compileInputValidator(schema)).not.toThrow();
  });

  it.each(Object.keys(READ_OUTPUT_SCHEMAS))('%s: every oneOf is discriminated, so a valid value cannot match two members', (method) => {
    const seen: string[] = [];
    walk(READ_OUTPUT_SCHEMAS[method], method, (node, at) => {
      if (!Array.isArray(node['oneOf'])) return;
      const members = node['oneOf'] as Record<string, unknown>[];
      // A null next to one object differs by type, with no `const` to carry.
      if (members.length === 2 && members[0]!['type'] === 'null' && members[1]!['type'] === 'object') { seen.push('nullable'); return; }
      const keys = members.map((m) => Object.entries(m['properties'] as Record<string, Record<string, unknown>>).filter(([, v]) => Object.hasOwn(v, 'const')).map(([k]) => k));
      const shared = keys[0]!.filter((k) => keys.every((list) => list.includes(k)));
      expect(shared.length, `${at}: no shared const discriminator`).toBeGreaterThan(0);
      const key = shared[0]!;
      const values = members.map((m) => (m['properties'] as Record<string, Record<string, unknown>>)[key]!['const']);
      expect(new Set(values).size, `${at}: discriminator values repeat`).toBe(members.length);
      for (const m of members) expect((m['required'] as string[]), `${at}: discriminator optional`).toContain(key);
      seen.push(key);
    });
    expect(seen).toContain('ok');
    expect(seen).toContain('kind');
    if (method === 'get_map') expect(seen).toContain('branch');
  });

  it.each(Object.keys(READ_OUTPUT_SCHEMAS))('%s: every object is closed, and only named nodes are open', (method) => {
    walk(READ_OUTPUT_SCHEMAS[method], method, (node, at) => {
      if (node['type'] !== 'object') return;
      if (node['additionalProperties'] === false || isRecord(node['additionalProperties'])) return;
      expect(node['additionalProperties'], at).toBe(true);
      expect(/\.unknownFields$|\.result$|\.(history|artifacts)\[\]$/.test(at), `${at}: open`).toBe(true);
    });
  });
});

describe('generated declarations', () => {
  const catalog = buildCatalog(TOOLS);
  const pascal = (name: string): string => name.split('_').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  const declarations = declarationsFor(catalog, [...MIGRATABLE_READS]);

  it.each([...MIGRATABLE_READS])('%s: no unknown or any except its counted open nodes', (method) => {
    const body = new RegExp(`^type ${pascal(method)}Output = ([\\s\\S]*?)(?=^type \\w+(?:Input|Output) = |^declare const )`, 'm').exec(declarations)![1]!;
    const { widened, openIndexes } = scanOutputWidening(body);
    expect(widened).toBe(0);
    expect(openIndexes).toBe(openOutputNodes(READ_OUTPUT_SCHEMAS[method]));
    expect(openIndexes).toBeGreaterThan(0);
  });

  /** Compiles declarations plus `extra`, importing the decoders' types from read-adapters.ts. */
  function diagnose(extra: string): string[] {
    const file = path.join(here, '__t6c_probe__.ts');
    const options: ts.CompilerOptions = { strict: true, noEmit: true, types: [], skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const host = ts.createCompilerHost(options);
    const text = `import type * as A from './read-adapters.js';\nimport type * as MR from './read-adapters/memory-read.js';\nimport type * as SH from './read-adapters/search-history.js';\nimport type * as AT from './read-adapters/attempt-status.js';\nimport type * as PT from './read-adapters/plan-tasks.js';\n${declarations}\n${extra}\nexport {};\n`;
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, lang) => (name === file ? ts.createSourceFile(file, text, lang, true) : original(name, lang));
    const exists = host.fileExists.bind(host);
    host.fileExists = (name) => name === file || exists(name);
    const read = host.readFile.bind(host);
    host.readFile = (name) => (name === file ? text : read(name));
    const program = ts.createProgram([file], options, host);
    return ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((d) => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }

  it('compile clean', { timeout: 120_000 }, () => {
    expect(diagnose('')).toEqual([]);
  });

  it('a consumer cannot read .value without narrowing on ok; it can after narrowing, and on branch', { timeout: 120_000 }, () => {
    expect(diagnose('declare const r: ReadGuideOutput; export const v = r.value;').join()).toContain("TS2339 Property 'value' does not exist on type 'ReadGuideOutput'");
    expect(diagnose('declare const r: GetMapOutput; export const v = r.error;').join()).toContain("TS2339 Property 'error' does not exist on type 'GetMapOutput'");
    expect(diagnose('declare const r: GetMapOutput; export const v = r.ok ? r.value.map : null;').join()).toContain('TS2339');
    expect(diagnose(`
      declare const g: ReadGuideOutput;
      export const text: string | null = g.ok ? g.value.text : null;
      declare const m: GetMapOutput;
      export const next: string | null = m.ok && m.value.branch === 'summaries' ? m.value.page.next : null;
      export const result: true | null = !m.ok && m.error.kind === 'tool-error' ? m.error.result.isError : null;
      export const code: string | null = !m.ok && m.error.kind === 'invalid-output' ? m.error.code : null;
      export const inert: unknown = !m.ok && m.error.kind === 'tool-error' ? m.error.result['content'] : null;
    `)).toEqual([]);
  });

  it('each decoder type and its declaration are the same type', { timeout: 120_000 }, () => {
    // Declarations are mutable and open nodes are `unknown`; `Same` maps a decoder type to that form and nothing else. A JSON
    // value is an object here by the rule on `history` and `artifacts`, which the runtime check enforces.
    const prelude = `
      type Open = { [key: string]: unknown };
      type IsJson<T> = [A.JsonObject] extends [T] ? ([T] extends [A.JsonObject] ? true : false) : false;
      type IsAny<T> = [boolean | number | string | null | A.JsonObject] extends [T] ? true : false;
      type Same<T> = IsJson<T> extends true ? Open : IsAny<T> extends true ? Open
        : T extends readonly (infer U)[] ? Same<U>[]
        : T extends object ? { -readonly [K in keyof T]: Same<T[K]> } : T;
      type OkOf<O> = Extract<O, { ok: true }> extends { value: infer V } ? V : never;
      declare function value<T>(): T;
      type Keys<T> = T extends object ? (T extends readonly (infer U)[] ? Keys<U> : { [K in keyof T & string]: K | \`\${K}.\${Keys<NonNullable<T[K]>> & string}\` }[keyof T & string]) : never;
    `;
    const pairs = [
      ['GetMapOutput', 'A.GetMapValue'],
      ['ReadRoomOutput', 'A.ReadRoomValue'],
      ['ReadGuideOutput', 'A.ReadGuideValue'],
      ['ListRolesOutput', 'A.ListRolesValue'],
      ['BacklogListOutput', 'A.BacklogListValue'],
      ['MemoryReadOutput', 'MR.MemoryReadValue'],
      ['SearchHistoryOutput', 'SH.SearchHistoryValue'],
      ['AttemptStatusOutput', 'AT.AttemptStatusValue'],
      ['PlanTasksOutput', 'PT.PlanTasksValue'],
    ];
    const checks = pairs.map(([out, dto], i) => `
      export const forward${i}: OkOf<${out}> = value<Same<${dto}>>();
      export const back${i}: Same<${dto}> = value<OkOf<${out}>>();
      export const keysA${i}: Keys<OkOf<${out}>> = value<Keys<Same<${dto}>>>();
      export const keysB${i}: Keys<Same<${dto}>> = value<Keys<OkOf<${out}>>>();
    `).join('\n');
    expect(diagnose(prelude + checks)).toEqual([]);
    // Control: the check can fail.
    expect(diagnose(`${prelude} export const wrong: OkOf<ReadGuideOutput> = value<{ text: number }>();`).join()).toContain('TS2322');
  });
});

describe('helper graph', () => {
  /** Every module this source can load at run time: static imports and exports (type-only ones erase), dynamic import and require. */
  const loads = (file: string): string[] => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) found.push((node.moduleSpecifier as ts.StringLiteral).text);
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined) found.push((node.moduleSpecifier as ts.StringLiteral).text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const target = node.arguments[0];
        // A computed target could be anything: this guard refuses to vouch for it.
        expect(target !== undefined && ts.isStringLiteralLike(target), `${file}: computed module target`).toBe(true);
        found.push((target as ts.StringLiteralLike).text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  };

  it('neither the schemas, nor the decoders, nor the catalogue reach the sandboxed helper: every relative module it can load is followed', () => {
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const target of loads(file)) {
        if (!target.startsWith('.')) continue;
        const next = path.resolve(path.dirname(file), target).replace(/\.js$/, '.ts');
        expect(existsSync(next), `${file} -> ${target}: unresolved`).toBe(true);
        visit(next);
      }
    };
    visit(path.join(here, 'helper-entry.ts'));
    expect([...seen].map((f) => path.relative(here, f)).sort()).toEqual(['guest.ts', 'helper-entry.ts']);
  });
});

describe('real handler values pass the runtime check', () => {
  let root: string;
  let project: string;
  let previousHome: string | undefined;
  let context: McpContext;
  const catalog = buildCatalog(TOOLS);
  const contract = createOutputContract(catalog, [...MIGRATABLE_READS]);
  const decoders = { get_map: decodeGetMap, read_room: decodeReadRoom, read_guide: decodeReadGuide, list_roles: decodeListRoles, backlog_list: decodeBacklogList } as const;
  const plan: RoomPlan = { id: 'pl-01', roomId: 'r-01', mode: 'verified', status: 'active', rev: 3, goal: 'Ship it', items: [{ id: 1, title: 'one', owner: 's-02', scope: 'x', after: [], criteria: ['it works'], verifier: null, status: 'ready', evidence: null, note: null, log: [] }], backlog: [], acceptedAt: null, completedAt: null, cancelledAt: null, completionSummary: null };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'parley-t6c-'));
    project = path.join(root, 'project');
    await mkdir(project);
    previousHome = process.env.PARLEY_HOME;
    process.env.PARLEY_HOME = path.join(root, 'home');
    const workId = (await createWork(project, { title: 'Outputs', goal: 'A goal' })).work.id;
    await addBacklogItem(project, { title: 'First card', details: 'with a detail' });
    await updateMap(project, workId, (map, letters) => {
      transitionSession(map, addSession(map, { provider: 'claude', label: 'lead', task: 'Lead' }).id, 'active');
      addSession(map, { provider: 'claude', label: 'worker', task: 'Do' });
      addRoom(map, { title: 'Room', creator: HUMAN, members: ['s-01', 's-02'], lead: 's-01' });
      const lead = map.sessions.find((s) => s.id === 's-01')!;
      lead.summary = 'A summary';
      lead.summarySource = 'agent';
      lead.artifacts.push({ kind: 'file', path: 'out.txt' });
      map.plans = [plan];
      for (let i = 0; i < 3; i++) letters.add({ roomId: 'r-01', from: 's-02', to: [], text: `note ${i}`, kind: 'note' });
      letters.add({ roomId: null, from: 's-02', to: ['s-01'], text: 'direct', kind: 'note' });
    });
    context = {
      projectPath: project, workId, workDir: workPaths(project, workId).dir, sessionId: 's-01', channel: false,
      providerRows: async () => [{ id: 'claude', label: 'Claude', family: 'claude', available: true, needs: null, models: null, effort: true, limits: null }],
      roleCatalog: async () => buildRoleCatalog(),
    };
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PARLEY_HOME;
    else process.env.PARLEY_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  const forms: [keyof typeof decoders, Record<string, unknown>, string | null][] = [
    ['get_map', {}, 'map'],
    ['get_map', { session: 's-01' }, 'session'],
    ['get_map', { room: 'r-01' }, 'room'],
    ['get_map', { field: 'goal' }, 'work-text'],
    ['get_map', { field: 'title' }, 'work-text'],
    ['get_map', { field: 'providers' }, 'providers'],
    ['get_map', { field: 'archive' }, 'archive'],
    ['get_map', { field: 'summaries' }, 'summaries'],
    ['get_map', { field: 'messages' }, 'messages'],
    ['get_map', { field: 'messages', room: 'r-01' }, 'messages'],
    ['get_map', { field: 'message', id: 'm-01' }, 'message'],
    ['get_map', { field: 'task', session: 's-01' }, 'session-text'],
    ['get_map', { field: 'summary', session: 's-01' }, 'session-text'],
    ['get_map', { field: 'contextFrom', session: 's-01' }, 'context-from'],
    ['get_map', { field: 'history', session: 's-01' }, 'history'],
    ['get_map', { field: 'artifacts', session: 's-01' }, 'artifacts'],
    ['get_map', { field: 'sessions' }, 'collection'],
    ['get_map', { field: 'rooms' }, 'collection'],
    ['get_map', { field: 'plans' }, 'collection'],
    ['get_map', { field: 'deletedSessions' }, 'collection'],
    ['get_map', { field: 'unreadRooms' }, 'collection'],
    ['get_map', { field: 'plan', id: 'pl-01', rev: 3 }, 'plan'],
    ['read_room', { room: 'r-01' }, null],
    ['read_room', { room: 'r-01', limit: 1 }, null],
    ['read_guide', {}, null],
    ['read_guide', { topic: 'rooms' }, null],
    ['list_roles', {}, null],
    ['backlog_list', {}, null],
    ['backlog_list', { filter: 'all', text: 'card' }, null],
  ];

  const settle = async (method: keyof typeof decoders, args: Record<string, unknown>) => {
    const raw = JSON.parse(JSON.stringify(await createToolRunner(context).call(method, args, undefined))) as Record<string, unknown>;
    const settled = contract.settle(method, args as never, raw['isError'] === true ? 'error' : 'ok', JSON.stringify(raw), 1);
    if (settled.kind !== 'ok' && settled.kind !== 'error') throw new Error('not a receipt');
    return { raw, settled, delivered: JSON.parse(settled.text!) as { ok: boolean; value?: Record<string, unknown>; error?: { kind: string; code?: string } } };
  };

  it.each(forms)('%s %j', async (method, args, branch) => {
    const { settled, delivered } = await settle(method, args);
    expect(delivered.error).toBeUndefined();
    expect(delivered.ok).toBe(true);
    expect(settled.kind).toBe('ok');
    if (branch !== null) expect(delivered.value!['branch']).toBe(branch);
  });

  it('a tool error from the real handler is delivered as the original result, and a selector never saw it', async () => {
    const { raw, settled, delivered } = await settle('read_room', { room: 'r-99' });
    expect(settled).toMatchObject({ kind: 'error', assessment: 'unknown' });
    expect(delivered).toEqual({ ok: false, error: { kind: 'tool-error', result: raw } });
  });

  it('m-5407: an argument that passes input validation and succeeds at the handler is never refused by a decoder', async () => {
    const revision = computeApiRevision({ catalog, launch: 'l', policySnapshot: 'unavailable' });
    const validators = compileCallValidators(catalog, revision);
    const runner = createToolRunner(context);
    const firstPage = JSON.parse(((await runner.call('get_map', { field: 'sessions' }, undefined)).content[0] as { text: string }).text) as { page: { next: string | null } };
    const topology = (JSON.parse(((await runner.call('get_map', { field: 'sessions', maxBytes: 2048 }, undefined)).content[0] as { text: string }).text) as { page: { next: string | null } }).page.next ?? firstPage.page.next ?? 'topology:AAAA';
    const fields = [undefined, 'goal', 'title', 'task', 'summary', 'history', 'artifacts', 'contextFrom', 'messages', 'message', 'summaries', 'archive', 'providers', 'sessions', 'rooms', 'plans', 'deletedSessions', 'unreadRooms', 'plan'];
    const grid = (axes: Record<string, readonly unknown[]>): Record<string, unknown>[] => Object.entries(axes).reduce<Record<string, unknown>[]>(
      (sets, [key, values]) => sets.flatMap((set) => values.map((v) => (v === undefined ? set : { ...set, [key]: v }))), [{}]);
    const cases: [keyof typeof decoders, Record<string, unknown>][] = [
      ...grid({ field: fields, session: [undefined, 's-01'], room: [undefined, 'r-01'], id: [undefined, 'm-01', 'pl-01'], rev: [undefined, 3], kind: [undefined, 'note'], cursor: [undefined, '', 'before:9', 'after:1', topology, 'offset:0:000000000000'], maxBytes: [undefined, 2048] }).map((a) => ['get_map', a] as [keyof typeof decoders, Record<string, unknown>]),
      ...grid({ room: ['r-01'], limit: [undefined, 0, -1, 1.5, 2, 1e9], cursor: [undefined, '', 'before:9', 'after:1', topology], maxBytes: [undefined, 2048], extra: [undefined, 1] }).map((a) => ['read_room', a] as [keyof typeof decoders, Record<string, unknown>]),
      ...grid({ topic: [undefined, 'rooms', 'plans'], extra: [undefined, 1] }).map((a) => ['read_guide', a] as [keyof typeof decoders, Record<string, unknown>]),
      ...grid({ extra: [undefined, 1] }).map((a) => ['list_roles', a] as [keyof typeof decoders, Record<string, unknown>]),
      ...grid({ filter: [undefined, 'open', 'taken', 'done', 'all'], text: [undefined, '', 'card'], extra: [undefined, 1] }).map((a) => ['backlog_list', a] as [keyof typeof decoders, Record<string, unknown>]),
    ];
    const counts = { tried: 0, refusedByInput: 0, toolError: 0, ok: 0 };
    const refused: unknown[] = [];
    for (const [method, args] of cases) {
      counts.tried++;
      let admitted;
      try { admitted = admitCall(validators, revision, method, args); } catch { counts.refusedByInput++; continue; }
      const raw = JSON.parse(JSON.stringify(await runner.call(method, admitted.args as Record<string, unknown>, undefined))) as unknown;
      const decoded = decoders[method](admitted.args, raw);
      if (decoded.result.ok) counts.ok++;
      else if (decoded.result.error.kind === 'tool-error') counts.toolError++;
      else refused.push({ method, args, code: decoded.result.error.code });
    }
    expect(refused).toEqual([]);
    // The grid really reaches success and failure in each direction.
    expect(counts.ok).toBeGreaterThan(1000);
    expect(counts.toolError).toBeGreaterThan(1000);
    expect(counts.refusedByInput).toBeGreaterThan(0);
  }, 240_000);
});
