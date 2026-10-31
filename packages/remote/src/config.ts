import { z } from 'zod';
import { isValidRelayHost } from '@parley/protocol/remote';
import { readJsonFile, writeJsonAtomic } from './files.js';

/**
 * `remote.json` (спека 5.2): адрес relay и переопределение адреса push-шлюза. Идентичность моста (`routeId`) и секреты
 * лежат в `keys.json`, устройства — в `devices.json`; «включено» хранит окно, а не мост.
 */
export const remoteConfigSchema = z.strictObject({
  v: z.literal(1),
  relay: z.string().refine(isValidRelayHost, 'invalid relay address').nullable(),
  pushGatewayUrl: z.string().max(256).optional(),
});
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;

export const defaultRemoteConfig = (): RemoteConfig => ({ v: 1, relay: null });

/** Нет файла — значения по умолчанию; битый файл — ошибка (мост не затирает чужую настройку молча). */
export async function loadRemoteConfig(file: string): Promise<RemoteConfig> {
  const raw = await readJsonFile(file);
  if (raw === undefined) return defaultRemoteConfig();
  const parsed = remoteConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error('remote.json is invalid');
  return parsed.data;
}

export async function saveRemoteConfig(file: string, config: RemoteConfig): Promise<void> {
  await writeJsonAtomic(file, config);
}
