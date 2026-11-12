import { describe, expect, it } from 'vitest';
import { buildOpencodeConfig } from './opencode-config.js';
import { OPENCODE_AUTO_FLAG, opencodeRoleLaunch } from './opencode-role.js';

const MCP = { workDir: '/work/w-1', sessionId: 's-01', projectPath: '/proj', workId: 'w-1', channel: false } as never;

describe('opencodeRoleLaunch', () => {
  it('a read-only role launches with the deny rules and without --auto', () => {
    const launch = opencodeRoleLaunch({ readOnly: true });
    expect(launch.autoFlag).toBeUndefined();
    expect(launch.permissions.filter((rule) => rule.effect === 'deny').map((rule) => rule.action)).toEqual(['edit', 'shell', 'webfetch', 'websearch', 'subagent']);
    // Parley tools are allowed last, so no deny rule can shadow them.
    expect(launch.permissions.at(-1)).toEqual({ action: 'parley_*', resource: '*', effect: 'allow' });
  });

  it('a writable role launches with --auto and no deny rule', () => {
    const launch = opencodeRoleLaunch({ readOnly: false });
    expect(launch.autoFlag).toBe(OPENCODE_AUTO_FLAG);
    expect(OPENCODE_AUTO_FLAG).toBe('--auto');
    expect(launch.permissions.some((rule) => rule.effect === 'deny')).toBe(false);
  });

  it('feeds buildOpencodeConfig: the config carries the same rules as the launch', () => {
    for (const readOnly of [true, false]) {
      const launch = opencodeRoleLaunch({ readOnly });
      expect(buildOpencodeConfig({ mcp: { ...MCP, command: undefined } as never, readOnly: launch.readOnly }).permissions).toEqual(launch.permissions);
    }
  });
});
