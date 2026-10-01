#!/usr/bin/env node
// MCP-сервер координации: один процесс на сессию, транспорт stdio.
// В stdout идёт ТОЛЬКО протокол JSON-RPC, диагностика — в stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { contextFromEnv } from './context.js';
import { createParleyServer } from './tools.js';

async function main(): Promise<number> {
  let server;
  try {
    // Потолок писем живёт в настройках, а не в окружении: сервер читает их сам
    // при старте, на время жизни процесса значение не меняется (4.7).
    const { config } = await loadConfig();
    server = createParleyServer({
      ...contextFromEnv(),
      messageRate: config.messageRate,
      worktreeRoot: config.worktreeRoot,
    });
  } catch (error) {
    process.stderr.write(`parley-mcp: ${(error as Error).message}\n`);
    return 1;
  }
  await server.connect(new StdioServerTransport());
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
