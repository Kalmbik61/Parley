import { createCapabilitiesSkillActions } from '../capabilities/skill-actions.js';
import { createProviderScheduler } from '../capabilities/scheduler.js';
import { createCapabilitiesPluginActions } from '../capabilities/plugin-actions.js';
import { homedir } from 'node:os';
import path from 'node:path';
import { isClaudeCode, scanClaudeCapabilities } from '@parley/core';
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
    if (!isClaudeCode(params.provider)) return { commands: [], skills: [], agents: [] };
    return scan({ home: homedir(), projectPath: params.projectPath });
  };
}


import { createSafeCapabilitiesService } from '../capabilities/snapshot.js';
import type { SafeCapabilitiesOptions } from '../capabilities/snapshot.js';
import type { HostContext } from '../context.js';
import { createCapabilitiesMcpActions } from '../capabilities/actions.js';
import type { McpExecutor } from '../capabilities/actions.js';
export interface CapabilitiesHandlersOptions extends SafeCapabilitiesOptions { executeMcp?: McpExecutor; executePlugin?: McpExecutor }

/** Create once per host; root registers these handlers alongside legacy list. */
export function createCapabilitiesHandlers(options: CapabilitiesHandlersOptions = {}) {
  let host: HostContext | undefined;
  const service = createSafeCapabilitiesService({ ...options,
    changed(projectPath, snapshot) {
      host?.broadcast('capabilities.changed', { projectPath, snapshot });
      options.changed?.(projectPath, snapshot);
    },
  });
  const scheduler = createProviderScheduler();
  const actions = createCapabilitiesMcpActions(service, options.executeMcp, scheduler);
  const plugins = createCapabilitiesPluginActions(service, options.executePlugin, scheduler);
  const skills = createCapabilitiesSkillActions(service, scheduler);
  const bind = (context: HostContext): void => {
    if (!host) { host = context; host.onShutdown(async () => { scheduler.dispose(); actions.dispose(); plugins.dispose(); skills.dispose(); service.dispose(); }); }
  };
  const handler = (refresh: boolean): Handler<'capabilities.get'> => async (params, request) => {
    if (!path.isAbsolute(params.projectPath)) throw new HostError('bad_request', 'projectPath must be an absolute path');
    bind(request.host);
    return refresh ? service.refresh(params.projectPath) : service.get(params.projectPath);
  };
  const capabilitiesMcpAdd: Handler<'capabilities.mcp.add'> = async (params, request) => { bind(request.host); return actions.add(params); };
  const capabilitiesMcpRemove: Handler<'capabilities.mcp.remove'> = async (params, request) => { bind(request.host); return actions.remove(params); };
  const capabilitiesMcpCheck: Handler<'capabilities.mcp.check'> = async (params, request) => { bind(request.host); return actions.check(params); };
  const capabilitiesPluginsAvailable: Handler<'capabilities.plugins.available'> = async (params, request) => { bind(request.host); return plugins.available(params); };
  const capabilitiesPluginsDetails: Handler<'capabilities.plugins.details'> = async (params, request) => { bind(request.host); return plugins.details(params); };
  const capabilitiesPluginsInstall: Handler<'capabilities.plugins.install'> = async (params, request) => { bind(request.host); return plugins.install(params); };
  const capabilitiesPluginsUninstall: Handler<'capabilities.plugins.uninstall'> = async (params, request) => { bind(request.host); return plugins.uninstall(params); };
  const capabilitiesPluginsEnable: Handler<'capabilities.plugins.enable'> = async (params, request) => { bind(request.host); return plugins.enable(params); };
  const capabilitiesPluginsDisable: Handler<'capabilities.plugins.disable'> = async (params, request) => { bind(request.host); return plugins.disable(params); };
  const capabilitiesPluginsAddMarketplace: Handler<'capabilities.plugins.addMarketplace'> = async (params, request) => { bind(request.host); return plugins.addMarketplace(params); };
  const capabilitiesSkillsShare: Handler<'capabilities.skills.share'> = async (params, request) => { bind(request.host); return skills.share(params); };
  const capabilitiesSkillsUnshare: Handler<'capabilities.skills.unshare'> = async (params, request) => { bind(request.host); return skills.unshare(params); };
  return { capabilitiesSkillsShare, capabilitiesSkillsUnshare, capabilitiesGet: handler(false), capabilitiesRefresh: handler(true), capabilitiesMcpAdd, capabilitiesMcpRemove, capabilitiesMcpCheck, capabilitiesPluginsAvailable, capabilitiesPluginsDetails, capabilitiesPluginsInstall, capabilitiesPluginsUninstall, capabilitiesPluginsEnable, capabilitiesPluginsDisable, capabilitiesPluginsAddMarketplace, service };
}
