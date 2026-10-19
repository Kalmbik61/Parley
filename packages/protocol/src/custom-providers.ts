import { z } from 'zod';

/** Префикс id своих провайдеров (спека 5.1): в `providers.json` id с ним запрещены. */
export const CUSTOM_PROVIDER_PREFIX = 'custom-';

export function isCustomProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/** Способ передачи ключа (спека 5.3): сам литерал заголовка живёт только в хосте. */
export type CustomProviderAuth = 'bearer' | 'api-key';

export interface CustomProviderModels {
  opus: string;
  sonnet: string;
  haiku: string;
  subagent: string;
}

/** Описание своего провайдера в `providers.list` (спека 5.1); ключа здесь нет. */
export interface CustomProviderInfo {
  preset: string | null;
  baseUrl: string;
  auth: CustomProviderAuth;
  models: CustomProviderModels;
  contextWindow: number | null;
  linkClaude: boolean;
  /** Папка провайдера `~/.parley/providers/<id>` — для показа в окне. */
  folder: string;
}

// Модель: одно слово, не с дефиса (CLI принял бы за флаг), непустая — как у `sessions.create.model`.
// Строгий id (спека 5.1, 7): совпадает с проверкой ядра, чтобы id не вышел из папки провайдеров.
const customId = z.string().max(40).regex(/^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/);

const modelSlot = z.string().max(200).regex(/^[^\s-]\S*$/);

export const customProviderMethodSchemas = {
  'providers.saveCustom': z.object({
    /** `null` — новый провайдер: id выдаёт хост; при правке id неизменен (спека, Review Focus 3). */
    id: customId.nullable(),
    // eslint-disable-next-line no-control-regex -- управляющие символы в имени запрещены намеренно
    label: z.string().trim().min(1).max(40).regex(/^[^\x00-\x1f]*$/),
    preset: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable(),
    baseUrl: z.string().trim().min(1).max(500),
    auth: z.enum(['bearer', 'api-key']),
    models: z.object({ opus: modelSlot, sonnet: modelSlot, haiku: modelSlot, subagent: modelSlot }),
    contextWindow: z.number().int().positive().max(10_000_000).nullable(),
    linkClaude: z.boolean(),
  }),
  'providers.deleteCustom': z.object({ id: customId, removeFolder: z.boolean() }),
} as const;

export interface CustomProviderMethodResults {
  'providers.saveCustom': { id: string };
  'providers.deleteCustom': { ok: true };
}
