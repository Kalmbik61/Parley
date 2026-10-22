import {
  accountLabel,
  baseUrlError,
  clearSecret,
  customProviderSecret,
  defaultAccountSlug,
  isAccountRecord,
  isCustomProviderId,
  isValidCustomProviderId,
  listCustomSecretIds,
  loadProviders,
  parleyHome,
  prepareCustomProviderDir,
  readCustomProviders,
  removeCustomProviderDir,
  slugProviderId,
  syncApiKeyApproval,
  userClaudeConfigDir,
  writeCustomProviders,
} from '@parley/core';
import type { CustomAccountRecord, CustomEndpointRecord, CustomProviderRecord } from '@parley/core';
import type { Params } from '@parley/protocol';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { AuthService } from '../providers/auth-service.js';
import type { CustomCheckService } from '../providers/custom-check.js';

/**
 * Записи читаются и пишутся целиком: два запроса подряд не должны потерять правку друг друга. Та же очередь
 * держит ключи своих провайдеров, подготовку их папок при запуске и удаление (финальная рецензия).
 */
let queue: Promise<unknown> = Promise.resolve();
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

type SaveParams = Params<'providers.saveCustom'>;
type AccountParams = Extract<SaveParams, { link: boolean }>;

const isAccountParams = (params: SaveParams): params is AccountParams =>
  params.kind === 'claude-account' || params.kind === 'codex-account';

/**
 * Занят и id с оставшейся папкой (удаление без removeFolder) или забытым ключом: новый провайдер не должен
 * унаследовать чужую историю, доверие и ключ (финальная рецензия).
 */
async function takenIds(records: readonly CustomProviderRecord[]): Promise<Set<string>> {
  const folders = (await readdir(path.join(parleyHome(), 'providers')).catch(() => [])).filter(isValidCustomProviderId);
  return new Set([
    ...Object.keys(await loadProviders()),
    ...records.map((record) => record.id),
    ...folders,
    ...(await listCustomSecretIds()),
  ]);
}

/**
 * Пустое имя аккаунта хост заменяет стандартным и записывает его в файл: имена не сползают после удалений
 * (спека подписок 5.9). При правке номер считает аккаунты до записи, при создании — все, как `accountLabel`.
 */
function accountRecordOf(params: AccountParams, id: string, records: readonly CustomProviderRecord[]): CustomAccountRecord {
  const record: CustomAccountRecord = { kind: params.kind, id, label: params.label, link: params.link };
  return params.label === '' ? { ...record, label: accountLabel(record, records) } : record;
}

function endpointRecordOf(params: Exclude<SaveParams, AccountParams>, id: string): CustomEndpointRecord {
  return {
    kind: 'endpoint',
    id,
    label: params.label,
    preset: params.preset,
    baseUrl: params.baseUrl,
    auth: params.auth,
    models: { ...params.models },
    contextWindow: params.contextWindow,
    linkClaude: params.linkClaude,
  };
}

/**
 * `providers.saveCustom` / `providers.deleteCustom` (спека 5.1, 5.4, Review Focus 3; подписки 5.1, 5.9, 10). Ключ здесь не
 * участвует: он идёт через `providers.setKey` и в файл записей не попадает; у аккаунта ключа нет вовсе.
 */
export function createCustomProviderHandlers(
  customCheck?: CustomCheckService,
  auth?: Pick<AuthService, 'refresh' | 'forget'>,
): {
  'providers.saveCustom': Handler<'providers.saveCustom'>;
  'providers.deleteCustom': Handler<'providers.deleteCustom'>;
} {
  const saveCustom: Handler<'providers.saveCustom'> = (params, request) =>
    serialized(async () => {
      // Аккаунт Codex — этап 3 спеки подписок: хост его пока не хранит и не запускает.
      if (params.kind === 'codex-account') throw new HostError('bad_request', 'Codex accounts are not supported by this host yet');
      // Вид и префикс id сходятся: аккаунт Claude и запись с адресом живут под `custom-`, `codex-` — только Codex (К8).
      if (params.id !== null && !isCustomProviderId(params.id)) {
        throw new HostError('bad_request', 'The id does not match the kind of the provider');
      }
      if (!isAccountParams(params)) {
        const urlError = baseUrlError(params.baseUrl);
        if (urlError !== null) throw new HostError('bad_request', urlError);
      }
      const records = await readCustomProviders();
      let id: string;
      if (params.id === null) {
        const taken = await takenIds(records);
        id = isAccountParams(params) ? defaultAccountSlug(params.kind, taken) : slugProviderId(params.label, taken);
      } else {
        id = params.id;
        // Id при правке не меняется и должен принадлежать существующей записи (Review Focus 3); вид записи тоже.
        const existing = records.find((record) => record.id === id);
        if (existing === undefined) throw new HostError('bad_request', 'Unknown custom provider');
        if ((existing.kind ?? 'endpoint') !== (params.kind ?? 'endpoint')) {
          throw new HostError('bad_request', 'The kind of a provider cannot be changed');
        }
      }
      const record: CustomProviderRecord = isAccountParams(params) ? accountRecordOf(params, id, records) : endpointRecordOf(params, id);
      const next = params.id === null ? [...records, record] : records.map((item) => (item.id === id ? record : item));
      try {
        await writeCustomProviders(next);
        // Смена linkClaude (у аккаунта — link) переставляет или убирает ссылки в папке провайдера.
        await prepareCustomProviderDir(record, { claudeConfigDir: userClaudeConfigDir() });
        // Режим bearer: хвост ключа, одобренный раньше в api-key, в папке не остаётся (К17).
        if (!isAccountRecord(record) && record.auth === 'bearer') await syncApiKeyApproval(id, null);
      } catch {
        throw new HostError('internal', 'Unable to save the custom provider');
      }
      customCheck?.forget(id);
      request.host.broadcast('providers.changed', { provider: id });
      // Сохранённый аккаунт сразу проверяется на вход (К5); ответ проверку не ждёт, смену состояния окно получит событием.
      if (isAccountRecord(record)) void auth?.refresh(id);
      return { id };
    });

  const deleteCustom: Handler<'providers.deleteCustom'> = ({ id, removeFolder }, request) =>
    serialized(async () => {
      const records = await readCustomProviders();
      const existing = records.find((record) => record.id === id);
      if (existing === undefined) throw new HostError('bad_request', 'Unknown custom provider');
      // У аккаунта подписки ключа и одобрения ключа нет (спека подписок 5.3, К12): чистить нечего.
      const hasKey = !isAccountRecord(existing);
      try {
        // Сначала ключ: упавший clearSecret не оставит ключ без записи, которую уже не удалить из окна.
        if (hasKey) await clearSecret(customProviderSecret(id));
        await writeCustomProviders(records.filter((record) => record.id !== id));
        // Папка может остаться: в ней не должно быть записи об одобренном ключе (К17).
        if (hasKey) await syncApiKeyApproval(id, null);
        if (removeFolder) await removeCustomProviderDir(id);
      } catch {
        throw new HostError('internal', 'Unable to delete the custom provider');
      }
      customCheck?.forget(id);
      // Новый аккаунт на освободившемся id не должен унаследовать прежнее состояние входа (и вход, если он идёт).
      if (isAccountRecord(existing)) auth?.forget(id);
      request.host.broadcast('providers.changed', { provider: id });
      return { ok: true as const };
    });

  return { 'providers.saveCustom': saveCustom, 'providers.deleteCustom': deleteCustom };
}
