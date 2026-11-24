// stdio MCP mock named `parley` with the shapes of check_inbox / wait_for. Env: MCP_LOG (jsonl log),
// MCP_LETTERS (json array of letters returned once by check_inbox; default one invented letter).
import fs from 'node:fs';
import readline from 'node:readline';

const L = (o) => fs.appendFileSync(process.env.MCP_LOG || '/dev/null', JSON.stringify(o) + '\n');
const letters = process.env.MCP_LETTERS ? JSON.parse(process.env.MCP_LETTERS)
  : [{ id: 'm-1', from: 's-1', fromLabel: 'lead', at: '2026-01-01T00:00:00.000Z', text: 'Invented mock letter: please review.', kind: 'note', room: null }];
let delivered = false;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const reply = (id, text) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(text) }] } });
const tools = [
  { name: 'check_inbox', description: 'Oldest unread messages', inputSchema: { type: 'object', properties: {} } },
  { name: 'wait_for', description: 'Wait for a session or the inbox', inputSchema: { type: 'object', properties: { target: { type: 'string' }, timeoutSec: { type: 'number' } }, required: ['target'] } },
];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  L({ in: m });
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'parley-mock', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools } });
  else if (m.method === 'tools/call') {
    const page = delivered ? [] : letters;
    if (m.params.name === 'check_inbox') { delivered = true; reply(m.id, { messages: page }); }
    else if (m.params.name === 'wait_for') { delivered = true; reply(m.id, page.length ? { state: 'message', messages: page } : { state: 'running' }); }
    else send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown tool' } });
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
