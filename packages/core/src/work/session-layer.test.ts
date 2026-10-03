import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import {
  buildSessionLayer,
  developerInstructions,
  querySpawnLimits,
  validateLayerArguments,
  validateSpawnBudget,
} from './session-layer.js';

const limits = { argMax: 1048576, pointerSize: 8 };

describe('common session layer', () => {
  it('orders every block and omits empty blocks without persisting anything', () => {
    const result = buildSessionLayer({
      guidance: 'GUIDE',
      bridge: 'BRIDGE',
      role: 'ROLE',
      playbook: 'PLAYBOOK',
      isLead: true,
      brief: 'BRIEF',
      parleyMd: 'RULES',
      memoryFacts: 'FACTS',
    });
    expect(result.text).toBe(
      'GUIDE\n\nBRIDGE\n\nROLE\n\nPLAYBOOK\n\nBRIEF\n\nTeam rules of this project (PARLEY.md):\nRULES\n\nFACTS',
    );
    expect(result.warnings).toEqual([]);
    expect(
      buildSessionLayer({
        guidance: 'GUIDE',
        role: 'ROLE',
        nativeClaudeRole: true,
        playbook: 'SECRET RECIPE',
        isLead: false,
      }).text,
    ).toBe('GUIDE');
  });

  it('marks role and lead playbook truncation with retained boundaries and bounded bytes', () => {
    const source = 'first\n' + 'Ж'.repeat(20000);
    const result = buildSessionLayer({
      guidance: 'GUIDE',
      role: source,
      playbook: source,
      isLead: true,
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'role-truncated',
      'recipe-playbook-truncated',
    ]);
    expect(result.text).toContain('first\n[Role is cut at 32 KB by Parley]');
    expect(result.text).toContain('first\n[Playbook is cut at 32 KB by Parley]');
    expect(result.blockBytes.role).toBeLessThanOrEqual(32768);
    expect(result.blockBytes.playbook).toBeLessThanOrEqual(32768);
  });

  it('rejects an oversized memory block safely, with numeric evidence and no content', () => {
    const facts = 'private fact '.repeat(2000);
    expect(() => buildSessionLayer({ guidance: 'GUIDE', memoryFacts: facts })).toThrow(
      'session-layer-too-large',
    );
    try {
      buildSessionLayer({ guidance: 'GUIDE', memoryFacts: facts });
    } catch (error) {
      expect(String(error)).not.toContain('private fact');
    }
  });

  it('checks the final escaped argument, not the pre-escaping text length', () => {
    const text = '\u0001'.repeat(17000);
    const result = buildSessionLayer({ guidance: text });
    expect(Buffer.byteLength(text)).toBeLessThan(98304);
    expect(() =>
      validateLayerArguments([developerInstructions(result.text)], result.blockBytes),
    ).toThrow('session-layer-too-large');
    const prefix = 'developer_instructions=';
    const fit = prefix + JSON.stringify('x'.repeat(98304 - Buffer.byteLength(prefix) - 2));
    expect(() => validateLayerArguments([fit])).not.toThrow();
    expect(() => validateLayerArguments([fit + 'x'])).toThrow('session-layer-too-large');
    const customLayer = 'x'.repeat(98305);
    expect(() =>
      validateLayerArguments(['--context', customLayer], result.blockBytes, customLayer),
    ).toThrow('session-layer-too-large');
  });

  it('serializes TOML-safe control characters and counts DEL escaping before the ceiling', () => {
    const text =
      Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('') +
      '\u007f\u0080\u009f quote " \\ Ж🙂';
    const assignment = developerInstructions(text);
    expect(parseToml(assignment).developer_instructions).toBe(text);
    expect(assignment).not.toContain('\u007f');
    const prefixBytes = Buffer.byteLength('developer_instructions=""');
    const fit = '\u007f'.repeat(Math.floor((98304 - prefixBytes) / 6));
    expect(() => validateLayerArguments([developerInstructions(fit)])).not.toThrow();
    expect(() => validateLayerArguments([developerInstructions(fit + '\u007f')])).toThrow(
      'session-layer-too-large',
    );
  });

  it('JSON serialization preserves quotes, backslashes, line breaks and Unicode', () => {
    const text = 'quote " \\\nЖ🙂';
    expect(JSON.parse(developerInstructions(text).slice('developer_instructions='.length))).toBe(
      text,
    );
  });
});

describe('final spawn budget', () => {
  it('counts executable, args, final environment, NULs, pointers and reserve', () => {
    const result = validateSpawnBudget(
      '/bin/tool',
      ['Ж'],
      { TOKEN: '🙂', ABSENT: undefined },
      limits,
    );
    expect(result.stringBytes).toBe(10 + 3 + 11);
    expect(result.pointerBytes).toBe(8 * (2 + 1 + 2));
    expect(result.estimatedBytes).toBe(result.stringBytes + result.pointerBytes + 32768);
  });

  it('rejects the aggregate after final inherited environment even with short args', () => {
    expect(() =>
      validateSpawnBudget(
        '/bin/tool',
        ['ok'],
        { PRIVATE: 'secret'.repeat(10000) },
        { argMax: 50000, pointerSize: 8 },
      ),
    ).toThrow('spawn-budget-too-large');
  });

  it('rejects NUL and Linux per-string overflow without exposing any values', () => {
    expect(() => validateSpawnBudget('/bin/tool', ['private\0secret'], {}, limits)).toThrow(
      'spawn-budget-invalid',
    );
    expect(() =>
      validateSpawnBudget(
        '/bin/tool',
        [],
        { SECRET: 's'.repeat(131072) },
        { ...limits, maxStringBytes: 131072 },
      ),
    ).toThrow('spawn-budget-too-large');
  });

  it('unknown or malformed native limits fail safely', () => {
    expect(() => validateSpawnBudget('/bin/tool', [], {}, null)).toThrow(
      'spawn-budget-unavailable',
    );
    expect(() =>
      validateSpawnBudget('/bin/tool', [], {}, { argMax: Number.NaN, pointerSize: 8 }),
    ).toThrow('spawn-budget-unavailable');
  });

  it('queries ARG_MAX and Linux page size, accepts no guessed fallback on query failure', async () => {
    const queried: string[] = [];
    const getconf = async (name: string): Promise<number | null> => {
      queried.push(name);
      return name === 'ARG_MAX' ? 2097152 : 4096;
    };
    expect(await querySpawnLimits({ platform: 'linux', pointerSize: 8, getconf })).toEqual({
      argMax: 2097152,
      pointerSize: 8,
      maxStringBytes: 131072,
    });
    expect(queried).toEqual(['ARG_MAX', 'PAGESIZE']);
    expect(
      await querySpawnLimits({ platform: 'linux', pointerSize: 8, getconf: async () => null }),
    ).toBeNull();
  });
});
