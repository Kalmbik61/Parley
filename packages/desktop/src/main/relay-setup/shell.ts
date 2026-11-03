import { shQuote } from './input.js';

/** What the wizard needs from an SSH connection. The real one is in `ssh.ts`; tests use a fake. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Run as root (`sudo`, or directly when the user is root). */
  sudo?: boolean;
  /** Every output line as it arrives (for the live log). */
  onLine?: (line: string) => void;
  /**
   * Run the command on the server apart from the SSH channel (spec 7.3), under this id (`[a-z0-9-]+`): a dropped
   * connection no longer kills it. For the commands of a step, not for checks.
   */
  detach?: string;
}

export interface RemoteShell {
  run(command: string, options?: RunOptions): Promise<RunResult>;
  /** Ends the process group of the running detached command `id` (a second channel); non-zero exit: nothing was killed. */
  interrupt?(id: string): Promise<RunResult>;
}

/** The SSH connection closed under a command (or the view of it timed out). The command itself goes on on the server. */
export class ConnectionLostError extends Error {
  constructor(message = 'the connection to the server was lost') {
    super(message);
    this.name = 'ConnectionLostError';
  }
}

/**
 * Where detached commands keep their lock, log, exit code and process group. `/var/lib` belongs to root: an ordinary
 * user cannot create the directory or a link in it beforehand (in `/var/tmp` they could, and root would follow them).
 * Outside `/opt/parley-relay`: that one is created by a step and deleted by Remove.
 */
export const SETUP_DIR = '/var/lib/parley-relay-setup';
export const COMMAND_ID = /^[a-z0-9-]+$/;

/**
 * Spec 7.3: the command runs in the background under `setsid flock -n -o lock` with its output in `<id>.log`. The
 * background part owns the state: it holds the lock while it runs (`-o`: the children of the command do not inherit
 * it), writes `active`, the process group in `<id>.pid` and `<id>.code`, and removes `active` and the pid file itself.
 * The foreground part (the SSH channel) only follows the log with `tail` and removes nothing, so a dropped channel
 * changes nothing on the server. A second command while one runs fails on the lock (exit 255 and a line saying why).
 */
export function detachedCommand(command: string, id: string, dir: string = SETUP_DIR): string {
  if (!COMMAND_ID.test(id)) throw new Error(`invalid command id: ${id}`);
  // `ps -o pgid=`: after `setsid` the leader of the group is `flock` and `sh` is its child, so `$$` is not the group.
  // The command runs in a subshell, so an `exit` inside it still lets the exit code be written.
  const background = `echo ${id} > ${dir}/active; ps -o pgid= -p $$ | tr -d " " > ${dir}/${id}.pid; (\n${command}\n); echo $? > ${dir}/${id}.code; rm -f ${dir}/active ${dir}/${id}.pid`;
  return [
    `D=${dir}; mkdir -p -m 0700 "$D"`,
    `[ "$(stat -c %u:%a "$D")" = "0:700" ] && [ ! -L "$D" ] || { echo "unsafe $D"; exit 254; }`,
    // The log is created before the background part starts: `tail` must find it even if the child is not scheduled yet.
    `: > "$D/${id}.log"; rm -f "$D/${id}.code"`,
    `setsid flock -n -o "$D/lock" sh -c ${shQuote(background)} >> "$D/${id}.log" 2>&1 < /dev/null &`,
    `tail -n +1 -f --pid=$! "$D/${id}.log"`,
    `[ -f "$D/${id}.code" ] && exit "$(cat "$D/${id}.code")"`,
    `flock -n "$D/lock" true || echo "another setup command is still running on the server"; exit 255`,
  ].join('\n');
}

/**
 * Cancels only the command `id`: the lock is held, `active` is this id and its pid file exists (retried every 0.2 s
 * for up to 5 s: the command may just be starting). A stale pid (after a reboot, or a finished command) is never
 * used: with the lock free nothing is killed. Then waits for the kernel to free the lock and clears `active`, so the
 * next survey does not report a command that «died mid-run» for a cancel we asked for. `kill -s TERM`: the `dash` of
 * Ubuntu and Debian rejects `kill -TERM -- -<pgid>`.
 */
export function interruptCommand(id: string, dir: string = SETUP_DIR): string {
  if (!COMMAND_ID.test(id)) throw new Error(`invalid command id: ${id}`);
  return [
    `D=${dir}; i=0; ok=`,
    `while [ $i -lt 25 ]; do`,
    `  if [ "$(cat "$D/active" 2>/dev/null)" = ${id} ] && [ -s "$D/${id}.pid" ] && ! flock -n "$D/lock" true; then ok=1; break; fi`,
    `  sleep 0.2; i=$((i+1))`,
    `done`,
    `[ -n "$ok" ] || exit 1`,
    `read -r pid < "$D/${id}.pid" || exit 1`,
    `case $pid in ''|*[!0-9]*) exit 1;; esac`,
    `kill -s TERM -- -"$pid" || exit 1`,
    `i=0; while ! flock -n "$D/lock" true && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`,
    `if flock -n "$D/lock" true; then [ "$(cat "$D/active" 2>/dev/null)" = ${id} ] && rm -f "$D/active"; rm -f "$D/${id}.pid"; fi`,
    'exit 0',
  ].join('\n');
}
