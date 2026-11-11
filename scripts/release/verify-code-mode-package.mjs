// Code Mode in a packaged app (plan T9b-packaging, H3; proposal .parley/review/T9b-packaging-proposal.md with Delta 1). The
// checks that need JavaScript, run by `verify-code-mode-package.sh`; the static ones also by `verify-packaged-apps.sh`.
//
// Usage: node verify-code-mode-package.mjs <command> <Parley.app> [args]
//   copies <app>                 the three known @parley/core copies (host, remote, app.asar) and their hashes; a fourth fails
//   sign-ignore <app> <yml>      every probe binary on disk matches a `mac.signIgnore` pattern of that electron-builder.yml
//   walk <app>                   no import route from out/main or remote/dist/main.js reaches the helper, broker or guest
//   tree <app>                   one sha256 over every file of the bundle (path, mode and bytes; symlinks by target)
//   config <app>                 the host's real mcpConfigJson: command = this embedded node, entry inside Resources/host
//   proof <app> ok|refused       checkLaunchProof of the host copy
//   helper <app> ok|refused      a real sandboxed helper run of `return 1` from the host copy
//   server <app>                 the real server.js of the host copy: classic, replacement, a nested read, stdin close
//
// `config`, `proof`, `helper` and `server` must run under the app's embedded node: they compare `process.execPath` with it and
// start every child with it. Nothing here writes into the bundle; scratch files go under the system temp directory.
// Nothing shipped imports this file (verify-packaged-apps.test.ts checks that).
//
// The walk's limit (s-296 N1, m-7475): it reads modules as text, against accidental routes in bundler output, not against adversarial code. It
// does not see a loader reached through an alias of a bound loader (`const r2 = r; r2('…')`), a member `.require` call
// (`process.mainModule?.require('…')`), or a computed createRequire (`process.getBuiltinModule('node:module')[k](url)('…')`). No bundler emits
// these today; each would be hand-written.

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
/** A failed check: thrown, so `finally` blocks stop children and remove scratch files before the exit code is set. */
class CheckFailed extends Error {}
const fail = (message) => {
  throw new CheckFailed(message);
};
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// ----- the bundle: files on disk and the app.asar archive -----

const resourcesOf = (app) => path.join(app, 'Contents', 'Resources');

/**
 * The asar archive's header (Chromium pickle: u32 4, u32 header pickle size, then u32 payload size, u32 string length, the
 * JSON). Data starts after the header pickle. No dependency: the release machine reads it with plain node.
 */
function readAsar(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerPickle = head.readUInt32LE(4);
    const length = head.readUInt32LE(12);
    const json = Buffer.alloc(length);
    readSync(fd, json, 0, length, 16);
    return { file, header: JSON.parse(json.toString('utf8')), dataOffset: 8 + headerPickle };
  } finally {
    closeSync(fd);
  }
}

/** Every entry of the archive as [relative path, node]; directories have `files`. */
function asarEntries(asar) {
  const out = [];
  const visit = (node, rel) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = rel === '' ? name : `${rel}/${name}`;
      out.push([p, child]);
      if (child.files !== undefined) visit(child, p);
    }
  };
  visit(asar.header, '');
  return out;
}

function asarNode(asar, rel) {
  let node = asar.header;
  for (const part of rel.split('/').filter(Boolean)) {
    node = node.files?.[part];
    if (node === undefined) return undefined;
  }
  return node;
}

function asarRead(asar, rel) {
  const node = asarNode(asar, rel);
  if (node === undefined || node.files !== undefined || node.link !== undefined) return undefined;
  if (node.unpacked === true) return readFileSync(path.join(`${asar.file}.unpacked`, rel));
  const fd = openSync(asar.file, 'r');
  try {
    const buf = Buffer.alloc(node.size);
    readSync(fd, buf, 0, node.size, asar.dataOffset + Number(node.offset));
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** Regular files under `dir` on disk, relative, sorted; symlinks are listed, not followed. */
function diskFiles(dir) {
  const out = [];
  const visit = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      const r = rel === '' ? name : path.join(rel, name);
      const st = lstatSync(path.join(dir, r));
      if (st.isDirectory()) visit(r);
      else out.push(r);
    }
  };
  visit('');
  return out;
}

const fileLine = (abs, rel) => {
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) return `${rel}\tlink\t${readlinkSync(abs)}`;
  return `${rel}\t${(st.mode & 0o777).toString(8)}\t${sha256(readFileSync(abs))}`;
};

