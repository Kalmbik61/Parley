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
  /** Ends the process group of the running detached command (a second channel). */
  interrupt?(): Promise<RunResult>;
}

/** Where detached commands keep their log and exit code. Outside `/opt/parley-relay`: that one is created by a step and deleted by Remove. */
export const SETUP_DIR = '/var/tmp/parley-relay-setup';
export const COMMAND_ID = /^[a-z0-9-]+$/;

/**
 * Spec 7.3: the command runs in the background under `setsid flock -n lock`, with its output in `<id>.log`. The
 * background part owns the state: it holds the lock while it runs, writes `active` and `<id>.code`, and removes
 * `active` itself. The foreground part (the SSH channel) only follows the log with `tail` and removes nothing, so a
 * dropped channel changes nothing on the server. A second command while one runs fails on the lock (exit 255).
 */
export function detachedCommand(command: string, id: string, dir: string = SETUP_DIR): string {
  if (!COMMAND_ID.test(id)) throw new Error(`invalid command id: ${id}`);
  // The command runs in a subshell, so an `exit` inside it still lets the exit code be written.
  const background = `echo ${id} > ${dir}/active; (\n${command}\n); echo $? > ${dir}/${id}.code; rm -f ${dir}/active`;
  return [
    `D=${dir}; mkdir -p -m 0700 "$D"; rm -f "$D/${id}.code" "$D/pid"`,
    `setsid flock -n "$D/lock" sh -c ${shQuote(background)} > "$D/${id}.log" 2>&1 < /dev/null &`,
    `p=$!; echo "$p" > "$D/pid"`,
    `tail -n +1 -f --pid="$p" "$D/${id}.log"; [ -f "$D/${id}.code" ] && exit "$(cat "$D/${id}.code")"; exit 255`,
  ].join('\n');
}

/**
 * Kills the process group by the `pid` file; waits a moment for a command that has just started. `kill -s TERM`
 * and not `kill -TERM`: the `dash` of Ubuntu and Debian rejects `kill -TERM -- -<pgid>` (checked on ubuntu:24.04).
 */
export function interruptCommand(dir: string = SETUP_DIR): string {
  return [
    `D=${dir}; i=0`,
    `while [ ! -s "$D/pid" ] && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done`,
    `read -r pid < "$D/pid" || exit 1`,
    `case $pid in ''|*[!0-9]*) exit 1;; esac`,
    `kill -s TERM -- -"$pid"`,
  ].join('\n');
}
