/**
 * Диалог «New session or room» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.5, 2.1) вместо прежних
 * `NewSessionDialog` и `CreateRoomDialog`. Переключателя типа нет: тип следует из числа агентов — один агент
 * создаёт сессию (`sessions.create` с `model` и `effort`, открывается её терминал), два и больше — комнату с
 * ведущим (N раз `sessions.create` и `rooms.create` с `lead` и `quiet: true`, открывается вкладка комнаты, строка
 * комнаты в сайдбаре разворачивается).
 *
 * Сессии комнаты стартуют сразу и без задачи (тихий старт: `task: ''`, ярлык пустой — строка сайдбара показывает
 * `S05`): задачу человек пишет в комнату один раз для всех, поэтому и письма-приглашения не нужны (`quiet`).
 * Одиночная сессия тоже стартует без задачи — её человек пишет в терминале.
 *
 * Частичный сбой запуска. Комната создаётся, только когда запущены все агенты. Если часть `sessions.create`
 * упала, диалог остаётся открытым и показывает итог по каждому агенту, а «Retry» повторяет только упавших;
 * комнаты нет до успеха всех. «Cancel» оставляет уже запущенные сессии обычными сессиями работы — они и так видны
 * в сайдбаре. Запущенные строки после первой попытки заперты: их провайдер, модель и усилие уже ушли в хост.
 *
 * Модель — только из списка провайдера (`providers.list.models`, решение 5 спеки): первый пункт `Default` — без
 * флага, модель CLI по умолчанию, дальше подписи списка, в `sessions.create.model` уходит `id`. Нет списка, `null`
 * или пусто — контрола нет и модель не передаётся. Усилие — сегмент `Low` / `Medium` / `High` при `effort: true`,
 * иначе скрыт. Своих списков и свободного ввода в окне нет.
 *
 * «In its own worktree» (спека 5.1, план worktree 4.3) остаётся: неактивен, пока `worktrees.available` не подтвердит,
 * что проект — git-репозиторий (`branches` для этого не годится: при отсоединённой голове ветки нет и у git-проекта).
 * Флажок один на все сессии диалога: у каждого агента комнаты свой worktree.
 *
 * Агент по умолчанию — то же правило, что у диалога новой работы (`lib/default-provider.ts`); последний выбранный
 * запоминается в `ui.json.lastProvider`. Список провайдеров может прийти позже открытия — строки ждут его как
 * «агент по умолчанию», а кнопка неактивна до ответа.
 *
 * Облик — спека окна 2026-09-29, 1.5 и снимки `dark-11`, `dark-12`. Цвет выбранного (рамка пилюли провайдера,
 * звезда ведущего) — `--ring`: в тёмной теме это `accent`, как в спеке, в светлой `accent-600`: чистый `accent` даёт
 * к фону диалога 2.69:1, ниже порога 3:1 для признака состояния.
 */

