/**
 * Хук голосового экрана (план T3/T4b): контроллер Live + `reduceVoice` + AppState + карточки + текстовые jobs.
 * Проводка без решений: правила живут в `screen-model.ts`, `cards-model.ts`, `voice-model.ts` и контроллере.
 * Голос карточку не решает: `decide` вызывает только кнопка на экране.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { useIsFocused } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import { selectVoiceCapability } from '@parley/remote-client';
import type { CardDecideResult } from '@parley/protocol';
import type { PhoneCard, PhoneJob, VoiceMethodResults, VoiceUsage } from '@parley/protocol/remote';
import { confirmWithOwner } from '../auth/confirm-owner';
import { useCovered } from '../auth/use-covered';
import { useCloseOnLock } from '../auth/use-lock-sheet';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';
import {
  applyCardChanged,
  canDecide,
  cardsFromSnapshot,
  currentCard,
  decideCard,
  dropCard,
  sheetVisible,
  sheetWaiting,
  sheetMode as sheetModeOf,
  type CardChoice,
  type SheetMode,
  type CardOutcome,
} from './cards-model';
import { createLiveController, type LiveController, type LiveFailure, type LiveSnapshot } from './live-controller';
import { createPeer, openMic, type MutableMic } from './live-peer';
import {
  appStateEffects,
  chooseFallback,
  decideResult,
  keyForText,
  latestJob,
  needsReset,
  progressLine,
  resultText,
  textJobKey,
  type FallbackView,
} from './screen-model';
import { INITIAL_VOICE, orbStateOf, reduceVoice, type OrbView, type VoiceModel } from './voice-model';

export interface LiveVoice {
  voice: VoiceModel;
  orb: OrbView;
  muted: boolean;
  /** Текст под сферой: сообщение об ошибке, если шаблона R15 нет. */
  errorText: string | null;
  fallback: FallbackView | null;
  progress: string | null;
  /** Итог текстового запроса (показан один раз). */
  result: string | null;
  card: PhoneCard | null;
  /** Лист карточки открыт (приложение не под замком, вкладка в фокусе, карточку не отложили). */
  sheetOpen: boolean;
  /** Карточка отложена: на экране значок, по нему лист открывается снова. */
  cardWaiting: boolean;
  sheetMode: SheetMode;
  cardBusy: boolean;
  notice: string | null;
  sending: boolean;
  start(): void;
  stop(): void;
  toggleMute(): void;
  submitText(text: string): Promise<boolean>;
  decide(choice: CardChoice): void;
  /** «Later»: свернуть лист, карточка остаётся в списке. */
  later(): void;
  reopenCard(): void;
  /** «Try again» в шаблоне R15. */
  retry(): void;
}

const PHRASES = { detailsOnScreen: 'Details are on screen.', clarifying: 'Clarifying.' };

