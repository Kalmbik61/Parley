#!/usr/bin/env node
// The provider binary of an isolated run (tools/code-mode-isolated-run.ts): it stands where `claude` would, so the host's real launch happens and
// no model turn can. Every start appends one line to PARLEY_ISOLATED_RECORD: argv, cwd and the Parley and Claude variables (never a token, key
// or secret). `--version` answers with the real claude's version, which the run resolved first (PARLEY_ISOLATED_CLAUDE_VERSION), so the host
// plans the launch it would plan for that claude; any other start waits until the host stops it. It reads nothing else and calls nothing.
import { appendFileSync } from 'node:fs';

const record = process.env['PARLEY_ISOLATED_RECORD'];
if (record !== undefined && record !== '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PARLEY_|HARNAS_|CLAUDE_|MCP_)/.test(k) && !/TOKEN|KEY|SECRET/.test(k)));
  appendFileSync(record, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env })}\n`, { mode: 0o600 });
}
if (process.argv.slice(2).includes('--version')) {
  const version = process.env['PARLEY_ISOLATED_CLAUDE_VERSION'];
  if (version === undefined || version === '') process.exit(1);
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