// ----- copies -----

/**
 * Every `@parley/core` in the bundle: a real directory named node_modules/@parley/core on disk (pnpm's symlinks are not
 * copies), a `package.json` named @parley/core anywhere, and the same inside app.asar. Grouped by where they live.
 */
function findCopies(app) {
  const resources = resourcesOf(app);
  const found = new Map();
  const add = (key, where, dir) => { if (!found.has(key)) found.set(key, { where, dir }); };
  for (const rel of diskFiles(app)) {
    const abs = path.join(app, rel);
    if (path.basename(rel) !== 'package.json' || lstatSync(abs).isSymbolicLink()) continue;
    let name;
    try { name = JSON.parse(readFileSync(abs, 'utf8')).name; } catch { continue; }
    if (name !== '@parley/core') continue;
    const dir = path.dirname(abs);
    const under = path.relative(resources, dir);
    const where = under.startsWith(`host${path.sep}`) ? 'host' : under.startsWith(`remote${path.sep}`) ? 'remote' : under.startsWith(`app.asar.unpacked${path.sep}`) ? 'asar' : `unknown:${under}`;
    add(dir, where, dir);
  }
  const asarFile = path.join(resources, 'app.asar');
  if (existsSync(asarFile)) {
    const asar = readAsar(asarFile);
    for (const [rel, node] of asarEntries(asar)) {
      if (!rel.endsWith('/package.json') && rel !== 'package.json') continue;
      if (node.files !== undefined || node.link !== undefined) continue;
      let name;
      try { name = JSON.parse(asarRead(asar, rel).toString('utf8')).name; } catch { continue; }
      if (name !== '@parley/core') continue;
      const dir = path.posix.dirname(rel);
      // The asar copy and its unpacked half are one copy.
      found.delete(path.join(`${asarFile}.unpacked`, dir));
      add(`asar:${dir}`, 'asar', `${asarFile}/${dir}`);
    }
  }
  return [...found.values()];
}

/** One hash per copy over its files; the asar copy is read from the archive, its unpacked files from disk. */
function copyHash(app, copy) {
  const resources = resourcesOf(app);
  const asarFile = path.join(resources, 'app.asar');
  const lines = [];
  if (copy.where === 'asar' && copy.dir.startsWith(`${asarFile}/`)) {
    const asar = readAsar(asarFile);
    const prefix = `${copy.dir.slice(asarFile.length + 1)}/`;
    for (const [rel, node] of asarEntries(asar).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!rel.startsWith(prefix) || node.files !== undefined) continue;
      lines.push(node.link !== undefined ? `${rel.slice(prefix.length)}\tlink\t${node.link}` : `${rel.slice(prefix.length)}\t${node.unpacked === true ? 'unpacked' : 'packed'}\t${sha256(asarRead(asar, rel))}`);
    }
  } else {
    for (const rel of diskFiles(copy.dir)) lines.push(fileLine(path.join(copy.dir, rel), rel));
  }
  return { files: lines.length, sha256: sha256(lines.join('\n')) };
}

function commandCopies(app) {
  const copies = findCopies(app).map((c) => ({ ...c, ...copyHash(app, c) }));
  const where = copies.map((c) => c.where).sort();
  print({ copies });
  if (where.join(',') !== 'asar,host,remote') fail(`expected exactly the host, remote and app.asar copies of @parley/core, found: ${where.join(', ') || 'none'}`);
}

// ----- sign-ignore -----

/** The `mac.signIgnore` list of electron-builder.yml: quoted one-line items. */
function signIgnorePatterns(yml) {
  const lines = readFileSync(yml, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s+signIgnore:\s*$/.test(l));
  if (start < 0) fail(`${yml}: no mac.signIgnore`);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s+-\s+'(.*)'\s*$/.exec(l);
    if (m === null) break;
    out.push(new RegExp(m[1]));
  }
  if (out.length === 0) fail(`${yml}: mac.signIgnore is empty`);
  return out;
}

function commandSignIgnore(app, yml) {
  const patterns = signIgnorePatterns(yml);
  const probes = diskFiles(app).filter((rel) => path.basename(rel) === 'procinfo-probe').map((rel) => path.join(app, rel));
  const unmatched = probes.filter((p) => !patterns.some((re) => re.test(p)));
  print({ patterns: patterns.map(String), probes, unmatched });
  if (probes.length === 0) fail('no procinfo-probe binary on disk in the bundle');
  if (unmatched.length > 0) fail(`mac.signIgnore does not match these probe paths: ${unmatched.join(', ')}`);
}

