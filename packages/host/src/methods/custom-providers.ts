import {
  baseUrlError,
  clearSecret,
  customProviderSecret,
  loadProviders,
  prepareCustomProviderDir,
  readCustomProviders,
  removeCustomProviderDir,
  slugProviderId,
  syncApiKeyApproval,
  userClaudeConfigDir,
  writeCustomProviders,
} from '@parley/core';
import type { CustomProviderRecord } from '@parley/core';
import type { Handler } from '../context.js';
import { HostError } from '../errors.js';
import type { CustomCheckService } from '../providers/custom-check.js';

/** Записи читаются и пишутся целиком: два запроса подряд не должны потерять правку друг друга. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * `providers.saveCustom` / `providers.deleteCustom` (спека 5.1, 5.4, Review Focus 3). Ключ здесь не
 * участвует: он идёт через `providers.setKey` и в файл записей не попадает.
 */
export function createCustomProviderHandlers(customCheck?: CustomCheckService): {
  'providers.saveCustom': Handler<'providers.saveCustom'>;
  'providers.deleteCustom': Handler<'providers.deleteCustom'>;
} {
  const saveCustom: Handler<'providers.saveCustom'> = (params, request) =>
    serialized(async () => {
      const urlError = baseUrlError(params.baseUrl);
      if (urlError !== null) throw new HostError('bad_request', urlError);
      const records = await readCustomProviders();
      let id: string;
      if (params.id === null) {
        const taken = new Set([...Object.keys(await loadProviders()), ...records.map((record) => record.id)]);
        id = slugProviderId(params.label, taken);
      } else {
        id = params.id;
        // Id при правке не меняется и должен принадлежать существующей записи (Review Focus 3).
        if (!records.some((record) => record.id === id)) throw new HostError('bad_request', 'Unknown custom provider');
      }
      const record: CustomProviderRecord = {
        id,
        label: params.label,
        preset: params.preset,
        baseUrl: params.baseUrl,
        auth: params.auth,
        models: { ...params.models },
        contextWindow: params.contextWindow,
        linkClaude: params.linkClaude,
      };
      const next = params.id === null ? [...records, record] : records.map((item) => (item.id === id ? record : item));
      try {
        await writeCustomProviders(next);
        // Смена linkClaude переставляет или убирает ссылки в папке провайдера.
        await prepareCustomProviderDir(record, { claudeConfigDir: userClaudeConfigDir() });
      } catch {
        throw new HostError('internal', 'Unable to save the custom provider');
      }
      customCheck?.forget(id);
      request.host.broadcast('providers.changed', { provider: id });
      return { id };
    });

  const deleteCustom: Handler<'providers.deleteCustom'> = ({ id, removeFolder }, request) =>
    serialized(async () => {
      const records = await readCustomProviders();
      if (!records.some((record) => record.id === id)) throw new HostError('bad_request', 'Unknown custom provider');
      try {
        await writeCustomProviders(records.filter((record) => record.id !== id));
        await clearSecret(customProviderSecret(id));
        // Папка может остаться: в ней не должно быть записи об одобренном ключе (К17).
        await syncApiKeyApproval(id, null);
        if (removeFolder) await removeCustomProviderDir(id);
      } catch {
        throw new HostError('internal', 'Unable to delete the custom provider');
      }
      customCheck?.forget(id);
      request.host.broadcast('providers.changed', { provider: id });
      return { ok: true as const };
    });

  return { 'providers.saveCustom': saveCustom, 'providers.deleteCustom': deleteCustom };
}
