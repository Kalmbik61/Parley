/**
 * Запуск агентов из строк диалогов «New session or room» и «New workspace»: по очереди `sessions.create` для строк,
 * которые ещё не запущены, и `rooms.create` над запущенными. Диалоги держат своё состояние (итоги по строкам, ошибку,
 * `busy`, отмену) и дают этим функциям только чтение и обратные вызовы; что делать после — открыть вкладку, закрыть
 * диалог, отправить промпт — решает диалог.
 */

import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S, startErrorText } from '../../../shared/strings.js';
import { effortChoices } from '../../lib/effort-choices.js';
import {
  chosenEffort,
  chosenModel,
  providerIdOf,
  roleSource,
  wantsWorktree,
  type AgentEnv,
  type AgentResult,
  type AgentRow,
  type Mode,
  type ProviderOption,
} from './agent-rows.js';

export interface LaunchTarget {
  projectPath: string;
  workId: string;
}

export interface StartAgentsOptions {
  bridge: ParleyBridge;
  target: LaunchTarget;
  rows: readonly AgentRow[];
  /** Итоги прежних попыток: запущенные пропускаются, новые дописываются сюда же. */
  done: Record<number, AgentResult>;
  env: AgentEnv;
  /** Свежесть снимка провайдеров между запусками: ключ могли убрать в другой карточке или окне. */
  providersRef: { readonly current: ProviderOption[] | null };
  providersReady: { readonly current: boolean };
  /** Общий флажок worktree и то, что проект — git-репозиторий (без него worktree не просят). */
  worktree: boolean;
  worktreeAvailable: boolean;
  /** Ярлык и задача каждой сессии. */
  label: string;
  task: string;
  /** Поле `lean`; `null` — не слать, решает хост. */
  lean: boolean | null;
  /** Писать ли в консоль сбой `sessions.create` (бэклог-запуск показывает его сам). */
  logFailures: boolean;
  isCancelled(): boolean;
  /** «По умолчанию» становится явным выбором строки. */
  pinProvider(key: number, provider: string): void;
  /** Итоги по строкам после каждого агента. */
  reportResults(done: Record<number, AgentResult>): void;
}

/** `stopped` — запуск прерван без итога (отмена, пропавший провайдер, строка без провайдера: тогда есть `error`). */
export type StartOutcome = { kind: 'started' } | { kind: 'failed' } | { kind: 'stopped'; error?: string };

/**
 * По очереди, а не разом: номера сессий идут в порядке строк, и звезда ведущего указывает на свою.
 */
export async function startAgents(options: StartAgentsOptions): Promise<StartOutcome> {
  const { bridge, target, done, env } = options;
  let allStarted = true;
  for (const row of options.rows) {
    if (done[row.key]?.status === 'started') continue;
    const providerId = providerIdOf(env, row);
    const info = options.providersRef.current?.find((provider) => provider.id === providerId);
    if (providerId === null) return { kind: 'stopped', error: S.dialogs.newWork.agentRequired };
    // Пока предыдущая сессия стартовала, ключ могли убрать в другой карточке или окне.
    if (!options.providersReady.current || info?.available !== true) return { kind: 'stopped' };
    // «По умолчанию» становится явным выбором: `lastProvider` сменится, когда запустятся все, и строка не должна
    // за ним перескочить — под итогом «запущена» стояла бы пилюля не того провайдера.
    if (row.provider === null) options.pinProvider(row.key, providerId);
    try {
      const { ref } = await bridge.call('sessions.create', {
        ...target,
        provider: providerId,
        label: options.label,
        task: options.task,
        parent: null,
        // Рецепт задаёт worktree построчно; без него — общий флажок. Без git-проекта worktree не просят.
        worktree: wantsWorktree(row, options.worktree) && options.worktreeAvailable,
        ...(row.role === null ? {} : { role: { source: roleSource(env, row), name: row.role.slice(row.role.indexOf(':') + 1) } }),
        // Модель и effort — только явно выбранные (тронутые) и ещё существующие в снимке провайдеров: `null` — явный
        // `Default` (снимает умолчание роли, флага нет), провайдер без списка или уровней их не получает, исчезнувший
        // после `providers.changed` выбор уходит как `Default`.
        ...(row.modelTouched && (info?.models?.length ?? 0) > 0 ? { model: chosenModel(row, info) } : {}),
        ...(row.effortTouched && effortChoices(info, chosenModel(row, info)) !== null ? { effort: chosenEffort(row, info) } : {}),
        ...(options.lean === null ? {} : { lean: options.lean }),
      });
      done[row.key] = { status: 'started', sessionId: ref.sessionId };
    } catch (err) {
      if (options.logFailures) console.warn('[parley] sessions.create', err);
      const failure = decodeIpcError(err);
      // Бюджет исчерпал кто-то другой за время диалога: `startErrorText` называет предел, где он и что делать.
      done[row.key] = { status: 'failed', message: startErrorText(failure, S.errors.actions.createSession) };
      allStarted = false;
    }
    // Диалог закрыли, пока шёл этот агент, — следующих не запускаем и итог в форму не пишем.
    if (options.isCancelled()) return { kind: 'stopped' };
    options.reportResults({ ...done });
  }
  return allStarted ? { kind: 'started' } : { kind: 'failed' };
}

