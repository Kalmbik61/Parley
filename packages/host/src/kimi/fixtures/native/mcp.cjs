const readline = require('node:readline');
const binding = require('./binding.cjs');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const lease = binding.read();
  const active = !!lease && !lease.revoked;
  let result;
  switch (method) {
    case 'initialize':
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'handoff-fixture', version: '0.0.0' } };
      break;
    case 'tools/list':
      binding.record({ event: method, allowed: active });
      result = { tools: active ? [{ name: 'handoff_probe', description: `TOOL_${lease.label}`, inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] : [] };
      break;
    case 'tools/call': {
      const allowed = active && lease.grant && params.name === 'handoff_probe';
      if (allowed) binding.write({ ...lease, grant: false });
      binding.record({ event: method, allowed });
      result = { content: [{ type: 'text', text: allowed ? `RESULT_${lease.label}` : 'PROBE_STALE_BINDING' }], isError: !allowed };
      break;
    }
    default:
      console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      return;
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
});
