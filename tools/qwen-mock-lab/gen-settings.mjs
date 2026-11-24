#!/usr/bin/env node
// Writes a QWEN_CODE_SYSTEM_SETTINGS_PATH file: the echo MCP server plus command hooks (and an http
// hook when --http-port is given) for the events Parley uses.
// usage: node gen-settings.mjs <out.json> <hook-log> <mcp-log> [--http-port <n>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [out, hookLog, mcpLog] = process.argv.slice(2);
const i = process.argv.indexOf('--http-port');
const httpPort = i > 0 ? process.argv[i + 1] : null;
const here = path.dirname(fileURLToPath(import.meta.url));
const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Notification', 'SessionEnd'];
const hooks = {};
for (const e of events) {
  const list = [{ type: 'command', command: `${process.execPath} ${path.join(here, 'hook.mjs')} ${hookLog}` }];
  if (httpPort) list.push({ type: 'http', url: `http://127.0.0.1:${httpPort}/hook`, headers: { 'X-Parley-Token': 'lab-token' } });
  hooks[e] = [{ hooks: list }];
}
const settings = { $version: 4, mcpServers: { parley: { command: process.execPath, args: [path.join(here, 'mcp.mjs')], env: { MCP_LOG: mcpLog } } }, hooks };
fs.writeFileSync(out, `${JSON.stringify(settings, null, 2)}\n`);
