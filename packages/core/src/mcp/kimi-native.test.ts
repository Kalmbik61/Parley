import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createKimiNativeMcp } from './kimi-native.js';

it('exposes no Parley tools or local fallback to an unbound Kimi process', async () => {
  const server = createKimiNativeMcp({
    PARLEY_WORK_DIR: '/dummy/.parley/works/w-0001',
    PARLEY_SESSION_ID: 's-01',
  });
  const client = new Client({ name: 'unbound fixture', version: '1' });
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toEqual([]);
    expect(await client.callTool({ name: 'get_map', arguments: {} })).toMatchObject({ isError: true });
  } finally {
    await client.close();
    await server.close();
  }
});
