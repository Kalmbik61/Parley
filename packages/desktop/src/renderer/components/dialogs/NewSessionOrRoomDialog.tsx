/**
 * Диалог «New session or room» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.5, 2.1) вместо прежних
 * `NewSessionDialog` и `CreateRoomDialog`. Переключателя типа нет: тип следует из числа агентов — один агент
 * создаёт сессию (`sessions.create` с `model` и `effort`, открывается её терминал), два и больше — комнату с
 * ведущим (N раз `sessions.create` и `rooms.create` с `lead` и `quiet: true`, открывается вкладка комнаты, строка
 * комнаты в сайдбаре разворачивается).
 *
 * Сессии комнаты стартуют сразу и без задачи (тихий старт: `task: ''`, ярлык пустой): задачу человек пишет в комнату
 * один раз для всех, поэтому и письма-приглашения не нужны (`quiet`). Одиночная сессия тоже стартует без задачи — её
 * человек пишет в терминале.
 *
 * Пустой ярлык хост пустым не оставляет: сессиям без задачи он ставит метку `NEW_LABEL` core (`applyChoice` в
 * `host/sessions/sessions-service.ts`), чтобы её переименовал заголовок Claude Code (автозаголовок). Поэтому
 * строка сайдбара, вкладка и упоминания показывают `S05 New session` до автозаголовка (у Codex его нет), а не голый `S05`,
 * как обещает спека 2.1. Расхождение и варианты — в отчёте куска 7, «Правки по ревью»: голый `S05` требует правки хоста и
 * решения, нужен ли автозаголовок таким сессиям.
 *
 * Частичный сбой запуска. Комната создаётся, только когда запущены все агенты. Если часть `sessions.create`
 * упала, диалог остаётся открытым и показывает итог по каждому агенту, а «Retry» повторяет только упавших;
 * комнаты нет до успеха всех. «Cancel» оставляет уже запущенные сессии обычными сессиями работы — они и так видны
 * в сайдбаре. Запущенные строки после первой попытки заперты: их провайдер, модель и усилие уже ушли в хост.
 * Провайдер «по умолчанию» при запуске фиксируется в строке: `ui.lastProvider` меняется, когда все агенты запущены, и
 * пилюля под итогом «запущена» не должна перескочить на провайдера последней строки, если `rooms.create` упал.
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
 * Агент по умолчанию — то же правило, что у диалога новой работы (`lib/default-provider.ts`); последний выбранный
 * запоминается в `ui.json.lastProvider`. Список провайдеров может прийти позже открытия — строки ждут его как
 * «агент по умолчанию», а кнопка неактивна до ответа.
 *
 * Облик — спека окна 2026-09-29, 1.5 и снимки `dark-11`, `dark-12`. Цвет выбранного (рамка пилюли провайдера,
 * звезда ведущего) — `--ring`: в тёмной теме это `accent`, как в спеке, в светлой `accent-600`: чистый `accent` даёт
 * к фону диалога 2.69:1, ниже порога 3:1 для признака состояния.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { Plus, X } from 'lucide-react';
import type { WorkEntry } from '@parley/core';
import type { Result } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../../shared/strings.js';
import { useLayoutStore } from '../../layout/store.js';
import { cn } from '../../lib/cn.js';
import { defaultProvider } from '../../lib/default-provider.js';
import { effortChoices } from '../../lib/effort-choices.js';
import { openWhenListed } from '../../lib/open-when-listed.js';
import { sessionTag, workTitleText } from '../../lib/participant.js';
import { workKey } from '../../lib/tree-order.js';
import { useUiStore } from '../../store/ui.js';
import { useHostStore } from '../../store/host.js';
import { useWorksStore } from '../../store/works.js';
import { Button } from '../../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '../../ui/dialog.js';
import { Input } from '../../ui/input.js';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select.js';
import { Switch } from '../../ui/switch.js';
import { AgentIcon } from '../AgentIcon.js';
import { ProviderCard } from '../providers/ProviderCard.js';
import { radioGroupKeyDown } from './radio-keys.js';

export interface NewSessionOrRoomDialogProps {
  open: boolean;
  bridge: ParleyBridge;
  /** Работа, для которой открыли диалог (меню карточки, строка `+ New session or room`); `null` — активная (⌘T). */
  work: { projectPath: string; workId: string } | null;
  /** «New room»: диалог открывается сразу с двумя агентами. */
  room: boolean;
  onOpenChange: (open: boolean) => void;
}

type ProviderOption = Result<'providers.list'>['providers'][number];

/**
 * Пункт `Default` списка моделей. Radix Select не берёт пустую строку как значение пункта, а `id` модели — слово без
 * пробелов (схема протокола): значение с ведущим пробелом с id не совпадёт никогда.
 */
const DEFAULT_MODEL = ' default';

