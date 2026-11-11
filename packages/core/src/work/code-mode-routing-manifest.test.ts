// The routing manifest guard (plan T8a). A TypeScript AST sweep of every non-test source file: each string or template literal that is
// not a module specifier is matched, whole word, against the names of the migration registry. The result must equal the manifest by
// (file, name) PRESENCE: a new mention is red until it is classified, a mention that left is red until its row goes. No counts, so a
// rewording that keeps the names passes: the operation-name convention (code-mode-instructions.ts) covers wording.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { MIGRATION_REGISTRY } from '../mcp/code-mode/migration-registry.js';
import { ROUTING_MANIFEST, type ManifestRow } from './code-mode-routing-manifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const NAMES = MIGRATION_REGISTRY.entries.map((e) => e.name).sort();
const NAME_PATTERN = `(?<![A-Za-z0-9_])(${NAMES.join('|')})(?![A-Za-z0-9_])`;
const NAME_ANY = new RegExp(NAME_PATTERN);
/** The manifest holds the names as data: it is not a text anybody reads. */
const SWEEP_SKIP = new Set(['code-mode-routing-manifest.ts']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'out', 'e2e'].includes(entry) || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry) && !SWEEP_SKIP.has(entry)) out.push(full);
  }
  return out;
}

/** Text of every literal that is not a module specifier, with where it stands. */
function literalsOf(file: string, text: string): { text: string; line: number }[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    const p = node.parent;
    const specifier =
      p !== undefined &&
      (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p) || (ts.isCallExpression(p) && p.expression.kind === ts.SyntaxKind.ImportKeyword));
    if (
      !specifier &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    ) {
      found.push({ text: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const FILES = [...sourceFiles(path.join(ROOT, 'packages')), ...sourceFiles(path.join(ROOT, 'tools'))];
const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');

/** Registry names a source text mentions in its literals, sorted; module specifiers and comments do not count. */
function namesOfSource(file: string, text: string): string[] {
  if (!NAME_ANY.test(text)) return [];
  const names = new Set<string>();
  for (const literal of literalsOf(file, text)) for (const m of literal.text.matchAll(new RegExp(NAME_PATTERN, 'g'))) names.add(m[1]!);
  return [...names].sort();
}

/** file -> sorted names, for the whole repository. */
function sweep(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of FILES) {
    const names = namesOfSource(file, readFileSync(file, 'utf8'));
    if (names.length > 0) out.set(rel(file), names);
  }
  return out;
}

/** Differences between a sweep and a manifest, one line each; empty when they agree. */
export function manifestProblems(swept: ReadonlyMap<string, readonly string[]>, manifest: readonly ManifestRow[]): string[] {
  const problems: string[] = [];
  const rows = new Map(manifest.map((row) => [row.file, row]));
  for (const [file, names] of swept) {
    const row = rows.get(file);
    if (row === undefined) {
      problems.push(`${file}: names ${names.join(', ')} but the file is not in the manifest`);
      continue;
    }
    for (const name of names) if (!row.names.includes(name)) problems.push(`${file}: names ${name} but the manifest row does not list it`);
    for (const name of row.names) if (!names.includes(name)) problems.push(`${file}: the manifest lists ${name} but the file no longer names it`);
  }
  for (const row of manifest) if (!swept.has(row.file)) problems.push(`${row.file}: in the manifest but the file names no operation`);
  return problems;
}

/** `file: text` of every literal that may say "classic" beyond the bare mode token, one entry per literal. */
const LISTED_CLASSIC_PHRASES: readonly string[] = [
  "tools/parley-token-benchmark-replay-arms.ts: the classic arm started in replacement mode",
  "tools/parley-token-benchmark-replay-judge.ts: classic plus the bootstrap",
  "tools/parley-token-benchmark-replay-judge.ts: descriptors that differ from classic: ",
  "tools/parley-token-benchmark-replay-judge.ts: differs from the classic layer outside the bootstrap",
  "tools/parley-token-benchmark-replay-judge.ts: equalsClassicOutsideLayer",
  "tools/parley-token-benchmark-replay-judge.ts: layerEqualsClassicWithBootstrap",
  "tools/parley-token-benchmark-replay-judge.ts: residual tools in classic's relative order",
  "tools/parley-token-benchmark-replay-judge.ts: residualOrderEqualClassic",
  "tools/parley-token-benchmark-replay-judge.ts: residualSchemasEqualClassic",
  "tools/parley-token-benchmark-replay-judge.ts: selectsClassic",
  "tools/parley-token-benchmark-replay-judge.ts: selectsClassic",
  "tools/parley-token-benchmark-replay-judge.ts: selectsClassic ",
  "tools/parley-token-benchmark-replay-judge.ts: toolList.residualOrderEqualClassic",
  "tools/parley-token-benchmark-replay-judge.ts: toolList.residualSchemasEqualClassic",
  "tools/parley-token-benchmark-replay-schema.ts: .argv.equalsClassicOutsideLayer",
  "tools/parley-token-benchmark-replay-schema.ts: .selectsClassic",
  "tools/parley-token-benchmark-replay-schema.ts: .selectsClassic.source",
  "tools/parley-token-benchmark-replay-schema.ts: .selectsClassic.value",
  "tools/parley-token-benchmark-replay-schema.ts: [\"classic\",\"replacement\"] or [\"replacement\"]",
  "tools/parley-token-benchmark-replay-schema.ts: a classic launch has no bootstrap to compare",
  "tools/parley-token-benchmark-replay-schema.ts: a run criterion on a classic-only goal",
  "tools/parley-token-benchmark-replay-schema.ts: classic or replacement",
  "tools/parley-token-benchmark-replay-schema.ts: classic, shipped or { fixture: [method] }",
  "tools/parley-token-benchmark-replay-schema.ts: equalsClassicOutsideLayer",
  "tools/parley-token-benchmark-replay-schema.ts: equalsClassicOutsideLayer",
  "tools/parley-token-benchmark-replay-schema.ts: equalsClassicOutsideLayer",
  "tools/parley-token-benchmark-replay-schema.ts: equalsClassicOutsideLayer",
  "tools/parley-token-benchmark-replay-schema.ts: layerEqualsClassicWithBootstrap",
  "tools/parley-token-benchmark-replay-schema.ts: replacement, classic or blocked",
  "tools/parley-token-benchmark-replay-schema.ts: residualOrderEqualClassic",
  "tools/parley-token-benchmark-replay-schema.ts: residualSchemasEqualClassic",
  "tools/parley-token-benchmark-replay-schema.ts: selectsClassic",
  "tools/parley-token-benchmark-replay-schema.ts: unaccounted or may-be-finishing, only with a classic held-run",
  "tools/parley-token-benchmark-replay.ts: invariant: a declared host fault that never fired on the classic arm",
  // The window's mode label (T12a-indicator, s-306): "Classic" and one sentence about the classic tool list.
  'packages/desktop/src/shared/strings.ts: Classic',
  'packages/desktop/src/shared/strings.ts: This launch runs the classic tool list.',
  "tools/parley-token-benchmark-t10-offline.ts: ].classic: calls of { name, args }",
  "tools/parley-token-benchmark-t10-offline.ts: static declaration size: a ceiling, not a request cost. With Claude tool search the initial classic request carried zero mcp__parley__* declarations (plan P:1283).",
  "tools/parley-token-benchmark-t10-offline.ts: | goal | classic declaration B | replacement declaration B | classic received B | replacement received B |",
];

describe('routing manifest guard', () => {
  const swept = sweep();

  it('the sweep reads the registry names and the manifest equals the sweep by (file, name)', () => {
    expect(NAMES).toHaveLength(50);
    expect(manifestProblems(swept, ROUTING_MANIFEST)).toEqual([]);
  });

  it('the guard catches each way a manifest can drift', () => {
    const base = ROUTING_MANIFEST;
    const row = base.find((r) => r.names.length > 1)!;
    const others = base.filter((r) => r !== row);
    expect(manifestProblems(swept, others)).toEqual([expect.stringContaining('not in the manifest')]);
    expect(manifestProblems(swept, [...others, { ...row, names: row.names.slice(1) }])).toEqual([expect.stringContaining('does not list')]);
    expect(manifestProblems(swept, [...others, { ...row, names: [...row.names, 'browser_open'] }])).toEqual([expect.stringContaining('no longer names')]);
    expect(manifestProblems(swept, [...base, { file: 'packages/core/src/gone.ts', disposition: 'identifier', owner: 'none', reason: 'x', names: ['get_map'] }])).toEqual([
      expect.stringContaining('in the manifest but the file names no operation'),
    ]);
    const grown = new Map(swept).set('packages/core/src/new-text.ts', ['report']);
    expect(manifestProblems(grown, base)).toEqual([expect.stringContaining('packages/core/src/new-text.ts')]);
  });

  it('a count is not a key: rewording a text, or repeating a mention, keeps the names and passes; a new name does not', () => {
    const before = "export const A = 'Call get_map first, then report.';\n// send_message is only a comment\nexport const B = `wait for ${'x'} with wait_for`;\n";
    const reworded = "export const A = 'First read the map with get_map; when done, call report.';\nexport const A2 = 'get_map, again';\nexport const B = `use wait_for to wait for ${'x'}`;\n";
    const grown = `${reworded}export const C = 'also check_inbox';\n`;
    expect(namesOfSource('before.ts', before)).toEqual(['get_map', 'report', 'wait_for']);
    expect(namesOfSource('reworded.ts', reworded)).toEqual(namesOfSource('before.ts', before));
    expect(namesOfSource('grown.ts', grown)).toEqual(['check_inbox', 'get_map', 'report', 'wait_for']);
    const row = { file: 'x.ts', disposition: 'actionable', owner: 'T8a', names: ['get_map', 'report', 'wait_for'] } as const;
    expect(manifestProblems(new Map([['x.ts', namesOfSource('reworded.ts', reworded)]]), [row])).toEqual([]);
    expect(manifestProblems(new Map([['x.ts', namesOfSource('grown.ts', grown)]]), [row])).toEqual([expect.stringContaining('does not list')]);
  });

  it('rows are well formed: sorted, unique, existing files, names from the registry, a reason exactly where the row is not actionable', () => {
    const files = ROUTING_MANIFEST.map((r) => r.file);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
    for (const row of ROUTING_MANIFEST) {
      expect(statSync(path.join(ROOT, row.file)).isFile(), row.file).toBe(true);
      expect(row.names.length, row.file).toBeGreaterThan(0);
      expect([...row.names], row.file).toEqual([...row.names].sort());
      for (const name of row.names) expect(NAMES, `${row.file}: ${name}`).toContain(name);
      if (row.disposition === 'actionable') {
        expect(row.reason, row.file).toBeUndefined();
        expect(['T8a', 'T8b', 'T8c/T8d'], row.file).toContain(row.owner);
      } else {
        expect(row.reason?.trim().length ?? 0, row.file).toBeGreaterThan(20);
        expect(row.owner, row.file).toBe('none');
      }
    }
  });

  it('the wording owned by another task is named, not edited here', () => {
    const owner = (file: string): string | undefined => ROUTING_MANIFEST.find((r) => r.file === file)?.owner;
    expect(owner('packages/core/src/work/guide.ts')).toBe('T8b');
    expect(owner('packages/core/src/roles/builtin.ts')).toBe('T8c/T8d');
    expect(owner('packages/core/src/work/skill.ts')).toBe('T8c/T8d');
  });

  it('a literal that says "classic" beyond the bare mode token is listed here, so the phrase cannot spread unnoticed', () => {
    const phrases: string[] = [];
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      if (!/classic/i.test(text)) continue;
      for (const literal of literalsOf(file, text)) if (/classic/i.test(literal.text) && literal.text !== 'classic') phrases.push(`${rel(file)}: ${literal.text}`);
    }
    // The native-policy refusal said "use the classic tools" until T8h (false at zero residual, m-5930): no such phrase is left in a shipped text.
    // What is listed is pinned to its file. The T9a replay harness (tools/, never shipped) names the arm "classic" in grammar words, messages and
    // self-check names; each such literal, repeats included, is one entry.
    expect([...phrases].sort()).toEqual([...LISTED_CLASSIC_PHRASES].sort());
  });
});

describe('the host stays exposure-neutral', () => {
  it('only the launcher (launch.ts and its gate order, launch-exposure.ts: T12a), the session MCP tools (read_guide, loaded on demand), the T9a launch harness and the T10 offline script import the instructions module; no host, desktop or protocol file does', () => {
    const importers = FILES.filter((file) => /code-mode-instructions/.test(readFileSync(file, 'utf8'))).map(rel);
    expect(importers).toEqual(['packages/core/src/mcp/tools.ts', 'packages/core/src/work/launch-exposure.ts', 'packages/core/src/work/launch.ts', 'tools/parley-token-benchmark-replay-launch.ts', 'tools/parley-token-benchmark-replay-sources.ts', 'tools/parley-token-benchmark-t10-offline.ts']);
  });

  it('ToolLaunch keeps exactly the keys it had: nothing about Code Mode travels to the host', () => {
    const source = readFileSync(path.join(ROOT, 'packages/core/src/mcp/remote-tools.ts'), 'utf8');
    const body = /export interface ToolLaunch \{([^}]*)\}/.exec(source)![1]!;
    const keys = [...body.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
    expect(keys).toEqual(['skillNavigator', 'skillListReduced', 'nativeContextRevision', 'agentRevision', 'toolProfile']);
  });
});
