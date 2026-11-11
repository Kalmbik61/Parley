#!/usr/bin/env node
// Stdio MCP server with one tool, `echo` (server name in the settings: "parley" -> mcp__parley__echo).
// Every received line is appended to $MCP_LOG when set.
import readline from 'node:readline';
import fs from 'node:fs';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  if (process.env.MCP_LOG) fs.appendFileSync(process.env.MCP_LOG, `${l}\n`);
  let m;
  try {
    m = JSON.parse(l);
  } catch {
    return;
  }
  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'parley-echo', version: '1' } } });
  else if (m.method === 'tools/list')
    out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (m.method === 'tools/call') {
    const text = m.params.arguments?.text;
    if (text === 'fail') out({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: 'echo failed' }] } });
    else out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: `echoed:${text}` }] } });
  } else if (m.id !== undefined && m.method) out({ jsonrpc: '2.0', id: m.id, result: {} });
});
