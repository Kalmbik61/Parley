import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOOLS as PARLEY_TOOLS } from '../mcp/tools.js';
import { CODEX_TOOL_EXAMPLES, OPENCODE_TOOL_EXAMPLES } from './guidance.js';

describe('OPENCODE_TOOL_EXAMPLES', () => {
  it('is the Code Mode bridge text', () => {
    expect(OPENCODE_TOOL_EXAMPLES).toMatchInlineSnapshot(`
      "Parley tools in OpenCode are not in your tool list. Call them inside the execute tool as tools.parley.<name>(args):
        return await tools.parley.get_map({});
        return await tools.parley.send_message({ to: "s-02", text: "Which branch?" });
        return await tools.parley.check_inbox({}); // per pointer
        return await tools.parley.wait_for({ target: "inbox", timeoutSec: 1500 }); // returns and marks messages read; on running repeat once
      Use one mail tool (check_inbox or wait_for) per execute call and return its result, so the result is the inbox page. Do not wait in the same script as other work.
        return await tools.parley.report({ status: "done", summary: "Done, found, left." });
      Call report at the end (failed if not done): it notifies your room lead, room owner or task giver, so send no "done" message. Then end the turn; do not poll get_map or check_inbox or start unrelated work. New messages reach you as the pointer after your turn."
    `);
  });

  it('names real tools and real argument keys', () => {
    const calls = [...OPENCODE_TOOL_EXAMPLES.matchAll(/tools\.parley\.(\w+)\((\{[^)]*\})?/g)];
    expect(calls.map((m) => m[1])).toEqual(['get_map', 'send_message', 'check_inbox', 'wait_for', 'report']);
    for (const [, name, args] of calls) {
      const tool = PARLEY_TOOLS.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      for (const key of [...(args ?? '').matchAll(/(\w+):/g)].map((m) => m[1]!)) expect(Object.keys(tool.inputSchema.properties ?? {})).toContain(key);
    }
  });

  it('keeps the wait at 1500 s, stays short and English, and never uses the Codex call form', () => {
    expect([...OPENCODE_TOOL_EXAMPLES.matchAll(/timeoutSec: (\d+)/g)].map((m) => m[1])).toEqual(['1500']);
    expect(OPENCODE_TOOL_EXAMPLES.split('\n').length).toBeLessThanOrEqual(8);
    expect(Buffer.byteLength(OPENCODE_TOOL_EXAMPLES)).toBeLessThanOrEqual(1400);
    expect(OPENCODE_TOOL_EXAMPLES).not.toMatch(/[А-Яа-яЁё]|mcp__parley|@exec/);
    expect(OPENCODE_TOOL_EXAMPLES).toContain('notifies your room lead, room owner or task giver');
  });

  it('leaves the Codex text byte-identical', () => {
    expect(createHash('sha256').update(CODEX_TOOL_EXAMPLES).digest('hex')).toBe('4f7db122d8ebe8d892a4f696ebb16c1f4642b7b1610c22bbba40636556fdb306');
  });
});
