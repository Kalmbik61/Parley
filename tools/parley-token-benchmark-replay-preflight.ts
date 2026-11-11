// T9a harness, slice H4a: the preflight. A run that cannot be trusted does not start: every check names what is wrong and the command that fixes it, and nothing is
// skipped or downgraded. `collectFacts` reads the machine; `preflightProblems` judges the facts (pure, so every refusal has a test).
//
// What the replay stands on, and what refuses it:
//   goals file       PARLEY_REPLAY_GOALS set, its bytes hash to the frozen sha, the schema check passes
//   machine          macOS (cp -c clones the data), sandbox-exec (the helper's sandbox), a loopback port can be bound
//   product build    the ignored native probe, protocol dist and core dist exist, and neither dist is older than its sources (the preload patches dist by text anchor,
//                    so an old dist would run old code while the anchors still match); the build is made from the pinned checkout inside the gate run
//   harness          the MCP client SDK is core's own and inside the repository, the handler probe really reports a handler start (the control), retry is 0
//   tree             the checkout is clean, and its tree hash is what the report carries

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { shippedProbe } from '../packages/core/src/mcp/code-mode/helper.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DistFact { readonly name: string; readonly dir: string; readonly exists: boolean; readonly newestBuiltMs: number | null; readonly newestSourceMs: number | null; readonly buildCommand: string }

export interface Facts {
  readonly goalsPath: string | undefined;
  readonly goalsText: string | null;
  readonly expectedGoalsSha: string;
  readonly goalsSchemaIssues: readonly string[];
  readonly platform: string;
  readonly sandboxExec: boolean;
  readonly loopback: boolean;
  readonly nativeProbe: { readonly path: string; readonly exists: boolean; readonly sha256: string | null };
  /** The product's own verdict on the probe (`shippedProbe`: manifest, the source hash it was built from, the binary hash): ok, or its reason. */
  readonly probeVerdict: { readonly ok: boolean; readonly reason: string | null } | null;
  /** The exit codes of the two builds the gate script made from this checkout, read from its stamp; null where there is no stamp. */
  readonly builds: { readonly stamp: string | null; readonly protocol: number | null; readonly core: number | null };
  readonly dists: readonly DistFact[];
  readonly sdk: { readonly root: string; readonly version: string } | null;
  readonly repo: string;
  readonly handlerProbeStarted: boolean | null;
  /** The retry count vitest runs this file with (0 pinned). */
  readonly retry: number | undefined;
  readonly treeClean: boolean;
  readonly treeHash: string | null;
  readonly node: string;
  readonly load: readonly number[];
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** Every refusal, by name; empty means the run may start. */
export function preflightProblems(f: Facts): readonly string[] {
  const out: string[] = [];
  if (f.goalsPath === undefined || f.goalsPath === '') out.push('PARLEY_REPLAY_GOALS is not set: point it at the frozen goals file (the run never falls back to another file and never skips)');
  else if (f.goalsText === null) out.push(`PARLEY_REPLAY_GOALS ${f.goalsPath} cannot be read`);
  else if (sha256(f.goalsText) !== f.expectedGoalsSha) out.push(`the goals file ${f.goalsPath} has sha256 ${sha256(f.goalsText).slice(0, 12)}, the frozen one is ${f.expectedGoalsSha.slice(0, 12)}`);
  for (const issue of f.goalsSchemaIssues) out.push(`goals file: ${issue}`);
  if (f.platform !== 'darwin') out.push(`the replay needs macOS (cp -c clones, sandbox-exec); this is ${f.platform}`);
  if (!f.sandboxExec) out.push('/usr/bin/sandbox-exec is missing: the helper sandbox cannot start');
  if (!f.loopback) out.push('a loopback port cannot be bound: the host the arms talk to cannot start');
  if (!f.nativeProbe.exists) out.push(`the native probe ${f.nativeProbe.path} is missing (it is not in git): build it with: node packages/desktop/scripts/build-procinfo-probe.mjs (the command is also in packages/core/native/darwin-arm64/manifest.json)`);
  else if (f.probeVerdict === null) out.push('the product\'s own probe check did not run');
  else if (!f.probeVerdict.ok) out.push(`the product refuses the native probe ${f.nativeProbe.path}: ${f.probeVerdict.reason ?? 'no reason'}`);
  if (f.builds.stamp === null) out.push('there is no build stamp (PARLEY_REPLAY_BUILD): the gate script builds protocol and core from this checkout and writes it; a run without it could be running an old or half-built dist');
  else for (const name of ['protocol', 'core'] as const) {
    const code = f.builds[name];
    if (code === null) out.push(`the build stamp ${f.builds.stamp} has no exit code for ${name}`);
    else if (code !== 0) out.push(`the ${name} build exited with ${code}: tsc emits despite errors, so the dist cannot be trusted`);
  }
  for (const d of f.dists) {
    if (!d.exists) out.push(`${d.name} dist ${d.dir} is missing: run ${d.buildCommand}`);
    else if (d.newestBuiltMs === null || d.newestSourceMs === null) out.push(`${d.name} dist ${d.dir}: the build time or the source time cannot be read`);
    else if (d.newestBuiltMs < d.newestSourceMs) out.push(`${d.name} dist ${d.dir} is older than its sources: run ${d.buildCommand}`);
  }
  if (f.sdk === null) out.push('the MCP client SDK cannot be resolved from the core package');
  else if (!f.sdk.root.startsWith(`${f.repo}${path.sep}`)) out.push(`the MCP client SDK ${f.sdk.root} is outside the repository`);
  if (f.handlerProbeStarted === null) out.push('the handler probe control did not run: the vi.mock of core/dist is not in place in this file');
  else if (!f.handlerProbeStarted) out.push('the handler probe control saw a real call and reported no handler start: handlerStarted would be false everywhere, so every handler criterion would pass or fail for nothing');
  if (f.retry !== 0) out.push(`vitest retry is ${String(f.retry)}, it must be 0: a retried attempt would hide a flaky arm`);
  if (!f.treeClean) out.push('the checkout is not clean: the result of the run names a tree hash, so the run is made from a committed tree');
  if (f.treeHash === null) out.push('the tree hash cannot be read');
  return out;
}

// ---------- reading the machine ----------

const newest = (dir: string, accept: (file: string) => boolean): number | null => {
  let best: number | null = null;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (accept(p)) { const m = statSync(p).mtimeMs; if (best === null || m > best) best = m; }
    }
  };
  try { walk(dir); } catch { return null; }
  return best;
};

