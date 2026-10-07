/**
 * Вид «Chat» вкладки сессии (план 2026-10-01, Task 3): тулбар (сегмент, модель, Stop), лента
 * (`FeedList`) и поле ввода (`Composer`).
 *
 * Подписку на ленту держит слой поверхностей (`FeedSubscription` в `SurfaceLayer.tsx`), здесь лента
 * только читается. Поверхности терминала в этом виде нет (решение контролёра Ж), поэтому «видимость»
 * сессии для «просмотрено» и уведомлений (`attention/seen.ts`) ставит сам вид — как `TerminalSurface`.
 * Карточки разрешения, вопроса и плана — с кнопками (`cards/`, кусок 4a): решения уходят `feed.decide`.
 *
 * Ввод (решение 8): текст уходит `pty.send` с `submit: true` через `sendWithToast` — те же отказы и
 * тосты, что у отправки из комнаты и ревью. Отправленное во время хода показывается в ленте серым,
 * пока не придёт промпт с тем же текстом, или до отказа отправки. «Stop» — `feed.interrupt` хоста (Esc агенту и
 * присмотр за исходом); у хоста без метода — Esc в терминал (`pty.input`).
 * Тоста «Sent to S01» в чате нет — отправленное видно в самой ленте; отказы и их тосты прежние.
 * Черновик и серые элементы живут в `ui-store.ts` по сессии и переживают смену вида и вкладки.
 * Поле и вложения очищаются сразу; если хост ничего не вставил (нет процесса, `blocked`, `busy`, `no-paste-mode`),
 * набранное возвращается — но только в поле, пустое к этому моменту: человек мог начать новое сообщение. Вставка без
 * Enter (`draft`, `input`, `blocked-before-enter`, `restarted`) ничего не возвращает: текст уже в поле ввода терминала.
 *
 * Codex (спека 2026-10-07, 5.4): лента из журнала; меню модели, effort и режима — подписи; подсказок `/` нет;
 * вложения — списком путей, как в комнате.
 *
 * Агенты (кусок 4b): «N agents running» в тулбаре — по карточкам `agent` ленты со статусом `running`; клик по ней и по
 * бейджу агентов в сайдбаре и комнате ведут в панель Agents правого сайдбара (`agents/open-agents.ts`); нет места — ставят просьбу показать карточку (`ui-store.ts`), которую исполняет лента. Пока
 * сессию держат одни фоновые субагенты (`heldByBackground`), лента кончается `turn`: хода нет, Stop не показывается,
 * поле ввода открыто — карточки агентов `turnActive` не считает.
 *
 * Меню режима в тулбаре (кусок 4a, решения К и Л): подпись — `mode` ленты, выбор — `sessions.setMode`;
 * пока запрос в пути или сессия не живая (хост ответил бы `not_found`), меню выключено; `verified: false` — тост «откройте терминал». Баннер «ждёт в
 * терминале» (решение Н) — когда активность сессии `blocked`, а карточки `pending` в ленте нет (диалог
 * без хука) и так держится 300 мс подряд; с карточкой ждёт человека сама карточка.
 *
 * Меню «модель · effort» (нормалайзер модели и effort 2026-10-06, 5.9): подпись модели — из ленты, иначе из карты
 * (`WorkSession.model` подписью каталога), уровень — из карты; пункты — модели провайдера и уровни модели из карты
 * (`effortChoices`). Выбор уходит `sessions.setModel` (хост перезапускает живую сессию через resume) и
 * `sessions.setEffort` (ползунок `/effort` с клавишей `s`): ни текста `/model`, ни записи в настройки CLI. Хост без
 * обоих методов — меню нет. Пункты неактивны, пока агент работает или его держат фоновые задачи, уровни — ещё и у
 * неживой сессии.
 *
 * Подсказки и вложения поля ввода (живая проверка 2026-10-02): команды, скиллы и субагенты берутся у хоста
 * (`capabilities-store.ts`), файлы — из рабочей папки сессии (`files.list`). Файлы,
 * брошенные на вид, скриншот из буфера и скрепка встают чипами над полем (`Composer`; список путей — в
 * `ui-store.ts`), а при отправке уходят упоминаниями `@"путь"` после текста (`attachments.ts`) — отправляет
 * их только человек. Серый элемент очереди хранит уже собранный текст; промпт ленты (`PromptItem`) снова
 * показывает хвостовые упоминания чипами.
 *
 * Ход считается только у живой сессии (`live`: lifecycle `active`): у уснувшей или закрытой Stop и
 * Queue не показываются, даже если лента кончилась промптом без конца хода.
 */

