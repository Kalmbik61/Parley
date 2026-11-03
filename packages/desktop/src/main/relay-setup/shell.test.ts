import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_ID, SETUP_DIR, detachedCommand, interruptCommand } from './shell.js';

/**
 * The wrapper of spec 7.3 needs util-linux `setsid` and GNU `tail --pid`: it runs on this machine when they are there
 * (Linux, as root), otherwise in a throw-away `ubuntu:24.04` container (Docker Desktop). With neither the tests are skipped.
 */
// The directory check wants root as the owner, so a local run needs root too.
const hasLocal = process.getuid?.() === 0 && spawnSync('sh', ['-c', 'command -v setsid >/dev/null && command -v flock >/dev/null']).status === 0;
const hasDocker = (): boolean => spawnSync('docker', ['image', 'inspect', 'ubuntu:24.04'], { stdio: 'ignore' }).status === 0;
const available = hasLocal || hasDocker();
// A container start takes seconds, more under the load of the whole suite.
vi.setConfig({ testTimeout: 60_000 });

/** Runs a shell script and returns its stdout. The script gets the setup directory as `$DIR`. */
function runScript(script: string): string {
  const work = mkdtempSync(path.join(os.tmpdir(), 'wrap-'));
  writeFileSync(path.join(work, 'run.sh'), script);
  if (hasLocal) return execFileSync('sh', [path.join(work, 'run.sh')], { encoding: 'utf8', timeout: 60_000 });
  return execFileSync('docker', ['run', '--rm', '-v', `${work}:/work`, 'ubuntu:24.04', 'sh', '/work/run.sh'], { encoding: 'utf8', timeout: 120_000 });
}