import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { WorkEntry } from '@harnas/core';
import type { HarnasBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../../shared/strings.js';
import { useLayoutStore } from '../../layout/store.js';
import { cn } from '../../lib/cn.js';
import { defaultProvider, type ProviderOption } from '../../lib/default-provider.js';
import { openWhenListed } from '../../lib/open-when-listed.js';
import { sessionTag } from '../../lib/participant.js';
import { workKey } from '../../lib/tree-order.js';
import { useUiStore } from '../../store/ui.js';
import { useWorksStore } from '../../store/works.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group.js';
import { AgentIcon } from '../AgentIcon.js';
import { radioGroupKeyDown } from './radio-keys.js';

export interface NewSessionOrRoomDialogProps {
  open: boolean;
  bridge: HarnasBridge;
  /** Работа, для которой открыли диалог (меню карточки, строка `+ New session or room`); `null` — активная (⌘T). */
  work: { projectPath: string; workId: string } | null;
  /** «New room»: диалог открывается сразу с двумя агентами. */
  room: boolean;
  onOpenChange: (open: boolean) => void;
}

type Effort = 'low' | 'medium' | 'high';

const EFFORTS: readonly { value: Effort; label: string }[] = [
  { value: 'low', label: S.dialogs.newSession.effortLow },
  { value: 'medium', label: S.dialogs.newSession.effortMedium },
  { value: 'high', label: S.dialogs.newSession.effortHigh },
];

/**
 * Пункт `Default` списка моделей. Radix Select не берёт пустую строку как значение пункта, а `id` модели — слово без
 * пробелов (схема протокола): значение с ведущим пробелом с id не совпадёт никогда.
 */
const DEFAULT_MODEL = ' default';

/** Строка агента диалога. `provider: null` — «агент по умолчанию»: он выбирается по ответу `providers.list`. */
interface AgentRow {
  key: number;
  provider: string | null;
  /** `id` из списка провайдера; `null` — `Default`, без флага. */
  model: string | null;
  effort: Effort;
}

/** Итог запуска по строке агента — только после первой попытки. */
type AgentResult = { status: 'started'; sessionId: string } | { status: 'failed'; message: string };

function initialRows(room: boolean): AgentRow[] {
  return Array.from({ length: room ? 2 : 1 }, (_, index) => ({ key: index + 1, provider: null, model: null, effort: 'medium' }));
}

/** Имя папки проекта — последний сегмент пути, как в мете карточки. */
function projectName(projectPath: string): string {
  return projectPath.split('/').filter((part) => part !== '').at(-1) ?? projectPath;
}

const keyOf = (entry: WorkEntry): string => workKey(entry.projectPath, entry.map.work.id);

/**
 * Список выбора не выше места, что осталось в окне: у примитива потолок `max-h-96`, и десять моделей Claude в окне 800×500
 * уходили за нижний край — пункты внизу было не достать.
 */
const LIST_HEIGHT = 'max-h-[min(24rem,var(--radix-select-content-available-height))]';

/**
 * Длинный пункт списка обрезается многоточием, а не переносится и не уезжает за край: Radix Select не передаёт `className`
 * на `ItemText` (он сам отбрасывает его — текст копируется в триггер), поэтому `truncate` примитива на пункте не
 * действует. Правило — на самом пункте, для его последнего потомка, как у триггера.
 */
const ITEM_CLIP = '[&>span:last-child]:min-w-0 [&>span:last-child]:truncate';

/** Пилюля провайдера (1.5): 34px, значок 14; выбранная — рамка `--ring`, фон `neutral-100`, вес 600; иначе рамка divider. */
const PILL =
  'inline-flex h-[34px] shrink-0 items-center gap-[7px] rounded-full border pl-2.5 pr-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-[.45]';

export function NewSessionOrRoomDialog({ open, bridge, work, room, onOpenChange }: NewSessionOrRoomDialogProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  const lastProvider = useUiStore((state) => state.ui.lastProvider);

  /** `null` — `providers.list` этого открытия ещё не ответил. */
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  /**
   * Работа диалога, заданная при открытии (меню карточки — её работа) или выбранная человеком; `null` — активная. Ключ,
   * а не проп: закрываясь, диалог сбрасывает `work` в сторе, и работа в поле не должна прыгать на время его исчезновения.
   */
  const [workChoice, setWorkChoice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [agents, setAgents] = useState<AgentRow[]>(() => initialRows(room));
  const [leadKey, setLeadKey] = useState(1);
  const [worktree, setWorktree] = useState(false);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [results, setResults] = useState<Record<number, AgentResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(room ? 3 : 2);
  /** Снятия ожиданий снимка (`openWhenListed`) — все гасятся при размонтировании. */
  const pendingRef = useRef(new Set<() => void>());

  useEffect(() => {
    const pending = pendingRef.current;
    return () => {
      for (const cancel of [...pending]) cancel();
    };
  }, []);

  // Каждое открытие — с чистой формой и составом по умолчанию: один агент, а «New room» — два.
  useEffect(() => {
    if (!open) return;
    const rows = initialRows(room);
    setAgents(rows);
    nextKey.current = rows.length + 1;
    setLeadKey(1);
    setName('');
    setWorkChoice(work === null ? null : workKey(work.projectPath, work.workId));
    setWorktree(false);
    setResults({});
    setError(null);
    setBusy(false);
  }, [open, room, work]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setProviders(null);
    bridge
      .call('providers.list', {})
      .then((result) => {
        if (!stale) setProviders(result.providers);
      })
      .catch((err: unknown) => {
        if (stale) return;
        console.warn('[harnas] providers.list', err);
        setError(errorText(decodeIpcError(err).code, S.errors.actions.loadProviders));
      });
    return () => {
      stale = true;
    };
  }, [open, bridge]);

  // Работа диалога: выбор человека или та, для которой открыли, иначе активная, иначе первая из активных (не активной,
  // `done` и архивной работе новая сессия не нужна — в списке их нет).
  const activeWorks = entries.filter((entry) => entry.map.work.status === 'active');
  const has = (key: string | null): key is string => key !== null && activeWorks.some((entry) => keyOf(entry) === key);
  const firstKey = activeWorks[0] === undefined ? null : keyOf(activeWorks[0]);
  const selectedKey = has(workChoice) ? workChoice : has(activeWorkKey) ? activeWorkKey : firstKey;
  const selected = activeWorks.find((entry) => keyOf(entry) === selectedKey) ?? null;
  const projectPath = selected?.projectPath ?? null;

  useEffect(() => {
    setWorktreeAvailable(false);
    setWorktree(false);
    if (!open || projectPath === null) return;
    let stale = false;
    bridge
      .call('worktrees.available', { projectPath })
      .then((result) => {
        if (!stale) setWorktreeAvailable(result.available);
      })
      .catch(() => {
        // Без ответа флажок просто остаётся неактивным.
      });
    return () => {
      stale = true;
    };
  }, [open, bridge, projectPath]);

  const defaultId = providers === null ? null : defaultProvider(providers, lastProvider);
  const providerIdOf = (row: AgentRow): string | null => row.provider ?? defaultId;
  const infoOf = (row: AgentRow): ProviderOption | undefined => {
    const id = providerIdOf(row);
    return providers?.find((provider) => provider.id === id);
  };

  const multi = agents.length >= 2;
  const lead = agents.some((row) => row.key === leadKey) ? leadKey : (agents[0]?.key ?? 1);
  const started = (row: AgentRow): boolean => results[row.key]?.status === 'started';
  const anyStarted = agents.some(started);
  /** После первой попытки кнопка называется «Retry»: повторяются только не запущенные. */
  const retrying = Object.keys(results).length > 0;
  /** Общие поля и состав заперты, как только хоть одна сессия запущена: она уже принадлежит этой работе. */
  const groupLocked = busy || anyStarted;

  const updateAgent = (key: number, patch: Partial<Omit<AgentRow, 'key'>>): void =>
    setAgents((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addAgent = (): void => {
    const last = agents[agents.length - 1];
    setAgents((rows) => [...rows, { key: nextKey.current++, provider: last?.provider ?? null, model: null, effort: 'medium' }]);
  };

  const removeAgent = (key: number): void => setAgents((rows) => (rows.length <= 1 ? rows : rows.filter((row) => row.key !== key)));

  const finish = (): void => {
    onOpenChange(false);
  };

  const submit = async (): Promise<void> => {
    // Второй клик по «Retry» или «Create room» приходит уже на выключенную кнопку: `busy` включается до него.
    if (busy) return;
    if (selected === null) {
      setError(S.dialogs.newSession.selectWorkRequired);
      return;
    }
    if (providers === null) return;
    setBusy(true);
    setError(null);
    try {
      const target = { projectPath: selected.projectPath, workId: selected.map.work.id };
      const done: Record<number, AgentResult> = { ...results };
      let allStarted = true;
      // По очереди, а не разом: номера сессий идут в порядке строк, и звезда ведущего указывает на свою.
      for (const row of agents) {
        if (done[row.key]?.status === 'started') continue;
        const providerId = providerIdOf(row);
        const info = providers.find((provider) => provider.id === providerId);
        if (providerId === null) {
          setError(S.dialogs.newWork.agentRequired);
          return;
        }
        try {
          const { ref } = await bridge.call('sessions.create', {
            ...target,
            provider: providerId,
            // Одиночная сессия несёт название из поля; агенты комнаты — пустой ярлык, строка покажет `S05`.
            label: multi ? '' : name.trim(),
            task: '',
            parent: null,
            worktree,
            // Модель и усилие — только когда контрол на экране: провайдер без списка или флага их не получает.
            ...(row.model !== null && (info?.models?.length ?? 0) > 0 ? { model: row.model } : {}),
            ...(info?.effort === true ? { effort: row.effort } : {}),
          });
          done[row.key] = { status: 'started', sessionId: ref.sessionId };
        } catch (err) {
          console.warn('[harnas] sessions.create', err);
          done[row.key] = { status: 'failed', message: errorText(decodeIpcError(err).code, S.errors.actions.createSession) };
          allStarted = false;
        }
        setResults({ ...done });
      }
      if (!allStarted) return;

      const lastRow = agents[agents.length - 1];
      const lastId = lastRow === undefined ? null : providerIdOf(lastRow);
      if (lastId !== null) useUiStore.getState().patchUi({ lastProvider: lastId });

      const sessionIds = agents.map((row) => {
        const result = done[row.key];
        return result?.status === 'started' ? result.sessionId : '';
      });
      if (!multi) {
        openWhenListed(target.projectPath, target.workId, { kind: 'session', sessionId: sessionIds[0] ?? '' }, pendingRef.current);
        finish();
        return;
      }
      const leadResult = done[lead];
      const trimmed = name.trim();
      try {
        const { roomId } = await bridge.call('rooms.create', {
          ...target,
          title: trimmed === '' ? S.dialogs.defaultRoomTitle(selected.map.rooms.length + 1) : trimmed,
          members: sessionIds,
          lead: leadResult?.status === 'started' ? leadResult.sessionId : (sessionIds[0] ?? ''),
          quiet: true,
        });
        openWhenListed(target.projectPath, target.workId, { kind: 'room', roomId }, pendingRef.current);
        finish();
      } catch (err) {
        console.warn('[harnas] rooms.create', err);
        setError(errorText(decodeIpcError(err).code, S.errors.actions.createRoom));
      }
    } finally {
      setBusy(false);
    }
  };

  const text = S.dialogs.newSession;
  const workTitle = selected?.map.work.title ?? '';
  const summary = multi ? text.summaryRoom(agents.length, workTitle) : text.summarySession(workTitle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[660px] max-w-[calc(100vw-2rem)]">
        <div className="flex shrink-0 flex-col gap-0.5">
          <DialogTitle>{multi ? text.titleRoom : text.titleSession}</DialogTitle>
          <DialogDescription className="text-xs text-neutral-700">{multi ? text.hintRoom : text.hintSession}</DialogDescription>
        </div>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span>{text.workspaceField}</span>
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
                      {text.workspaceOption(entry.map.work.title, projectName(entry.projectPath))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <label className="flex min-w-0 flex-col gap-1">
              {multi ? text.roomNameField : text.sessionNameField}
              <Input
                value={name}
                disabled={groupLocked}
                placeholder={multi ? text.roomNamePlaceholder : text.sessionNamePlaceholder}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <span>{text.agentsField}</span>
            <div className="flex min-w-0 flex-col gap-2">
              {agents.map((row, index) => {
                const info = infoOf(row);
                const models = info?.models ?? null;
                const chosenId = providerIdOf(row);
                const result = results[row.key];
                const rowLocked = busy || result?.status === 'started';
                const isLead = row.key === lead;
                return (
                  <div key={row.key} data-agent-row className="flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {multi ? (
                        <button
                          type="button"
                          title={isLead ? text.lead : text.makeLead}
                          aria-label={isLead ? text.lead : text.makeLead}
                          aria-pressed={isLead}
                          disabled={busy}
                          onClick={() => setLeadKey(row.key)}
                          className={cn(
                            'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-base leading-none hover:bg-foreground/10 disabled:pointer-events-none',
                            isLead ? 'text-ring' : 'text-neutral-600',
                          )}
                        >
                          {isLead ? '★' : '☆'}
                        </button>
                      ) : null}
                      <div role="radiogroup" aria-label={text.agentGroup(index + 1)} onKeyDown={radioGroupKeyDown} className="flex shrink-0 gap-1">
                        {(providers ?? []).map((provider) => {
                          const on = provider.id === chosenId;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              tabIndex={on ? 0 : -1}
                              title={providerName(provider.id, provider.label)}
                              disabled={!provider.available || rowLocked}
                              onClick={() => {
                                if (!on) updateAgent(row.key, { provider: provider.id, model: null });
                              }}
                              className={cn(PILL, on ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7')}
                            >
                              {/* Буква значка провайдера без бренда (`GLM` → «G») не должна попадать в имя кнопки. */}
                              <span aria-hidden="true" className="inline-flex">
                                <AgentIcon provider={provider.id} size={14} />
                              </span>
                              {provider.label}
                            </button>
                          );
                        })}
                      </div>
                      {models !== null && models.length > 0 ? (
                        <Select
                          value={row.model ?? DEFAULT_MODEL}
                          disabled={rowLocked}
                          onValueChange={(value) => updateAgent(row.key, { model: value === DEFAULT_MODEL ? null : value })}
                        >
                          <SelectTrigger aria-label={text.modelField} className="min-w-0 flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={LIST_HEIGHT}>
                            <SelectItem value={DEFAULT_MODEL} className={ITEM_CLIP}>
                              {text.modelDefault}
                            </SelectItem>
                            {models.map((model) => (
                              <SelectItem key={model.id} value={model.id} className={ITEM_CLIP}>
                                {model.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="min-w-0 flex-1" />
                      )}
                      {info?.effort === true ? (
                        <ToggleGroup
                          type="single"
                          value={row.effort}
                          disabled={rowLocked}
                          aria-label={text.effortField}
                          className="shrink-0"
                          onValueChange={(value) => {
                            // Повторный клик по выбранному пункту Radix сообщает пустой строкой — усилие не снимается.
                            if (value !== '') updateAgent(row.key, { effort: value as Effort });
                          }}
                        >
                          {EFFORTS.map((effort) => (
                            <ToggleGroupItem key={effort.value} value={effort.value}>
                              {effort.label}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      ) : null}
                      <button
                        type="button"
                        title={text.removeAgent}
                        aria-label={text.removeAgent}
                        disabled={agents.length === 1 || groupLocked}
                        onClick={() => removeAgent(row.key)}
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-800 hover:bg-foreground/10 disabled:pointer-events-none disabled:opacity-35"
                      >
                        <X className="size-[15px]" aria-hidden="true" />
                      </button>
                    </div>
                    {result === undefined ? null : (
                      <p
                        role="status"
                        className={cn('min-w-0 break-words text-xs', result.status === 'failed' ? 'text-destructive' : 'text-neutral-700')}
                      >
                        {result.status === 'started' ? text.agentStarted(sessionTag(result.sessionId)) : result.message}
                      </p>
                    )}
                  </div>
                );
              })}
              <Button type="button" variant="outline" disabled={groupLocked} onClick={addAgent} className="self-start">
                <Plus className="size-[13px]" aria-hidden="true" />
                {text.addAgent}
              </Button>
            </div>
          </div>

          <label className="flex items-center gap-2">
            <Switch checked={worktree} disabled={!worktreeAvailable || groupLocked} onCheckedChange={setWorktree} />
            {text.inOwnWorktree}
          </label>
          {error !== null ? <p className="text-destructive">{error}</p> : null}
        </div>
        <DialogFooter className="items-center">
          <span className="min-w-0 flex-1 truncate text-xs text-neutral-700" title={summary}>
            {summary}
          </span>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || providers === null || selected === null} onClick={() => void submit()}>
            {retrying ? S.common.retry : multi ? text.submitRoom : text.submitSession}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