/** Пункт `Default` списка уровней — без флага `--effort`; уровень — токен без пробелов (`EFFORT_TOKEN`), с ним не совпадёт. */
const DEFAULT_EFFORT = ' default';

/** Строка агента диалога. `provider: null` — «агент по умолчанию»: он выбирается по ответу `providers.list`. */
interface AgentRow {
  key: number;
  provider: string | null;
  /** `id` из списка провайдера; `null` — `Default`, без флага. */
  model: string | null;
  /** Уровень из списка модели; `null` — `Default`, без флага. */
  effort: string | null;
}

/** Итог запуска по строке агента — только после первой попытки. */
type AgentResult = { status: 'started'; sessionId: string } | { status: 'failed'; message: string };

function initialRows(room: boolean): AgentRow[] {
  return Array.from({ length: room ? 2 : 1 }, (_, index) => ({ key: index + 1, provider: null, model: null, effort: null }));
}

/**
 * Модель строки, если она есть в списке провайдера; иначе `null` — `Default`. Каталог мог смениться под открытым
 * диалогом (`providers.changed`): исчезнувшая модель не показывается выбранной и не уходит в `sessions.create`.
 */
function chosenModel(row: Pick<AgentRow, 'model'>, info: ProviderOption | undefined): string | null {
  return row.model !== null && (info?.models ?? []).some((option) => option.id === row.model) ? row.model : null;
}

/**
 * Уровень строки, если он есть среди уровней её модели; иначе `null` — `Default`. Одно правило на подпись списка, сброс
 * при смене модели и отправку: снимок провайдеров мог смениться под строкой (`providers.changed`).
 */
