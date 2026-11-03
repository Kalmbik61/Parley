import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_ID, SETUP_DIR, detachedCommand, interruptCommand } from './shell.js';

/**
 * The wrapper of spec 7.3 needs util-linux `setsid` and GNU `tail --pid`: it runs on this machine when they are there
 * (Linux), otherwise in a throw-away `ubuntu:24.04` container (Docker Desktop). With neither the tests are skipped.
 */
const hasLocal = spawnSync('sh', ['-c', 'command -v setsid >/dev/null && tail --pid=1 -n0 /dev/null 2>/dev/null; command -v setsid >/dev/null']).status === 0;
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

const DIR = hasLocal ? path.join(os.tmpdir(), `parley-wrap-${process.pid}`) : '/tmp/parley-relay-setup';
const w = (command: string, id = 'step-1'): string => detachedCommand(command, id, DIR);
/** The wrapper becomes a variable of the test script (quoted, as a sh -c argument is). */
const asVar = (name: string, text: string): string => `${name}='${text.replace(/'/g, `'\\''`)}'`;
/** Pids of processes with the given command name (Linux /proc). */
const PGREP = `pgrep_comm() { for p in /proc/[0-9]*; do read -r c < "$p/comm" 2>/dev/null; [ "$c" = "$1" ] && echo "\${p#/proc/}"; done; }`;

describe('the id of a command', () => {
  it('is [a-z0-9-]+ and nothing else is accepted', () => {
    expect(COMMAND_ID.test('image-1')).toBe(true);
    for (const bad of ['', 'Image', 'a b', 'a;b', 'a/../b', "a'b", 'a_b']) expect(() => detachedCommand('true', bad)).toThrow();
  });

  it('the setup directory is outside the install directory', () => {
    expect(SETUP_DIR.startsWith('/opt/parley-relay')).toBe(false);
    expect(interruptCommand()).toContain(`${SETUP_DIR}`);
  });
});

describe.skipIf(!available)(`the wrapper of spec 7.3 (${hasLocal ? 'local' : 'ubuntu:24.04 container'})`, () => {
  it('writes the log and the exit code, returns the output and the code of the command', () => {
    const out = runScript(
      `${asVar('W', w("echo hello; echo oops >&2; exit 3"))}\nsh -c "$W"; echo "wrapper-exit=$?"\necho "code=$(cat ${DIR}/step-1.code)"\ncat ${DIR}/step-1.log\ntest -e ${DIR}/active && echo ACTIVE-LEFT || echo no-active\nls -ld ${DIR}`,
    );
    expect(out).toContain('hello');
    expect(out).toContain('oops');
    expect(out).toContain('wrapper-exit=3');
    expect(out).toContain('code=3');
    expect(out).toContain('no-active');
    expect(out).toMatch(/drwx------/);
  });

  it('a dead channel (tail killed) does not stop the command: it finishes and writes its code', () => {
    const out = runScript(
      [
        PGREP,
        asVar('W', w('sleep 2; echo finished-late; exit 7')),
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sleep 1',
        'for p in $(pgrep_comm tail); do kill "$p"; done',
        'sleep 3',
        `echo "code=$(cat ${DIR}/step-1.code)"`,
        `cat ${DIR}/step-1.log`,
      ].join('\n'),
    );
    expect(out).toContain('code=7');
    expect(out).toContain('finished-late');
  });

  it('the interrupt kills the group by the pid file and stops the command and its children', () => {
    const out = runScript(
      [
        PGREP,
        asVar('W', w('sleep 60 & sleep 61; echo never')),
        asVar('I', interruptCommand(DIR)),
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sleep 1',
        `echo "active=$(cat ${DIR}/active)"; echo "pid=$(cat ${DIR}/pid)"`,
        'sh -c "$I"; echo "interrupt-exit=$?"',
        'sleep 1',
        `echo "sleepers=$(pgrep_comm sleep | wc -l)"`,
        `cat ${DIR}/step-1.log`,
        `test -e ${DIR}/active && echo ACTIVE-LEFT || echo no-active`,
        `flock -n ${DIR}/lock true && echo lock-free || echo lock-held`,
      ].join('\n'),
    );
    expect(out).toContain('active=step-1');
    expect(out).toMatch(/pid=\d+/);
    expect(out).toContain('interrupt-exit=0');
    expect(out).toContain('sleepers=0');
    expect(out).not.toContain('never');
    // A killed command cannot clean up: `active` stays (the survey reads it), the kernel frees the lock.
    expect(out).toContain('ACTIVE-LEFT');
    expect(out).toContain('lock-free');
  });

  it('a dead channel removes nothing: the lock and active stay while the command runs; a second command is refused', () => {
    const out = runScript(
      [
        PGREP,
        asVar('W', w('sleep 3; echo first-done')),
        asVar('W2', w('echo second-ran', 'step-2')),
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sleep 1',
        'for p in $(pgrep_comm tail); do kill "$p"; done',
        'sleep 0.5',
        `echo "active-after-drop=$(cat ${DIR}/active)"`,
        'sh -c "$W2" > /dev/null 2>&1; echo "second-exit=$?"',
        `test -e ${DIR}/step-2.log && cat ${DIR}/step-2.log`,
        'sleep 3',
        `echo "first-code=$(cat ${DIR}/step-1.code)"`,
        `test -e ${DIR}/active && echo ACTIVE-LEFT || echo no-active`,
      ].join('\n'),
    );
    expect(out).toContain('active-after-drop=step-1');
    expect(out).toContain('second-exit=255');
    expect(out).not.toContain('second-ran');
    expect(out).toContain('first-code=0');
    expect(out).toContain('no-active');
  });

  it('the interrupt waits for a command that has just started', () => {
    const out = runScript(
      [
        PGREP,
        asVar('W', w('sleep 60')),
        asVar('I', interruptCommand(DIR)),
        `rm -rf ${DIR}`,
        `sh -c "$W" > /dev/null 2>&1 &`,
        'sh -c "$I"; echo "interrupt-exit=$?"',
        'sleep 1',
        `echo "sleepers=$(pgrep_comm sleep | wc -l)"`,
      ].join('\n'),
    );
    expect(out).toContain('interrupt-exit=0');
    expect(out).toContain('sleepers=0');
  });

  it('a hostile command text stays inside the quoted script', () => {
    const out = runScript(`${asVar('W', w("echo 'a'\\''b'; echo \"$HOME\" > /dev/null"))}\nsh -c "$W"; echo "exit=$?"`);
    expect(out).toContain("a'b");
    expect(out).toContain('exit=0');
  });
});
