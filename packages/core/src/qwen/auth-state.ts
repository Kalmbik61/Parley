import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { qwenHome } from './home.js';

export type QwenAuthHint = 'configured' | 'qwen-account' | 'env-key' | 'not-detected';

export interface QwenAuthHints {
  selectedType: string | null;
  model: string | null;
  oauthFilePresent: boolean;
  envKeyPresent: boolean;
  hint: QwenAuthHint;
}

export interface QwenAuthDeps {
  /** Reads settings.json only. Never called for the credential file. */
  readFile(file: string): Promise<string>;
  /** Presence check only. */
  exists(file: string): Promise<boolean>;
}

const defaultDeps: QwenAuthDeps = {
  readFile: (file) => readFile(file, 'utf8'),
  exists: (file) =>
    access(file).then(
      () => true,
      () => false,
    ),
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Sign-in hints, never a verdict. Reads only `security.auth.selectedType` and
 * `model.name` from settings.json; the credential file is checked for presence
 * and never opened; the env key is checked for presence and never returned.
 */
export async function qwenAuthHints(
  env: NodeJS.ProcessEnv = process.env,
  deps: QwenAuthDeps = defaultDeps,
): Promise<QwenAuthHints> {
  const home = qwenHome(env);
  let selectedType: string | null = null;
  let model: string | null = null;
  try {
    const parsed: unknown = JSON.parse(await deps.readFile(path.join(home, 'settings.json')));
    if (parsed && typeof parsed === 'object') {
      const root = parsed as { security?: { auth?: { selectedType?: unknown } }; model?: { name?: unknown } };
      selectedType = str(root.security?.auth?.selectedType);
      model = str(root.model?.name);
    }
  } catch {
    // missing or broken settings: hints stay null
  }
  let oauthFilePresent = false;
  try {
    oauthFilePresent = await deps.exists(path.join(home, 'oauth_creds.json'));
  } catch {
    oauthFilePresent = false;
  }
  const envKeyPresent = (env.OPENAI_API_KEY ?? '') !== '';
  const hint: QwenAuthHint = selectedType
    ? 'configured'
    : oauthFilePresent
      ? 'qwen-account'
      : envKeyPresent
        ? 'env-key'
        : 'not-detected';
  return { selectedType, model, oauthFilePresent, envKeyPresent, hint };
}
