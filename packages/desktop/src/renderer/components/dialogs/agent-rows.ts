/**
 * Общее состояние строк агентов диалогов «New session or room» и «New workspace»: тип строки, правила выбора модели и
 * уровня, провайдер и роль строки, список строк (`useAgentRows`), снимок провайдеров на время открытия
 * (`useDialogProviders`) и роли проекта (`useProjectRoles`). Отрисовка строк — `AgentRowsEditor.tsx`, запуск —
 * `launch-agents.ts`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Result, RoleSummary } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';
import { defaultProvider } from '../../lib/default-provider.js';
import { effortChoices } from '../../lib/effort-choices.js';
import { useHostStore } from '../../store/host.js';
import { useUiStore } from '../../store/ui.js';

export type ProviderOption = Result<'providers.list'>['providers'][number];

/**
 * Пункт `Default` списка моделей. Radix Select не берёт пустую строку как значение пункта, а `id` модели — слово без
 * пробелов (схема протокола): значение с ведущим пробелом с id не совпадёт никогда.
 */
export const DEFAULT_MODEL = ' default';

/** Пункт `Default` списка уровней — без флага `--effort`; уровень — токен без пробелов (`EFFORT_TOKEN`), с ним не совпадёт. */
export const DEFAULT_EFFORT = ' default';

/** Строка агента диалога. `provider: null` — «агент по умолчанию»: он выбирается по ответу `providers.list`. */
export interface AgentRow {
  key: number;
  provider: string | null;
  /** `id` из списка провайдера; `null` — `Default`, без флага. */
  model: string | null;
  /** Уровень из списка модели; `null` — `Default`, без флага. */
  effort: string | null;
  role: string | null;
  /** Роль из рецепта, которой на этой машине нет: строка не запускается, пока её не поправят. */
  roleMissing: string | null;
  /** Свой worktree строки; `null` — как у общего флажка. Рецепт задаёт его построчно. */
  worktree: boolean | null;
  providerTouched: boolean;
  modelTouched: boolean;
  effortTouched: boolean;
}

/** Итог запуска по строке агента — только после первой попытки. */
export type AgentResult = { status: 'started'; sessionId: string } | { status: 'failed'; message: string };

/** Режим комнаты. */
export type Mode = 'free' | 'checklist' | 'verified';
export const MODES: readonly Mode[] = ['free', 'checklist', 'verified'];

export const blankRow = (key: number, provider: string | null = null): AgentRow => ({ key, provider, model: null, effort: null, role: null, roleMissing: null, worktree: null, providerTouched: false, modelTouched: false, effortTouched: false });

/**
 * Модель строки, если она есть в списке провайдера; иначе `null` — `Default`. Каталог мог смениться под открытым
 * диалогом (`providers.changed`): исчезнувшая модель не показывается выбранной и не уходит в `sessions.create`.
 */
export function chosenModel(row: Pick<AgentRow, 'model'>, info: ProviderOption | undefined): string | null {
  return row.model !== null && (info?.models ?? []).some((option) => option.id === row.model) ? row.model : null;
}

/**
 * Уровень строки, если он есть среди уровней её модели; иначе `null` — `Default`. Одно правило на подпись списка, сброс
 * при смене модели и отправку: снимок провайдеров мог смениться под строкой (`providers.changed`).
 */
export function chosenEffort(row: Pick<AgentRow, 'model' | 'effort'>, info: ProviderOption | undefined): string | null {
  if (row.effort === null) return null;
  return effortChoices(info, chosenModel(row, info))?.some((level) => level.id === row.effort) === true ? row.effort : null;
}

/** Что нужно знать о строке, чтобы найти её роль и провайдера: роли проекта, снимок провайдеров и агент по умолчанию. */
export interface AgentEnv {
  roles: readonly RoleSummary[];
  providers: readonly ProviderOption[] | null;
  defaultId: string | null;
}

export const roleOf = (env: AgentEnv, row: AgentRow): RoleSummary | undefined => env.roles.find((role) => role.id === row.role);

export function providerIdOf(env: AgentEnv, row: AgentRow): string | null {
  const role = roleOf(env, row);
  return role?.source !== undefined && role.source !== 'builtin' ? role.provider : row.provider ?? role?.provider ?? env.defaultId;
}

export function infoOf(env: AgentEnv, row: AgentRow): ProviderOption | undefined {
  const id = providerIdOf(env, row);
  return env.providers?.find((provider) => provider.id === id);
}

/** Источник роли строки: из каталога ролей, а пока он не ответил — из самого id (`claude:name`). */
export function roleSource(env: AgentEnv, row: AgentRow): 'builtin' | 'claude' | 'codex' {
  return roleOf(env, row)?.source ?? ((row.role ?? '').slice(0, (row.role ?? '').indexOf(':')) as 'builtin' | 'claude' | 'codex');
}

/** Свой worktree строки или общий флажок диалога. */
export const wantsWorktree = (row: AgentRow, worktree: boolean): boolean => row.worktree ?? worktree;

/**
 * Список строк агентов. `initialCount` — сколько пустых строк в начале, `minRows` — ниже скольки удалять нельзя
 * (диалог сессии держит одну, диалог работы — ни одной).
 */
