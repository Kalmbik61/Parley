/**
 * Диалог «New session or room» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.5, 2.1) вместо прежних
 * `NewSessionDialog` и `CreateRoomDialog`. Тип следует из числа агентов и переключателя «Put them in a room»: один
 * агент создаёт сессию (`sessions.create` с `model` и `effort`, открывается её терминал); два и больше — по умолчанию
 * комнату с ведущим (N раз `sessions.create` и `rooms.create` с `lead` и `quiet: true`, открывается вкладка комнаты, строка
 * комнаты в сайдбаре разворачивается), а при выключенном переключателе — N отдельных сессий (N раз `sessions.create`,
 * без `rooms.create`, ведущего, названия комнаты и режима; открывается вкладка первой из созданных сессий). Переключатель
 * виден от двух агентов и каждое открытие начинается с включённого. Рецепт — это комната: при выключенном переключателе
 * выбор рецепта спрятан, а выбор рецепта переключатель включает. Отдельные сессии ведут себя как одиночная: к ним
 * относится флажок «Lean session», а лимит размера комнаты (`roomConcurrent`) бюджет не применяет — только слоты и запуски.
 *
 * Строки агентов, их состояние, снимок провайдеров и запуск общие с диалогом «New workspace»: `AgentRowsEditor.tsx`,
 * `agent-rows.ts`, `launch-agents.ts` в этой папке.
 *
 * Сессии комнаты стартуют сразу и без задачи (тихий старт: `task: ''`, ярлык пустой): задачу человек пишет в комнату
 * один раз для всех, поэтому и письма-приглашения не нужны (`quiet`). Одиночная сессия тоже стартует без задачи — её
 * человек пишет в терминале.
 *
 * Пустой ярлык хост пустым не оставляет: `addSession` core ставит сессии имя по номеру (`defaultSessionName`, спека
 * архива комнат, часть 2, 13), и автозаголовок его не меняет. Поэтому строка сайдбара, вкладка и упоминания
 * показывают `S05 Roman`, а не голый `S05` и не прежнее «New session».
 *
 * Частичный сбой запуска. Комната (если она нужна) создаётся, только когда запущены все агенты. Если часть `sessions.create`
 * упала, диалог остаётся открытым и показывает итог по каждому агенту, а «Retry» повторяет только упавших;
 * комнаты нет до успеха всех, а без комнаты после успеха всех открывается вкладка первой сессии. «Cancel» оставляет уже запущенные сессии обычными сессиями работы — они и так видны
 * в сайдбаре. Запущенные строки после первой попытки заперты: их провайдер, модель и усилие уже ушли в хост.
 * Провайдер «по умолчанию» при запуске фиксируется в строке: `ui.lastProvider` меняется, когда все агенты запущены, и
 * пилюля под итогом «запущена» не должна перескочить на провайдера последней строки, если `rooms.create` упал.
 *
 * Рецепт (спека рецептов, 6.1) выбирается наверху: он заполняет строки (роль, провайдер, модель, усилие, worktree,
 * ведущий; `count` уже развёрнут хостом), режим комнаты и дальше правится свободно. Заданное рецептом — явный выбор, как
 * тронутое человеком: уходит в сессию поверх умолчаний роли; не заданное остаётся умолчанием роли. Комната создаётся с
 * `mode` и снимком рецепта, взятым из `recipes.list` в момент создания. Строка с ролью, которой на машине нет, не
 * запускается, пока её не поправят. «Save as recipe» пишет состав, режим и плейбук файлом проекта через main.
 *
 * Закрытие диалога (Cancel, Esc, ×, клик мимо) отменяет идущий запуск: остальные агенты, комната и вкладка не создаются,
 * а форму, которую успели открыть заново (в том числе ⌘T поверх открытого диалога), запуск не трогает и не закрывает.
 * Отправленный запрос отменить нельзя — его сессия останется обычной сессией работы, как после частичного сбоя.
 *
 * Упавший `sessions.create` следа в окне не оставляет, но хост пишет запись сессии в карту до запуска и при сбое запуска
 * её не откатывает, а ответ об ошибке id не несёт: окно запись удалить не может. «Retry» заводит новую запись, запись
 * упавшей остаётся в сайдбаре не запущенной сессией (её убирает «Delete» меню строки) — при сбое worktree так осиротеют
 * все агенты. Откат записи — на стороне хоста; пункт «Хост не откатывает запись упавшей сессии» — в TODOS, §4.
 *
 * Модель — только из списка провайдера (`providers.list.models`, решение 5 спеки): первый пункт `Default` — без
 * флага, модель CLI по умолчанию, дальше подписи списка, в `sessions.create.model` уходит `id`. Нет списка, `null`
 * или пусто — контрола нет и модель не передаётся. Effort (нормалайзер модели и effort 2026-10-06, 5.9) — список
 * `Default` и уровней выбранной модели (`lib/effort-choices.ts`; у модели `Default` — уровни, общие для моделей
 * провайдера), описание уровня — второй строкой пункта; уровней нет — поля нет. Смена модели сбрасывает уровень,
 * которого у новой модели нет, в `Default`, смена провайдера — и модель, и уровень. Уходят только явно выбранные
 * значения: `Default` — без флага, CLI берёт сохранённое у себя. Своих списков и свободного ввода в окне нет.
 *
 * «In its own worktree» (спека 5.1, план worktree 4.3) остаётся: неактивен, пока `worktrees.available` не подтвердит,
 * что проект — git-репозиторий (`branches` для этого не годится: при отсоединённой голове ветки нет и у git-проекта).
 * Флажок один на все сессии диалога: у каждого агента комнаты свой worktree.
 *
 * Lean-режим (C2.2): участники комнаты уходят в `sessions.create` с `lean` из настройки `leanAgents` (читается при
 * открытии вместе с порогами; не пришла к «Create room» — комната спрашивает её ещё раз, и всё равно нет — поля нет,
 * решает хост), одиночная сессия и сессии без комнаты — со своим флажком «Lean session» (по умолчанию он по `leanAgents`, пока
 * человек его не тронул; без галочки поля нет).
 * Флажок виден, только когда хост отдал `leanAgents`: старый хост поле `lean` отбрасывает, и галочка бы врала.
 *
 * Бюджет работы (P37): пороги читаются из настроек при открытии, занятое — из карты выбранной работы. Подвал показывает,
 * сколько сессий идёт и сколько запусков осталось в часе; старт, который не помещается (нужные участники больше свободных
 * слотов или запусков, комната больше своего порога; у отдельных сессий порога комнаты нет), блокируется с объяснением — до первого `sessions.create`, чтобы
 * команда не стартовала наполовину. Старт команды создаёт ровно запрошенных участников: временной одиночной сессии нет.
 * Отказ самого хоста (бюджет исчерпал другой процесс) показывается по агенту его же текстом.
 *
 * Агент по умолчанию — то же правило, что у диалога новой работы (`lib/default-provider.ts`); последний выбранный
 * запоминается в `ui.json.lastProvider`. Список провайдеров может прийти позже открытия — строки ждут его как
 * «агент по умолчанию», а кнопка неактивна до ответа.
 *
 * Подсказки полей (2026-10-07): «?» у Recipe, Workspace, названия, Agents, Put them in a room, In its own worktree и Mode показывает по
 * наведению, что это за поле (`FieldHint`, тексты — `S.dialogs.newSession.hints`; у Mode — строки режимов панели плана).
 *
 * Облик — спека окна 2026-09-29, 1.5 и снимки `dark-11`, `dark-12`. Цвет выбранного (рамка пилюли провайдера,
 * звезда ведущего) — `--ring`: в тёмной теме это `accent`, как в спеке, в светлой `accent-600`: чистый `accent` даёт
 * к фону диалога 2.69:1, ниже порога 3:1 для признака состояния.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RecipeAgent, RecipeCatalogView, RecipeEntryView, WindowWorkEntry } from '@parley/core';
import {
  RESOURCE_LIMIT_KEYS,
  limitsFromConfig,
  resourceStatus,
  teamStartFits,
  type ResourceLimits,
} from '@parley/core/resource-policy';
import type { BacklogMethodParams } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { providerName, S } from '../../../shared/strings.js';
import { useLayoutStore } from '../../layout/store.js';
import { cn } from '../../lib/cn.js';
import { openWhenListed } from '../../lib/open-when-listed.js';
import { workTitleText } from '../../lib/participant.js';
import { workKey } from '../../lib/tree-order.js';
import type { BacklogTakeContext } from '../../store/ui.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { Button } from '../../ui/button.js';
import { Checkbox } from '../../ui/checkbox.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Textarea } from '../../ui/textarea.js';
import { Input } from '../../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';
import { TOOLTIP_DELAY_MS, TooltipProvider } from '../../ui/tooltip.js';
import {
  MODES,
  infoOf,
  providerIdOf,
  useAgentRows,
  useDialogProviders,
  useProjectRoles,
  wantsWorktree,
  type AgentEnv,
  type AgentResult,
  type AgentRow,
  type Mode,
} from './agent-rows.js';
import { AgentRowsEditor, ITEM_CLIP, LIST_HEIGHT } from './AgentRowsEditor.js';
import { FieldCaption, FieldHint } from './FieldHint.js';
import { createRoom, fetchRoomLean, startAgents } from './launch-agents.js';
import { RecipeSavePanel } from './RecipeSavePanel.js';

export interface NewSessionOrRoomDialogProps {
  open: boolean;
  bridge: ParleyBridge;
  /** Работа, для которой открыли диалог (меню карточки, строка `+ New session or room`); `null` — активная (⌘T). */
  work: { projectPath: string; workId: string } | null;
  /** «New room»: диалог открывается сразу с двумя агентами. */
  room: boolean;
  backlog?: BacklogTakeContext | null;
  onCreated?(target: BacklogMethodParams<'backlog.take'>['target']): Promise<void>;
  onOpenChange: (open: boolean) => void;
}

