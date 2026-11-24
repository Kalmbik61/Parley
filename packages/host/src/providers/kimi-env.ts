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