import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import type { FeedItem } from '@parley/core';
import { HOST_ERROR_REASONS, refKey, type ModelOption, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import type { FileRoot } from '../../shared/files-types.js';
import type { TerminalTab } from '../lib/feed-view.js';
import { useHostSupports } from '../lib/capabilities.js';
import { defaultRoot } from '../files/store.js';
import { cn } from '../lib/cn.js';
import { effortChoices } from '../lib/effort-choices.js';
import { activityFor, useActivityStore, type ActivityEntry } from '../store/activity.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { NotRunningCard } from '../terminal/NotRunningCard.js';
import { dragHasFiles } from '../terminal/drop.js';
import { resumeSession, sendWithToast, type SendWithToastDeps } from '../terminal/send.js';
import { composeRoomMessage } from '../components/rooms/attachments.js';
import { addAttachments, composePrompt } from './attachments.js';
import { ChatEnvContext, type ChatEnv } from './chat-env.js';
import { ChatToolbar, modeLabel, type ModeChoice } from './ChatToolbar.js';
import { openAgentsPanel } from '../agents/open-agents.js';
import { useCapabilitiesStore } from './capabilities-store.js';
import { Composer } from './Composer.js';
import { currentModel, hasPendingCard, runningAgents, turnActive } from './feed-model.js';
import { FeedList } from './FeedList.js';
import { useFeedStore, type FeedEntry } from './store.js';
import type { SuggestionSource } from './use-suggestions.js';
import { useChatUiStore, type Queued } from './ui-store.js';
import { useFeed } from './use-feed.js';
import { WaitingBanner } from './WaitingBanner.js';

export interface ChatViewProps {
  workKey: string;
  tab: TerminalTab;
  sessionRef: SessionRef;
  /** Работа активна; вкладка активна в группе по построению — тело рисуется только у активной. */
  visible: boolean;
  /** Сессия живая (lifecycle `active`): только тогда может идти ход. */
  live: boolean;
  bridge: ParleyBridge;
  /** `SendWithToastDeps` окна (из `AppShell` через раскладку). */
  sendDeps: SendWithToastDeps;
  /** Провайдер сессии: по нему берутся модели и уровни для меню «модель · effort». */
  provider: string;
  /** Модель из карты (`WorkSession.model`); `null` — «Default», без флага. */
  storedModel: string | null;
  /** Уровень effort из карты (`WorkSession.effort`); `null` — «Default», без флага. */
  storedEffort: string | null;
}

/**
 * Баннер ждёт, пока условие держится столько подряд: `Notification` с `permission_prompt` приходит на
 * доли секунды раньше карточки `PermissionRequest`, и без паузы баннер мигал бы перед каждой карточкой.
 */
const BANNER_DELAY_MS = 300;

/** `true`, только когда `condition` держится `delayMs` подряд; пропажа условия снимает сразу. */
function useHeldFor(condition: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!condition) {
      setHeld(false);
      return undefined;
    }
    const timer = setTimeout(() => setHeld(true), delayMs);
    return () => clearTimeout(timer);
  }, [condition, delayMs]);
  return condition && held;
}

const NO_ITEMS: readonly FeedItem[] = [];
const NO_QUEUED: readonly Queued[] = [];
const NO_MODELS: readonly ModelOption[] = [];
const NO_PATHS: readonly string[] = [];

