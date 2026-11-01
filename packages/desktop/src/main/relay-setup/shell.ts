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
}

export interface RemoteShell {
  run(command: string, options?: RunOptions): Promise<RunResult>;
}
