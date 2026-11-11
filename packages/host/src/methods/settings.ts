import {
  CodeModeNotSaved,
  codeModeRequested,
  codeModeState,
  DEFAULT_CONFIG,
  ENV_NAMES,
  ENV_PREFIX,
  envName,
  loadConfig,
  parseSetting,
  saveConfig,
  setCodeMode,
} from '@parley/core';
import type { ParleyConfig } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

const isConfigKey = (key: string): key is keyof ParleyConfig =>
  Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key);

export const settingsGet: Handler<'settings.get'> = async () => {
  const { config: loaded, fromEnv } = await loadConfig();
  // Code Mode as new launches get it (config.json and the store row together), never config.json alone (plan T12a, §3); and which of the four
  // states that is, so the window shows a partial off on open too (lead m-7289, R2). One read of both stores: `on` is exactly "requested".
  const codeMode = await codeModeState();
  const config = { ...loaded, codeMode: codeMode === 'on' };
  // Ключ пришёл из переменной окружения — файл его не перекроет, оверлей
  // настроек должен показать это как замок с именем переменной (раздел 3.4):
  // с тем, под которым она реально задана, — `PARLEY_*` или прежним `HARNAS_*`.
  const locked: Record<string, string> = {};
  for (const key of fromEnv) locked[key] = envName(process.env, ENV_NAMES[key]) ?? `${ENV_PREFIX}${ENV_NAMES[key]}`;
  return { config, locked, codeMode };
};

export const settingsSet: Handler<'settings.set'> = async (params) => {
  if (!isConfigKey(params.key)) {
    throw new HostError('bad_request', `unknown setting: ${params.key}`);
  }
  const parsed = parseSetting(params.key, params.value);
  if ('error' in parsed) {
    throw new HostError('bad_request', parsed.error);
  }
  // Code Mode goes only through its ordered writes (plan T12a, §3): a human's off is kept in the store too, so a deleted config does not undo it.
  if (params.key === 'codeMode') {
    let codeMode;
    try {
      codeMode = await setCodeMode(parsed.value as boolean);
    } catch (error) {
      if (error instanceof CodeModeNotSaved) throw new HostError('internal', `Code Mode was not saved; it is still ${error.previous}`);
      throw error;
    }
    const { config } = await loadConfig();
    // The window shows what new launches get, which the store row decides: config.json may still say true after `off-next-launch`.
    return { config: { ...config, codeMode: await codeModeRequested() }, codeMode };
  }
  await saveConfig({ [params.key]: parsed.value } as Partial<ParleyConfig>);
  const { config } = await loadConfig();
  return { config };
};