/** Подпись модели по каталогу провайдера; нет в каталоге или подпись пустая — сам id. */
function modelCaption(models: readonly ModelOption[], id: string): string {
  const label = models.find((option) => option.id === id)?.label;
  return label === undefined || label === '' ? id : label;
}

/**
 * Чем занята сессия для меню «модель · effort» — по тем же признакам хост ответит отказом (спека 5.7, 5.8): агент
 * работает сам или ждёт человека — `agent`; ход окончен, а держат фоновые задачи — `background`; иначе (`idle`,
 * `unseen`, активность ещё неизвестна) — `idle`.
 */
function occupation(activity: ActivityEntry['activity'] | undefined): 'idle' | 'agent' | 'background' {
  if (activity === undefined) return 'idle';
  if (activity.activity === 'blocked' || (activity.activity === 'working' && !activity.heldByBackground)) return 'agent';
  return activity.heldByBackground || activity.tasks.some((task) => task.background) ? 'background' : 'idle';
}

/**
 * Отказ смены модели или уровня. `conflict` с причиной `busy` — сессия занята (так отвечает хост: агент работает, держат
 * фоновые задачи, в поле терминала черновик, открыт ползунок, идёт другая смена); прочее — общий текст по коду.
 */
function choiceFailed(method: string, action: string, error: unknown): void {
  const { code, message, data } = decodeIpcError(error);
  console.warn(`[parley] ${method}`, message);
  const busy = code === 'conflict' && data?.['reason'] === HOST_ERROR_REASONS.busy;
  toast.error(busy ? S.chat.choice.sessionBusy : errorText(code, action));
}

/** Номер серого элемента — общий на окно: элементы разных сессий живут в одном сторе. */
let nextQueuedId = 0;

function promptCount(items: readonly FeedItem[], text: string): number {
  const wanted = text.trim();
  return items.filter((item) => item.kind === 'prompt' && item.text.trim() === wanted).length;
}

function noteOf(feed: FeedEntry | null): string | null {
  if (feed?.status === 'error') return S.chat.feedUnavailable;
  if (feed === null || feed.status === 'loading') return S.chat.loading;
  return S.chat.empty;
}

