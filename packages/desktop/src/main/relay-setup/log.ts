import { appendFile, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Replaces every secret value of this run with `***`, wherever it turns up (command output, error texts). */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret !== '') out = out.split(secret).join('***');
  return out;
}

export interface RunLog {
  write(line: string): Promise<void>;
}

/**
 * `~/.parley/remote/relay-setup.log`, 0600 (spec 6.7). The file holds commands as shown on the screen and the
 * server's output, with the run's secrets masked; file bodies of `.env` are never written (the plan shows its name only).
 */
export function createRunLog(file: string, secrets: () => readonly string[], now: () => Date = () => new Date()): RunLog {
  let prepared = false;
  return {
    async write(line) {
      if (!prepared) {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, '', { mode: 0o600 });
        await chmod(file, 0o600);
        prepared = true;
      }
      await appendFile(file, `${now().toISOString()} ${redactSecrets(line, secrets())}\n`, { mode: 0o600 });
    },
  };
}
