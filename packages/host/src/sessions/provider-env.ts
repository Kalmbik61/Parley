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
  'CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION', 'PARLEY_HOOK_TOKEN',
]);

/** Ключ-заглушка loopback-адреса без ключа (`keyOptional`): им же подтверждается запрос Claude Code о ключе (К17). */
export const LOOPBACK_KEY_PLACEHOLDER = 'parley-local';

/** Final process-only transform. The caller reads the key immediately before this call. */
export function providerLaunchEnv(entry: ProviderEntry, inherited: NodeJS.ProcessEnv, planEnv: Record<string, string>, key: string | null): NodeJS.ProcessEnv {
  const env = { ...agentEnv(inherited), ...planEnv };
  // Любой провайдер с ключом в хранилище (GLM и свои, спека своих провайдеров 5.2) получает чистое окружение.
  if (entry.runner.secret === undefined) return env;
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_CODE_USE_') || GLM_SELECTORS.has(upper)) delete env[name];
  }
  Object.assign(env, entry.runner.env);
  // Своя папка настроек провайдера; у GLM её нет, и `CLAUDE_CONFIG_DIR` остаётся снятым.
  if (entry.runner.configDir !== undefined) env.CLAUDE_CONFIG_DIR = entry.runner.configDir;
  env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  // Ключ-заглушка нужна только локальному адресу без ключа (`keyOptional`), чтобы Claude Code не спрашивал вход.
  const value = key ?? (entry.runner.keyOptional === true ? LOOPBACK_KEY_PLACEHOLDER : null);
  if (value !== null) {
    if (entry.runner.auth === 'api-key') env.ANTHROPIC_API_KEY = value;
    else env.ANTHROPIC_AUTH_TOKEN = value;
  }
  return env;
}