/** The one dist of a package: when it was last built (its newest emitted file), and when its sources last changed (tests are not built). */
export function distFact(repo: string, pkg: 'core' | 'protocol'): DistFact {
  const dir = path.join(repo, 'packages', pkg, 'dist');
  const src = path.join(repo, 'packages', pkg, 'src');
  const exists = existsSync(dir);
  return {
    name: pkg, dir, exists,
    newestBuiltMs: exists ? newest(dir, (f) => f.endsWith('.js')) : null,
    newestSourceMs: newest(src, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')),
    buildCommand: `pnpm --filter @parley/${pkg} build`,
  };
}

const bindsLoopback = (): Promise<boolean> => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)));
});

/** The stamp the gate script writes: `{ "protocol": <exit code>, "core": <exit code> }`. */
export function readBuilds(stamp: string | undefined): Facts['builds'] {
  if (stamp === undefined || stamp === '' || !existsSync(stamp)) return { stamp: null, protocol: null, core: null };
  try {
    const v = JSON.parse(readFileSync(stamp, 'utf8')) as Record<string, unknown>;
    const code = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) ? x : null);
    return { stamp, protocol: code(v['protocol']), core: code(v['core']) };
  } catch { return { stamp, protocol: null, core: null }; }
}

const git = (repo: string, args: string[]): string | null => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim(); } catch { return null; } };

/** Reads what the preflight judges. `sdk`, `retry` and the probe control come from the caller: they are known only inside the run file. */
export async function collectFacts(input: {
  repo: string; goalsPath: string | undefined; expectedGoalsSha: string; goalsSchemaIssues: (text: string) => readonly string[];
  sdk: () => Promise<{ root: string; version: string }>; retry: number | undefined; handlerProbeControl: () => Promise<boolean | null>;
  /** Path of the build stamp the gate script wrote (`PARLEY_REPLAY_BUILD`). */
  buildStamp?: string | undefined;
}): Promise<Facts> {
  const goalsText = input.goalsPath === undefined || input.goalsPath === '' ? null : (() => { try { return readFileSync(input.goalsPath, 'utf8'); } catch { return null; } })();
  const probePath = path.join(input.repo, 'packages', 'core', 'native', 'darwin-arm64', 'procinfo-probe');
  let sdk: Facts['sdk'] = null;
  try { sdk = await input.sdk(); } catch { sdk = null; }
  const status = git(input.repo, ['status', '--porcelain']);
  return {
    goalsPath: input.goalsPath, goalsText, expectedGoalsSha: input.expectedGoalsSha,
    goalsSchemaIssues: goalsText === null ? [] : input.goalsSchemaIssues(goalsText),
    platform: os.platform(), sandboxExec: existsSync('/usr/bin/sandbox-exec'), loopback: await bindsLoopback(),
    nativeProbe: { path: probePath, exists: existsSync(probePath), sha256: existsSync(probePath) ? sha256(readFileSync(probePath)) : null },
    probeVerdict: existsSync(probePath) ? (() => { const r = shippedProbe(path.dirname(probePath)); return 'reason' in r ? { ok: false, reason: r.reason } : { ok: true, reason: null }; })() : null,
    builds: readBuilds(input.buildStamp),
    dists: [distFact(input.repo, 'protocol'), distFact(input.repo, 'core')], sdk, repo: input.repo,
    handlerProbeStarted: await input.handlerProbeControl(), retry: input.retry,
    treeClean: status === '', treeHash: git(input.repo, ['rev-parse', 'HEAD^{tree}']), node: process.version, load: os.loadavg(),
  };
}