// ----- walk -----

const FORBIDDEN = /(?:^|\/)mcp\/code-mode\/(?:helper|helper-entry|broker|guest)\.js$/;
/**
 * Dynamic imports whose specifier is not a literal, known by file and exact expression. Each one is a route the walk cannot
 * follow, so it is listed with why it cannot lead to the helper; any other one fails the walk.
 */
const KNOWN_NON_LITERAL = [
  {
    file: /\/app\.asar\/out\/main\/index\.js$/,
    expression: '/* @vite-ignore */ pathToFileURL(file',
    why: 'relay-setup loadFakeSsh: the e2e seam of an unpackaged build; fakeSshModulePath returns null when app.isPackaged',
  },
];
const squash = (text) => text.replace(/\s+/g, ' ').trim();
const BUILTIN = new Set(builtinModules);

/** A file system over disk and app.asar: paths inside `<Resources>/app.asar/` read from the archive. */
function bundleFs(app) {
  const asarFile = path.join(resourcesOf(app), 'app.asar');
  const asar = existsSync(asarFile) ? readAsar(asarFile) : null;
  const inAsar = (p) => asar !== null && p.startsWith(`${asarFile}/`);
  const rel = (p) => p.slice(asarFile.length + 1);
  return {
    isFile(p) {
      if (inAsar(p)) { const n = asarNode(asar, rel(p)); return n !== undefined && n.files === undefined; }
      try { return lstatSync(p).isFile() || lstatSync(realpathSync(p)).isFile(); } catch { return false; }
    },
    isDir(p) {
      if (inAsar(p)) { const n = asarNode(asar, rel(p)); return n !== undefined && n.files !== undefined; }
      try { return lstatSync(realpathSync(p)).isDirectory(); } catch { return false; }
    },
    read(p) { return inAsar(p) ? asarRead(asar, rel(p)).toString('utf8') : readFileSync(p, 'utf8'); },
    real(p) { return inAsar(p) ? p : realpathSync(p); },
  };
}

/**
 * Specifiers of one module: static imports/exports, side-effect imports, literal `import()`, and the literal calls of every loader. A loader is
 * plain `require` and every name bound to `createRequire(...)` (bundlers rename them, `require$1`, `require$2`), and a `createRequire(...)(...)`
 * called at once. A loader called with anything but a literal, a loader member other than `.resolve(<literal>)`, and a `createRequire(...)`
 * that is neither bound nor called at once are all reported as non-literal: the walk cannot follow them (s-296 R1).
 */
function specifiersOf(text) {
  const out = new Set();
  const nonLiteral = [];
  const literal = (arg) => /^['"`]([^'"`$]+)['"`]$/.exec(arg.trim())?.[1] ?? null;
  for (const m of text.matchAll(/\b(?:import|export)\b[^'"`;()]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/(?:^|[;\n}])\s*import\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
    const lit = literal(m[1]);
    if (lit !== null) out.add(lit);
    else nonLiteral.push(m[1].slice(0, 80));
  }
  const escape = (n) => n.replace(/\$/g, '\\$');
  // createRequire under its own name or an alias (`import { createRequire as x }`, `const { createRequire: x } = ...`).
  const creators = new Set(['createRequire', ...[...text.matchAll(/\bcreateRequire\s*(?:as|:)\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1])]);
  const bound = [];
  const direct = [];
  for (const c of creators) {
    const name = escape(c);
    const b = [...text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:[A-Za-z_$][\\w$]*\\.)?${name}\\s*\\([^)]*\\)\\s*(?=[;,\\n])`, 'g'))];
    const d = [...text.matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\([^)]*\\)\\s*\\(\\s*([^)]*?)\\s*\\)`, 'g'))];
    const creations = [...text.matchAll(new RegExp(`(?<![\\w$])${name}\\s*\\(`, 'g'))].length;
    if (creations !== b.length + d.length) nonLiteral.push(`${c}: ${creations} created, ${b.length} bound, ${d.length} called at once`);
    bound.push(...b);
    direct.push(...d);
  }
  for (const m of direct) {
    const lit = literal(m[1]);
    if (lit !== null) out.add(lit);
    else nonLiteral.push(`createRequire(...)(${m[1].slice(0, 60)})`);
  }
  for (const name of new Set(['require', ...bound.map((m) => m[1])])) {
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\s*\\(\\s*([^)]*?)\\s*\\)`, 'g'))) {
      const lit = literal(m[1]);
      if (lit !== null) out.add(lit);
      else nonLiteral.push(`${name}(${m[1].slice(0, 60)})`);
    }
    for (const m of text.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(\\s*([^)]*?)\\s*\\)`, 'g'))) {
      if (m[1] === 'resolve' && literal(m[2]) !== null) continue;
      nonLiteral.push(`${name}.${m[1]}(${m[2].slice(0, 60)})`);
    }
  }
  return { specifiers: [...out], nonLiteral };
}

