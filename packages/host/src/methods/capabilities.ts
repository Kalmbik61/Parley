import { homedir } from 'node:os';
import path from 'node:path';
import { scanClaudeCapabilities } from '@parley/core';
import type { Capabilities } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

type Scan = (options: { home: string; projectPath: string }) => Promise<Capabilities>;

/**
 * `capabilities.list` — подсказки поля ввода вида «Chat» (живая проверка 2026-10-02): команды, скиллы
 * и субагенты Claude Code из папок человека и проекта. Только чтение; у других провайдеров списков нет.
 * Снимка работ метод не читает, поэтому `worksReady` его не ждёт.
 */
export function createCapabilitiesList(scan: Scan = scanClaudeCapabilities): Handler<'capabilities.list'> {
  return async (params) => {
    if (!path.isAbsolute(params.projectPath)) {
      throw new HostError('bad_request', 'projectPath must be an absolute path');
    }
    if (params.provider !== 'claude') return { commands: [], skills: [], agents: [] };
    return scan({ home: homedir(), projectPath: params.projectPath });
  };
}


import { createSafeCapabilitiesService } from '../capabilities/snapshot.js';
import type { SafeCapabilitiesOptions } from '../capabilities/snapshot.js';
import type { HostContext } from '../context.js';
import { createCapabilitiesMcpActions } from '../capabilities/actions.js';
import type { McpExecutor } from '../capabilities/actions.js';
export interface CapabilitiesHandlersOptions extends SafeCapabilitiesOptions { executeMcp?: McpExecutor }

/** Create once per host; root registers these handlers alongside legacy list. */
export function createCapabilitiesHandlers(options: CapabilitiesHandlersOptions = {}) {
  let host: HostContext | undefined;
  const service = createSafeCapabilitiesService({ ...options,
    changed(projectPath, snapshot) {
      host?.broadcast('capabilities.changed', { projectPath, snapshot });
      options.changed?.(projectPath, snapshot);
    },
  });
  const actions = createCapabilitiesMcpActions(service, options.executeMcp);
  const bind = (context: HostContext): void => {
    if (!host) { host = context; host.onShutdown(async () => { actions.dispose(); service.dispose(); }); }
  };
  const handler = (refresh: boolean): Handler<'capabilities.get'> => async (params, request) => {
    if (!path.isAbsolute(params.projectPath)) throw new HostError('bad_request', 'projectPath must be an absolute path');
    bind(request.host);
    return refresh ? service.refresh(params.projectPath) : service.get(params.projectPath);
  };
  const capabilitiesMcpAdd: Handler<'capabilities.mcp.add'> = async (params, request) => { bind(request.host); return actions.add(params); };
  const capabilitiesMcpRemove: Handler<'capabilities.mcp.remove'> = async (params, request) => { bind(request.host); return actions.remove(params); };
  const capabilitiesMcpCheck: Handler<'capabilities.mcp.check'> = async (params, request) => { bind(request.host); return actions.check(params); };
  return { capabilitiesGet: handler(false), capabilitiesRefresh: handler(true), capabilitiesMcpAdd, capabilitiesMcpRemove, capabilitiesMcpCheck, service };
}
