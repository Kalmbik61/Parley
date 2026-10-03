import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { contextFromEnv } from '../mcp/context.js';
import { createParleyServer } from '../mcp/tools.js';
import { GUIDE } from '../work/guide.js';

describe('read_guide uses the immutable MCP launch snapshot', () => {
  it.each([false, true])('keeps launch flag %s after the global flag changes, without native I/O', async enabled => {
    const context = contextFromEnv({ PARLEY_WORK_DIR: '/tmp/navigator-fixture/.parley/works/w-0001', PARLEY_SKILL_NAVIGATOR: enabled ? '1' : '0' });
    const server = createParleyServer(context);
    const client = new Client({ name: 'navigator-guide-fixture', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      vi.stubEnv('PARLEY_SKILL_NAVIGATOR', enabled ? '0' : '1');
      for (const topic of [undefined, 'lead', 'tools']) {
        const result = await client.callTool({ name: 'read_guide', arguments: topic === undefined ? {} : { topic } });
        expect(result.isError).not.toBe(true);
        const content = result.content as { text: string }[];
        const text = content[0]!.text;
        expect(text.includes('find_skill')).toBe(enabled);
        if (!enabled && topic === undefined) expect(text).toBe(GUIDE);
        if (enabled && topic === 'lead') expect(text).toContain('query and for');
        if (enabled && topic === 'tools') expect(text).toContain('unverified loading route');
      }
    } finally {
      vi.unstubAllEnvs();
      await client.close();
      await server.close();
    }
  });
});