export function useAgentRows(initialCount: number, minRows: number) {
  const [agents, setAgents] = useState<AgentRow[]>(() => Array.from({ length: initialCount }, (_, index) => blankRow(index + 1)));
  const nextKey = useRef(initialCount + 1);

  /** Новый состав целиком — с открытия формы или из рецепта. */
  const replaceAgents = (rows: AgentRow[]): void => {
    setAgents(rows);
    nextKey.current = rows.length + 1;
  };
  const resetAgents = (count: number): void => replaceAgents(Array.from({ length: count }, (_, index) => blankRow(index + 1)));
  const updateAgent = (key: number, patch: Partial<Omit<AgentRow, 'key'>>): void =>
    setAgents((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addAgent = (): void => {
    const last = agents[agents.length - 1];
    setAgents((rows) => [...rows, blankRow(nextKey.current++, last?.provider ?? null)]);
  };
  const removeAgent = (key: number): void => setAgents((rows) => (rows.length <= minRows ? rows : rows.filter((row) => row.key !== key)));

  return { agents, setAgents, replaceAgents, resetAgents, updateAgent, addAgent, removeAgent };
}

/**
 * Снимок провайдеров на время, пока диалог открыт: ответ `providers.list`, его обновление по `providers.changed` и
 * перезапуску хоста, агент по умолчанию. Снимок сбрасывается до отрисовки (`useLayoutEffect`), как форма: в `useEffect`
 * диалог успевал показать пилюли прошлого открытия, и карточка, открытая на такой пилюле, теряла её из-под себя, когда
 * сброс доходил (фокус после Escape — на диалоге).
 *
 * `providersRef` и `providersReady` отвечают на вопрос «свежо ли сейчас» синхронно: он нужен и между последовательными
 * запусками агентов. Обновление фиксирует неявный выбор строк: удаление ключа не должно тихо заменить выбранный GLM на Claude.
 */
export function useDialogProviders(open: boolean, bridge: ParleyBridge, setAgents: Dispatch<SetStateAction<AgentRow[]>>) {
  const lastProvider = useUiStore((state) => state.ui.lastProvider);
  const connections = useHostStore((state) => state.connections);
  const priorConnections = useRef(connections);
  /** `null` — `providers.list` этого открытия ещё не ответил. */
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const providersRef = useRef<ProviderOption[] | null>(null);
  const providersReady = useRef(false);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const reloadProviders = useCallback(async (): Promise<void> => {
    await refreshRef.current?.();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    let stale = false;
    let generation = 0;
    providersRef.current = null;
    providersReady.current = false;
    setProviders(null);
    setProvidersError(null);
    const refresh = async (): Promise<void> => {
      if (stale) return;
      const current = ++generation;
      // Сохраняем и неявный выбор: удаление ключа не должно тихо заменить выбранный GLM на Claude.
      const prior = providersRef.current;
      if (prior !== null) {
        const chosen = defaultProvider(prior, useUiStore.getState().ui.lastProvider);
        setAgents((rows) => rows.map((row) => row.provider === null ? { ...row, provider: chosen } : row));
      }
      providersReady.current = false;
      setProvidersLoading(true);
      try {
        const result = await bridge.call('providers.list', {});
        if (stale || current !== generation) return;
        providersRef.current = result.providers;
        providersReady.current = true;
        setProviders(result.providers);
        setProvidersError(null);
      } catch (err: unknown) {
        if (stale || current !== generation) return;
        console.warn('[parley] providers.list', err);
        setProvidersError(errorText(decodeIpcError(err).code, S.errors.actions.loadProviders));
      } finally {
        if (!stale && current === generation) setProvidersLoading(false);
      }
    };
    refreshRef.current = refresh;
    // Событие несёт только id, поэтому доступность выясняем заново, а не угадываем действие с ключом.
    const offChanged = bridge.on('providers.changed', () => { void refresh(); });
    void refresh();
    return () => {
      stale = true;
      providersReady.current = false;
      refreshRef.current = null;
      offChanged();
    };
  }, [open, bridge, setAgents]);

  useEffect(() => {
    if (priorConnections.current === connections) return;
    priorConnections.current = connections;
    // Перезапуск хоста не закрывает форму: новый ответ заменяет снимок и отменяет ответы прежнего хоста.
    void reloadProviders();
  }, [connections, reloadProviders]);

  const defaultId = providers === null ? null : defaultProvider(providers, lastProvider);
  return { providers, providersLoading, providersError, providersRef, providersReady, reloadProviders, defaultId };
}

/** Роли проекта для списков строк; пока проект не выбран или ответа нет — пусто. */
export function useProjectRoles(open: boolean, bridge: ParleyBridge, projectPath: string | null): RoleSummary[] {
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  useEffect(() => {
    setRoles([]);
    if (!open || projectPath === null) return;
    let stale = false;
    bridge.call('roles.list', { projectPath }).then((result) => { if (!stale) setRoles(result.roles); }).catch(() => {});
    return () => { stale = true; };
  }, [open, bridge, projectPath]);
  return roles;
}
