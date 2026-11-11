#!/usr/bin/env node
// MCP-сервер координации: один процесс на сессию, транспорт stdio.
// В stdout идёт ТОЛЬКО протокол JSON-RPC, диагностика — в stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { envValue } from '../names.js';
import { createAssistantServer } from './assistant.js';
import type { CodeModeSurfaceFactory } from './code-mode-tools.js';
import { CodeModeStartError, contextFromEnv, type McpContext, workDirFromEnv } from './context.js';
import { createRemoteToolRunner, launchOf } from './remote-tools.js';
import { createParleyServer, createToolRunner, originalToolNames } from './tools.js';

/** Запись `failed` до выхода, если каталог работы и сессия известны. Показать её человеку — обязанность T8h и T12a. */
async function recordStartFailure(code: string): Promise<void> {
  const workDir = workDirFromEnv(process.env);
  const sessionId = envValue(process.env, 'SESSION_ID');
  if (workDir === null || sessionId === undefined) return;
  const [{ writeExposureRecord }, { REGISTRY_REVISION }] = await Promise.all([import('./code-mode/exposure-record.js'), import('./code-mode/migration-registry.js')]);
  writeExposureRecord(workDir, sessionId, { v: 1, effective: 'failed', reason: code, migrated: [], residual: [], registryRevision: REGISTRY_REVISION, residualSchemaSha256: null, launchId: null, nonce: envValue(process.env, 'CODE_MODE_LAUNCH') ?? null });
}

/**
 * Режим этого запуска (план T8h). Только файл решения, который пишет запускающий, и только при совпадении нонса из окружения: значение
 * из настроек не может совпасть с файлом, поэтому репозиторий не включит режим и не остановит сервер. Нонса нет — файл не открывается.
 */
async function launchedExposure(context: McpContext): Promise<Pick<McpContext, 'codeModeExposure' | 'codeModeLaunch'>> {
  const nonce = envValue(process.env, 'CODE_MODE_LAUNCH');
  if (nonce === undefined) return {};
  const { honouredExposure } = await import('./code-mode/launch-decision.js');
  const honoured = honouredExposure(context.workDir, context.sessionId, nonce);
  if (honoured === 'not-understood') throw new CodeModeStartError('unknown-decision');
  return honoured === 'replacement' ? { codeModeExposure: 'replacement', codeModeLaunch: nonce } : {};
}

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
      const base = {
        ...contextFromEnv(),
        messageRate: config.messageRate,
        resumeRate: config.resumeRate,
        worktreeRoot: config.worktreeRoot,
      };
      const context = { ...base, ...(await launchedExposure(base)) };
      // Code Mode (план T7b): только когда запуск сказал об этом явно, и грузится только тогда: классика за него не платит.
      let codeMode: CodeModeSurfaceFactory | undefined;
      if (context.codeModeExposure === 'replacement') {
        // Только сессии, запущенные Parley (решение человека), и без канала агента нечем исполнять.
        if (context.sessionId === null || context.agent === undefined) throw new CodeModeStartError('no-session-or-agent');
        const [{ checkReplacement }, { replacementSurfaceFactory }] = await Promise.all([import('./code-mode/migration-registry.js'), import('./code-mode-tools.js')]);
        const checked = checkReplacement(originalToolNames(context));
        if (!checked.ok) throw new CodeModeStartError(checked.problem);
        codeMode = replacementSurfaceFactory(context);
        // Клиент ушёл — процесс кончается, как только ни один начатый вызов не ждёт ответа (план T8h). Классика живёт как жила.
        const [{ exitWhenClientGone }, { SESSION_SCHEDULER }] = await Promise.all([import('./code-mode/client-gone.js'), import('./code-mode/scheduler.js')]);
        exitWhenClientGone(process.stdin, process.stdout, SESSION_SCHEDULER, () => process.exit(0));
      }
      // Сессия запущена хостом (есть канал агента и id): инструменты исполняет он, и этот процесс карту не открывает
      // (спека хранилища 6.3). Без канала или сессии (старая, запущенная человеком или не Parley) — прежний путь,
      // прямое чтение карты (6.5). Хост прежней сборки отвечает на `/agent/tools` 404 (сразу после обновления он ещё
      // старый, а этот сервер уже новый): тогда удалённый исполнитель до конца процесса отдаёт всё запасному — тому же
      // местному исполнителю, что у сессии без канала, — вместо отказа каждому инструменту до перезапуска хоста (6.5).
      server =
        context.agent !== undefined && context.sessionId !== null
          ? createParleyServer(context, createRemoteToolRunner(context.agent, launchOf(context), { fallback: createToolRunner(context) }), codeMode)
          : createParleyServer(context);
    }
  } catch (error) {
    process.stderr.write(`parley-mcp: ${(error as Error).message}\n`);
    // stderr доходит не до всех, а клиент может жить дальше без инструментов: след отказа — в записи. Сбой записи ничего не меняет.
    if (error instanceof CodeModeStartError) await recordStartFailure(error.code).catch(() => undefined);
    return 1;
  }
  await server.connect(new StdioServerTransport());
  return 0;
}

const code = await main();
if (code !== 0) process.exit(code);
