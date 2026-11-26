import { describe, expect, it } from 'vitest';
import { kimiTerminalEnv } from './kimi-env.js';

describe('kimiTerminalEnv', () => {
  it.each([undefined, '0'])('disables auto-update when inherited flag is %s', (flag) => {
    const env = kimiTerminalEnv({ KIMI_CODE_NO_AUTO_UPDATE: flag });

    expect(env.KIMI_CODE_NO_AUTO_UPDATE).toBe('1');
  });

  it('strips Parley and Harnas variables while preserving the provider environment', () => {
    const inherited = {
      PARLEY_AGENT_TOKEN: 'parent-token',
      PARLEY_SESSION_ID: 'parent-session',
      HARNAS_HOOK_TOKEN: 'parent-hook-token',
      HARNAS_CAPABILITY: 'parent-capability',
      parley_custom: 'parent-value',
      harnas_custom: 'parent-value',
      KIMI_CODE_HOME: '/tmp/kimi-home',
      KIMI_API_KEY: 'provider-key',
      PATH: '/usr/bin',
    };

    const env = kimiTerminalEnv(inherited);

    expect(Object.keys(env).filter((name) => /^(?:PARLEY|HARNAS)_/i.test(name))).toEqual([]);
    expect(env).toMatchObject({
      KIMI_CODE_HOME: inherited.KIMI_CODE_HOME,
      KIMI_API_KEY: inherited.KIMI_API_KEY,
      PATH: inherited.PATH,
    });
    expect(inherited.PARLEY_AGENT_TOKEN).toBe('parent-token');
  });
});
