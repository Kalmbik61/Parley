import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ASSISTANT_TOOLS, JOB_CANCEL_SAFE_TOOLS, JOB_ONLY_TOOLS, JOB_TOKEN_PREFIX, JOB_TOOL_ALLOWLIST, createAssistantServer } from './assistant.js';

async function connect(fetch: typeof globalThis.fetch, token = 't0k'): Promise<Client> {
  const server = createAssistantServer({ url: 'http://127.0.0.1:1/assistant', token, fetch });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}
const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parley-mcp в режиме помощника', () => {
  it('отдаёт четырнадцать инструментов в заданном порядке', async () => {
    const client = await connect(vi.fn());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'parley_overview',
      'parley_detail',
      'parley_find',
      'parley_room',
      'parley_session',
      'propose_message',
      'propose_room',
      'propose_decision',
      'propose_room_decision',
      'propose_actions',
      'schedule_check',
      'list_reminders',
      'cancel_reminder',
      'end_conversation',
    ]);
  });
  it('схемы новых инструментов', () => {
    const byName = (name: string): Tool => ASSISTANT_TOOLS.find((tool) => tool.name === name)!;
    const decision = (byName('propose_decision').inputSchema.properties as Record<string, { oneOf: Array<{ properties: { kind: { enum: string[] } } }> }>).decision!;
    expect(decision.oneOf.map((branch) => branch.properties.kind.enum[0])).toEqual(['permission', 'question', 'plan']);
    expect(byName('propose_decision').inputSchema.properties).toHaveProperty('card');
    expect(byName('propose_decision').inputSchema.required).not.toContain('card');
    expect(byName('schedule_check').inputSchema.required).toEqual(['what']);
    expect(byName('propose_room').inputSchema.required).toEqual(['work', 'title', 'members']);
    expect(byName('list_reminders').annotations).toEqual({ readOnlyHint: true });
    expect(byName('cancel_reminder').description).toContain('*');
    expect(byName('parley_find').inputSchema.required).toEqual(['query']);
    expect(byName('parley_room').annotations).toEqual({ readOnlyHint: true });
  });
  it('propose_actions: до двадцати шагов, ветки oneOf по глаголам, не только чтение', () => {
    const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === 'propose_actions')!;
    expect(tool.annotations).toBeUndefined();
    expect(tool.inputSchema.required).toEqual(['steps']);
    const steps = (tool.inputSchema.properties as { steps: { minItems: number; maxItems: number; items: { oneOf: Array<{ properties: { do: { enum: string[] } }; additionalProperties: boolean }> } } }).steps;
    expect([steps.minItems, steps.maxItems]).toEqual([1, 20]);
    expect(steps.items.oneOf.flatMap((branch) => branch.properties.do.enum)).toEqual(['create_work', 'create_session', 'wake', 'interrupt', 'sleep', 'close', 'create_room', 'add_to_room', 'message']);
    expect(steps.items.oneOf.every((branch) => branch.additionalProperties === false)).toBe(true);
    expect(tool.description).toContain('Nothing happens until the person clicks.');
  });
  it('propose_room уходит POST на /propose_room', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { text: 'Card prepared' }));
    const client = await connect(fetch);
    const args = { work: 'work:a:w', title: 'Review', members: ['session:s1'] };
    const result = await client.callTool({ name: 'propose_room', arguments: args });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1/assistant/propose_room', expect.objectContaining({ method: 'POST', body: JSON.stringify(args) }));
    expect(result.isError).toBeFalsy();
  });
  it('вызов — POST в хост с токеном, ответ — текст', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(200, { text: 'Work "Parley": 2 working' }));
    const client = await connect(fetch);
    const result = await client.callTool({ name: 'parley_detail', arguments: { target: 'room:a:w:r' } });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1/assistant/parley_detail', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer t0k' }),
      body: JSON.stringify({ target: 'room:a:w:r' }),
    }));
    expect(result.content).toEqual([{ type: 'text', text: 'Work "Parley": 2 working' }]);
    expect(result.isError).toBeFalsy();
  });
  it('отказ хоста — ошибка инструмента с его текстом', async () => {
    const client = await connect(vi.fn().mockResolvedValue(reply(404, { error: 'No room "Foo"' })));
    const result = await client.callTool({ name: 'propose_message', arguments: { target: 'Foo', text: 'x' } });
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'No room "Foo"' }] });
  });
  it('хост недоступен — ошибка, а не падение сервера', async () => {
    const client = await connect(vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await client.callTool({ name: 'parley_overview', arguments: {} });
    expect(result.isError).toBe(true);
  });

  describe('токен job', () => {
    it('allowlist — чтение плюс propose_*, без напоминаний и конца разговора', () => {
      expect(JOB_TOOL_ALLOWLIST.every((name) => ASSISTANT_TOOLS.some((tool) => tool.name === name))).toBe(true);
      for (const name of ['schedule_check', 'list_reminders', 'cancel_reminder', 'end_conversation']) expect(JOB_TOOL_ALLOWLIST).not.toContain(name);
      for (const name of JOB_TOOL_ALLOWLIST) {
        const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name)!;
        expect(tool.annotations?.readOnlyHint === true || name.startsWith('propose_') || name === 'link_request').toBe(true);
      }
    });
    it('link_request только у job: разговор его не видит и не вызывает', async () => {
      expect(JOB_ONLY_TOOLS).toEqual(['link_request']);
      expect(JOB_TOOL_ALLOWLIST).toContain('link_request');
      const fetch = vi.fn(async () => reply(200, { text: 'ok' }));
      const client = await connect(fetch);
      expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('link_request');
      const result = await client.callTool({ name: 'link_request', arguments: { supersedes: [], reason: 'x' } });
      expect(result.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      const job = await connect(fetch, `${JOB_TOKEN_PREFIX}abc`);
      expect((await job.listTools()).tools.map((tool) => tool.name)).toContain('link_request');
    });
    it('список безопасных для отмены инструментов явный: чтение, propose_* и link_request', () => {
      expect([...JOB_CANCEL_SAFE_TOOLS].sort()).toEqual([...JOB_TOOL_ALLOWLIST].sort());
      for (const name of ['schedule_check', 'cancel_reminder', 'end_conversation', 'list_reminders']) expect(JOB_CANCEL_SAFE_TOOLS).not.toContain(name);
    });
    it('с токеном job модель видит только allowlist', async () => {
      const client = await connect(vi.fn(), `${JOB_TOKEN_PREFIX}abc`);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([...JOB_TOOL_ALLOWLIST]);
    });
    it('инструмент вне allowlist не доходит до хоста', async () => {
      const fetch = vi.fn(async () => reply(200, { text: 'ok' }));
      const client = await connect(fetch, `${JOB_TOKEN_PREFIX}abc`);
      const result = await client.callTool({ name: 'schedule_check', arguments: { what: 'x' } });
      expect(result.isError).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      const allowed = await client.callTool({ name: 'parley_overview', arguments: {} });
      expect(allowed.isError).not.toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
