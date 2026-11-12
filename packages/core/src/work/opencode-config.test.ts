import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_SERVER_ENTRY } from './mcp-config.js';
import {
  buildOpencodeConfig,
  opencodeCliConfigContent,
  opencodeConfigContent,
  opencodePermissions,
  type OpencodeConfig,
} from './opencode-config.js';

const mcp = { workDir: '/w/.parley/works/w-0001', sessionId: 's-7', command: '/opt/node/bin/node' };

describe('buildOpencodeConfig', () => {
  it('writable role without a model: Parley MCP, only the parley allow rule, no model', () => {
    expect(buildOpencodeConfig({ mcp })).toMatchInlineSnapshot(`
      {
        "autoupdate": false,
        "mcp": {
          "parley": {
            "command": [
              "/opt/node/bin/node",
            ],
            "environment": {
              "HARNAS_SESSION_ID": "s-7",
              "HARNAS_WORK_DIR": "/w/.parley/works/w-0001",
              "PARLEY_SESSION_ID": "s-7",
              "PARLEY_WORK_DIR": "/w/.parley/works/w-0001",
            },
            "type": "local",
          },
        },
        "permissions": [
          {
            "action": "parley_*",
            "effect": "allow",
            "resource": "*",
          },
        ],
      }
    `);
  });

  it('read-only role with a model: denies first, parley allow last, model kept as given', () => {
    const config = buildOpencodeConfig({ mcp, readOnly: true, model: 'opencode/big-pickle#high' });
    expect(config.model).toBe('opencode/big-pickle#high');
    expect(config.permissions.map((p) => `${p.effect}:${p.action}`)).toEqual([
      'deny:edit', 'deny:shell', 'deny:webfetch', 'deny:websearch', 'deny:subagent', 'allow:parley_*',
    ]);
    expect(config.permissions.at(-1)).toEqual({ action: 'parley_*', resource: '*', effect: 'allow' });
  });

  it('read-only role without a model, and writable role with one', () => {
    expect(buildOpencodeConfig({ mcp, readOnly: true })).not.toHaveProperty('model');
    expect(buildOpencodeConfig({ mcp, model: 'mock/mock-1' })).toMatchObject({ model: 'mock/mock-1', permissions: opencodePermissions(false) });
  });

  it('puts the session channel and tool profile into the MCP environment', () => {
    const env = buildOpencodeConfig({ mcp: { ...mcp, channel: true, toolProfile: 'short' } }).mcp['parley']!.environment;
    expect(env).toMatchObject({ PARLEY_CHANNEL: '1', PARLEY_TOOL_PROFILE: 'short' });
  });

  it('default launch is the absolute node and the absolute MCP entry (no relative path)', () => {
    const config = buildOpencodeConfig({ mcp: { workDir: '/w', sessionId: 's-1' } });
    const command = config.mcp['parley']!.command;
    expect(command).toEqual([process.execPath, MCP_SERVER_ENTRY]);
    expect(command.every((part) => path.isAbsolute(part))).toBe(true);
  });

  it.each(['node', './node', 'parley-mcp'])('refuses the relative command %s', (command) => {
    expect(() => buildOpencodeConfig({ mcp: { ...mcp, command } })).toThrow(/absolute/);
  });

  it.each(['', 'gpt', '/x', 'a/', 'a b/c', 'a/b#', 'a/b#c#d'])('refuses the model %j', (model) => {
    expect(() => buildOpencodeConfig({ mcp, model })).toThrow(/provider\/model/);
  });
});

describe('env documents', () => {
  it('OPENCODE_CONFIG_CONTENT is the JSON of the config', () => {
    const params = { mcp, readOnly: true, model: 'mock/mock-1' };
    expect(JSON.parse(opencodeConfigContent(params)) as OpencodeConfig).toEqual(buildOpencodeConfig(params));
  });
  it('OPENCODE_CLI_CONFIG_CONTENT switches the release highlights off', () => {
    expect(JSON.parse(opencodeCliConfigContent())).toEqual({ highlights: false });
  });
});
