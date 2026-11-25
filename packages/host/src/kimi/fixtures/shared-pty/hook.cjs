const fs = require('node:fs');
const binding = require('./binding.cjs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.SHARED_PTY_HOOKS, JSON.stringify(payload) + '\n');
const { hook_event_name: event, session_id: id, tool_name: tool } = payload;

// Synthetic tool grant only. Unlike handoff, a new provider ID rebinds the same PTY.
const lease = binding.read();
if (event === 'SessionStart') binding.write({ ...lease, id, grant: false });
if (event === 'UserPromptSubmit') console.log('SHARED_PTY_FIXTURE_RULES');
if (event === 'PreToolUse' && tool === 'mcp__plugin-parley-shared-pty-probe_fixture__handoff_probe') {
  if (id !== lease.id) process.exitCode = 2;
  else binding.write({ ...lease, grant: true });
}