export function ChatView({ workKey, tab, sessionRef, visible, live, bridge, sendDeps, provider, storedModel, storedEffort }: ChatViewProps): JSX.Element {
  const feed = useFeed(sessionRef);
  const codex = provider === 'codex';
  const items = feed?.items ?? NO_ITEMS;
  const active = live && turnActive(items);
  const blocked = useActivityStore((state) => activityFor(state.byRef, sessionRef)?.activity.activity === 'blocked');
  const waiting = blocked && !hasPendingCard(items);
  const showBanner = useHeldFor(waiting, BANNER_DELAY_MS);
  const canSetMode = useHostSupports('sessions.setMode');
  const canInterrupt = useHostSupports('feed.interrupt');
  const canSetModel = useHostSupports('sessions.setModel');
  const canSetEffort = useHostSupports('sessions.setEffort');
  const [modeBusy, setModeBusy] = useState(false);
  const [choiceBusy, setChoiceBusy] = useState(false);
  const providerInfo = useProvidersStore((state) => state.providers.find((item) => item.id === provider));
  const models = providerInfo?.models ?? NO_MODELS;
  // Уровни модели из карты — тот же список, по которому хост проверит выбор; модели в карте нет — уровни «Default».
  const efforts = effortChoices(providerInfo, storedModel);
  // Подпись модели: что CLI запустил на деле (лента), иначе выбор из карты подписью каталога.
  const modelLabel = currentModel(items) ?? (storedModel === null ? null : modelCaption(models, storedModel));
  const occupied = useActivityStore((state) => occupation(activityFor(state.byRef, sessionRef)?.activity));
  const busyReason = occupied === 'agent' ? S.chat.choice.agentWorking : occupied === 'background' ? S.chat.choice.backgroundTasks : null;
  // Модель неживой сессии меняется только в карте (хост ответит `restarted: false`), уровень — только у живой: его ставит
  // ползунок самого CLI.
  const modelDisabled = live ? busyReason : null;
  const effortDisabled = live ? busyReason : S.chat.choice.notLive;
  const showChoice = !codex && canSetModel && canSetEffort && (models.length > 0 || efforts !== null);
  // Карточка неживой сессии — то же правило, что у `TerminalSurface`.
  const showCard = useWorksStore((state) => {
    const entry = state.entries.find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId);
    const lifecycle = entry?.map.sessions.find((item) => item.id === sessionRef.sessionId)?.lifecycle;
    return lifecycle === 'sleeping' || lifecycle === 'closed' || lifecycle === 'pending';
  });

  const sessionKey = refKey(sessionRef);
  const entry = useWorksStore((state) => state.entries.find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId));
  const capabilities = useCapabilitiesStore((state) => state.byProject[sessionRef.projectPath]?.capabilities ?? null);
  useEffect(() => {
    useCapabilitiesStore.getState().load(bridge, sessionRef.projectPath, provider);
  }, [bridge, sessionRef.projectPath, provider]);
  // Файлы подсказок — корень сессии, как у «Файлов»: рабочая копия (worktree), иначе проект.
  const filesRoot = useMemo<FileRoot | null>(
    () => (entry === undefined ? null : { workKey, spec: defaultRoot(entry, sessionRef.sessionId) }),
    [entry, workKey, sessionRef.sessionId],
  );
  const listDir = useCallback(
    (dir: string) => (filesRoot === null ? Promise.resolve([]) : bridge.files.list(filesRoot, dir)),
    [bridge, filesRoot],
  );
  const suggestionSource = useMemo<SuggestionSource>(() => ({ capabilities, listDir }), [capabilities, listDir]);
  const [dropping, setDropping] = useState(false);
  const draft = useChatUiStore((state) => state.drafts[sessionKey] ?? '');
  const attachments = useChatUiStore((state) => state.attachments[sessionKey] ?? NO_PATHS);
  const queued = useChatUiStore((state) => state.queued[sessionKey] ?? NO_QUEUED);
  // Просьба показать карточку агента — только про эту сессию (бейдж в сайдбаре и комнате, тулбар); исполняет лента.
  const reveal = useChatUiStore((state) => (state.reveal?.sessionKey === sessionKey ? state.reveal : null));
  const clearReveal = useChatUiStore((state) => state.clearReveal);
  const agents = runningAgents(items);
  useEffect(() => {
    useUiStore.getState().setSessionVisible(sessionKey, visible);
  }, [sessionKey, visible]);
  useEffect(() => () => useUiStore.getState().setSessionVisible(sessionKey, false), [sessionKey]);

  // Настоящий промпт с тем же текстом пришёл — серый элемент уходит.
  useEffect(() => {
    useChatUiStore.getState().updateQueued(sessionKey, (was) => {
      const left = was.filter((entry) => promptCount(items, entry.text) <= entry.seen);
      return left.length === was.length ? was : left;
    });
  }, [items, sessionKey]);

  const submit = (typed: string, paths: readonly string[]): void => {
    const { updateQueued, setDraft, setAttachments } = useChatUiStore.getState();
    const text = codex ? composeRoomMessage(typed, paths) : composePrompt(typed, paths);
    const id = String((nextQueuedId += 1));
    if (active) updateQueued(sessionKey, (was) => [...was, { id, text, seen: promptCount(items, text) }]);
    // Поле очищается сразу, как в любом чате; хост ничего не вставил — набранное вернётся (ниже).
    setDraft(sessionKey, '');
    if (paths.length > 0) setAttachments(sessionKey, []);
    void sendWithToast(sendDeps, sessionRef, text, true, { silentSuccess: true }).then((outcome) => {
      if (!('error' in outcome) && outcome.submitted) return;
      // Отказ или вставка без Enter: в очередь CLI сообщение не попало.
      updateQueued(sessionKey, (was) => (was.some((entry) => entry.id === id) ? was.filter((entry) => entry.id !== id) : was));
      // Вставка без Enter (`draft`, `input`, `blocked-before-enter`, `restarted`) — текст уже в поле ввода терминала.
      if (!('error' in outcome) && outcome.inserted) return;
      // Ничего не вставлено (нет процесса, `blocked`, `busy`, `no-paste-mode`): набранное не должно пропасть. Человек за
      // это время мог начать новое сообщение — его поле не трогаем.
      const now = useChatUiStore.getState();
      if ((now.drafts[sessionKey] ?? '') !== '' || (now.attachments[sessionKey] ?? NO_PATHS).length > 0) return;
      setDraft(sessionKey, typed);
      if (paths.length > 0) setAttachments(sessionKey, paths);
    });
  };

  const setMode = (mode: ModeChoice): void => {
    if (modeBusy || !live || mode === feed?.mode) return;
    setModeBusy(true);
    bridge
      .call('sessions.setMode', { ref: sessionRef, mode })
      .then((result) => {
        if (!result.verified) toast(S.chat.mode.openTerminal);
      })
      .catch((error: unknown) => {
        const { code, message } = decodeIpcError(error);
        console.warn('[parley] sessions.setMode', message);
        toast.error(errorText(code, S.errors.actions.switchMode));
      })
      .finally(() => setModeBusy(false));
  };

  // Модель: хост пишет её в карту и, если сессия живая, перезапускает её через resume с флагами из карты (спека 5.8).
  const selectModel = (id: string): void => {
    if (choiceBusy || modelDisabled !== null || id === storedModel) return;
    setChoiceBusy(true);
    bridge
      .call('sessions.setModel', { ref: sessionRef, model: id })
      .then((result) => {
        // Уровня из карты у новой модели нет — хост вернул «Default»; человек выбирал уровень сам и должен об этом узнать.
        if (storedEffort !== null && result.effort === null) {
          const level = efforts?.find((option) => option.id === storedEffort)?.label ?? storedEffort;
          toast(S.chat.choice.effortReset(modelCaption(models, id), level));
        }
      })
      .catch((error: unknown) => choiceFailed('sessions.setModel', S.errors.actions.switchModel, error))
      .finally(() => setChoiceBusy(false));
  };

  // Уровень: хост ставит его ползунком `/effort` с клавишей `s` — «только для этой сессии» — и сверяет подвал (спека 5.7).
  const selectEffort = (id: string): void => {
    if (choiceBusy || effortDisabled !== null || id === storedEffort) return;
    setChoiceBusy(true);
    bridge
      .call('sessions.setEffort', { ref: sessionRef, effort: id })
      .then((result) => {
        if (!result.verified) toast(S.chat.choice.openTerminal);
      })
      .catch((error: unknown) => choiceFailed('sessions.setEffort', S.errors.actions.switchEffort, error))
      .finally(() => setChoiceBusy(false));
  };

  // Скриншот из буфера → drops/ (main) → путь; отказы — теми же тостами, что у терминала.
  const pasteImage = useCallback(async (): Promise<string | null> => {
    try {
      return await bridge.app.saveDropImage('clipboard');
    } catch (error) {
      const { code, message } = decodeIpcError(error);
      console.warn('[parley] saveDropImage', message);
      toast.error(code === 'drops:too-large' ? S.terminal.imageTooLarge : errorText(code, S.errors.actions.saveScreenshot));
      return null;
    }
  }, [bridge]);
  const pickFiles = useCallback(async (): Promise<string[]> => {
    try {
      return await bridge.app.chooseFiles();
    } catch (error) {
      console.warn('[parley] chooseFiles', decodeIpcError(error).message);
      return [];
    }
  }, [bridge]);

  // Файлы из Finder на весь вид: подсветка, затем пути вложениями над полем ввода.
  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    setDropping(false);
    if (!dragHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    // Пустой путь — у `File` нет места на диске (синтетический): пропускаем.
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => bridge.app.pathForFile(file))
      .filter((path) => path !== '');
    useChatUiStore.getState().setAttachments(sessionKey, addAttachments(attachments, paths));
  };

  // Агент работает, а видимого признака в ленте нет: последний элемент не пишущийся текст и нет карточки.
  const lastItem = items.at(-1);
  const showWorking = active && !(lastItem?.kind === 'text' && lastItem.streaming) && !hasPendingCard(items);
  const turnStart = items.findLast((item) => item.kind === 'prompt')?.at ?? null;

  // Stop — метод хоста: он шлёт Esc и сам закрывает ход, который CLI бросил без записи (ответа ещё не было),
  // стирая возвращённый в поле терминала текст промпта. Хост без метода — прежний Esc в терминал.
  const stop = (): void => {
    if (!canInterrupt) {
      bridge.notify('pty.input', { ref: sessionRef, data: '\x1b' });
      return;
    }
    bridge.call('feed.interrupt', { ref: sessionRef }).catch((error: unknown) => {
      console.warn('[parley] feed.interrupt', decodeIpcError(error).message);
    });
  };
  // К первой работающей карточке; у только что созданной (`SubagentStart` ещё не пришёл) `agentId` нет — прокручивать не к чему.
  const showAgent = (): void => {
    const agentId = agents.map((agent) => agent.agentId).find((id): id is string => id !== null) ?? null;
    openAgentsPanel(sessionKey, agentId);
  };
  const env = useMemo<ChatEnv>(() => ({ bridge, sessionRef, workKey, tabId: tab.id }), [bridge, sessionKey, workKey, tab.id]);

  return (
    <ChatEnvContext.Provider value={env}>
      <div
        data-testid="chat-view"
        {...(dropping ? { 'data-dropping': '' } : {})}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', dropping && 'ring-2 ring-inset ring-ring')}
      >
        <ChatToolbar
          workKey={workKey}
          tabId={tab.id}
          view="chat"
          available
          provider={provider}
          model={codex && modelLabel !== null && storedEffort !== null ? `${modelLabel} · ${storedEffort}` : modelLabel}
          {...(codex && feed?.mode != null ? { modeLabelText: modeLabel(feed.mode) } : {})}
          {...(canSetMode && !codex ? { modeMenu: { mode: feed?.mode ?? null, busy: modeBusy || !live, onSelect: setMode } } : {})}
          {...(showChoice
            ? {
                choiceMenu: {
                  models,
                  model: storedModel,
                  modelLabel: modelLabel ?? S.chat.choice.default,
                  efforts,
                  effort: storedEffort,
                  modelDisabled,
                  effortDisabled,
                  busy: choiceBusy,
                  onSelectModel: selectModel,
                  onSelectEffort: selectEffort,
                },
              }
            : {})}
          {...(agents.length > 0 ? { agents: { running: agents.length, onShow: showAgent } } : {})}
        />
        <FeedList
          items={items}
          queued={queued}
          note={noteOf(feed)}
          {...(feed?.status === 'error' ? { onRetry: () => useFeedStore.getState().retry(sessionRef) } : {})}
          {...(showWorking ? { working: { since: turnStart } } : {})}
          {...(reveal === null ? {} : { reveal, onRevealed: clearReveal })}
        />
        {showCard ? <NotRunningCard sessionRef={sessionRef} onResume={() => resumeSession(bridge, sessionRef)} /> : null}
        {showBanner ? <WaitingBanner workKey={workKey} tabId={tab.id} /> : null}
        <Composer
          source={suggestionSource}
          slashCommands={!codex}
          codex={codex}
          onPickFiles={pickFiles}
          onPasteImage={pasteImage}
          dictationId={`chat:${sessionKey}`}
          bridge={bridge}
          busy={active}
          visible={visible}
          text={draft}
          onTextChange={(text) => useChatUiStore.getState().setDraft(sessionKey, text)}
          attachments={attachments}
          onAttachmentsChange={(next) => useChatUiStore.getState().setAttachments(sessionKey, next)}
          onSubmit={submit}
          {...(active ? { onStop: stop } : {})}
        />
      </div>
    </ChatEnvContext.Provider>
  );
}
