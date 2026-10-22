import { z } from 'zod';

/** Префикс id своих провайдеров (спека 5.1): в `providers.json` id с ним запрещены. */
export const CUSTOM_PROVIDER_PREFIX = 'custom-';

export function isCustomProviderId(id: string): boolean {
  return id.startsWith(CUSTOM_PROVIDER_PREFIX);
}

/** Префикс id аккаунта Codex (спека подписок 5.1): аккаунт Claude остаётся `custom-<slug>`. */
export const CODEX_ACCOUNT_PREFIX = 'codex-';

export function isCodexAccountId(id: string): boolean {
  return id.startsWith(CODEX_ACCOUNT_PREFIX);
}

/** Id, которым владеет Parley (запись в `custom-providers.json`, папка `~/.parley/providers/<id>`): `custom-` или `codex-`. */
export function isManagedProviderId(id: string): boolean {
  return isCustomProviderId(id) || isCodexAccountId(id);
}

/**
 * Вид записи (спека подписок 5.1): свой адрес и ключ, аккаунт Claude Code или аккаунт Codex. Хост до подписок
 * вида не отдаёт: окно читает его отсутствие как `endpoint`, миграции файла нет.
 */
export type CustomProviderKind = 'endpoint' | 'claude-account' | 'codex-account';

/** Способ передачи ключа (спека 5.3): сам литерал заголовка живёт только в хосте. */
export type CustomProviderAuth = 'bearer' | 'api-key';

export interface CustomProviderModels {
  opus: string;
  sonnet: string;
  haiku: string;
  subagent: string;
}

/** Описание своего провайдера с адресом в `providers.list` (спека 5.1); ключа здесь нет. */
export interface CustomEndpointInfo {
  /** Необязателен: хост до подписок вида не отдаёт, окно читает отсутствие как `endpoint` (спека подписок 5.1). */
  kind?: 'endpoint';
  preset: string | null;
  baseUrl: string;
  auth: CustomProviderAuth;
  models: CustomProviderModels;
  contextWindow: number | null;
  linkClaude: boolean;
  /** Папка провайдера `~/.parley/providers/<id>` — для показа в окне. */
  folder: string;
}

/**
 * Описание аккаунта подписки в `providers.list` (спека подписок 5.1, 5.5): ни адреса, ни ключа, ни моделей.
 * `link` — общие с `~/.claude` скиллы, агенты и настройки (у `endpoint` это `linkClaude`).
 */
export interface CustomAccountInfo {
  kind: 'claude-account' | 'codex-account';
  link: boolean;
  /** Папка аккаунта `~/.parley/providers/<id>` — для показа в окне. */
  folder: string;
  /** Вошёл ли аккаунт; `null` — ещё не проверяли (`providers.authStatus`, спека подписок 5.5). */
  signedIn: boolean | null;
  /** Идёт ли сейчас вход (процесс жив): окно после повторного открытия Settings показывает терминал входа. */
  signingIn: boolean;
}

/**
 * Описание в `providers.list.custom` (спека подписок 5.1): запись с адресом или аккаунт подписки. Окно сужает по виду
 * (`kindOf` в `custom-provider-draft.ts`): у записи без `kind` вид `endpoint`, чужих полей она не читает.
 */
export type CustomProviderInfo = CustomEndpointInfo | CustomAccountInfo;

// Модель: одно слово, не с дефиса (CLI принял бы за флаг), непустая — как у `sessions.create.model`.
// Строгий id (спека 5.1, 7): совпадает с проверкой ядра, чтобы id не вышел из папки провайдеров.
// Префикса два (спека подписок 5.1, К8): `custom-` — свои провайдеры и аккаунты Claude, `codex-` — аккаунты Codex.
const customId = z.string().max(40).regex(/^(custom|codex)-[a-z0-9]+(?:-[a-z0-9]+)*$/);

const modelSlot = z.string().max(200).regex(/^[^\s-]\S*$/);

// Запись с адресом: прежняя схема плюс вид (спека подписок 5.1). Обратная совместимость промежуточных коммитов
// ветки (решение 2): окно и хост до подписок шлют запись без `kind`, поэтому у этой формы он необязателен, а
// отсутствие читается как `endpoint`. Форма аккаунта `kind` требует, иначе её не отличить от записи с адресом.
const endpointRecord = z.object({
  kind: z.literal('endpoint').optional(),
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
});

// Аккаунт подписки (спека подписок 5.1): имя может быть пустым — тогда хост берёт стандартное (`Claude 2`).
const accountRecord = z.object({
  kind: z.enum(['claude-account', 'codex-account']),
  id: customId.nullable(),
  // eslint-disable-next-line no-control-regex -- управляющие символы в имени запрещены намеренно
  label: z.string().trim().max(40).regex(/^[^\x00-\x1f]*$/),
  link: z.boolean(),
});

const signInProvider = z.object({ provider: z.string() });

const saveCustomRecord = z.discriminatedUnion('kind', [endpointRecord, accountRecord]);

/** Честный тип параметров `providers.saveCustom`: запись с адресом или аккаунт подписки (спека подписок 5.1). */
export type CustomProviderSaveParams = z.infer<typeof saveCustomRecord>;

export const customProviderMethodSchemas = {
  // Обе формы разбираются и в типе: `Params<'providers.saveCustom'>` равен `CustomProviderSaveParams`, обработчик хоста
  // сужает его по `kind` (спека подписок 5.1; приведение к форме с адресом решения 2 снято задачей хоста).
  'providers.saveCustom': saveCustomRecord,
  'providers.deleteCustom': z.object({ id: customId, removeFolder: z.boolean() }),
  // Состояние входа и вход в аккаунт (спека подписок 5.5): отдельный путь PTY, не `pty-manager` сессий.
  'providers.authStatus': signInProvider,
  'providers.signIn': signInProvider,
  /** Вставка кода из браузера в терминал входа. */
  'providers.signInInput': z.object({ provider: z.string(), data: z.string().max(4096) }),
  'providers.signInResize': z.object({
    provider: z.string(),
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
  'providers.cancelSignIn': signInProvider,
  'providers.signOut': signInProvider,
} as const;

export interface CustomProviderMethodResults {
  'providers.saveCustom': { id: string };
  'providers.deleteCustom': { ok: true };
  /** Результат команды самого CLI (`claude auth status --json`, `codex login status`); `detail` — короткая подпись, если есть. */
  'providers.authStatus': { signedIn: boolean; detail: string | null };
  'providers.signIn': { ok: true };
  'providers.signInInput': { ok: true };
  'providers.signInResize': { ok: true };
  'providers.cancelSignIn': { ok: true };
  'providers.signOut': { ok: true };
}
