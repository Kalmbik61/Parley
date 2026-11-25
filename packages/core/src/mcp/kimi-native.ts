import { contextFromEnv, type McpContext } from './context.js';
import { createRemoteToolRunner, launchOf } from './remote-tools.js';
import { createParleyServer, type ToolRunner } from './tools.js';

export const KIMI_MCP_LAUNCH_ENV = 'PARLEY_KIMI_NATIVE';
export const KIMI_MCP_SERVER_FLAG = '--kimi-native';

const unboundTools: ToolRunner = {
  async list() { return []; },
  async call() { return { isError: true, content: [{ type: 'text', text: 'No active Parley Kimi launch.' }] }; },
};

/** The registered server is also started by ordinary Kimi. It must never fall back to local authority. */
export function createKimiNativeMcp(env: NodeJS.ProcessEnv) {
  let context: McpContext | undefined;
  if (env[KIMI_MCP_LAUNCH_ENV] === '1') {
    try { context = contextFromEnv(env); } catch { /* An incomplete launch has no tools. */ }
  }
  if (context?.agent !== undefined && context.sessionId !== null) {
    return createParleyServer(context, createRemoteToolRunner(context.agent, launchOf(context)));
  }
  return createParleyServer({ projectPath: '', workId: '', workDir: '', sessionId: null, channel: false }, unboundTools);
}
