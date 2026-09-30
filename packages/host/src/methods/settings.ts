import {
  DEFAULT_CONFIG,
  ENV_NAMES,
  ENV_PREFIX,
  envName,
  loadConfig,
  parseSetting,
  saveConfig,
} from '@parley/core';
import type { ParleyConfig } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';

const isConfigKey = (key: string): key is keyof ParleyConfig =>
  Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key);

export const settingsGet: Handler<'settings.get'> = async () => {
  const { config, fromEnv } = await loadConfig();
  // Ключ пришёл из переменной окружения — файл его не перекроет, оверлей
  // настроек должен показать это как замок с именем переменной (раздел 3.4):
  // с тем, под которым она реально задана, — `PARLEY_*` или прежним `HARNAS_*`.
  const locked: Record<string, string> = {};
  for (const key of fromEnv) locked[key] = envName(process.env, ENV_NAMES[key]) ?? `${ENV_PREFIX}${ENV_NAMES[key]}`;
  return { config, locked };
};

export const settingsSet: Handler<'settings.set'> = async (params) => {
  if (!isConfigKey(params.key)) {
    throw new HostError('bad_request', `неизвестная настройка: ${params.key}`);
  }
  const parsed = parseSetting(params.key, params.value);
  if ('error' in parsed) {
    throw new HostError('bad_request', parsed.error);
  }
  await saveConfig({ [params.key]: parsed.value } as Partial<ParleyConfig>);
  const { config } = await loadConfig();
  return { config };
};
