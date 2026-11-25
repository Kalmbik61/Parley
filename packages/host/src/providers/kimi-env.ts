import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { agentEnv } from '@parley/core';

/** Preserve the user's Kimi/provider environment without parent-session authority. */
export function kimiLoginEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = agentEnv(inherited);
  for (const name of Object.keys(env)) {
    if (/^(?:PARLEY|HARNAS)_.*(?:TOKEN|CAPABILITY)$/i.test(name)) delete env[name];
  }
  env.KIMI_CODE_NO_AUTO_UPDATE = '1';
  return env;
}


/** Resolve the same user store the ACP and native CLI will open. */
export async function kimiHome(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  const home = path.resolve(cwd, env.KIMI_CODE_HOME || path.join(env.HOME || homedir(), '.kimi-code'));
  return realpath(home).catch(() => home);
}

export function kimiTerminalEnv(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = agentEnv(inherited);
  for (const name of Object.keys(env)) {
    if (/^(?:PARLEY|HARNAS)_/i.test(name)) delete env[name];
  }
  delete env.KIMI_CODE_EXPERIMENTAL_TOOL_SELECT;
  return env;
}