export function useLiveVoice(): LiveVoice {
  const { supervisor } = useRuntimeState();
  const reachable = supervisor?.state === 'ready';
  const methods = supervisor?.hello?.methods ?? null;
  const canUseVoice = selectVoiceCapability({ methods }).canUseVoice;
  const canListCards = methods?.includes('cards.list') ?? false;

  const [voice, dispatch] = useReducer(reduceVoice, INITIAL_VOICE);
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [muted, setMuted] = useState(false);
  const [failure, setFailure] = useState<LiveFailure | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [usage, setUsage] = useState<VoiceUsage | null>(null);
  const [textJob, setTextJob] = useState<PhoneJob | 'submitting' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [cards, setCards] = useState<PhoneCard[]>([]);
  const [cardBusy, setCardBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const micRef = useRef<MutableMic | null>(null);
  const mutedRef = useRef(false);
  const shownRef = useRef(new Set<string>());
  const textJobIdRef = useRef<string | null>(null);

  // m6: контроллер создаётся в эффекте и освобождается его cleanup: повторный mount (StrictMode, Fast Refresh) получает новый.
  const [controller, setController] = useState<LiveController | null>(null);
  useEffect(() => {
    const created = createLiveController({
      call: (method, params) => runtime.call(method, params) as never,
      onHostEvent: (event, listener) => runtime.onHostEvent((name, data) => (name === event ? listener(data as never) : undefined)),
      openMic: async () => {
        const mic = await openMic();
        micRef.current = mic;
        mic.setEnabled(!mutedRef.current);
        return mic;
      },
      createPeer,
      now: () => Date.now(),
      setTimer: (callback, ms) => {
        const handle = setTimeout(callback, ms);
        return () => clearTimeout(handle);
      },
      setTick: (callback, ms) => {
        const handle = setInterval(callback, ms);
        return () => clearInterval(handle);
      },
      phrases: PHRASES,
      fallbackText: '(not transcribed)',
    });
    const offEvents = created.subscribe(dispatch);
    const offChange = created.onChange(() => setSnapshot(created.snapshot()));
    setController(created);
    // Экран уходит: `dispose` закрывает сессию на хосте и освобождает микрофон; jobs продолжаются.
    return () => {
      offEvents();
      offChange();
      created.dispose();
      setController(null);
    };
  }, []);

  // Фон: сессия закрыта и микрофон выключен; передний план отражается в контроллере (подтверждения только на экране).
  useEffect(() => {
    if (controller === null) return undefined;
    const apply = (state: string): void => {
      const effects = appStateEffects(state);
      setForeground(effects.foreground);
      controller.setForeground(effects.foreground);
      if (effects.stop) void controller.stop();
    };
    apply(AppState.currentState ?? 'active');
    const sub = AppState.addEventListener('change', apply);
    return () => sub.remove();
  }, [controller]);

  // Mac пропал или вернулся. Возврат Mac и возврат приложения на экран стирают прошлый отказ (M5).
  const resetFailure = useCallback(() => {
    setFailure(null);
    setErrorText(null);
  }, []);
  useEffect(() => {
    dispatch({ type: reachable ? 'macBack' : 'macLost' });
    if (reachable) resetFailure();
  }, [reachable, resetFailure]);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  useEffect(() => {
    if (!foreground) return;
    resetFailure();
    if (needsReset(voiceRef.current)) dispatch({ type: 'stop' });
  }, [foreground, resetFailure]);

  // Лимит: пока показан шаблон, остаток перечитывается; положительный остаток возвращает модель в idle.
  useEffect(() => {
    if (voice.state !== 'limit_reached' || !reachable) return;
    let live = true;
    setUsage(null);
    runtime
      .call('voice.usage.get', {})
      .then((u) => {
        if (!live) return;
        const next = u as VoiceUsage;
        setUsage(next);
        if (next.remainingSeconds > 0) {
          resetFailure();
          dispatch({ type: 'stop' });
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [voice.state, reachable, resetFailure]);

  // Карточки: снимок при подключении и переподключении, затем `cards.changed`. События, пришедшие во время запроса, не теряются.
  useEffect(() => {
    if (!reachable || !canListCards) {
      setCards([]);
      return;
    }
    let live = true;
    let loading = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const buffered: PhoneCard[] = [];
    const off = runtime.onHostEvent((event, data) => {
      if (event !== 'cards.changed') return;
      const card = (data as { card?: PhoneCard } | null)?.card;
      if (card === undefined || !live) return;
      if (loading) buffered.push(card);
      else setCards((list) => applyCardChanged(list, card));
    });
    // m4: сбой `cards.list` не теряет буфер событий (они применяются к пустому списку) и повторяется один раз.
    const load = (retryLeft: boolean): void => {
      loading = true;
      runtime
        .call('cards.list', {})
        .then((res) => {
          if (!live) return;
          const list = (res as { cards?: PhoneCard[] }).cards ?? [];
          setCards(buffered.splice(0).reduce(applyCardChanged, cardsFromSnapshot(list)));
          loading = false;
        })
        .catch(() => {
          if (!live) return;
          setCards((list) => buffered.splice(0).reduce(applyCardChanged, list));
          loading = false;
          if (retryLeft) retryTimer = setTimeout(() => load(false), 5000);
        });
    };
    load(true);
    return () => {
      live = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      off();
    };
  }, [reachable, canListCards]);

  // Текстовый job этого экрана: следим по `jobs.changed`.
  useEffect(
    () =>
      runtime.onHostEvent((event, data) => {
        if (event !== 'jobs.changed') return;
        const job = (data as { job?: PhoneJob } | null)?.job;
        if (job === undefined || job.jobId !== textJobIdRef.current) return;
        setTextJob((prev) => (prev !== null && prev !== 'submitting' && prev.revision > job.revision ? prev : job));
      }),
    [],
  );

  // VO-05: итог показывается один раз при приложении на экране и подтверждается `jobs.ackInline`.
  useEffect(() => {
    if (textJob === null || textJob === 'submitting') return;
    const decision = decideResult(textJob, foreground, shownRef.current);
    if (!decision.show) return;
    shownRef.current.add(textJob.jobId);
    keyRef.current = null;
    setResult(resultText(textJob));
    if (decision.ack) void runtime.call('jobs.ackInline', { jobId: textJob.jobId, revision: textJob.revision }).catch(() => undefined);
  }, [textJob, foreground]);

  const start = useCallback(() => {
    if (controller === null) return;
    setFailure(null);
    setErrorText(null);
    void controller.start().then((res) => {
      if (res.ok) return;
      setFailure(res.code);
      setErrorText(res.message);
    });
  }, [controller]);

  const stop = useCallback(() => {
    void controller?.stop();
  }, [controller]);

  // «Try again»: прошлый отказ стёрт, модель выведена из error/limit_reached, сессия начинается заново.
  const retry = useCallback(() => {
    resetFailure();
    dispatch({ type: 'stop' });
    start();
  }, [resetFailure, start]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    // Mute экрана глушит только микрофон: человек слышит ответ Live, поэтому controller.setMuted (гейт ack) не трогаем.
    micRef.current?.setEnabled(!next);
    dispatch({ type: next ? 'pause' : 'resume' });
  }, []);

  // Новая сессия начинается с открытого микрофона.
  useEffect(() => {
    if (voice.state === 'idle' && mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
    }
  }, [voice.state]);

  const keyRef = useRef<{ text: string; key: string } | null>(null);
  const submitText = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    setResult(null);
    setNotice(null);
    // m5: после сбоя тот же текст уходит с прежним ключом, и хост не создаёт второй job.
    keyRef.current = keyForText(keyRef.current, trimmed, () => textJobKey(Crypto.randomUUID()));
    const idempotencyKey = keyRef.current.key;
    setTextJob('submitting');
    textJobIdRef.current = null;
    try {
      const res = (await runtime.call('jobs.submit', {
        text: trimmed,
        idempotencyKey,
        correlation: { mode: 'text' },
      })) as VoiceMethodResults['jobs.submit'];
      textJobIdRef.current = res.jobId;
      // Событие могло прийти раньше ответа: тогда состояние уже есть, иначе спросим `jobs.get`.
      const got = (await runtime.call('jobs.get', { jobId: res.jobId }).catch(() => null)) as VoiceMethodResults['jobs.get'] | null;
      const fresh = got?.job ?? null;
      if (fresh !== null) setTextJob((prev) => (prev !== null && prev !== 'submitting' && prev.revision > fresh.revision ? prev : fresh));
      return true;
    } catch {
      setTextJob(null);
      setNotice('Could not send. Try again');
      return false;
    }
  }, []);

  const card = currentCard(cards);
  const covered = useCovered();
  const focused = useIsFocused();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [hiddenByLock, setHiddenByLock] = useState(false);
  const sheetCtx = { card, covered: covered || hiddenByLock, focused, dismissed };
  const sheetOpen = sheetVisible(sheetCtx);
  // B1: замок закрывает лист сразу и снимает отметку, когда обложка уходит.
  useCloseOnLock(sheetOpen, () => setHiddenByLock(true));
  useEffect(() => {
    if (!covered) setHiddenByLock(false);
  }, [covered]);
  const later = useCallback(() => {
    if (card !== null) setDismissed((set) => new Set(set).add(card.cardId));
  }, [card]);
  const reopenCard = useCallback(() => {
    if (card !== null) setDismissed((set) => new Set([...set].filter((id) => id !== card.cardId)));
  }, [card]);

  const decide = useCallback(
    (choice: CardChoice) => {
      if (card === null || !canDecide({ card, covered: covered || hiddenByLock, busy: cardBusy })) return;
      setCardBusy(true);
      setNotice(null);
      void decideCard(
        {
          call: (method, params) => runtime.call(method, params) as Promise<CardDecideResult>,
          confirmOwner: (prompt) => confirmWithOwner(LocalAuthentication, prompt),
        },
        card,
        choice,
      )
        .then((outcome: CardOutcome) => {
          if (outcome.kind === 'applied') setCards((list) => dropCard(list, card.cardId));
          else {
            setNotice(outcome.message);
            if (outcome.kind === 'stale') setCards((list) => dropCard(list, card.cardId));
          }
        })
        .finally(() => setCardBusy(false));
    },
    [card, cardBusy, covered, hiddenByLock],
  );

  const job = latestJob([textJob === 'submitting' ? null : textJob, ...(snapshot?.jobs ?? [])]);
  const progress = progressLine(textJob === 'submitting' && job === null ? 'submitting' : job);
  const orb = orbStateOf(voice, job === null ? [] : [{ state: job.state }]);
  const fallback = chooseFallback({ voice, reachable, canUseVoice, failure, remainingSeconds: usage?.remainingSeconds ?? null });

  return { voice, orb, muted, errorText: fallback === null ? errorText : null, fallback, progress, result, card, sheetOpen, cardWaiting: sheetWaiting(sheetCtx), sheetMode: sheetModeOf(methods), cardBusy, notice, sending: textJob === 'submitting', start, stop, toggleMute, submitText, decide, later, reopenCard, retry };
}