function resolveFile(fs, p) {
  for (const c of [p, `${p}.js`, `${p}.mjs`, `${p}.cjs`, path.join(p, 'index.js')]) if (fs.isFile(c)) return fs.real(c);
  return null;
}

/** The target of `exports[sub]` (string or condition object) of a package; `main` or index.js for the root. */
function exportTarget(pkg, sub) {
  const pick = (v) => (typeof v === 'string' ? v : v !== null && typeof v === 'object' ? pick(v.import ?? v.require ?? v.node ?? v.default) : undefined);
  if (pkg.exports !== undefined) {
    if (typeof pkg.exports === 'string') return sub === '.' ? pkg.exports : undefined;
    return pick(pkg.exports[sub]);
  }
  return sub === '.' ? (pkg.main ?? 'index.js') : sub;
}

/** `@parley/*` and relative specifiers are followed; builtins, electron and other packages are leaves. */
function resolveSpecifier(fs, from, spec) {
  if (spec.startsWith('node:') || BUILTIN.has(spec) || spec === 'electron' || spec.startsWith('electron/')) return { leaf: spec };
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const r = resolveFile(fs, path.resolve(path.dirname(from), spec));
    return r === null ? { unresolved: spec } : { file: r };
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (!name.startsWith('@parley/')) return { leaf: spec };
  const sub = spec === name ? '.' : `./${spec.slice(name.length + 1)}`;
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const pkgDir = path.join(dir, 'node_modules', name);
    if (fs.isDir(pkgDir) && fs.isFile(path.join(pkgDir, 'package.json'))) {
      const target = exportTarget(JSON.parse(fs.read(path.join(pkgDir, 'package.json'))), sub);
      const r = target === undefined ? null : resolveFile(fs, path.join(pkgDir, target));
      return r === null ? { unresolved: spec } : { file: r };
    }
    if (path.dirname(dir) === dir) return { unresolved: spec };
  }
}

function walkFrom(fs, roots) {
  const seen = new Set();
  const unresolved = [];
  const nonLiteral = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const parsed = specifiersOf(fs.read(file));
    for (const n of parsed.nonLiteral) nonLiteral.push({ file, expression: n });
    for (const spec of parsed.specifiers) {
      const r = resolveSpecifier(fs, file, spec);
      if (r.file !== undefined) stack.push(r.file);
      else if (r.unresolved !== undefined) unresolved.push({ file, spec });
    }
  }
  return { seen: [...seen].sort(), unresolved, nonLiteral };
}

