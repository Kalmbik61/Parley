/**
 * Что нужно помощнику, чтобы завести нового агента или новую работу (спека 2026-10-28, 6.2 и 6.3): проект, роль,
 * провайдер и модель. Чистые функции над снимком работ, списком ролей и реестром провайдеров; готовность провайдера
 * (`ready`) приходит снаружи. Правило провайдера и модели роли — то же, что в окне (`roleProvider`, `roleModel`).
 */

import { ASSISTANT_PROVIDER_ORDER, providerLabel, roleModel, roleProvider, type ProviderEntry, type RoleSummary } from '@parley/core';
import { projectLabel, projectName, targetsOf, type OverviewSource } from './overview.js';

/**
 * Проект — `projectPath` любой записи снимка, в том числе архивных работ. Ищется по пути, по id работы (берётся её
 * проект) и по имени папки без учёта регистра; два проекта с одним именем — отказ с id работ, чтобы выбрать.
 */
export function resolveProject(source: OverviewSource, wanted: string): { projectPath: string; label: string } | { error: string } {
  const key = wanted.trim();
  const label = (projectPath: string): string => projectLabel(source.entries, projectPath, source.home);
  // Первая работа каждого проекта: по её id проект можно назвать однозначно.
  const firstWork = new Map<string, string>();
  const byId = new Map<string, string>();
  for (const target of targetsOf(source, { hidden: true })) {
    if (target.kind !== 'work') continue;
    byId.set(target.id, target.projectPath);
    if (!firstWork.has(target.projectPath)) firstWork.set(target.projectPath, target.id);
  }
  if (firstWork.has(key)) return { projectPath: key, label: label(key) };
  const ofWork = byId.get(key);
  if (ofWork !== undefined) return { projectPath: ofWork, label: label(ofWork) };
  const name = key.toLowerCase();
  const matches = name === '' ? [] : [...firstWork.keys()].filter((projectPath) => projectName(projectPath).toLowerCase() === name);
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { projectPath: only, label: label(only) };
  if (matches.length > 1) {
    const list = matches.map((projectPath) => `${label(projectPath)} (${firstWork.get(projectPath) ?? ''})`).join(', ');
    return { error: `"${key}" matches several projects: ${list}. Name one by a work id.` };
  }
  return { error: `"${key}" is not a Parley project; add it in Parley first.` };
}

/** Роль по имени: точное без учёта регистра побеждает подстроку; несколько совпадений — отказ со списком. */
export function resolveRole(roles: readonly RoleSummary[], wanted: string): { role: RoleSummary } | { error: string } {
  const key = wanted.trim();
  const name = key.toLowerCase();
  const exact = roles.filter((role) => role.name.toLowerCase() === name);
  const matches = exact.length > 0 ? exact : name === '' ? [] : roles.filter((role) => role.name.toLowerCase().includes(name));
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return { role: only };
  if (matches.length > 1) {
    return { error: `"${key}" matches several roles: ${matches.map((role) => `${role.name} (${role.source})`).join(', ')}. Say which one.` };
  }
  return { error: `No role "${key}". Roles: ${roles.map((role) => role.name).join(', ')}.` };
}

export interface NewAgentChoice {
  provider: ProviderEntry;
  /** Что уйдёт в `sessions.create`; `null` — не передавать (явный `null` стёр бы умолчание роли). */
  model: string | null;
  /** Что показать на карточке: названная модель или модель роли на этом провайдере. */
  shownModel: string | null;
}

export interface ChooseProviderInput {
  role: RoleSummary | null;
  provider: string | null;
  model: string | null;
  /** Умолчание окна (`assistant.configure.defaultProvider`). */
  fallback: string | null;
  registry: Readonly<Record<string, ProviderEntry>>;
  /** Причина, по которой провайдер не готов, или `null`, если готов. */
  ready(entry: ProviderEntry): Promise<string | null>;
}

const NO_PROVIDER_READY = 'No provider is ready to start an agent — open Settings.';

/**
 * Провайдер и модель нового агента (спека 6.2). Не встроенная роль навязывает свой провайдер; иначе названный;
 * иначе провайдер встроенной роли; иначе умолчание окна, а без него — первый готовый в порядке помощника.
 */
export async function chooseProvider(input: ChooseProviderInput): Promise<{ choice: NewAgentChoice } | { error: string }> {
  const { role, registry } = input;
  const entries = Object.values(registry);
  const providers = entries.map((entry) => entry.id).join(', ');

  let named: ProviderEntry | null = null;
  if (input.provider !== null) {
    const wanted = input.provider.trim().toLowerCase();
    named = entries.find((entry) => entry.id.toLowerCase() === wanted || entry.label.toLowerCase() === wanted) ?? null;
    if (named === null) return { error: `No provider "${input.provider}". Providers: ${providers}.` };
  }
  if (role !== null && role.source !== 'builtin' && named !== null && named.id !== role.provider) {
    const own = Object.hasOwn(registry, role.provider) ? registry[role.provider] : undefined;
    return { error: `Role ${role.name} runs on ${own === undefined ? role.provider : providerLabel(own)}; leave the provider out or pick another role.` };
  }

  let entry: ProviderEntry | undefined;
  const fixedId = roleProvider(role ?? undefined, named?.id ?? null, null);
  if (fixedId !== null) {
    entry = Object.hasOwn(registry, fixedId) ? registry[fixedId] : undefined;
    if (entry === undefined) return { error: `No provider "${fixedId}". Providers: ${providers}.` };
    const why = await input.ready(entry);
    if (why !== null) return { error: `${providerLabel(entry)} is not ready: ${why}` };
  } else {
    const order = new Set([...(input.fallback === null ? [] : [input.fallback]), ...ASSISTANT_PROVIDER_ORDER, ...Object.keys(registry)]);
    for (const id of order) {
      const candidate = Object.hasOwn(registry, id) ? registry[id] : undefined;
      if (candidate === undefined) continue;
      if ((await input.ready(candidate)) === null) {
        entry = candidate;
        break;
      }
    }
    if (entry === undefined) return { error: NO_PROVIDER_READY };
  }

  if (input.model === null) return { choice: { provider: entry, model: null, shownModel: roleModel(role ?? undefined, entry.id) } };
  const wantedModel = input.model.trim();
  const models = entry.models;
  if (models === undefined || models === null || models.length === 0) return { choice: { provider: entry, model: wantedModel, shownModel: wantedModel } };
  const key = wantedModel.toLowerCase();
  const found = models.find((model) => model.id.toLowerCase() === key || model.label.toLowerCase() === key);
  if (found === undefined) return { error: `${providerLabel(entry)} has no model "${wantedModel}". Models: ${models.map((model) => model.id).join(', ')}.` };
  return { choice: { provider: entry, model: found.id, shownModel: found.id } };
}
