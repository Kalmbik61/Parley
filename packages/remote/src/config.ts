import { z } from 'zod';
import { isValidRelayHost } from '@parley/protocol/remote';
import { readJsonFile, writeJsonAtomic } from './files.js';
import { resolvePushGatewayUrl } from './push-gateway-client.js';

/**
 * `remote.json` (спека 5.2): адрес relay и переопределение адреса push-шлюза. Идентичность моста (`routeId`) и секреты
 * лежат в `keys.json`, устройства — в `devices.json`; «включено» хранит окно, а не мост.
 */
export const remoteConfigSchema = z.strictObject({
  v: z.literal(1),
  relay: z.string().refine(isValidRelayHost, 'invalid relay address').nullable(),
  /** `https://…` (для петли — `http://`), без запроса и учётных данных; путь допустим. Неверный адрес — ошибка запуска. */
  pushGatewayUrl: z
    .string()
    .max(256)
    .refine((value) => resolvePushGatewayUrl(value, null) !== null, 'invalid push gateway address')
    .optional(),
});
export type RemoteConfig = z.infer<typeof remoteConfigSchema>;

export const defaultRemoteConfig = (): RemoteConfig => ({ v: 1, relay: null });

/** Файл неверен: `fields` — какие поля, чтобы журнал и окно сказали, что чинить. */
export class RemoteConfigError extends Error {
  constructor(readonly fields: string[]) {
    super(`remote.json is invalid: ${fields.join(', ') || 'file'}`);
    this.name = 'RemoteConfigError';
  }
}

/** Нет файла — значения по умолчанию; битый файл — ошибка (мост не затирает чужую настройку молча). */
export async function loadRemoteConfig(file: string): Promise<RemoteConfig> {
  const raw = await readJsonFile(file);
  if (raw === undefined) return defaultRemoteConfig();
  const parsed = remoteConfigSchema.safeParse(raw);
  if (!parsed.success) throw new RemoteConfigError([...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'file'))]);
  return parsed.data;
}

export async function saveRemoteConfig(file: string, config: RemoteConfig): Promise<void> {
  await writeJsonAtomic(file, config);
}