function commandWalk(app) {
  const resources = resourcesOf(app);
  const fs = bundleFs(app);
  const mainDir = path.join(resources, 'app.asar', 'out', 'main');
  const asar = readAsar(path.join(resources, 'app.asar'));
  const rootsUnder = (dir) => asarEntries(asar)
    .filter(([rel, node]) => rel.startsWith(dir) && node.files === undefined && /\.(?:m?js|cjs)$/.test(rel))
    .map(([rel]) => path.join(resources, 'app.asar', rel));
  const mainRoots = rootsUnder('out/main/');
  const preloadRoots = rootsUnder('out/preload/');
  const remoteRoot = path.join(resources, 'remote', 'dist', 'main.js');
  if (mainRoots.length === 0) fail(`no out/main in ${mainDir}`);
  if (preloadRoots.length === 0) fail(`no out/preload in ${path.join(resources, 'app.asar', 'out', 'preload')}`);
  if (!existsSync(remoteRoot)) fail(`no ${remoteRoot}`);
  const report = {};
  let bad = [];
  // The window's main process and the bridge load @parley/core; the preloads load only electron today, and are walked so that a change shows.
  for (const [name, roots, entersCore] of [['main', mainRoots, true], ['preload', preloadRoots, false], ['remote', [realpathSync(remoteRoot)], true]]) {
    const w = walkFrom(fs, roots);
    const codeMode = w.seen.filter((f) => /\/mcp\/code-mode(?:-tools)?[/.]/.test(f)).map((f) => f.slice(f.indexOf('/mcp/') + 1));
    const forbidden = w.seen.filter((f) => FORBIDDEN.test(f));
    const known = (n) => KNOWN_NON_LITERAL.find((k) => k.file.test(n.file) && squash(n.expression) === k.expression);
    const parleyNonLiteral = w.nonLiteral.filter((n) => known(n) === undefined);
    const allowed = w.nonLiteral.filter((n) => known(n) !== undefined).map((n) => ({ file: n.file, expression: squash(n.expression), why: known(n).why }));
    report[name] = { roots: roots.length, modules: w.seen.length, codeMode, forbidden, unresolved: w.unresolved, nonLiteralDynamic: parleyNonLiteral, knownNonLiteral: allowed };
    // A walk that never entered @parley/core proves nothing about it.
    if (entersCore && !w.seen.some((f) => /\/@parley\/core\/dist\//.test(f) || /\/node_modules\/@parley\/core\/dist\//.test(f))) bad.push(`${name}: the walk never entered @parley/core`);
    bad = bad.concat(forbidden.map((f) => `${name}: reaches ${f}`), w.unresolved.filter((u) => u.spec.startsWith('.') || u.spec.startsWith('@parley/')).map((u) => `${name}: cannot resolve ${u.spec} from ${u.file}`), parleyNonLiteral.map((n) => `${name}: a dynamic import or loader call that is not a literal in ${n.file}: ${n.expression}`));
  }
  print(report);
  if (bad.length > 0) fail(bad.join('\n'));
}

// ----- tree -----

function commandTree(app) {
  const lines = diskFiles(app).map((rel) => fileLine(path.join(app, rel), rel));
  print({ files: lines.length, sha256: sha256(lines.join('\n')) });
}

// ----- runtime, under the embedded node -----

function hostCore(app) {
  const resources = resourcesOf(app);
  const hostMain = path.join(resources, 'host', 'dist', 'main.js');
  const index = realpathSync(createRequire(hostMain).resolve('@parley/core'));
  const hostDir = realpathSync(path.join(resources, 'host'));
  if (!index.startsWith(`${hostDir}/`)) fail(`the host resolves @parley/core outside Resources/host: ${index}`);
  const dir = path.dirname(path.dirname(index));
  return { dir, index, url: (rel) => pathToFileURL(path.join(dir, 'dist', rel)).href };
}

function embeddedNodeOnly(app) {
  const node = realpathSync(path.join(resourcesOf(app), 'node', 'bin', 'node'));
  if (realpathSync(process.execPath) !== node) fail(`run this command with the app's embedded node (${node}), not ${process.execPath}`);
  return node;
}

async function commandConfig(app) {
  const node = embeddedNodeOnly(app);
  const core = hostCore(app);
  const { mcpConfigJson } = await import(pathToFileURL(core.index).href);
  const { MCP_SERVER_NAME } = await import(core.url('names.js'));
  const server = JSON.parse(mcpConfigJson({ workDir: path.join(tmpdir(), 'parley-t9b-config'), sessionId: 's-01' })).mcpServers[MCP_SERVER_NAME];
  const hostDir = realpathSync(path.join(resourcesOf(app), 'host'));
  const entry = server.args?.[0] ?? '';
  print({ node: process.version, command: server.command, entry, core: core.index });
  if (realpathSync(server.command) !== node) fail(`mcpConfigJson command is not the embedded node: ${server.command}`);
  if (!realpathSync(entry).startsWith(`${hostDir}/`) || entry.includes('app.asar')) fail(`mcpConfigJson entry is not inside Resources/host: ${entry}`);
}

async function commandProof(app, expect) {
  embeddedNodeOnly(app);
  const { checkLaunchProof } = await import(hostCore(app).url('mcp/code-mode/helper.js'));
  const r = await checkLaunchProof();
  print({ ok: r.ok, reason: r.reason ?? null });
  if ((expect === 'ok') !== (r.ok === true)) fail(`launch proof: expected ${expect}, got ${r.ok ? 'ok' : `refused: ${r.reason}`}`);
}

async function catalogue(core) {
  const C = await import(core.url('mcp/code-mode/catalog.js'));
  const K = await import(core.url('mcp/code-mode/contracts.js'));
  const { TOOLS } = await import(core.url('mcp/tools.js'));
  const catalog = C.buildCatalog(TOOLS);
  const apiRevision = K.computeApiRevision({ catalog, launch: 't9b-packaging', policySnapshot: 'unavailable' });
  return { validators: K.compileCallValidators(catalog, apiRevision), apiRevision, TOOLS };
}

async function commandHelper(app, expect) {
  embeddedNodeOnly(app);
  const core = hostCore(app);
  const H = await import(core.url('mcp/code-mode/helper.js'));
  const { validators, apiRevision } = await catalogue(core);
  const r = await H.runHelper({ code: 'return 1', methods: ['get_map'], host: async () => ({ kind: 'ok', text: '{}' }), validators, apiRevision });
  await r.drained;
  const view = { status: r.status, runStatus: r.runStatus, reason: r.reason, spawned: r.spawned, hostCalls: r.hostCalls, value: r.outcome?.value ?? null, launch: r.launch?.ok ?? null, cleanup: r.cleanup };
  print(view);
  const ok = r.status === 'finished' && r.runStatus === 'completed' && r.outcome?.value === '1' && r.spawned && r.hostCalls === 0;
  if (expect === 'ok' && !ok) fail(`helper run of return 1 did not complete: ${JSON.stringify(view)}`);
  if (expect === 'refused' && (r.status !== 'unavailable' || r.spawned)) fail(`helper run was expected to be refused before spawning: ${JSON.stringify(view)}`);
}

/**
 * A synthetic `/agent/tools` host: `list` gets the real tools of this copy, `call` a fixed read result; or 404 for everything.
 * With `holdCall`, that call's answer waits for `release()`, so a run can be looked at while it holds its record.
 */
async function fixtureHost(mode, tools, holdCall = 0) {
  const log = [];
  const token = randomBytes(32).toString('hex');
  let release = () => undefined;
  const held = new Promise((r) => { release = r; });
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      log.push(body);
      if (mode === '404') { res.writeHead(404); res.end(); return; }
      let op;
      try { op = JSON.parse(body).op; } catch { op = undefined; }
      if (op === 'call' && ++calls === holdCall) await held;
      const text = op === 'list' ? JSON.stringify({ ok: true, result: { tools } }) : JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: '{"map":1}' }] } });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, log, release: () => release(), calls: () => log.filter((b) => { try { return JSON.parse(b).op === 'call'; } catch { return false; } }).length, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

