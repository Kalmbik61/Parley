/**
 * Диалог «New workspace» (кусок 7 плана «Organic», спека окна 2026-09-29, 1.7): работа и, по желанию, агенты в ней.
 * Поля: проект (сегмент известных проектов), название, блок «Agents» и первый промпт. Ширина 660 — строки агентов те же,
 * что в «New session or room»; от «+» заголовка проекта проект уже выбран, иначе по умолчанию проект активной работы
 * (как в прототипе handoff).
 *
 * Блок «Agents» начинается с нуля строк и кнопки «Add agent». Нуль агентов — создаётся только работа (`works.create`),
 * она становится активной (без вкладки), названию не из чего браться — оно обязательно. Строки, снимок провайдеров и
 * запуск общие с диалогом «New session or room» (`components/dialogs/AgentRowsEditor.tsx`, `agent-rows.ts`,
 * `launch-agents.ts`). Один агент — одна сессия; два и больше — переключатель «Put them in a room» (включён по умолчанию):
 * включён — комната с ведущим (звезда в строке), выключен — отдельные сессии, по одному `sessions.create` на строку.
 * Рецептов и подвала с бюджетом здесь нет.
 *
 * Первый промпт виден, только когда есть агент. Одна сессия — её `task`; отдельные сессии — один и тот же `task` каждой;
 * комната — сессии стартуют тихо (`task: ''`, `quiet`), а после `rooms.create` промпт уходит в комнату первым письмом
 * человека всем участникам (`rooms.send` с пустым `to`, как из композера комнаты). Пустой промпт — ничего не отправляется.
 * Название комнаты — «Room 1»: у новой работы комнат ещё нет.
 *
 * Согласие на папку (спека 2026-10-21, 4.2 п. 1): между проверкой формы и `works.create` окно спрашивает `trust.list`; папки
 * нет в списке — диалог «Trust … for agents?» (`TrustFolderDialog`), и без «Trust» работа не создаётся, какой бы
 * провайдер ни был выбран. «Trust» — `trust.grant` (`by: 'window'`) и дальше всё как обычно; «Cancel» — назад в композер.
 * Хост прежней сборки без `trust.list` (`unknown_method`) запусков не удерживает — спрашивать у него нечего.
 *
 * Порядок вызовов — `works.create`, затем `sessions.create` по строкам, затем `rooms.create` и `rooms.send` (если нужны).
 * Если что-то после первого упало, работа уже есть: диалог показывает ошибку и «Retry», который по нажатию повторяет
 * только упавшее — проект и название тогда заперты, чтобы не казалось, что повтор создаст работу с новым названием; уже
 * запущенные строки и созданная комната не повторяются. Ничего не создаётся без явного действия человека (Create
 * workspace, ⌘Enter, Retry).
 *
 * Пустое название при агентах берётся из первого промпта (`titleFromPrompt`); пустой промпт — тихий старт агента, он ждёт
 * задачу в терминале. Ни названия, ни промпта — ошибка. Ярлык сессии пуст: хост поставит имя по номеру
 * (`defaultSessionName` core) — `S01 Ralph`. Цель работы (`goal`) пуста.
 *
 * «In its own worktree» (спека Orca-UI 6.6, план worktree 4.3) остаётся: виден, если есть агент и `worktrees.available`
 * для проекта. «Choose a folder…» (`app.chooseFolder`) остаётся рядом с сегментом: без него в окне без работ нельзя выбрать
 * первый проект.
 *
 * Новая работа становится активной, а вкладка (сессии, комнаты; у пустой работы — никакой) открывается, только когда снимок
 * работ (`works.changed`) принёс её: ответы `works.create`, `sessions.create` и `rooms.create` приходят раньше снимка, и
 * вкладка, открытая сразу, мигнула бы телом «Session deleted» (`lib/open-when-listed.ts`). Закрытие диалога отменяет идущий
 * запуск: остальные агенты, комната и вкладка не создаются.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, providerName, S } from '../../shared/strings.js';
import { AgentRowsEditor } from '../components/dialogs/AgentRowsEditor.js';
import { FieldHint } from '../components/dialogs/FieldHint.js';
import { TrustFolderDialog } from '../components/dialogs/TrustFolderDialog.js';
import {
  infoOf,
  providerIdOf,
  useAgentRows,
  useDialogProviders,
  useProjectRoles,
  type AgentEnv,
  type AgentResult,
  type AgentRow,
} from '../components/dialogs/agent-rows.js';
import { createRoom, fetchRoomLean, startAgents, type LaunchTarget } from '../components/dialogs/launch-agents.js';
import { useLayoutStore } from '../layout/store.js';
import { openWhenListed } from '../lib/open-when-listed.js';
import { workKey } from '../lib/tree-order.js';
import { TOOLTIP_DELAY_MS, TooltipProvider } from '../ui/tooltip.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';
import { Textarea } from '../ui/textarea.js';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group.js';
import { MicButton } from '../voice/MicButton.js';
import { useDictationStore } from '../voice/dictation-store.js';
import { isVoiceShortcut, useTextareaDictation } from '../voice/targets.js';

export interface NewWorkDraft {
  projectPath: string | null;
  title: string;
  /** Первый промпт; при нуле агентов в проверку идёт пустым. */
  prompt: string;
  /** Сколько агентов добавлено: без них названию не из чего взяться и оно обязательно. */
  agentCount: number;
}

