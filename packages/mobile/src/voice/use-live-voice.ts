/**
 * Хук голосового экрана (план T3/T4b): контроллер Live + `reduceVoice` + AppState + карточки + текстовые jobs.
 * Проводка без решений: правила живут в `screen-model.ts`, `cards-model.ts`, `voice-model.ts` и контроллере.
 * Голос карточку не решает: `decide` вызывает только кнопка на экране.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import { selectVoiceCapability } from '@parley/remote-client';
import type { CardDecideResult } from '@parley/protocol';
import type { PhoneCard, PhoneJob, VoiceMethodResults, VoiceUsage } from '@parley/protocol/remote';
import { confirmWithOwner } from '../auth/confirm-owner';
import { runtime } from '../runtime/instance';
import { useRuntimeState } from '../runtime/use-runtime';
import {
  applyCardChanged,
  cardsFromSnapshot,
  currentCard,
  decideCard,
  dropCard,
  type CardChoice,
  type CardOutcome,
} from './cards-model';
import { createLiveController, type LiveController, type LiveFailure, type LiveSnapshot } from './live-controller';
import { createPeer, openMic, type MutableMic } from './live-peer';
import {
  appStateEffects,
  chooseFallback,
  decideResult,
  latestJob,
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
  cardBusy: boolean;
  notice: string | null;
  sending: boolean;
  start(): void;
  stop(): void;
  toggleMute(): void;
  submitText(text: string): Promise<boolean>;
  decide(choice: CardChoice): void;
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

  const controller = useMemo<LiveController>(
    () =>
      createLiveController({
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
      }),
    [],
  );

  useEffect(() => {
    const offEvents = controller.subscribe(dispatch);
    const offChange = controller.onChange(() => setSnapshot(controller.snapshot()));
    return () => {
      offEvents();
      offChange();
    };
  }, [controller]);
  // Экран уходит: сессия закрывается (jobs продолжаются), контроллер освобождается.
  useEffect(
    () => () => {
      void controller.stop();
      controller.dispose();
    },
    [controller],
  );

  // Фон: сессия закрыта и микрофон выключен; передний план отражается в контроллере (подтверждения только на экране).
  useEffect(() => {
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

  // Mac пропал или вернулся.
  useEffect(() => {
    dispatch({ type: reachable ? 'macBack' : 'macLost' });
  }, [reachable]);

  // Карточки: снимок при подключении и переподключении, затем `cards.changed`. События, пришедшие во время запроса, не теряются.
  useEffect(() => {
    if (!reachable || !canListCards) {
      setCards([]);
      return;
    }
    let live = true;
    let loading = true;
    const buffered: PhoneCard[] = [];
    const off = runtime.onHostEvent((event, data) => {
      if (event !== 'cards.changed') return;
      const card = (data as { card?: PhoneCard } | null)?.card;
      if (card === undefined || !live) return;
      if (loading) buffered.push(card);
      else setCards((list) => applyCardChanged(list, card));
    });
    runtime
      .call('cards.list', {})
      .then((res) => {
        if (!live) return;
        const list = (res as { cards?: PhoneCard[] }).cards ?? [];
        setCards(buffered.reduce(applyCardChanged, cardsFromSnapshot(list)));
      })
      .catch(() => undefined)
      .finally(() => {
        loading = false;
      });
    return () => {
      live = false;
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
    setResult(resultText(textJob));
    if (decision.ack) void runtime.call('jobs.ackInline', { jobId: textJob.jobId, revision: textJob.revision }).catch(() => undefined);
  }, [textJob, foreground]);

  const start = useCallback(() => {
    setFailure(null);
    setErrorText(null);
    void controller.start().then((res) => {
      if (res.ok) return;
      setFailure(res.code);
      setErrorText(res.message);
      if (res.code === 'limit_reached') {
        runtime
          .call('voice.usage.get', {})
          .then((u) => setUsage(u as VoiceUsage))
          .catch(() => undefined);
      }
    });
  }, [controller]);

  const stop = useCallback(() => {
    void controller.stop();
  }, [controller]);

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    // Mute экрана глушит только микрофон: человек слышит ответ Live, поэтому controller.setMuted (гейт ack) не трогаем.
    micRef.current?.setEnabled(!next);
    dispatch({ type: next ? 'pause' : 'resume' });
  }, [controller]);

  // Новая сессия начинается с открытого микрофона.
  useEffect(() => {
    if (voice.state === 'idle' && mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
    }
  }, [voice.state]);

  const submitText = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    setResult(null);
    setNotice(null);
    setTextJob('submitting');
    textJobIdRef.current = null;
    try {
      const res = (await runtime.call('jobs.submit', {
        text: trimmed,
        idempotencyKey: textJobKey(Crypto.randomUUID()),
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
  const decide = useCallback(
    (choice: CardChoice) => {
      if (card === null || cardBusy) return;
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
    [card, cardBusy],
  );

  const job = latestJob([textJob === 'submitting' ? null : textJob, ...(snapshot?.jobs ?? [])]);
  const progress = progressLine(textJob === 'submitting' && job === null ? 'submitting' : job);
  const orb = orbStateOf(voice, job === null ? [] : [{ state: job.state }]);
  const fallback = chooseFallback({ voice, reachable, canUseVoice, failure, remainingSeconds: usage?.remainingSeconds ?? null });

  return { voice, orb, muted, errorText: fallback === null ? errorText : null, fallback, progress, result, card, cardBusy, notice, sending: textJob === 'submitting', start, stop, toggleMute, submitText, decide };
}
