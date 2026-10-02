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
 * пока не придёт промпт с тем же текстом, или до отказа отправки. «Stop» — Esc агенту (`pty.input`).
 * Тоста «Sent to S01» в чате нет — отправленное видно в самой ленте; отказы и их тосты прежние.
 * Черновик и серые элементы живут в `ui-store.ts` по сессии и переживают смену вида и вкладки.
 *
 * Меню режима в тулбаре (кусок 4a, решения К и Л): подпись — `mode` ленты, выбор — `sessions.setMode`;
 * пока запрос в пути или сессия не живая (хост ответил бы `not_found`), меню выключено; `verified: false` — тост «откройте терминал». Баннер «ждёт в
 * терминале» (решение Н) — когда активность сессии `blocked`, а карточки `pending` в ленте нет (диалог
 * без хука) и так держится 300 мс подряд; с карточкой ждёт человека сама карточка.
 *
 * Ход считается только у живой сессии (`live`: lifecycle `active`): у уснувшей или закрытой Stop и
 * Queue не показываются, даже если лента кончилась промптом без конца хода.
 */

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { FeedItem } from '@parley/core';
import { refKey, type ModelOption, type SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import type { TerminalTab } from '../lib/feed-view.js';
import { useHostSupports } from '../lib/capabilities.js';
import { activityFor, useActivityStore } from '../store/activity.js';
import { useProvidersStore } from '../store/providers.js';
import { useUiStore } from '../store/ui.js';
import { useWorksStore } from '../store/works.js';
import { NotRunningCard } from '../terminal/NotRunningCard.js';
import { resumeSession, sendWithToast, type SendWithToastDeps } from '../terminal/send.js';
import { ChatEnvContext, type ChatEnv } from './chat-env.js';
import { ChatToolbar, type ModeChoice } from './ChatToolbar.js';
import { Composer } from './Composer.js';
import { currentModel, hasPendingCard, turnActive } from './feed-model.js';
import { FeedList } from './FeedList.js';
import { useFeedStore, type FeedEntry } from './store.js';
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
  /** Провайдер сессии: по нему берётся список моделей для меню. */
  provider: string;
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

export function ChatView({ workKey, tab, sessionRef, visible, live, bridge, sendDeps, provider }: ChatViewProps): JSX.Element {
  const feed = useFeed(sessionRef);
  const items = feed?.items ?? NO_ITEMS;
  const active = live && turnActive(items);
  const model = currentModel(items);
  const blocked = useActivityStore((state) => activityFor(state.byRef, sessionRef)?.activity.activity === 'blocked');
  const waiting = blocked && !hasPendingCard(items);
  const showBanner = useHeldFor(waiting, BANNER_DELAY_MS);
  const canSetMode = useHostSupports('sessions.setMode');
  const [modeBusy, setModeBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const modelOptions = useProvidersStore((state) => state.providers.find((item) => item.id === provider)?.models) ?? NO_MODELS;
  // Карточка неживой сессии — то же правило, что у `TerminalSurface`.
  const showCard = useWorksStore((state) => {
    const entry = state.entries.find((item) => item.projectPath === sessionRef.projectPath && item.map.work.id === sessionRef.workId);
    const lifecycle = entry?.map.sessions.find((item) => item.id === sessionRef.sessionId)?.lifecycle;
    return lifecycle === 'sleeping' || lifecycle === 'closed' || lifecycle === 'pending';
  });

  const sessionKey = refKey(sessionRef);
  const draft = useChatUiStore((state) => state.drafts[sessionKey] ?? '');
  const queued = useChatUiStore((state) => state.queued[sessionKey] ?? NO_QUEUED);
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

  const submit = (text: string): void => {
    const { updateQueued } = useChatUiStore.getState();
    const id = String((nextQueuedId += 1));
    if (active) updateQueued(sessionKey, (was) => [...was, { id, text, seen: promptCount(items, text) }]);
    void sendWithToast(sendDeps, sessionRef, text, true, { silentSuccess: true }).then((outcome) => {
      if (!('error' in outcome) && outcome.submitted) return;
      // Отказ или вставка без Enter: в очередь CLI сообщение не попало.
      updateQueued(sessionKey, (was) => (was.some((entry) => entry.id === id) ? was.filter((entry) => entry.id !== id) : was));
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

  const selectModel = (id: string): void => {
    if (modelBusy || !live) return;
    setModelBusy(true);
    void sendWithToast(sendDeps, sessionRef, `/model ${id}`, true, { silentSuccess: true }).finally(() => setModelBusy(false));
  };

  // Агент работает, а видимого признака в ленте нет: последний элемент не пишущийся текст и нет карточки.
  const lastItem = items.at(-1);
  const showWorking = active && !(lastItem?.kind === 'text' && lastItem.streaming) && !hasPendingCard(items);
  const turnStart = items.findLast((item) => item.kind === 'prompt')?.at ?? null;

  const stop = (): void => bridge.notify('pty.input', { ref: sessionRef, data: '\x1b' });
  const env = useMemo<ChatEnv>(() => ({ bridge, sessionRef, workKey, tabId: tab.id }), [bridge, sessionKey, workKey, tab.id]);

  return (
    <ChatEnvContext.Provider value={env}>
      <div data-testid="chat-view" className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <ChatToolbar
          workKey={workKey}
          tabId={tab.id}
          view="chat"
          available
          model={model}
          {...(canSetMode ? { modeMenu: { mode: feed?.mode ?? null, busy: modeBusy || !live, onSelect: setMode } } : {})}
          {...(modelOptions.length > 0 ? { modelMenu: { options: modelOptions, busy: modelBusy || !live, onSelect: selectModel } } : {})}
        />
        <FeedList
          items={items}
          queued={queued}
          note={noteOf(feed)}
          {...(feed?.status === 'error' ? { onRetry: () => useFeedStore.getState().retry(sessionRef) } : {})}
          {...(showWorking ? { working: { since: turnStart } } : {})}
        />
        {showCard ? <NotRunningCard sessionRef={sessionRef} onResume={() => resumeSession(bridge, sessionRef)} /> : null}
        {showBanner ? <WaitingBanner workKey={workKey} tabId={tab.id} /> : null}
        <Composer
          busy={active}
          visible={visible}
          text={draft}
          onTextChange={(text) => useChatUiStore.getState().setDraft(sessionKey, text)}
          onSubmit={submit}
          {...(active ? { onStop: stop } : {})}
        />
      </div>
    </ChatEnvContext.Provider>
  );
}