/**
 * Края названия — то же правило, что у `works.rename` (`@parley/protocol`, `TITLE_EDGES`):
 * невидимые символы формата считаются пробелами, иначе название из одних ZWSP прошло бы.
 * Повторено здесь, а не взято из схемы: `works.create` названия не обрезает (старые клиенты),
 * и окно шлёт уже обрезанное.
 */
const TITLE_EDGES = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

export function trimTitle(title: string): string {
  return title.replace(TITLE_EDGES, '');
}

/** Счёт по кодовым точкам: эмодзи — один символ, а не два, как у `length`. */
const codePoints = (text: string): number => [...text].length;

/** Сколько знаков первого промпта идёт в название, если его не ввели (прототип handoff: первые 40 знаков первой строки). */
const DERIVED_TITLE_LENGTH = 40;

/** Название из первого промпта (1.7): первая непустая строка, до 40 знаков; в промпте одни пробелы — пусто. */
export function titleFromPrompt(prompt: string): string {
  for (const line of prompt.split('\n')) {
    const trimmed = trimTitle(line);
    if (trimmed !== '') return trimTitle([...trimmed].slice(0, DERIVED_TITLE_LENGTH).join(''));
  }
  return '';
}

/** Название, с которым уйдёт `works.create`: введённое, а если его нет — из первого промпта. */
function effectiveTitle(draft: Pick<NewWorkDraft, 'title' | 'prompt'>): string {
  const typed = trimTitle(draft.title);
  return typed !== '' ? typed : titleFromPrompt(draft.prompt);
}

/**
 * Пределы: название 1–120, первый промпт до 20000 — по кодовым точкам; проект обязателен. Название обязательно, если нет
 * ни одного агента или промпт не даёт названия. Тексты — S.dialogs.newWork. Агент у строки проверяется при запуске.
 */
export function validateDraft(draft: NewWorkDraft): Partial<Record<keyof NewWorkDraft, string>> {
  const errors: Partial<Record<keyof NewWorkDraft, string>> = {};
  const text = S.dialogs.newWork;
  if (draft.projectPath === null) errors.projectPath = text.selectFolderRequired;
  const typed = trimTitle(draft.title);
  if (typed === '' && titleFromPrompt(draft.prompt) === '') errors.title = draft.agentCount === 0 ? text.titleRequired : text.titleOrPromptRequired;
  else if (codePoints(typed) > 120) errors.title = text.titleLength;
  if (codePoints(draft.prompt) > 20000) errors.prompt = text.promptTooLong;
  return errors;
}

/** Имя папки проекта — последний сегмент пути; полный путь идёт в `title` пункта сегмента. */
function projectName(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, '') || projectPath;
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

export interface NewWorkComposerProps {
  open: boolean;
  /** От «+» заголовка проекта — уже выбран; `null` — ⌘N и «New workspace». */
  projectPath: string | null;
  /** Начальное название: «Create workspace …» палитры (кусок 6.2); `''` — пусто. */
  title: string;
  bridge: ParleyBridge;
  onOpenChange(open: boolean): void;
}

