#!/usr/bin/env node
// MCP-сервер координации: один процесс на сессию, транспорт stdio.
// В stdout идёт ТОЛЬКО протокол JSON-RPC, диагностика — в stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { contextFromEnv } from './context.js';
import { createHarnasServer } from './tools.js';

async function main(): Promise<number> {
  let server;
  try {
    server = createHarnasServer(contextFromEnv());
  } catch (error) {
    process.stderr.write(`harnas-mcp: ${(error as Error).message}\n`);
    return 1;
  }
  await server.connect(new StdioServerTransport());
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
