const fs = require('node:fs');
const binding = require('./binding.cjs');
const lease = binding.read();
const { hook_event_name: event, session_id: id, tool_name: tool } = JSON.parse(fs.readFileSync(0, 'utf8'));
const allowed = !!lease && !lease.revoked && lease.id === id;
if (lease && !lease.revoked && (id !== lease.id || event !== 'SessionStart')) {
  // A different real provider ID permanently invalidates this generation.
  if (id !== lease.id) lease.revoked = true;
  lease.grant = allowed && event === 'PreToolUse';
  binding.write(lease);
}
binding.record({ event, id, tool, allowed });
if (event === 'UserPromptSubmit' && allowed) console.log(`RULES_${lease.label}`);
if (event === 'PreToolUse' && !allowed) {
  console.error('PROBE_STALE_BINDING');
  process.exitCode = 2;
}