export function NewWorkComposer({ open, projectPath: initialProject, title: initialTitle, bridge, onOpenChange }: NewWorkComposerProps): JSX.Element {
  const entries = useWorksStore((state) => state.entries);
  const hiddenProjects = useUiStore((state) => state.ui.hiddenProjects);
  const [projectPath, setProjectPath] = useState<string | null>(initialProject);
  const [chosenFolders, setChosenFolders] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  useTextareaDictation('new-workspace', promptRef, setPrompt);
  const { agents, setAgents, resetAgents, updateAgent, addAgent, removeAgent } = useAgentRows(0, 0);
  const [leadKey, setLeadKey] = useState(1);
  /** «Put them in a room»: при двух агентах и больше включён по умолчанию; выключен — отдельные сессии. */
  const [inRoom, setInRoom] = useState(true);
  const [providerCard, setProviderCard] = useState<{ row: number; provider: string } | null>(null);
  const [results, setResults] = useState<Record<number, AgentResult>>({});
  const [worktree, setWorktree] = useState(false);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof NewWorkDraft, string>>>({});
  const [error, setError] = useState<string | null>(null);
  /** Работа создана, а запуск не дошёл до конца — «Retry» повторяет только недостающее. */
  const [createdWork, setCreatedWork] = useState<LaunchTarget | null>(null);
  /** Комната создана, а первый промпт в неё не ушёл — «Retry» повторяет только отправку. */
  const [createdRoom, setCreatedRoom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Папка, согласия на которую ждёт диалог доверия; `null` — диалога нет. */
  const [trustFolder, setTrustFolder] = useState<string | null>(null);
  /**
   * Идущая проверка согласия или ответ на диалог. Закрытие композера и новое открытие ставят ей `cancelled`: дальше она
   * ничего не делает — не открывает диалог и не создаёт работу.
   */
  const trustGateRef = useRef<{ cancelled: boolean } | null>(null);
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

  useEffect(() => {
    if (launchRef.current !== null) launchRef.current.cancelled = true;
    if (trustGateRef.current !== null) trustGateRef.current.cancelled = true;
  }, [open, initialProject, initialTitle]);

  // Каждое открытие — с чистой формой: проект открывшего (от «+» заголовка) или проект активной работы, название из
  // палитры, ни одного агента; агент по умолчанию выбирается заново по правилу (`lastProvider` помнит прошлый). Сброс — до
  // отрисовки (`useLayoutEffect`): в `useEffect` он шёл после неё, и диалог успевал показаться с названием и промптом
  // прошлого открытия.
  useLayoutEffect(() => {
    if (!open) return;
    const activeKey = useLayoutStore.getState().activeWorkKey;
    const activeProject =
      useWorksStore.getState().entries.find((entry) => workKey(entry.projectPath, entry.map.work.id) === activeKey)?.projectPath ?? null;
    // Проект активной работы, убранный из списка («Remove from list…»), не предлагается: новая работа молча вернула бы его.
    const offered = activeProject !== null && useUiStore.getState().ui.hiddenProjects.includes(activeProject) ? null : activeProject;
    setProjectPath(initialProject ?? offered);
    setTitle(initialTitle);
    setPrompt('');
    resetAgents(0);
    setLeadKey(1);
    setInRoom(true);
    setProviderCard(null);
    setResults({});
    setWorktree(false);
    setFieldErrors({});
    setError(null);
    setCreatedWork(null);
    setCreatedRoom(null);
    setBusy(false);
    setTrustFolder(null);
  }, [open, initialProject, initialTitle]);

  const { providers, providersLoading, providersError, providersRef, providersReady, reloadProviders, defaultId } = useDialogProviders(open, bridge, setAgents);
  const roles = useProjectRoles(open, bridge, projectPath);
  const env: AgentEnv = { roles, providers, defaultId };

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
        // Без ответа поле просто не показывается.
      });
    return () => {
      stale = true;
    };
  }, [open, bridge, projectPath]);

  // Убранные из списка проекты («Remove from list…», спека архива, 6.3) в выборе не показываются. Исключение — выбранный
  // сейчас (от «+» заголовка в режиме «показать всё») и добавленный через «Choose a folder…»: иначе выбор не был бы виден.
  const knownProjects = [...new Set([...entries.map((entry) => entry.projectPath), ...chosenFolders])]
    .filter((path) => !hiddenProjects.includes(path) || path === projectPath || chosenFolders.includes(path))
    .sort();

  const chooseFolder = async (): Promise<void> => {
    const dir = await bridge.app.chooseFolder();
    if (dir === null) return;
    setChosenFolders((current) => (current.includes(dir) ? current : [...current, dir]));
    setProjectPath(dir);
  };

  const hasAgents = agents.length > 0;
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
  const workLocked = createdWork !== null;
  /** Состав заперт, как только хоть одна сессия запущена или комната создана: они уже принадлежат этой работе. */
  const groupLocked = busy || agents.some(started) || createdRoom !== null;
  const allWorktree = agents.every((row) => (row.worktree ?? worktree));

  const finish = (): void => {
    setBusy(false);
    setCreatedWork(null);
    onOpenChange(false);
  };

  /**
   * Всё, что идёт после `works.create`: агенты, комната, первый промпт и вкладка. Повторный вызов («Retry») делает только
   * недостающее: запущенные строки пропускаются (`results`), созданная комната (`createdRoom`) тоже.
   */
  const launchInto = async (work: LaunchTarget): Promise<void> => {
    const launch = { cancelled: false };
    launchRef.current = launch;
    setBusy(true);
    setError(null);
    let finished = false;
    try {
      if (!hasAgents) {
        openWhenListed(work.projectPath, work.workId, { kind: 'work' }, pendingRef.current);
        finished = true;
        finish();
        return;
      }
      const done: Record<number, AgentResult> = { ...results };
      // Участники комнаты — по настройке `leanAgents` (хост её не отдал — поле lean опускаем, решает хост).
      let roomLean: boolean | null = null;
      if (roomMode) {
        roomLean = await fetchRoomLean(bridge);
        if (launch.cancelled) return;
      }
      const outcome = await startAgents({
        bridge,
        target: work,
        rows: agents,
        done,
        env,
        providersRef,
        providersReady,
        worktree,
        worktreeAvailable,
        // Пустой ярлык: хост поставит имя по номеру (см. докблок).
        label: '',
        // Сессии комнаты стартуют тихо: промпт уйдёт в комнату письмом человека.
        task: roomMode ? '' : prompt,
        lean: roomMode ? roomLean : null,
        logFailures: true,
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
        openWhenListed(work.projectPath, work.workId, { kind: 'session', sessionId: sessionIds[0] ?? '' }, pendingRef.current);
        finished = true;
        finish();
        return;
      }

      let roomId = createdRoom;
      if (roomId === null) {
        const leadResult = done[lead];
        const created = await createRoom({
          bridge,
          target: work,
          title: S.dialogs.defaultRoomTitle(1),
          members: sessionIds,
          lead: leadResult?.status === 'started' ? leadResult.sessionId : (sessionIds[0] ?? ''),
          mode: 'free',
          recipeId: null,
          logFailures: true,
          isCancelled: () => launch.cancelled,
        });
        if (created.kind === 'stopped') return;
        if (created.kind === 'failed') {
          setError(created.message);
          return;
        }
        roomId = created.roomId;
      }
      // Первый промпт — первое письмо человека всем участникам комнаты (`to: []`, как у композера комнаты).
      if (prompt.trim() !== '') {
        try {
          await bridge.call('rooms.send', { ...work, roomId, to: [], text: prompt, kind: 'note', requestedAt: Date.now() });
        } catch (err) {
          console.warn('[parley] rooms.send', err);
          if (launch.cancelled) return;
          setCreatedRoom(roomId);
          setError(`${S.dialogs.newWork.firstPromptNotSent} ${errorText(decodeIpcError(err).code, S.rooms.sendAction)}`);
          return;
        }
        if (launch.cancelled) return;
      }
      openWhenListed(work.projectPath, work.workId, { kind: 'room', roomId }, pendingRef.current);
      finished = true;
      finish();
    } finally {
      if (launchRef.current === launch) launchRef.current = null;
      // Отменённый запуск форму не трогает: диалог закрыт, а если открыт заново — там уже свой запуск.
      if (!launch.cancelled) {
        if (!finished) setCreatedWork(work);
        setBusy(false);
      }
    }
  };

  const submit = async (): Promise<void> => {
    if (useDictationStore.getState().finishBeforeSend('new-workspace')) return;
    if (busy) return;
    // Агенты — только после ответа `providers.list`: до него не известно, кто доступен.
    if (hasAgents && (!providersReady.current || availabilityError !== null)) return;
    if (createdWork !== null) {
      await launchInto(createdWork);
      return;
    }
    const errors = validateDraft({ projectPath, title, prompt: hasAgents ? prompt : '', agentCount: agents.length });
    setFieldErrors(errors);
    if (projectPath === null || Object.keys(errors).length > 0) return;
    setBusy(true);
    setError(null);
    const gate = { cancelled: false };
    trustGateRef.current = gate;
    let trusted = true;
    try {
      const { folders } = await bridge.call('trust.list', {});
      // Хост записывает realpath папки: путь, выбранный человеком, сверяется с тем, что хост отдал.
      trusted = folders.some((record) => record.folder === projectPath);
    } catch (err) {
      const info = decodeIpcError(err);
      // Хост прежней сборки трёх методов `trust.*` не знает и запусков не удерживает: спрашивать нечего.
      if (info.code !== 'unknown_method') {
        console.warn('[parley] trust.list', info.message);
        if (gate.cancelled) return;
        setError(errorText(info.code, S.errors.actions.checkFolderTrust));
        setBusy(false);
        return;
      }
    }
    if (gate.cancelled) return;
    if (!trusted) {
      // Форма остаётся запертой (`busy`) на время диалога; «Trust» продолжает отсюда, «Cancel» отпускает форму.
      setTrustFolder(projectPath);
      return;
    }
    await createWork(projectPath);
  };

  /** `works.create` и всё, что идёт за ним; папка уже доверена. */
  const createWork = async (folder: string): Promise<void> => {
    let workId: string;
    try {
      ({ workId } = await bridge.call('works.create', { projectPath: folder, title: effectiveTitle({ title, prompt: hasAgents ? prompt : '' }), goal: '' }));
    } catch (err) {
      console.warn('[parley] works.create', err);
      setError(errorText(decodeIpcError(err).code, S.errors.actions.createWorkspace));
      setBusy(false);
      return;
    }
    await launchInto({ projectPath: folder, workId });
  };

  /** «Trust» в диалоге: запись согласия окном, затем создание работы. */
  const trustAndCreate = async (folder: string): Promise<void> => {
    const gate = trustGateRef.current;
    setTrustFolder(null);
    try {
      await bridge.call('trust.grant', { folder, by: 'window' });
    } catch (err) {
      const info = decodeIpcError(err);
      console.warn('[parley] trust.grant', info.message);
      if (gate?.cancelled === true) return;
      setError(errorText(info.code, S.errors.actions.grantTrust));
      setBusy(false);
      return;
    }
    if (gate?.cancelled === true) return;
    await createWork(folder);
  };

  /** «Cancel» в диалоге: назад в композер, ничего не создано. */
  const cancelTrust = (): void => {
    setTrustFolder(null);
    setBusy(false);
  };

  const text = S.dialogs.newWork;
  const fieldError = (key: keyof NewWorkDraft): JSX.Element | null =>
    fieldErrors[key] === undefined ? null : <span className="text-xs text-destructive">{fieldErrors[key]}</span>;
  const shownError = error ?? (hasAgents ? providersError ?? availabilityError : null);

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="w-[660px] max-w-[calc(100vw-2rem)]"
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !event.metaKey) return;
          event.preventDefault();
          void submit();
        }}
        onEscapeKeyDown={(event) => {
          // Capture-обработчик внешнего слоя может сработать первым: Escape закрывает только карточку провайдера.
          if (providerCard !== null) {
            event.preventDefault();
            setProviderCard(null);
          }
        }}
      >
        <DialogTitle>{text.title}</DialogTitle>
        {/* Свой провайдер тултипов: диалог не зависит от провайдера окна (`main.tsx`) — его монтируют и отдельно, в тестах. */}
        <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <div className="flex min-w-0 flex-col gap-1">
            <span id="new-work-project">{text.projectField}</span>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {knownProjects.length > 0 ? (
                <ToggleGroup
                  type="single"
                  value={projectPath ?? ''}
                  disabled={workLocked}
                  aria-labelledby="new-work-project"
                  // Длинных имён и многих проектов сегмент не выталкивает за край: он переносится, имя обрезается.
                  className="max-w-full flex-wrap rounded-[18px]"
                  onValueChange={(value) => {
                    // Повторный клик по выбранному пункту Radix сообщает пустой строкой — проект не снимается.
                    if (value !== '') setProjectPath(value);
                  }}
                >
                  {knownProjects.map((path) => (
                    <ToggleGroupItem key={path} value={path} title={path} className="max-w-[16rem]">
                      <span className="min-w-0 truncate">{projectName(path)}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              ) : null}
              <Button type="button" variant="outline" size="sm" disabled={workLocked} onClick={() => void chooseFolder()}>
                {text.chooseFolder}
              </Button>
            </div>
            {fieldError('projectPath')}
          </div>
          <label className="flex flex-col gap-1">
            {text.titleField}
            <Input
              value={title}
              disabled={workLocked}
              placeholder={hasAgents ? text.titlePlaceholder : text.titlePlaceholderRequired}
              onChange={(event) => setTitle(event.target.value)}
            />
            {fieldError('title')}
          </label>
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
            minRows={0}
            providerCard={providerCard}
            onProviderCard={setProviderCard}
            reloadProviders={reloadProviders}
            onLead={setLeadKey}
            onUpdate={updateAgent}
            onRemove={removeAgent}
            onAdd={addAgent}
            onClearError={() => setError(null)}
          />
          {multi ? (
            <span className="flex items-center gap-1">
              {/* «?» — вне `label`: внутри он попал бы в имя переключателя. */}
              <label className="flex items-center gap-2">
                <Switch checked={inRoom} disabled={groupLocked} onCheckedChange={setInRoom} />
                {S.dialogs.newSession.putInRoom}
              </label>
              <FieldHint field={S.dialogs.newSession.putInRoom} text={S.dialogs.newSession.hints.putInRoom} />
            </span>
          ) : null}
          {hasAgents ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="new-work-prompt">{text.promptField}</label>
                <MicButton targetId="new-workspace" size="sm" />
              </div>
              <Textarea
                id="new-work-prompt"
                ref={promptRef}
                value={prompt}
                placeholder={text.promptPlaceholder}
                className="min-h-[96px] rounded-2xl"
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  // В диалоге обработчик клавиш окна молчит (`keys/handler.ts`, контекст dialog): ⌘⇧M ловит само поле.
                  if (!isVoiceShortcut(event.nativeEvent)) return;
                  event.preventDefault();
                  void useDictationStore.getState().toggle('new-workspace');
                }}
              />
              {fieldError('prompt')}
            </div>
          ) : null}
          {hasAgents && worktreeAvailable ? (
            <label className="flex items-center gap-2">
              <Switch
                checked={allWorktree}
                disabled={groupLocked}
                onCheckedChange={(on) => { setWorktree(on); setAgents((rows) => rows.map((row) => ({ ...row, worktree: null }))); }}
              />
              {S.dialogs.newSession.inOwnWorktree}
            </label>
          ) : null}
          {shownError !== null ? <p className="text-destructive">{shownError}</p> : null}
        </div>
        </TooltipProvider>
        <DialogFooter className="items-center">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {S.common.cancel}
            </Button>
          </DialogClose>
          <Button type="button" disabled={busy || (hasAgents && (providers === null || providersLoading || providersError !== null || availabilityError !== null))} onClick={() => void submit()}>
            {workLocked ? S.common.retry : text.submit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* Рядом с диалогом, а не внутри: ⌘Enter и клики диалога доверия не всплывают в форму композера. */}
    <TrustFolderDialog
      open={trustFolder !== null}
      folder={trustFolder ?? ''}
      onTrust={() => trustFolder !== null && void trustAndCreate(trustFolder)}
      onCancel={cancelTrust}
    />
    </>
  );
}