function chosenEffort(row: Pick<AgentRow, 'model' | 'effort'>, info: ProviderOption | undefined): string | null {
  if (row.effort === null) return null;
  return effortChoices(info, chosenModel(row, info))?.some((level) => level.id === row.effort) === true ? row.effort : null;
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

/** Свой наблюдатель для каждого поповера: анимация закрытия старого не отключает новый. */
function ProviderPopoverContent(props: ComponentPropsWithoutRef<typeof PopoverContent>): JSX.Element {
  const providerResize = useRef<ResizeObserver | null>(null);
  const observeProviderContent = useCallback((content: HTMLDivElement | null): void => {
    providerResize.current?.disconnect();
    providerResize.current = null;
    if (content === null || typeof ResizeObserver === 'undefined') return;
    // Radix ограничивает высоту после автофокуса: раскрываем только скрытый фокус этой карточки.
    const observer = new ResizeObserver((entries) => {
      const focused = content.ownerDocument.activeElement;
      if (!content.isConnected || !(focused instanceof HTMLElement) || !content.contains(focused) || content.clientHeight === 0) return;
      const bounds = content.getBoundingClientRect();
      const height = entries.find((entry) => entry.target === content)?.borderBoxSize[0]?.blockSize ?? content.offsetHeight;
      // Прямоугольники учитывают zoom-анимацию, scrollTop и размеры ResizeObserver — нет.
      const scale = bounds.height / height;
      if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) return;
      const top = bounds.top + content.clientTop * scale;
      const bottom = Math.min(bounds.bottom - content.clientTop * scale, top + content.clientHeight * scale);
      const rect = focused.getBoundingClientRect();
      if (rect.height <= 0 || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return;
      // Chromium кладёт scrollTop на сетку пикселей устройства, округляя к ближнему: при DPR 1 из 78.4 выходило 78, и низ
      // поля оставался на 0.4 px под краем карточки. Цель — сразу на сетке, с запасом в сторону раскрытия.
      const grid = window.devicePixelRatio || 1;
      if (rect.bottom > bottom) content.scrollTop = Math.ceil((content.scrollTop + (rect.bottom - bottom) / scale) * grid) / grid;
      else if (rect.top < top) content.scrollTop = Math.floor((content.scrollTop + (rect.top - top) / scale) * grid) / grid;
    });
    providerResize.current = observer;
    observer.observe(content);
  }, []);
  return <PopoverContent {...props} ref={observeProviderContent} />;
}

export function NewSessionOrRoomDialog({ open, bridge, work, room, onOpenChange }: NewSessionOrRoomDialogProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const activeWorkKey = useLayoutStore((state) => state.activeWorkKey);
  const lastProvider = useUiStore((state) => state.ui.lastProvider);
  const connections = useHostStore((state) => state.connections);
  const priorConnections = useRef(connections);

  /** `null` — `providers.list` этого открытия ещё не ответил. */
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providerCard, setProviderCard] = useState<{ row: number; provider: string } | null>(null);
  /** Синхронная свежесть снимка нужна и между последовательными запусками агентов комнаты. */
  const providersRef = useRef<ProviderOption[] | null>(null);
  const providersReady = useRef(false);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const reloadProviders = useCallback(async (): Promise<void> => {
    await refreshRef.current?.();
  }, []);
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
  }, [open, room, work]);

  // Каждое открытие — с чистой формой и составом по умолчанию: один агент, а «New room» — два. Сброс — до отрисовки
  // (`useLayoutEffect`): в `useEffect` он шёл после неё, и диалог успевал показаться с названием и агентами прошлого открытия.
  useLayoutEffect(() => {
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
    setProviderCard(null);
  }, [open, room, work]);

  // Снимок провайдеров — тоже до отрисовки, как форма: в `useEffect` диалог успевал показать пилюли прошлого открытия, и
  // карточка, открытая на такой пилюле, теряла её из-под себя, когда сброс доходил (фокус после Escape — на диалоге).
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
  }, [open, bridge]);

  useEffect(() => {
    if (priorConnections.current === connections) return;
    priorConnections.current = connections;
    // Перезапуск хоста не закрывает форму: новый ответ заменяет снимок и отменяет ответы прежнего хоста.
    void reloadProviders();
  }, [connections, reloadProviders]);

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
  const unavailable = providers === null ? undefined : agents.find((row) => !started(row) && infoOf(row)?.available !== true);
  const unavailableInfo = unavailable === undefined ? undefined : infoOf(unavailable);
  const availabilityError = unavailable === undefined ? null : S.dialogs.newSession.providerUnavailable(
    unavailableInfo === undefined ? providerIdOf(unavailable) ?? S.dialogs.newSession.agentsField : providerName(unavailableInfo.id, unavailableInfo.label),
  );
  const anyStarted = agents.some(started);
  /** После первой попытки кнопка называется «Retry»: повторяются только не запущенные. */
  const retrying = Object.keys(results).length > 0;
  /** Общие поля и состав заперты, как только хоть одна сессия запущена: она уже принадлежит этой работе. */
  const groupLocked = busy || anyStarted;

  const updateAgent = (key: number, patch: Partial<Omit<AgentRow, 'key'>>): void =>
    setAgents((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addAgent = (): void => {
    const last = agents[agents.length - 1];
    setAgents((rows) => [...rows, { key: nextKey.current++, provider: last?.provider ?? null, model: null, effort: null }]);
  };

  const removeAgent = (key: number): void => setAgents((rows) => (rows.length <= 1 ? rows : rows.filter((row) => row.key !== key)));

  const finish = (): void => {
    onOpenChange(false);
  };

  const submit = async (): Promise<void> => {
    // Второй клик по «Retry» или «Create room» приходит уже на выключенную кнопку: `busy` включается до него.
    if (busy || !providersReady.current) return;
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
      let allStarted = true;
      // По очереди, а не разом: номера сессий идут в порядке строк, и звезда ведущего указывает на свою.
      for (const row of agents) {
        if (done[row.key]?.status === 'started') continue;
        const providerId = providerIdOf(row);
        const info = providersRef.current?.find((provider) => provider.id === providerId);
        if (providerId === null) {
          setError(S.dialogs.newWork.agentRequired);
          return;
        }
        // Пока предыдущая сессия стартовала, ключ могли убрать в другой карточке или окне.
        if (!providersReady.current || info?.available !== true) {
          return;
        }
        // «По умолчанию» становится явным выбором: `lastProvider` сменится, когда запустятся все, и строка не должна
        // за ним перескочить — под итогом «запущена» стояла бы пилюля не того провайдера.
        if (row.provider === null) updateAgent(row.key, { provider: providerId });
        const model = chosenModel(row, info);
        const effort = chosenEffort(row, info);
        try {
          const { ref } = await bridge.call('sessions.create', {
            ...target,
            provider: providerId,
            // Одиночная сессия несёт название из поля; агенты комнаты — пустой ярлык, строка покажет `S05`.
            label: multi ? '' : name.trim(),
            task: '',
            parent: null,
            worktree,
            // Модель и effort — только явно выбранные и ещё существующие в снимке провайдеров: `Default` — без флага,
            // провайдер без списка или флага их не получает, исчезнувший после `providers.changed` выбор не уходит.
            ...(model === null ? {} : { model }),
            ...(effort === null ? {} : { effort }),
          });
          done[row.key] = { status: 'started', sessionId: ref.sessionId };
        } catch (err) {
          console.warn('[parley] sessions.create', err);
          done[row.key] = { status: 'failed', message: errorText(decodeIpcError(err).code, S.errors.actions.createSession) };
          allStarted = false;
        }
        // Диалог закрыли, пока шёл этот агент, — следующих не запускаем и итог в форму не пишем.
        if (launch.cancelled) return;
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
        if (launch.cancelled) return;
        openWhenListed(target.projectPath, target.workId, { kind: 'room', roomId }, pendingRef.current);
        finish();
      } catch (err) {
        console.warn('[parley] rooms.create', err);
        if (launch.cancelled) return;
        setError(errorText(decodeIpcError(err).code, S.errors.actions.createRoom));
      }
    } finally {
      if (launchRef.current === launch) launchRef.current = null;
      // Отменённый запуск форму не трогает: диалог закрыт, а если открыт заново — там уже свой запуск.
      if (!launch.cancelled) setBusy(false);
    }
  };

  const text = S.dialogs.newSession;
  const workTitle = selected === null ? '' : workTitleText(selected.map.work.title);
  const summary = multi ? text.summaryRoom(agents.length, workTitle) : text.summarySession(workTitle);

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
                      {text.workspaceOption(workTitleText(entry.map.work.title), projectName(entry.projectPath))}
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
                const efforts = effortChoices(info, chosenModel(row, info));
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
                            <Popover
                              key={provider.id}
                              open={providerCard?.row === row.key && providerCard.provider === provider.id}
                              onOpenChange={(cardOpen) => {
                                if (!cardOpen) setProviderCard(null);
                                else if (!rowLocked && (!provider.available || on)) setProviderCard({ row: row.key, provider: provider.id });
                              }}
                            >
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={on}
                                  tabIndex={on ? 0 : -1}
                                  title={providerName(provider.id, provider.label)}
                                  disabled={rowLocked}
                                  onClick={() => {
                                    if (provider.available && !on) {
                                      updateAgent(row.key, { provider: provider.id, model: null, effort: null });
                                      setError(null);
                                    }
                                  }}
                                  className={cn(
                                    PILL,
                                    on ? 'border-ring bg-neutral-100 font-semibold' : 'border-border hover:bg-foreground/7',
                                    !provider.available && 'opacity-45',
                                  )}
                                >
                                  {/* Буква значка провайдера без бренда (`GLM` → «G») не должна попадать в имя кнопки. */}
                                  <span aria-hidden="true" className="inline-flex">
                                    <AgentIcon provider={provider.id} size={14} />
                                  </span>
                                  {provider.label}
                                </button>
                              </PopoverTrigger>
                              <ProviderPopoverContent
                                aria-label={providerName(provider.id, provider.label)}
                                align="start"
                                collisionPadding={12}
                                className="max-h-[min(calc(100vh-48px),var(--radix-popover-content-available-height))] w-[min(360px,calc(100vw-24px))] overflow-y-auto"
                              >
                                <ProviderCard
                                  provider={provider}
                                  onReload={reloadProviders}
                                  onRestartHost={() => {
                                    setProviderCard(null);
                                    useUiStore.getState().confirmRestartHost();
                                  }}
                                />
                              </ProviderPopoverContent>
                            </Popover>
                          );
                        })}
                      </div>
                      {models !== null && models.length > 0 ? (
                        <Select
                          value={chosenModel(row, info) ?? DEFAULT_MODEL}
                          disabled={rowLocked}
                          onValueChange={(value) => {
                            const model = value === DEFAULT_MODEL ? null : value;
                            // Уровня, которого у новой модели нет, больше не выбрать — он сбрасывается в `Default` (спека 5.9).
                            updateAgent(row.key, { model, effort: chosenEffort({ model, effort: row.effort }, info) });
                          }}
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
                      {efforts === null ? null : (
                        <Select
                          value={chosenEffort(row, info) ?? DEFAULT_EFFORT}
                          disabled={rowLocked}
                          onValueChange={(value) => updateAgent(row.key, { effort: value === DEFAULT_EFFORT ? null : value })}
                        >
                          {/* Ширина постоянная: длинная подпись уровня не сдвигает модель и не выталкивает строку из окна 800×500. */}
                          <SelectTrigger aria-label={text.effortField} className="w-32 shrink-0">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className={LIST_HEIGHT}>
                            <SelectItem value={DEFAULT_EFFORT} className={ITEM_CLIP}>
                              {text.effortDefault}
                            </SelectItem>
                            {efforts.map((level) => (
                              <SelectItem key={level.id} value={level.id} description={level.description} className={ITEM_CLIP}>
                                {level.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
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
        </div>
        <DialogFooter className="items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-xs">
            {/* Ошибка диалога — в подвале: он не прокручивается, а тело с пятью агентами в окне 800×500 уходит за край. */}
            {error !== null || providersError !== null || availabilityError !== null ? (
              <p role="alert" className="break-words text-destructive">
                {error ?? providersError ?? availabilityError}
              </p>
            ) : null}
            <span className="truncate text-neutral-700" title={summary}>
              {summary}
            </span>
          </div>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || providers === null || providersLoading || providersError !== null || availabilityError !== null || selected === null} onClick={() => void submit()}>
            {retrying ? S.common.retry : multi ? text.submitRoom : text.submitSession}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