const DIR = SETUP_DIR;
const w = (command: string, id = 'step-1'): string => detachedCommand(command, id, DIR);
const intr = (id = 'step-1'): string => interruptCommand(id, DIR);
/** The wrapper becomes a variable of the test script (quoted, as a sh -c argument is). */
const asVar = (name: string, text: string): string => `${name}='${text.replace(/'/g, `'\\''`)}'`;
/** Pids of processes with the given command name (Linux /proc). */
const PGREP = `pgrep_comm() { for p in /proc/[0-9]*; do read -r c < "$p/comm" 2>/dev/null; [ "$c" = "$1" ] && echo "\${p#/proc/}"; done; }`;

describe('the id of a command', () => {
  it('is [a-z0-9-]+ and nothing else is accepted', () => {
    expect(COMMAND_ID.test('image-1')).toBe(true);
    for (const bad of ['', 'Image', 'a b', 'a;b', 'a/../b', "a'b", 'a_b']) {
      expect(() => detachedCommand('true', bad)).toThrow();
      expect(() => interruptCommand(bad)).toThrow();
    }
  });

  it('the setup directory is under /var/lib (root-only parent) and outside the install directory', () => {
    expect(SETUP_DIR).toBe('/var/lib/parley-relay-setup');
    expect(SETUP_DIR.startsWith('/opt/parley-relay')).toBe(false);
  });
});

describe.skipIf(!available)(`the wrapper of spec 7.3 (${hasLocal ? 'local' : 'ubuntu:24.04 container'})`, () => {
  it('writes the log and the exit code, returns the output and the code of the command; no state is left', () => {
    const out = runScript(
      `${asVar('W', w('echo hello; echo oops >&2; exit 3'))}\nsh -c "$W"; echo "wrapper-exit=$?"\necho "code=$(cat ${DIR}/step-1.code)"\ncat ${DIR}/step-1.log\nls ${DIR}\nls -ld ${DIR}`,
    );
    expect(out).toContain('hello');
    expect(out).toContain('oops');
    expect(out).toContain('wrapper-exit=3');
    expect(out).toContain('code=3');
    expect(out).not.toMatch(/^active$/m);
    expect(out).not.toMatch(/step-1\.pid/);
    expect(out).toMatch(/drwx------/);
  });

  it('a dead channel (tail killed) does not stop the command: it finishes and writes its code', () => {
    const out = runScript(
      [PGREP, asVar('W', w('sleep 2; echo finished-late; exit 7')), `sh -c "$W" > /dev/null 2>&1 &`, 'sleep 1', 'for p in $(pgrep_comm tail); do kill "$p"; done', 'sleep 3', `echo "code=$(cat ${DIR}/step-1.code)"`, `cat ${DIR}/step-1.log`].join('\n'),
    );
    expect(out).toContain('code=7');
    expect(out).toContain('finished-late');
  });

  it('a dead channel removes nothing: active, the pid file and the lock stay while the command runs; a second command is refused with a reason', () => {
    const out = runScript(
      [
        PGREP,
        asVar('W', w('sleep 3; echo first-done')),
        asVar('W2', w('echo second-ran', 'step-2')),
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sleep 1',
        'for p in $(pgrep_comm tail); do kill "$p"; done',
        'sleep 0.5',
        `echo "active-after-drop=$(cat ${DIR}/active)"; test -s ${DIR}/step-1.pid && echo pid-kept`,
        'sh -c "$W2"; echo "second-exit=$?"',
        'sleep 3',
        `echo "first-code=$(cat ${DIR}/step-1.code)"`,
        `test -e ${DIR}/active && echo ACTIVE-LEFT || echo no-active`,
        `test -e ${DIR}/step-1.pid && echo PID-LEFT || echo no-pid`,
      ].join('\n'),
    );
    expect(out).toContain('active-after-drop=step-1');
    expect(out).toContain('pid-kept');
    expect(out).toContain('another setup command is still running on the server');
    expect(out).toContain('second-exit=255');
    expect(out).not.toContain('second-ran');
    expect(out).toContain('first-code=0');
    expect(out).toContain('no-active');
    expect(out).toContain('no-pid');
  });

  it('the pid file holds the process GROUP (the leader is flock, not sh)', () => {
    const out = runScript(
      [asVar('W', w('sleep 2')), `sh -c "$W" > /dev/null 2>&1 &`, 'sleep 1', `pgid=$(cat ${DIR}/step-1.pid)`, 'echo "members=$(ps -o pid=,pgid= -g $pgid | wc -l)"', `echo "flock-pgid=$(ps -o pgid= -C flock | tr -d ' ')"`, 'echo "pgid=$pgid"', 'sleep 2'].join('\n'),
    );
    const pgid = /pgid=(\d+)/.exec(out)?.[1];
    expect(pgid).toBeDefined();
    expect(out).toContain(`flock-pgid=${pgid}`);
    expect(Number(/members=(\d+)/.exec(out)?.[1])).toBeGreaterThanOrEqual(2);
  });

  it('a child that outlives the command does not keep the lock (flock -o)', () => {
    const out = runScript([asVar('W', w('setsid sleep 4 > /dev/null 2>&1 < /dev/null &')), 'sh -c "$W"; echo "exit=$?"', `flock -n ${DIR}/lock true && echo lock-free || echo lock-held`].join('\n'));
    expect(out).toContain('exit=0');
    expect(out).toContain('lock-free');
  });

  it('the interrupt kills the group of its command and its children, clears active and the pid file, frees the lock', () => {
    const out = runScript(
      [
        PGREP,
        asVar('W', w('sleep 60 & sleep 61; echo never')),
        asVar('I', intr()),
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sleep 1',
        `echo "active=$(cat ${DIR}/active)"; echo "pid=$(cat ${DIR}/step-1.pid)"`,
        'sh -c "$I"; echo "interrupt-exit=$?"',
        'sleep 1',
        `echo "sleepers=$(pgrep_comm sleep | wc -l)"`,
        `cat ${DIR}/step-1.log`,
        `test -e ${DIR}/active && echo ACTIVE-LEFT || echo no-active`,
        `test -e ${DIR}/step-1.pid && echo PID-LEFT || echo no-pid`,
        `flock -n ${DIR}/lock true && echo lock-free || echo lock-held`,
      ].join('\n'),
    );
    expect(out).toContain('active=step-1');
    expect(out).toMatch(/pid=\d+/);
    expect(out).toContain('interrupt-exit=0');
    expect(out).toContain('sleepers=0');
    expect(out).not.toContain('never');
    expect(out).toContain('no-active');
    expect(out).toContain('no-pid');
    expect(out).toContain('lock-free');
  });

  it('the interrupt waits for a command that has just started', () => {
    const out = runScript(
      [PGREP, asVar('W', w('sleep 60')), asVar('I', intr()), `rm -rf ${DIR}`, `sh -c "$W" > /dev/null 2>&1 &`, 'sh -c "$I"; echo "interrupt-exit=$?"', 'sleep 1', `echo "sleepers=$(pgrep_comm sleep | wc -l)"`].join('\n'),
    );
    expect(out).toContain('interrupt-exit=0');
    expect(out).toContain('sleepers=0');
  });

  it('the interrupt kills nothing for another command, or on stale state with a free lock', () => {
    const out = runScript(
      [
        PGREP,
        // A live process in its own group whose number sits in a stale pid file; the lock is free.
        'setsid sleep 30 & victim=$!',
        'sleep 0.3',
        `mkdir -p -m 0700 ${DIR}; echo step-1 > ${DIR}/active; echo $victim > ${DIR}/step-1.pid`,
        asVar('I', intr()),
        'sh -c "$I"; echo "stale-exit=$?"',
        'kill -0 $victim 2>/dev/null && echo victim-alive || echo victim-dead',
        // A running command of another id.
        asVar('W', w('sleep 30', 'other-1')),
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sleep 1',
        'sh -c "$I"; echo "other-exit=$?"',
        `test -s ${DIR}/other-1.pid && echo other-alive || echo other-dead`,
        'kill $victim',
      ].join('\n'),
    );
    expect(out).toContain('stale-exit=1');
    expect(out).toContain('victim-alive');
    expect(out).toContain('other-exit=1');
    expect(out).toContain('other-alive');
  }, 60_000);

  it('an unsafe directory (not root-only, or a link) stops the command before it writes anything', () => {
    const out = runScript(
      [
        asVar('W', w('echo should-not-run')),
        `mkdir -p ${DIR}; chmod 777 ${DIR}`,
        'sh -c "$W"; echo "open-exit=$?"',
        `rm -rf ${DIR}; mkdir /tmp/elsewhere; chmod 700 /tmp/elsewhere; ln -s /tmp/elsewhere ${DIR}`,
        'sh -c "$W"; echo "link-exit=$?"',
        'ls /tmp/elsewhere | wc -l',
      ].join('\n'),
    );
    expect(out.match(/unsafe/g)?.length).toBe(2);
    expect(out).toContain('open-exit=254');
    expect(out).toContain('link-exit=254');
    expect(out).not.toContain('should-not-run');
    expect(out.trim().split('\n').at(-1)).toBe('0');
  });

  it('a quick command never loses its output or code, however the processes are scheduled', () => {
    const out = runScript(
      [
        asVar('W', w('echo quick-output')),
        'bad=0; n=0',
        'while [ $n -lt 60 ]; do n=$((n+1)); o=$(sh -c "$W" 2>&1); c=$?; [ "$c" = 0 ] && [ "$o" = quick-output ] || { bad=$((bad+1)); echo "round $n: code=$c out=$o"; }; done',
        'echo "bad=$bad"',
      ].join('\n'),
    );
    expect(out).toContain('bad=0');
  });

  it('a hostile command text stays inside the quoted script', () => {
    const out = runScript(`${asVar('W', w("echo 'a'\\''b'; echo \"$HOME\" > /dev/null"))}\nsh -c "$W"; echo "exit=$?"`);
    expect(out).toContain("a'b");
    expect(out).toContain('exit=0');
  });
});
