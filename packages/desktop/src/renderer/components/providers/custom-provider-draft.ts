/**
 * Черновик формы своего провайдера (спека своих провайдеров, 4.3, 5.1, 7): проверка полей на стороне окна и
 * превращение в параметры `providers.saveCustom`. Ключ в параметры не входит — он уходит отдельно `providers.setKey`.
 */

import type { CustomProviderAuth, CustomProviderInfo, CustomProviderModels, Params } from '@parley/protocol';
import { S } from '../../../shared/strings.js';
import type { CustomPreset, CustomPresetEndpoint } from './custom-presets.js';

export interface CustomProviderDraft {
  /** `null` — новый провайдер: id выдаёт хост. */
  id: string | null;
  label: string;
  preset: string | null;
  endpointId: string | null;
  baseUrl: string;
  auth: CustomProviderAuth;
  models: CustomProviderModels;
  /** «Одна модель на все слоты»: сохраняется значение слота Sonnet. */
  oneModel: boolean;
  contextWindow: number | null;
  linkClaude: boolean;
  /** Набранный ключ; сохранённый живёт на хосте. */
  key: string;
}

const EMPTY_MODELS: CustomProviderModels = { opus: '', sonnet: '', haiku: '', subagent: '' };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const SLOTS = ['opus', 'sonnet', 'haiku', 'subagent'] as const;

/** Пресет и его адрес (или «Own address», если `null`); «Подтянуть из Claude Code» включено у нового (К4). */
export function draftFromPreset(preset: CustomPreset | null, endpoint: CustomPresetEndpoint | null): CustomProviderDraft {
  return {
    id: null,
    label: preset?.label ?? '',
    preset: preset?.id ?? null,
    endpointId: endpoint?.id ?? null,
    baseUrl: endpoint?.baseUrl ?? '',
    auth: endpoint?.auth ?? 'bearer',
    models: endpoint === null ? { ...EMPTY_MODELS } : { ...endpoint.models },
    oneModel: false,
    contextWindow: endpoint?.contextWindow ?? null,
    linkClaude: true,
    key: '',
  };
}

export function draftFromProvider(item: { id: string; label: string; custom: CustomProviderInfo }): CustomProviderDraft {
  const { custom } = item;
  const { opus, sonnet, haiku, subagent } = custom.models;
  return {
    id: item.id,
    label: item.label,
    preset: custom.preset,
    endpointId: null,
    baseUrl: custom.baseUrl,
    auth: custom.auth,
    models: { ...custom.models },
    oneModel: sonnet !== '' && opus === sonnet && haiku === sonnet && subagent === sonnet,
    contextWindow: custom.contextWindow,
    linkClaude: custom.linkClaude,
    key: '',
  };
}

function effectiveModels(draft: CustomProviderDraft): CustomProviderModels {
  if (!draft.oneModel) return Object.fromEntries(SLOTS.map((slot) => [slot, draft.models[slot].trim()])) as unknown as CustomProviderModels;
  const model = draft.models.sonnet.trim();
  return { opus: model, sonnet: model, haiku: model, subagent: model };
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** Адрес на этом же компьютере: ключ ему не нужен (спека 4.1, 8), проверка идёт и без ключа. */
export function isLoopbackAddress(url: string): boolean {
  const parsed = parse(url.trim());
  return parsed !== null && LOOPBACK.has(parsed.hostname);
}

/** Первая ошибка черновика текстом для человека или `null`. */
export function draftError(draft: CustomProviderDraft, keySaved: boolean): string | null {
  const E = S.customProviders.errors;
  if (draft.label.trim() === '') return E.name;
  const url = draft.baseUrl.trim();
  if (url.includes('{')) return E.placeholder;
  const parsed = parse(url);
  if (parsed === null || /\s/.test(url)) return E.address;
  const loopback = LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return E.https;
  if (parsed.username !== '' || parsed.password !== '') return E.credentials;
  if (url.includes('?') || url.includes('#')) return E.query;
  const models = effectiveModels(draft);
  for (const slot of SLOTS) {
    const model = models[slot];
    if (model === '') return draft.oneModel ? E.oneModelEmpty : E.slotEmpty;
    if (!/^[^\s-]\S*$/.test(model)) return E.slotInvalid;
  }
  if (draft.id === null && !keySaved && draft.key.trim() === '' && !loopback) return E.key;
  return null;
}

export function saveParams(draft: CustomProviderDraft): Params<'providers.saveCustom'> {
  return {
    id: draft.id,
    label: draft.label.trim(),
    preset: draft.preset,
    baseUrl: draft.baseUrl.trim(),
    auth: draft.auth,
    models: effectiveModels(draft),
    contextWindow: draft.contextWindow,
    linkClaude: draft.linkClaude,
  };
}