/**
 * Настройка `leanAgents` для участников комнаты, когда при открытии она не пришла (ответ опоздал или упал): комната
 * спрашивает её ещё раз и один раз за запуск. Нет и теперь — `null`: поле lean опускаем, решает хост.
 */
export async function fetchRoomLean(bridge: ParleyBridge): Promise<boolean | null> {
  try {
    const { config } = await bridge.call('settings.get', {});
    if (typeof config.leanAgents === 'boolean') return config.leanAgents;
  } catch {
    // Хост настроек не отдал — поле lean не шлём.
  }
  return null;
}

export interface CreateRoomOptions {
  bridge: ParleyBridge;
  target: LaunchTarget;
  title: string;
  members: string[];
  lead: string;
  mode: Mode;
  /** Рецепт, выбранный в диалоге; `null` — комната без рецепта. */
  recipeId: string | null;
  logFailures: boolean;
  isCancelled(): boolean;
}

/** `stopped` — диалог закрыли (ничего не показываем); `failed` — текст ошибки для диалога. */
export type CreateRoomOutcome = { kind: 'created'; roomId: string } | { kind: 'stopped' } | { kind: 'failed'; message: string };

export async function createRoom(options: CreateRoomOptions): Promise<CreateRoomOutcome> {
  const { bridge, target } = options;
  // Снимок рецепта — из каталога в момент создания комнаты: правка файла за время диалога попадает в неё, а после
  // создания комнату уже не меняет. Рецепт исчез или стал битым — комната без него не создаётся.
  let recipe: { id: string; name: string; playbook: string } | null = null;
  if (options.recipeId !== null) {
    try {
      const fresh = await bridge.call('recipes.list', { projectPath: target.projectPath });
      if (options.isCancelled()) return { kind: 'stopped' };
      const found = fresh.entries.find((item) => item.status === 'valid' && item.recipe.id === options.recipeId);
      if (found === undefined || found.status !== 'valid') return { kind: 'failed', message: S.recipes.gone };
      recipe = { id: found.recipe.id, name: found.recipe.name, playbook: found.recipe.playbook };
    } catch (err) {
      if (options.isCancelled()) return { kind: 'stopped' };
      return { kind: 'failed', message: errorText(decodeIpcError(err).code, S.errors.actions.createRoom) };
    }
  }
  try {
    const { roomId } = await bridge.call('rooms.create', {
      ...target,
      title: options.title,
      members: options.members,
      lead: options.lead,
      quiet: true,
      ...(options.mode === 'free' ? {} : { mode: options.mode }),
      ...(recipe === null ? {} : { recipe }),
    });
    if (options.isCancelled()) return { kind: 'stopped' };
    return { kind: 'created', roomId };
  } catch (err) {
    if (options.logFailures) console.warn('[parley] rooms.create', err);
    if (options.isCancelled()) return { kind: 'stopped' };
    return { kind: 'failed', message: startErrorText(decodeIpcError(err), S.errors.actions.createRoom) };
  }
}
