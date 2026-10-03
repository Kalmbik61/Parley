import { agentEnv, type ProviderEntry } from '@parley/core';

/** Inherited selectors removed for the approved host-managed GLM contract. */
const GLM_SELECTORS = new Set([
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
  'CLAUDE_CODE_HOST_CREDS_FILE', 'CLAUDE_CODE_HOST_GATEWAY_LINEAGE',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR', 'CLAUDE_BG_AUTH_SNAPSHOT_PATH',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_HERMETIC_MODE',
  'CLAUDE_CODE_ENVIRONMENT_KIND', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_RESTRICTED', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_AUTO_MODE_MODEL', 'CLAUDE_CODE_BG_CLASSIFIER_MODEL',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE_SETTINGS_PATH',
  'CLAUDE_CODE_MANAGED_SETTINGS_PATH', 'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION', 'PARLEY_HOOK_TOKEN',
]);

/** Final process-only transform. The caller reads the key immediately before this call. */
export function providerLaunchEnv(entry: ProviderEntry, inherited: NodeJS.ProcessEnv, planEnv: Record<string, string>, key: string | null): NodeJS.ProcessEnv {
  const env = { ...agentEnv(inherited), ...planEnv };
  if (entry.runner.secret !== 'zai') return env;
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_CODE_USE_') || GLM_SELECTORS.has(upper)) delete env[name];
  }
  Object.assign(env, entry.runner.env);
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  if (key !== null) env.ANTHROPIC_AUTH_TOKEN = key;
  return env;
}