/** Значение «без рецепта» в списке: Radix Select не берёт пустую строку, а id рецепта содержит двоеточие. */
const NO_RECIPE = 'none';

/** Имя папки проекта — последний сегмент пути, как в мете карточки. */
function projectName(projectPath: string): string {
  return projectPath.split('/').filter((part) => part !== '').at(-1) ?? projectPath;
}

const keyOf = (entry: WindowWorkEntry): string => workKey(entry.projectPath, entry.map.work.id);

export function NewSessionOrRoomDialog({ open, bridge, work, room, backlog = null, onCreated, onOpenChange }: NewSessionOrRoomDialogProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);

  const [providerCard, setProviderCard] = useState<{ row: number; provider: string } | null>(null);
  /**
   * Работа диалога, заданная при открытии (меню карточки — её работа) или выбранная человеком; `null` — активная. Ключ,
   * а не проп: закрываясь, диалог сбрасывает `work` в сторе, и работа в поле не должна прыгать на время его исчезновения.
   */
  const [workChoice, setWorkChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [task, setTask] = useState('');
  const [createdTarget, setCreatedTarget] = useState<BacklogMethodParams<'backlog.take'>['target'] | null>(null);
  const { agents, setAgents, replaceAgents, resetAgents, updateAgent, addAgent, removeAgent } = useAgentRows(room ? 2 : 1, 1);
  const [leadKey, setLeadKey] = useState(1);
  /** «Put them in a room»: при двух агентах и больше включён по умолчанию; выключен — отдельные сессии без комнаты. */
  const [inRoom, setInRoom] = useState(true);
  const [worktree, setWorktree] = useState(false);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  // Корень git для Autonomous: null — ответа нет (ждём, сбой, старый хост без gitRoot) и подсказки тоже нет.
  const [gitRoot, setGitRoot] = useState<boolean | null>(null);
  /** «Lean session» одиночной сессии: начальное значение — настройка `leanAgents`, пока человек не тронул галочку. У комнаты вместо него сама настройка. */
  const [lean, setLean] = useState(false);
  /** Человек менял галочку в этом открытии: пришедшие позже настройки её не перезаписывают. */
  const leanTouchedRef = useRef(false);
  /** `leanAgents` из настроек этого открытия; `null` — хост её не отдал (старый хост) или ответ не пришёл. */
  const [leanAgents, setLeanAgents] = useState<boolean | null>(null);
  /** Каталог рецептов проекта; `null` — не загружен или хост рецептов не знает: выбора рецепта тогда нет. */
  const [recipes, setRecipes] = useState<RecipeCatalogView | null>(null);
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [recipesReload, setRecipesReload] = useState(0);
  const [mode, setMode] = useState<Mode>('free');
  const nameId = useId();
  const modeId = useId();
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Record<number, AgentResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Пороги бюджета из настроек этого открытия; `null` — хост их не отдал (старый хост) или ответ не пришёл. */
  const [limits, setLimits] = useState<ResourceLimits | null>(null);
  /** Снятия ожиданий снимка (`openWhenListed`) — все гасятся при размонтировании. */
  const pendingRef = useRef(new Set<() => void>());
  /**
   * Идущий запуск. Закрытие диалога или новое открытие (форма сбрасывается) ставит ему `cancelled`: дальше он ничего не
   * делает — не создаёт остальных агентов, комнату и вкладку, не трогает форму и не закрывает диалог второй раз.
   */
  const launchRef = useRef<{ cancelled: boolean } | null>(null);

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const cancel of [...pending]) cancel();
    };
  }, []);

  // Диалог закрыли (Cancel, Esc, ×, клик мимо), открыли заново или открыли с другой работой / как «New room» (⌘T поверх
  // открытого): форма начинается заново, и запуск прежней, если он ещё идёт, больше не нужен.
  useEffect(() => {
    if (launchRef.current !== null) launchRef.current.cancelled = true;
  }, [open, room, work, backlog]);

  // Каждое открытие — с чистой формой и составом по умолчанию: один агент, а «New room» — два. Сброс — до отрисовки
  // (`useLayoutEffect`): в `useEffect` он шёл после неё, и диалог успевал показаться с названием и агентами прошлого открытия.
  useLayoutEffect(() => {
    if (!open) return;
    resetAgents(room ? 2 : 1);
    setLeadKey(1);
    setInRoom(true);
    setName(''); setTask(backlog?.task ?? ''); setCreatedTarget(null);
    setWorkChoice(work === null ? null : workKey(work.projectPath, work.workId));
    setWorktree(false);
    setLean(false);
    leanTouchedRef.current = false;
    setRecipeId(null);
    setMode('free');
    setSaving(false);
    setResults({});
    setError(null);
    setBusy(false);
    setProviderCard(null);
  }, [open, room, work, backlog]);

  const { providers, providersLoading, providersError, providersRef, providersReady, reloadProviders, defaultId } = useDialogProviders(open, bridge, setAgents);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLimits(null);
    setLeanAgents(null);
    bridge
      .call('settings.get', {})
      .then(({ config }) => {
        if (stale) return;
        if (RESOURCE_LIMIT_KEYS.every((key) => typeof config[key] === 'number')) setLimits(limitsFromConfig(config));
        if (typeof config.leanAgents === 'boolean') {
          setLeanAgents(config.leanAgents);
          if (!leanTouchedRef.current) setLean(config.leanAgents);
        }
      })
      .catch(() => {
        // Без порогов подвал бюджета не показывается, а решает хост.
      });
    return () => {
      stale = true;
    };
  }, [open, bridge]);

  // Работа диалога: выбор человека или та, для которой открыли, иначе активная, иначе первая из активных (не активной,
  // `done` и архивной работе новая сессия не нужна — в списке их нет).
  const activeWorks = entries.filter((entry) => entry.map.work.status === 'active' && (!backlog || entry.projectPath === backlog.projectPath));
  const has = (key: string | null): key is string => key !== null && activeWorks.some((entry) => keyOf(entry) === key);
  const firstKey = activeWorks[0] === undefined ? null : keyOf(activeWorks[0]);
  const selectedKey = has(workChoice) ? workChoice : has(activeWorkKey) ? activeWorkKey : firstKey;
  const selected = activeWorks.find((entry) => keyOf(entry) === selectedKey) ?? null;
  const projectPath = selected?.projectPath ?? null;
  const roles = useProjectRoles(open, bridge, projectPath);
  const env: AgentEnv = { roles, providers, defaultId };

  // Рецепты выбранного проекта. Хост без `recipes.list` или отказ — просто без выбора рецепта: диалог работает как прежде.
  useEffect(() => {
    setRecipes(null);
    if (!open || projectPath === null) return;
    let stale = false;
    bridge.call('recipes.list', { projectPath }).then((result) => { if (!stale) setRecipes(result); }).catch(() => {});
    return () => { stale = true; };
  }, [open, bridge, projectPath, recipesReload]);
  // Рецепт принадлежит проекту (рецепты проекта — его файлы): другой проект — выбор сброшен, строки остаются.
  useEffect(() => { setRecipeId(null); }, [projectPath]);

  useEffect(() => {
    setWorktreeAvailable(false);
    setGitRoot(null);
    setWorktree(false);
    if (!open || projectPath === null) return;
    let stale = false;
    bridge
      .call('worktrees.available', { projectPath })
      .then((result) => {
        if (stale) return;
        setWorktreeAvailable(result.available);
        if (typeof result.gitRoot === 'boolean') setGitRoot(result.gitRoot);
      })
      .catch(() => {
        // Без ответа флажок просто остаётся неактивным.
      });
    return () => {
      stale = true;
    };
  }, [open, bridge, projectPath]);

  const multi = agents.length >= 2;
  /** Комната — два агента и больше при включённом «Put them in a room»; иначе сессии отдельные (одна или несколько). */
  const roomMode = multi && inRoom;
  const lead = agents.some((row) => row.key === leadKey) ? leadKey : (agents[0]?.key ?? 1);
  const started = (row: AgentRow): boolean => results[row.key]?.status === 'started';
  const unavailable = providers === null ? undefined : agents.find((row) => !started(row) && infoOf(env, row)?.available !== true);
  const unavailableInfo = unavailable === undefined ? undefined : infoOf(env, unavailable);
  const availabilityError = unavailable === undefined ? null : S.dialogs.newSession.providerUnavailable(
    unavailableInfo === undefined ? providerIdOf(env, unavailable) ?? S.dialogs.newSession.agentsField : providerName(unavailableInfo.id, unavailableInfo.label),
  );
  const anyStarted = agents.some(started);
  /** После первой попытки кнопка называется «Retry»: повторяются только не запущенные. */
  const retrying = Object.keys(results).length > 0;
  /** Общие поля и состав заперты, как только хоть одна сессия запущена: она уже принадлежит этой работе. */
  const groupLocked = busy || anyStarted || createdTarget !== null;

  const allWorktree = agents.every((row) => wantsWorktree(row, worktree));

  /**
   * Рецепт заполняет состав, режим и ведущего. Заданное им (провайдер, модель, усилие) — явный выбор, как тронутое
   * человеком; не заданное остаётся умолчанием роли. Провайдер встроенной роли по умолчанию, которого нет на машине,
   * заменяется агентом по умолчанию (спека рецептов, 8). Рецепт — это комната: «Put them in a room» включается.
   */
  const applyRecipe = (entry: Extract<RecipeEntryView, { status: 'valid' }>): void => {
    const available = (id: string | null): boolean => id === null || providers === null || providers.find((provider) => provider.id === id)?.available === true;
    const rowsOfRecipe = entry.agents.map((agent, index): AgentRow => {
      const choice = agent.choice;
      const resolvedProvider = agent.resolved?.provider ?? null;
      const missing = agent.status === 'role-missing';
      return {
        key: index + 1,
        role: missing ? null : choice.role,
        roleMissing: missing ? choice.role : null,
        worktree: choice.worktree,
        provider: choice.provider ?? (available(resolvedProvider) ? resolvedProvider : null),
        providerTouched: choice.provider !== undefined,
        model: choice.model ?? null,
        modelTouched: choice.model !== undefined,
        effort: choice.effort ?? null,
        effortTouched: choice.effort !== undefined,
      };
    });
    replaceAgents(rowsOfRecipe);
    setLeadKey(entry.agents.findIndex((agent) => agent.choice.lead) + 1 || 1);
    setInRoom(true);
    setMode(entry.recipe.mode);
    setResults({});
    setError(null);
  };
  const chooseRecipe = (value: string): void => {
    if (value === NO_RECIPE) { setRecipeId(null); return; }
    const entry = recipes?.entries.find((item): item is Extract<RecipeEntryView, { status: 'valid' }> => item.status === 'valid' && item.recipe.id === value);
    if (entry === undefined) return;
    setRecipeId(value);
    applyRecipe(entry);
  };
  const chosenRecipe = recipes?.entries.find((item): item is Extract<RecipeEntryView, { status: 'valid' }> => item.status === 'valid' && item.recipe.id === recipeId) ?? null;
  /** Состав для файла рецепта; `null`, пока у какой-то строки нет роли — рецепт без роли разборщик не примет. */
  const recipeAgents = (): RecipeAgent[] | null => {
    const rowsOut: RecipeAgent[] = [];
    for (const row of agents) {
      if (row.role === null) return null;
      // Тронутый, но не определившийся провайдер (null или пустая строка) в файл не идёт: пустое значение хост отвергает.
      const providerId = providerIdOf(env, row);
      rowsOut.push({
        role: row.role, worktree: wantsWorktree(row, worktree), lead: row.key === lead, count: 1,
        ...(row.providerTouched && providerId ? { provider: providerId } : {}),
        ...(row.modelTouched ? { model: row.model } : {}),
        ...(row.effortTouched ? { effort: row.effort } : {}),
      });
    }
    return rowsOut;
  };

  const finish = (): void => {
    onOpenChange(false);
  };

  const submit = async (): Promise<void> => {
    // Второй клик по «Retry» или «Create room» приходит уже на выключенную кнопку: `busy` включается до него.
    if (busy) return;
    if (createdTarget !== null) {
      setBusy(true); setError(null);
      const retry = { cancelled: false }; launchRef.current = retry;
      try { await onCreated?.(createdTarget); if (!retry.cancelled) finish(); }
      catch { if (!retry.cancelled) setError(S.backlog.markFailed); }
      finally { if (launchRef.current === retry) launchRef.current = null; if (!retry.cancelled) setBusy(false); }
      return;
    }
    if (!providersReady.current) return;
    if (selected === null) {
      setError(S.dialogs.newSession.selectWorkRequired);
      return;
    }
    if (providers === null) return;
    if (availabilityError !== null) return;
    const launch = { cancelled: false };
    launchRef.current = launch;
    setBusy(true);
    setError(null);
    try {
      const target = { projectPath: selected.projectPath, workId: selected.map.work.id };
      const done: Record<number, AgentResult> = { ...results };
      // Настройка не пришла при открытии (ответ опоздал или упал): комната спрашивает её ещё раз и один раз за запуск.
      let roomLean = leanAgents;
      if (roomMode && roomLean === null) {
        roomLean = await fetchRoomLean(bridge);
        if (launch.cancelled) return;
      }
      const outcome = await startAgents({
        bridge,
        target,
        rows: agents,
        done,
        env,
        providersRef,
        providersReady,
        worktree,
        worktreeAvailable,
        // Одиночная сессия несёт название из поля; остальные — пустой ярлык, хост даст им имя по номеру.
        label: multi ? '' : name.trim(),
        task: backlog ? task : '',
        // Участники комнаты — по настройке (хост её не отдал — решает сам), сессии без комнаты — только с галочкой.
        // Скрытый чекбокс (leanAgents === null) не отправляет прежнюю галочку.
        lean: roomMode ? roomLean : lean && leanAgents !== null ? true : null,
        logFailures: !backlog,
        isCancelled: () => launch.cancelled,
        pinProvider: (key, provider) => updateAgent(key, { provider }),
        reportResults: setResults,
      });
      if (outcome.kind === 'stopped') {
        if (outcome.error !== undefined) setError(outcome.error);
        return;
      }
      if (outcome.kind === 'failed') return;

      const lastRow = agents[agents.length - 1];
      const lastId = lastRow === undefined ? null : providerIdOf(env, lastRow);
      if (lastId !== null) useUiStore.getState().patchUi({ lastProvider: lastId });

      const sessionIds = agents.map((row) => {
        const result = done[row.key];
        return result?.status === 'started' ? result.sessionId : '';
      });
      if (!roomMode) {
        // Открывается вкладка первой из созданных сессий.
        openWhenListed(target.projectPath, target.workId, { kind: 'session', sessionId: sessionIds[0] ?? '' }, pendingRef.current);
        if (backlog) {
          const createdSession = { ...target, sessionId: sessionIds[0] ?? '' }; setCreatedTarget(createdSession);
          try { await onCreated?.(createdSession); } catch { if (!launch.cancelled) setError(S.backlog.markFailed); return; }
          if (launch.cancelled) return;
        }
        finish();
        return;
      }
      const leadResult = done[lead];
      const trimmed = name.trim();
      const created = await createRoom({
        bridge,
        target,
        title: trimmed === '' ? S.dialogs.defaultRoomTitle(selected.map.rooms.length + 1) : trimmed,
        members: sessionIds,
        lead: leadResult?.status === 'started' ? leadResult.sessionId : (sessionIds[0] ?? ''),
        mode,
        recipeId,
        logFailures: !backlog,
        isCancelled: () => launch.cancelled,
      });
      if (created.kind === 'stopped') return;
      if (created.kind === 'failed') {
        setError(created.message);
        return;
      }
      openWhenListed(target.projectPath, target.workId, { kind: 'room', roomId: created.roomId }, pendingRef.current);
      if (backlog) {
        const createdRoomTarget = { ...target, roomId: created.roomId }; setCreatedTarget(createdRoomTarget);
        try { await onCreated?.(createdRoomTarget); } catch { if (!launch.cancelled) setError(S.backlog.markFailed); return; }
        if (launch.cancelled) return;
      }
      finish();
    } finally {
      if (launchRef.current === launch) launchRef.current = null;
      // Отменённый запуск форму не трогает: диалог закрыт, а если открыт заново — там уже свой запуск.
      if (!launch.cancelled) setBusy(false);
    }
  };

  const text = S.dialogs.newSession;
  /**
   * Бюджет выбранной работы. Нужны слоты только тем строкам, что ещё не запущены (после частичного сбоя «Retry»
   * повторяет упавших), а порог комнаты — всему составу: комната работает целиком. Отдельным сессиям порога комнаты нет.
   */
  const budget = limits === null || selected === null ? null : resourceStatus(selected.map, limits, Date.now());
  const pendingStarts = agents.filter((row) => !started(row)).length;
  const fit = budget === null || limits === null ? null : teamStartFits(budget, pendingStarts, roomMode ? limits.roomConcurrent : undefined);
  const budgetBlocked =
    fit === null || fit.fits ? null
      : fit.scope === 'room' ? text.budgetBlockedRoom(agents.length, fit.remaining)
        : fit.reason === 'launches' ? text.budgetBlockedStarts(fit.needed, fit.remaining)
          : text.budgetBlockedSlots(fit.needed, fit.remaining);
  const budgetText = budget === null ? null
    : text.budgetLine(budget.work.concurrent.used + budget.work.concurrent.reserved, budget.work.concurrent.limit, budget.work.launches.remaining);
  const workTitle = selected === null ? '' : workTitleText(selected.map.work.title);
  const summary = roomMode ? text.summaryRoom(agents.length, workTitle) : multi ? text.summarySessions(agents.length, workTitle) : text.summarySession(workTitle);
  /** Название сессий общее только у одной сессии и у комнаты; у нескольких отдельных его нет. */
  const showName = !multi || roomMode;
  /** Рецепт — комната: при выключенном «Put them in a room» выбора рецепта нет. */
  const showRecipes = recipes !== null && !(multi && !inRoom);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[660px] max-w-[calc(100vw-2rem)]"
        onEscapeKeyDown={(event) => {
          // Capture-обработчик внешнего слоя может сработать первым: Escape закрывает только карточку.
          if (providerCard !== null) {
            event.preventDefault();
            setProviderCard(null);
          }
        }}
      >
        <div className="flex shrink-0 flex-col gap-0.5">
          <DialogTitle>{saving ? S.recipes.saveTitle : roomMode ? text.titleRoom : multi ? text.titleSessions : text.titleSession}</DialogTitle>
          <DialogDescription className="text-xs text-neutral-700">{roomMode ? text.hintRoom : multi ? text.hintSessions : text.hintSession}</DialogDescription>
        </div>
        {saving && projectPath !== null ? (
          <RecipeSavePanel
            bridge={bridge}
            projectPath={projectPath}
            mode={mode}
            agents={recipeAgents()}
            playbook={chosenRecipe?.recipe.playbook ?? S.recipes.playbookTemplate}
            onBack={() => setSaving(false)}
            onSaved={(id) => { setSaving(false); setRecipesReload((value) => value + 1); setRecipeId(id); }}
          />
        ) : (
          <>
        {/* Свой провайдер тултипов: диалог не зависит от провайдера окна (`main.tsx`) — его монтируют и отдельно, в тестах. */}
        <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          {showRecipes ? (
            <div className="flex min-w-0 flex-col gap-1">
              <FieldCaption text={S.recipes.field} hint={text.hints.recipe} />
              <Select value={recipeId ?? NO_RECIPE} disabled={groupLocked} onValueChange={chooseRecipe}>
                <SelectTrigger aria-label={S.recipes.field}><SelectValue /></SelectTrigger>
                <SelectContent className={LIST_HEIGHT}>
                  <SelectItem value={NO_RECIPE}>{S.recipes.none}</SelectItem>
                  {recipes.entries.map((entry) => entry.status === 'valid'
                    ? <SelectItem key={entry.recipe.id} value={entry.recipe.id} title={entry.recipe.name} className={ITEM_CLIP}>{entry.recipe.name}</SelectItem>
                    : <SelectItem key={entry.id} value={entry.id} disabled title={entry.file} className={ITEM_CLIP}>{S.recipes.invalidOption(entry.file, S.recipes.reason[entry.diagnostic.code] ?? entry.diagnostic.code)}</SelectItem>)}
                </SelectContent>
              </Select>
              {chosenRecipe === null ? null : <p data-recipe-description className="m-0 break-words text-xs text-neutral-700">{chosenRecipe.recipe.description}</p>}
            </div>
          ) : null}
          <div className={cn('grid gap-3', showName ? 'grid-cols-2' : 'grid-cols-1')}>
            <div className="flex min-w-0 flex-col gap-1">
              <FieldCaption text={text.workspaceField} hint={text.hints.workspace} />
              <Select value={selectedKey ?? ''} disabled={groupLocked} onValueChange={setWorkChoice}>
                <SelectTrigger
                  aria-label={text.workspaceField}
                  {...(selected === null ? null : { title: text.workspaceOption(workTitle, projectName(selected.projectPath)) })}
                >
                  <SelectValue placeholder={text.noWorkspaces} />
                </SelectTrigger>
                <SelectContent className={LIST_HEIGHT}>
                  {activeWorks.map((entry) => (
                    <SelectItem key={keyOf(entry)} value={keyOf(entry)} title={entry.projectPath} className={ITEM_CLIP}>
                      {text.workspaceOption(workTitleText(entry.map.work.title), projectName(entry.projectPath))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {showName ? (
              <div className="flex min-w-0 flex-col gap-1">
                {/* Подпись — через `htmlFor`: «?» внутри обёртки-`label` стал бы её первым полем вместо ввода. */}
                <span className="flex min-w-0 items-center gap-1">
                  <label htmlFor={nameId}>{roomMode ? text.roomNameField : text.sessionNameField}</label>
                  <FieldHint field={roomMode ? text.roomNameField : text.sessionNameField} text={roomMode ? text.hints.roomName : text.hints.sessionName} />
                </span>
                <Input
                  id={nameId}
                  value={name}
                  disabled={groupLocked}
                  placeholder={roomMode ? text.roomNamePlaceholder : text.sessionNamePlaceholder}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            ) : null}
          </div>

          {backlog && <label>{S.backlog.task}<Textarea aria-label={S.backlog.task} value={task} disabled={groupLocked}
            onChange={event => setTask(event.target.value)} /></label>}
          <AgentRowsEditor
            agents={agents}
            env={env}
            results={results}
            lead={roomMode ? lead : null}
            showRowWorktree={multi}
            worktreeAvailable={worktreeAvailable}
            worktree={worktree}
            busy={busy}
            groupLocked={groupLocked}
            minRows={1}
            providerCard={providerCard}
            onProviderCard={setProviderCard}
            reloadProviders={reloadProviders}
            onLead={setLeadKey}
            onUpdate={updateAgent}
            onRemove={removeAgent}
            onAdd={addAgent}
            onClearError={() => setError(null)}
          />

          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            {multi ? (
              <span className="flex items-center gap-1">
                <label className="flex items-center gap-2">
                  <Switch checked={inRoom} disabled={groupLocked} onCheckedChange={setInRoom} />
                  {text.putInRoom}
                </label>
                <FieldHint field={text.putInRoom} text={text.hints.putInRoom} />
              </span>
            ) : null}
            {/* «?» — вне `label`: внутри он попал бы в имя переключателя и списка. */}
            <span className="flex items-center gap-1">
              <label className="flex items-center gap-2">
                <Switch
                  checked={worktreeAvailable && allWorktree}
                  disabled={!worktreeAvailable || groupLocked}
                  onCheckedChange={(on) => { setWorktree(on); setAgents((rows) => rows.map((row) => ({ ...row, worktree: null }))); }}
                />
                {text.inOwnWorktree}
              </label>
              <FieldHint field={text.inOwnWorktree} text={text.hints.worktree} />
            </span>
            {roomMode || leanAgents === null ? null : (
              <span className="flex items-center gap-1">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={lean}
                    disabled={groupLocked}
                    onCheckedChange={(value) => {
                      leanTouchedRef.current = true;
                      setLean(value === true);
                    }}
                  />
                  {text.leanSession}
                </label>
                <FieldHint field={text.leanSession} text={text.hints.leanSession} />
              </span>
            )}
            {roomMode ? (
              <span className="flex items-center gap-2">
                <span className="flex items-center gap-1">
                  <label htmlFor={modeId}>{S.recipes.modeField}</label>
                  <FieldHint field={S.recipes.modeField} text={[text.hints.mode, ...MODES.map((item) => `${S.plans.modes[item]} — ${S.plans.modeHelp[item]}`)].join('\n')} />
                </span>
                <Select value={mode} disabled={groupLocked} onValueChange={(value) => setMode(value as Mode)}>
                  <SelectTrigger id={modeId} aria-label={S.recipes.modeField} className="w-[120px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{MODES.map((item) => <SelectItem key={item} value={item}>{S.plans.modes[item]}</SelectItem>)}</SelectContent>
                </Select>
              </span>
            ) : null}
            {roomMode && recipes !== null ? (
              <Button type="button" variant="outline" disabled={groupLocked || selected === null} onClick={() => setSaving(true)} className="ml-auto">
                {S.recipes.save}
              </Button>
            ) : null}
          </div>
          {/* Рецепт и режим живут только у комнаты (спека рецептов, 5.3: не меньше двух агентов): без комнаты они молча терялись. */}
          {!roomMode && (recipeId !== null || mode !== 'free') ? <p role="status" data-recipe-dropped className="m-0 text-xs text-neutral-700">{multi ? text.separateDropsRecipe : S.recipes.singleDropsRecipe}</p> : null}
          {/* Подсказка — только у выбранного Autonomous и только по явному ответу «не корень git» (gitRoot === false): пока ответа нет или он не пришёл, её нет. */}
          {roomMode && mode === 'autonomous' && gitRoot === false ? <p role="status" data-autonomous-needs-git className="m-0 text-xs text-neutral-700">{S.plans.autonomousNeedsGit}</p> : null}
          {multi && !worktreeAvailable && agents.some((row) => row.worktree === true) ? <p className="m-0 text-xs text-neutral-700">{S.recipes.noWorktree}</p> : null}
        </div>
        </TooltipProvider>
        <DialogFooter className="items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
            {/* Ошибка диалога — в подвале: он не прокручивается, а тело с пятью агентами в окне 800×500 уходит за край. */}
            {error !== null || providersError !== null || availabilityError !== null ? (
              <p role="alert" className="break-words text-destructive">
                {error ?? providersError ?? availabilityError}
              </p>
            ) : null}
            {budgetBlocked !== null ? (
              <p role="status" data-budget-blocked className="m-0 break-words text-destructive">{budgetBlocked}</p>
            ) : null}
            <span className="truncate text-neutral-700" title={summary}>
              {summary}
            </span>
            {budgetText !== null ? (
              <span data-budget className="truncate text-neutral-700" title={budgetText}>{budgetText}</span>
            ) : null}
          </div>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || providers === null || providersLoading || providersError !== null || availabilityError !== null || selected === null || budgetBlocked !== null || agents.some((row) => row.roleMissing !== null)} onClick={() => void submit()}>
            {retrying ? S.common.retry : roomMode ? text.submitRoom : multi ? text.submitSessions : text.submitSession}
          </Button>
        </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