/** The real server.js over stdio JSON-RPC, as a client sees it. */
function startServer(entry, env, preload) {
  const child = spawn(process.execPath, [...(preload === undefined ? [] : ['--import', preload]), entry], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdin.on('error', () => undefined);
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const waiting = new Map();
  let buffered = '';
  let id = 0;
  child.stdout.on('data', (d) => {
    buffered += d.toString();
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const m = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      if (m.id !== undefined) waiting.get(m.id)?.(m);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 60 s; stderr: ${stderr.slice(-500)}`)), 60_000);
    waiting.set(n, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return {
    child, exited, request, stderr: () => stderr,
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't9b-packaging', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    },
    async names() { return (await request('tools/list', {})).result.tools.map((t) => t.name); },
    /** code_execute with the revision code_search names, or with `revision` when given (a server with no broker). */
    async execute(code, revision) {
      const apiRevision = revision ?? JSON.parse((await request('tools/call', { name: 'code_search', arguments: { query: 'get_map' } })).result.content[0].text).apiRevision;
      const r = await request('tools/call', { name: 'code_execute', arguments: { code, apiRevision } });
      return JSON.parse(r.result.content[0].text);
    },
    kill() { child.kill('SIGKILL'); },
  };
}

const WRAPPERS = ['code_search', 'code_docs', 'code_execute'];

/** The T8h preload (code-mode-client-gone.test.ts): the fixture broker over the fixture source's allow, patched in at load. */
const BROKER_PRELOAD = `import { registerHooks } from 'node:module';
const patch = (source, from, to) => { if (!source.includes(from)) throw new Error('anchor: ' + from); return source.replace(from, to); };
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/mcp/code-mode-tools.js')) return result;
  let s = patch(String(result.source), 'broker: null })', 'broker: FIXTURE_BROKER(catalog, launchId) })');
  s = \`import { createBroker as CB_ } from './code-mode/broker.js'; import { claimFixtureSourceMint as M_ } from './code-mode/native-policy.js'; const MINT_ = M_();
const FIXTURE_BROKER = (catalog, launchId) => CB_({ source: MINT_('fixture', { revision: () => 'r', decide: () => 'allow' }), catalog, launchId, agent: { url: process.env.PARLEY_AGENT_URL, token: process.env.PARLEY_AGENT_TOKEN }, launch: {}, hold: { workDir: process.env.PARLEY_WORK_DIR, sessionId: process.env.PARLEY_SESSION_ID } });\\n\` + s;
  return { ...result, source: s };
} });
`;

const traceLoads = (log) => `import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({ load(url, context, next) { if (url.includes('/code-mode')) appendFileSync(${JSON.stringify(log)}, url + '\\n'); return next(url, context); } });
`;

async function commandServer(app) {
  embeddedNodeOnly(app);
  const core = hostCore(app);
  const entry = path.join(core.dir, 'dist', 'mcp', 'server.js');
  const appReal = realpathSync(app);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'parley-t9b-server-')));
  const servers = [];
  const hosts = [];
  try {
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    mkdirSync(project);
    process.env['PARLEY_HOME'] = home;
    process.env['HARNAS_HOME'] = home;
    const store = await import(core.url('work/store.js'));
    const map = await import(core.url('work/map.js'));
    const decision = await import(core.url('mcp/code-mode/launch-decision.js'));
    const exposure = await import(core.url('mcp/code-mode/exposure-record.js'));
    const record = await import(core.url('mcp/code-mode/run-record.js'));
    const { TOOLS } = await catalogue(core);
    const workId = (await store.createWork(project, { title: 'T9b packaging' })).work.id;
    let sessionId = '';
    await store.updateMap(project, workId, (m) => { const s = map.addSession(m, { provider: 'claude', label: 'packaged', task: 'Check' }); map.transitionSession(m, s.id, 'active'); sessionId = s.id; });
    const workDir = store.workPaths(project, workId).dir;
    const decide = () => {
      const nonce = decision.newLaunchNonce();
      if (!decision.writeLaunchDecision(workDir, sessionId, { v: 1, nonce, effective: 'replacement', requested: true, reason: null, provider: 'claude', at: new Date().toISOString() })) fail('the launch decision was not written');
      return nonce;
    };
    const envOf = (h, extra = {}) => ({ PATH: '/usr/bin:/bin', HOME: root, PARLEY_HOME: home, HARNAS_HOME: home, PARLEY_WORK_DIR: workDir, PARLEY_SESSION_ID: sessionId, PARLEY_AGENT_URL: `${h.url}/agent/browser`, PARLEY_AGENT_TOKEN: h.token, ...extra });
    const host = async (mode) => { const h = await fixtureHost(mode, TOOLS); hosts.push(h); return h; };
    const open = async (h, extra, preload) => { const s = startServer(entry, envOf(h, extra), preload); servers.push(s); await s.init(); return s; };
    const report = {};

    // Classic: no nonce. The 49, no wrappers, no Code Mode module loaded, no record.
    {
      const h = await host('404');
      const loaded = path.join(root, 'loaded.log');
      const trace = path.join(root, 'trace.mjs');
      writeFileSync(trace, traceLoads(loaded));
      const s = await open(h, {}, trace);
      const names = await s.names();
      report.classic = { tools: names.length, wrappers: WRAPPERS.filter((w) => names.includes(w)), codeModeLoaded: existsSync(loaded) ? readFileSync(loaded, 'utf8').trim().split('\n') : [], record: exposure.readExposureRecord(workDir, sessionId).kind };
      if (names.length !== 49 || report.classic.wrappers.length > 0 || report.classic.codeModeLoaded.length > 0 || report.classic.record !== 'unknown') fail(`classic start: ${JSON.stringify(report.classic)}`);
      s.child.stdin.end();
      report.classic.exit = await s.exited;
      if (report.classic.exit !== 0) fail(`classic: stdin closed, exit ${report.classic.exit}`);
    }

    // Replacement as shipped (no broker): 52 with the wrappers last, the record written, code_execute unavailable with zero
    // dispatch; then stdin closes and the process exits.
    {
      const h = await host('404');
      const nonce = decide();
      const s = await open(h, { PARLEY_CODE_MODE_LAUNCH: nonce });
      const names = await s.names();
      const answer = await s.execute('return await parley.get_map({})', `cm1.${'0'.repeat(64)}`);
      const rec = exposure.readExposureRecord(workDir, sessionId);
      report.replacement = { tools: names.length, last: names.slice(-3), record: rec.kind === 'record' ? { effective: rec.record.effective, nonce: rec.record.nonce === nonce } : rec.kind, error: answer.error?.kind ?? null, operations: answer.operations?.length ?? null, hostCalls: h.calls() };
      if (names.length !== 52 || names.slice(-3).join() !== WRAPPERS.join() || rec.kind !== 'record' || rec.record.effective !== 'replacement' || rec.record.nonce !== nonce || answer.error?.kind !== 'unavailable' || h.calls() !== 0) fail(`replacement start: ${JSON.stringify(report.replacement)}`);
      s.child.stdin.end();
      report.replacement.exit = await s.exited;
      if (report.replacement.exit !== 0) fail(`replacement: stdin closed, exit ${report.replacement.exit}`);
    }

    // A nested read through the fixture broker (preload patch, T8h). The host holds the second read: meanwhile the run
    // record, outside the bundle, has the first read's terminal line and the second's intent. Then the run completes,
    // two calls reached the host, and the record is released.
    {
      const h = await fixtureHost('list', TOOLS, 2);
      hosts.push(h);
      const preload = path.join(root, 'broker.mjs');
      writeFileSync(preload, BROKER_PRELOAD);
      const s = await open(h, { PARLEY_CODE_MODE_LAUNCH: decide() }, preload);
      const pending = s.execute('await parley.get_map({}); await parley.get_map({}); return 1;');
      const file = record.runRecordPath(workDir, sessionId);
      for (const end = Date.now() + 30_000; h.calls() < 2; ) {
        if (Date.now() > end) fail(`nested read: the second call did not reach the host; stderr: ${s.stderr().slice(-800)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
      const held = { record: file, recordOutsideBundle: !path.resolve(realpathSync(file)).startsWith(`${appReal}/`), first: lines.filter((l) => l.o === 1 && 's' in l), second: lines.filter((l) => l.o === 2 && 'm' in l).map((l) => l.m), view: record.inspectRunRecord(workDir, sessionId).kind };
      h.release();
      const answer = await pending;
      report.nestedRead = { held, status: answer.status ?? null, value: answer.value ?? null, operations: (answer.operations ?? []).map((o) => o.outcome ?? null), hostCalls: h.calls(), after: record.inspectRunRecord(workDir, sessionId).kind };
      if (!held.recordOutsideBundle || JSON.stringify(held.first) !== '[{"o":1,"s":"succeeded"}]' || held.second.join() !== 'get_map' || held.view !== 'held-live') fail(`nested read, while held: ${JSON.stringify(held)}`);
      if (answer.status !== 'completed' || answer.value !== 1 || h.calls() !== 2 || report.nestedRead.operations.join() !== 'succeeded,succeeded' || report.nestedRead.after !== 'free') fail(`nested read: ${JSON.stringify(report.nestedRead)}; stderr: ${s.stderr().slice(-800)}`);
      s.child.stdin.end();
      report.nestedRead.exit = await s.exited;
      if (report.nestedRead.exit !== 0) fail(`nested read: stdin closed, exit ${report.nestedRead.exit}`);
    }
    print(report);
  } finally {
    for (const s of servers) s.kill();
    await Promise.all(hosts.map((h) => h.close()));
    rmSync(root, { recursive: true, force: true });
  }
}

// ----- main -----

const [command, app, arg] = process.argv.slice(2);
if (command === undefined || app === undefined || !existsSync(path.join(app, 'Contents', 'Resources'))) {
  process.stderr.write('usage: verify-code-mode-package.mjs <command> <Parley.app> [arg]\n');
  process.exit(2);
}
const commands = {
  copies: () => commandCopies(app),
  'sign-ignore': () => commandSignIgnore(app, arg ?? fail('sign-ignore needs the electron-builder.yml path')),
  walk: () => commandWalk(app),
  tree: () => commandTree(app),
  config: () => commandConfig(app),
  proof: () => commandProof(app, arg ?? 'ok'),
  helper: () => commandHelper(app, arg ?? 'ok'),
  server: () => commandServer(app),
};
try {
  await (commands[command] ?? (() => fail(`unknown command ${command}`)))();
} catch (e) {
  process.stderr.write(`verify-code-mode-package: ${e instanceof CheckFailed ? e.message : (e?.stack ?? String(e))}\n`);
  process.exitCode = 1;
}
