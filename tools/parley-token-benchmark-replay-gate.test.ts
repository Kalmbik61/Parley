// T9a harness, slice H4a-2: how the replay run is kept out of routine runs and made to run, explicitly, in the gate. Nothing in the gate may exclude or skip a test.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(path.join(here, name), 'utf8');
const RUN_FILE = 'parley-token-benchmark-replay.run.test.ts';

describe('the replay run file is excluded from routine runs by name, and only there', () => {
  it('the routine tools config excludes exactly two files by name, each with its reason: the replay run and the node:test observer', () => {
    const text = read('vitest.config.ts');
    expect(text.match(/exclude:/g)).toHaveLength(1);
    const list = /exclude: \[([^\]]*)\]/s.exec(text)![1]!;
    const entries = list.split('\n').map((l) => l.trim()).filter((l) => l.startsWith("'**/"));
    expect(entries).toEqual([
      "'**/parley-token-benchmark-replay.run.test.ts', // the full replay run: minutes, machine-bound, run by the gate script",
      "'**/bench/window-sync/observer.test.mjs', // a node:test file (`import { test } from 'node:test'`): vitest finds no suite in it, so it runs under `node --test`",
    ]);
    expect(list).toContain('...configDefaults.exclude');
  });
  it('the run config includes exactly that file, excludes nothing, and pins retry 0', () => {
    const text = read('vitest.replay-run.config.ts');
    expect(text).toContain(`include: ['${RUN_FILE}']`);
    expect(text).toMatch(/retry: 0,/);
    expect(text).not.toMatch(/^\s*exclude:/m);
    expect(text).not.toMatch(/\.skip|skipIf|todo/);
  });
});

