import { homedir } from 'node:os';
import path from 'node:path';

/** Qwen home: `$QWEN_HOME` when it is an absolute path, else `<HOME>/.qwen`. */
export function qwenHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.QWEN_HOME;
  if (override && path.isAbsolute(override)) return override;
  return path.join(env.HOME || homedir(), '.qwen');
}
