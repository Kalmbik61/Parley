#!/usr/bin/env node
// MCP-сервер координации: один процесс на сессию, транспорт stdio.
// В stdout идёт ТОЛЬКО протокол JSON-RPC, диагностика — в stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { envValue } from '../names.js';
import { createAssistantServer } from './assistant.js';
import { contextFromEnv } from './context.js';
import { createRemoteToolRunner, launchOf } from './remote-tools.js';
import { createParleyServer } from './tools.js';

async function main(): Promise<number> {
  let server;
  try {
    const assistantUrl = envValue(process.env, 'ASSISTANT_URL');
    if (assistantUrl !== undefined) {
      // Режим помощника (спека 2026-10-14, 7.1): своя пара инструментов, карта работ не нужна.
      server = createAssistantServer({ url: assistantUrl, token: envValue(process.env, 'ASSISTANT_TOKEN') ?? '' });
    } else {
      // Потолок писем живёт в настройках, а не в окружении: сервер читает их сам
      // при старте, на время жизни процесса значение не меняется (4.7).
      const { config } = await loadConfig();
      const context = {
        ...contextFromEnv(),
        messageRate: config.messageRate,
        worktreeRoot: config.worktreeRoot,
      };
      // Сессия запущена хостом (есть канал агента и id): инструменты исполняет он, и этот процесс карту не открывает
      // (спека хранилища 6.3). Без канала или сессии (старая, запущенная человеком или не Parley) — прежний путь,
      // прямое чтение карты (6.5).
      server =
        context.agent !== undefined && context.sessionId !== null
          ? createParleyServer(context, createRemoteToolRunner(context.agent, launchOf(context)))
          : createParleyServer(context);
    }
  } catch (error) {
    process.stderr.write(`parley-mcp: ${(error as Error).message}\n`);
    return 1;
  }
  await server.connect(new StdioServerTransport());
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