describe('the gate script', () => {
  const text = read('parley-token-benchmark-replay-gate.sh');
  it('builds core and then protocol (protocol references core, so a checkout without dist fails the other way round), and stops when either build exits non-zero, before anything runs', () => {
    expect(text.indexOf('pnpm --filter @parley/core build')).toBeGreaterThan(0);
    expect(text.indexOf('pnpm --filter @parley/protocol build')).toBeGreaterThan(text.indexOf('pnpm --filter @parley/core build'));
    expect(read('../packages/protocol/tsconfig.json')).toContain('"references": [{ "path": "../core" }]');
    const stop = text.indexOf('if [ "$PROTOCOL" -ne 0 ] || [ "$CORE" -ne 0 ]; then');
    expect(stop).toBeGreaterThan(text.indexOf('CORE=$?'));
    expect(text.indexOf('exit 1', stop)).toBeGreaterThan(stop);
    expect(stop).toBeLessThan(text.indexOf('vitest run'));
  });
  it('writes both exit codes and a nonce for this run into the stamp the run reads', () => {
    expect(text).toContain('{"protocol":%s,"core":%s,"run":"%s"}');
    expect(text).toContain('RUN="$$-$(date +%s)"');
    expect(text).toContain('PARLEY_REPLAY_BUILD="$STAMP"');
  });
  it('runs the run file explicitly through its own config, with retry 0, one worker, and nothing that excludes or skips', () => {
    expect(text).toContain('--config tools/vitest.replay-run.config.ts');
    expect(text).not.toContain('--root');
    expect(text).toContain('--retry=0');
    expect(text).toContain('--no-file-parallelism --maxWorkers=1 --minWorkers=1');
    const command = text.split('\n').filter((l) => l.includes('vitest')).join('\n'); // the line(s) that start vitest: the report check below legitimately reads `skips`
    expect(command).toContain('vitest run');
    expect(command).not.toMatch(/--exclude|--passWithNoTests|\s-t\s|--testNamePattern|\.skip|skipIf|--bail=0/);
  });
  it('runs the node:test file under node --test and stops on a failure, before the replay run', () => {
    const at = text.indexOf('node --test tools/bench/window-sync/observer.test.mjs');
    expect(at).toBeGreaterThan(text.indexOf('CORE=$?'));
    expect(at).toBeLessThan(text.indexOf('vitest run'));
    expect(text.slice(at, text.indexOf('\n', at))).toContain('|| { echo "gate: observer.test.mjs failed under node --test" >&2; exit 1; }');
  });
  it('removes any earlier report before the run, so a stale pass can never be read', () => {
    expect(text.indexOf('rm -f "$OUT"')).toBeGreaterThan(0);
    expect(text.indexOf('rm -f "$OUT"')).toBeLessThan(text.indexOf('vitest run'));
    expect(text).toContain('PARLEY_REPLAY_REPORT="$OUT"');
  });
  it('fails unless the report judged every goal of the frozen file, counts no skip, is for that file, carries this run\'s stamp and says passed', () => {
    expect(text).toContain('r.goals !== expected');
    expect(text).toContain('JSON.parse(goalsText).goals.length');
    expect(text).toContain('r.skips.classic === 0 && r.skips.replacement === 0');
    expect(text).toContain('r.goalsSha !== crypto.createHash("sha256").update(goalsText).digest("hex")');
    expect(text).toContain('r.buildStamp !== fs.readFileSync(stampPath, "utf8")');
    expect(text).toContain('r.passed !== true');
    expect(text).toContain('there is no report at');
    expect(text.match(/process\.exit\(1\)/g)!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('the gate script, run: a stub pnpm stands for the builds and for vitest', () => {
  let dir = '';
  const SCRIPT = path.join(here, 'parley-token-benchmark-replay-gate.sh');
  const goalsText = JSON.stringify({ version: 1, goals: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  const goalsSha = createHash('sha256').update(goalsText).digest('hex');
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'parley-replay-gate-'));
    spawnSync('git', ['init', '-q', dir]);
    mkdirSync(path.join(dir, 'bin'));
    writeFileSync(path.join(dir, 'goals.json'), goalsText);
    mkdirSync(path.join(dir, 'tools', 'bench', 'window-sync'), { recursive: true });
    writeFileSync(path.join(dir, 'tools', 'bench', 'window-sync', 'observer.test.mjs'), "import { test } from 'node:test';\ntest('stands for the observer', () => {});\n");
    // the stub: `--filter <pkg> build` exits as STUB_<PKG>_BUILD says; `exec vitest` marks that it started and writes the report STUB_REPORT names (nothing when it is empty)
    writeFileSync(path.join(dir, 'bin', 'pnpm'), `#!/bin/sh
if [ "$1" = "--filter" ]; then
  case "$2" in
    @parley/protocol) exit "\${STUB_PROTOCOL_BUILD:-0}" ;;
    @parley/core) exit "\${STUB_CORE_BUILD:-0}" ;;
  esac
  exit 9
fi
if [ "$1" = "exec" ] && [ "$2" = "vitest" ]; then
  echo started > "${dir}/vitest-started"
  if [ -n "\${STUB_REPORT:-}" ]; then node -e 'const fs = require("node:fs"); const stamp = JSON.stringify(fs.readFileSync(process.env.PARLEY_REPLAY_BUILD, "utf8")).slice(1, -1); fs.writeFileSync(process.env.PARLEY_REPLAY_REPORT, process.env.STUB_REPORT.replace("@STAMP@", () => stamp));'; fi
  exit "\${STUB_VITEST_EXIT:-0}"
fi
exit 9
`);
    chmodSync(path.join(dir, 'bin', 'pnpm'), 0o755);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const run = (env: Record<string, string>) => {
    const out = path.join(dir, 'report.json');
    const r = spawnSync('sh', [SCRIPT, out], { cwd: dir, encoding: 'utf8', env: { PATH: `${path.join(dir, 'bin')}:${process.env['PATH']}`, HOME: process.env['HOME'] ?? '', TMPDIR: dir, PARLEY_REPLAY_GOALS: path.join(dir, 'goals.json'), ...env } });
    return { code: r.status, stderr: r.stderr, stdout: r.stdout, out, started: existsSync(path.join(dir, 'vitest-started')) };
  };
  // a report the stub writes: @STAMP@ is replaced by this run's stamp text, as the run file would copy it
  const report = (over: Record<string, unknown> = {}): string => JSON.stringify({ goals: 3, verdicts: 9, skips: { classic: 0, replacement: 0 }, goalsSha, buildStamp: '@STAMP@', passed: true, ...over }).replace('"@STAMP@"', '"@STAMP@"');

  it('a failed core build stops the gate before vitest starts; the stamp holds both codes and exit is 1', () => {
    const r = run({ STUB_CORE_BUILD: '1' });
    expect(r.code).toBe(1);
    expect(r.started).toBe(false);
    expect(r.stderr).toContain('a build failed (protocol 0, core 1)');
    const stamp = readFileSync(path.join(dir, readdirStamp()), 'utf8');
    expect(JSON.parse(stamp)).toMatchObject({ protocol: 0, core: 1 });
  });
  it('a node:test file that fails stops the gate before vitest starts', () => {
    writeFileSync(path.join(dir, 'tools', 'bench', 'window-sync', 'observer.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert';\ntest('fails', () => { assert.equal(1, 2); });\n");
    const r = run({ STUB_REPORT: report() });
    expect(r.code).toBe(1);
    expect(r.started).toBe(false);
    expect(r.stderr).toContain('observer.test.mjs failed under node --test');
  });
  it('a failed protocol build stops it too', () => {
    const r = run({ STUB_PROTOCOL_BUILD: '2' });
    expect(r.code).toBe(1);
    expect(r.started).toBe(false);
  });
  it('a full report for this run passes', () => {
    const r = run({ STUB_REPORT: report() });
    expect(r.started).toBe(true);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('3 goals');
  });
  it.each([
    ['a short report', { goals: 1 }, /judged 1 goals, the frozen file has 3/],
    ['no verdicts', { verdicts: 0 }, /no verdicts/],
    ['a skipped goal on the classic arm', { skips: { classic: 1, replacement: 0 } }, /counts skips/],
    ['a skipped goal on the replacement arm', { skips: { classic: 0, replacement: 2 } }, /counts skips/],
    ['no skips field', { skips: undefined }, /counts skips/],
    ['another goals file', { goalsSha: 'abc' }, /another goals file/],
    ['another run\'s stamp', { buildStamp: 'an older stamp' }, /not from this run/],
    ['passed false', { passed: false }, /passed=false/],
  ])('%s fails', (_name, over, message) => {
    const r = run({ STUB_REPORT: report(over) });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(message);
  });
  it('no report at all fails, and so does a stale passing report left by an earlier run', () => {
    expect(run({}).code).toBe(1);
    const stale = path.join(dir, 'report.json');
    writeFileSync(stale, report({ buildStamp: 'old' }));
    const r = run({});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('there is no report');
  });
  it('a vitest that fails fails the gate even with a good report on disk', () => {
    expect(run({ STUB_REPORT: report(), STUB_VITEST_EXIT: '1' }).code).toBe(1);
  });
  const readdirStamp = (): string => spawnSync('sh', ['-c', `ls ${dir} | grep '^parley-replay-build'`], { encoding: 'utf8' }).stdout.trim();
});

describe('the configs, run for real (vitest list reads the files without running a test)', () => {
  const repoRoot = path.resolve(here, '..');
  const list = (args: string[]): string => {
    const r = spawnSync('pnpm', ['exec', 'vitest', 'list', ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    return `${r.stdout}${r.stderr}`;
  };
  it('the gate\'s own command line finds the one run file from the repository root, and nothing else', () => {
    const out = list(['--config', 'tools/vitest.replay-run.config.ts']);
    expect(out).toContain('parley-token-benchmark-replay.run.test.ts');
    expect(out).toContain('judges every goal of the frozen file');
    expect(out).not.toMatch(/parley-token-benchmark-replay-(arms|data|host|judge)/);
    expect(out).not.toContain('Startup Error');
  }, 130_000);
  it('the routine tools run does not list the run file or the observer', () => {
    const out = list(['--root', 'tools']);
    expect(out).not.toContain('parley-token-benchmark-replay.run.test.ts');
    expect(out).not.toContain('observer.test.mjs');
    expect(out).toContain('parley-token-benchmark-replay-gate.test.ts');
  }, 130_000);
});
