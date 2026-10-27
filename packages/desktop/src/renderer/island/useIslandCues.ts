/**
 * Проводка сигналов острова (#9 T4, §3.1, §3.6–§3.7): исходы показа (`IslandPresentationOutcome`) из `present()`
 * и свои фронты (начало работы, наведение, открыть и закрыть, фазы помощника, решение с острова) идут в политику
 * (`sound/cues.ts`), а её решение играет граф окна (`sound/graph.ts`). Main и `shell.beep()` не участвуют.
 *
 * - Запросы звучат по «Sound when you're needed» (`islandSound.needs`) и `soundEligible` исхода — его проводка не
 *   переопределяет.
 * - Done звучит, только если `expand === true` и включено «Sound when an agent finishes» (`islandSound.finished`):
 *   тихий Done (`expand: false`) молчит всегда.
 * - Наведение, открыть и закрыть, начало работы — только с «Interface sounds» (`islandSound.ui`).
 * - Фазы помощника (слушает, ошибка) и решение с острова — всегда; молчат только при громкости 0.
 * - Свои сигналы получают свои ключи (`cue:<сигнал>:<n>`), ключей исходов они не повторяют. Повтор ключа исхода
 *   (переподключение, ререндер) молчит.
 *
 * Голос помощника (`speaking`) пока не подключён: B22 передаст `speaker.speaking()`.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { IslandPresentationOutcome, IslandSoundConfig } from '../../shared/island.js';
import { useAssistantStore } from './assistant/store.js';
import { useConsentsStore } from './consents/store.js';
import { useIslandRequests } from './requests.js';
import { createCuePolicy, type CueRequest, type IslandSignal } from './sound/cues.js';
import { islandSound } from './sound/graph.js';

/** Сигнал исхода показа (#9 §3.1): согласие и терминал звучат как разрешение, предложение комнаты — как вопрос. */
export const OUTCOME_SIGNAL: Readonly<Record<IslandPresentationOutcome['kind'], IslandSignal>> = {
  permission: 'permission',
  consent: 'permission',
  'terminal-request': 'permission',
  question: 'question',
  'room-proposal': 'question',
  plan: 'plan',
  done: 'done',
};

/** Звучит ли исход при этих настройках: Done — по `finished` и `expand`, запросы — по `needs` и `soundEligible`. */
export function outcomeEligible(outcome: IslandPresentationOutcome, sound: IslandSoundConfig): boolean {
  return outcome.kind === 'done' ? outcome.expand && sound.finished : sound.needs && outcome.soundEligible;
}

export interface IslandCueInput {
  sound: IslandSoundConfig;
  /** Идёт работа агентов (`model.active`): фронт «нет → да» — `start`. */
  active: boolean;
  /** Курсор над островом (решает main): фронт «нет → да» — `hover`. */
  hovered: boolean;
  /** Звучит голос помощника (§6.4). Пока `() => false`: речь подключает B22. */
  speaking?: () => boolean;
}

export interface IslandCues {
  /** Исходы показа из `present()`: один запрос политики на исход. */
  present(outcomes: readonly IslandPresentationOutcome[]): void;
  /** Человек выдвинул убранный остров (язычок). */
  open(): void;
  /** Человек убрал остров (стрелка ⌃, смахивание). */
  close(): void;
}

const NOT_SPEAKING = (): boolean => false;

export function useIslandCues(input: IslandCueInput): IslandCues {
  const soundRef = useRef(input.sound);
  soundRef.current = input.sound;
  const speakingRef = useRef(input.speaking ?? NOT_SPEAKING);
  speakingRef.current = input.speaking ?? NOT_SPEAKING;
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const cues = useMemo(() => {
    const policy = createCuePolicy({ now: () => Date.now(), speaking: () => speakingRef.current() });
    let seq = 0;
    const decide = (requests: CueRequest[]): void => {
      if (requests.length === 0) return;
      policy.decide(requests).forEach((decision, index) => {
        if (decision.verdict !== 'play') return;
        const signal = requests[index]!.signal;
        const play = (): void => {
          if (decision.duckVoice) islandSound.duckVoice();
          islandSound.play(signal, { quiet: decision.gainDb < 0 });
        };
        if (decision.delayMs <= 0) {
          play();
          return;
        }
        const timer = setTimeout(() => {
          timers.current.delete(timer);
          play();
        }, decision.delayMs);
        timers.current.add(timer);
      });
    };
    /** Свой сигнал острова: новый ключ на каждое событие. */
    const own = (signal: IslandSignal, eligible: boolean): void => {
      seq += 1;
      decide([{ signal, key: `cue:${signal}:${seq}`, eligible }]);
    };
    return {
      own,
      present: (outcomes: readonly IslandPresentationOutcome[]): void =>
        decide(outcomes.map((outcome) => ({ signal: OUTCOME_SIGNAL[outcome.kind], key: outcome.key, eligible: outcomeEligible(outcome, soundRef.current) }))),
      open: (): void => own('open', soundRef.current.ui),
      close: (): void => own('close', soundRef.current.ui),
    };
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  // Громкость и палитра — в граф окна. Возврат громкости из 0 граф подтверждает тихим `unmute`.
  useEffect(() => islandSound.setVolume(input.sound.volume), [input.sound.volume]);
  useEffect(() => islandSound.setPalette(input.sound.palette), [input.sound.palette]);

  // Фронты «нет → да»: значение при монтировании — база, а не событие.
  const active = useRef(input.active);
  useEffect(() => {
    if (input.active && !active.current) cues.own('start', soundRef.current.ui);
    active.current = input.active;
  }, [input.active, cues]);
  const hovered = useRef(input.hovered);
  useEffect(() => {
    if (input.hovered && !hovered.current) cues.own('hover', soundRef.current.ui);
    hovered.current = input.hovered;
  }, [input.hovered, cues]);

  // Фазы помощника: начал и кончил слушать, ошибка.
  useEffect(
    () =>
      useAssistantStore.subscribe((state, prev) => {
        if (state.input === 'listening' && prev.input !== 'listening') cues.own('listen-start', true);
        if (state.input !== 'listening' && prev.input === 'listening') cues.own('listen-end', true);
        if (state.host.phase === 'error' && prev.host.phase !== 'error') cues.own('error', true);
      }),
    [cues],
  );
  // Решение с острова применено. Запрос ленты при `applied` уходит из очереди, пока решается (`deciding`); карточка
  // согласия получает пометку `done`.
  useEffect(() => {
    const offRequests = useIslandRequests.subscribe((state, prev) => {
      if (prev.items.some((item) => item.deciding && !state.items.some((next) => next.key === item.key))) cues.own('decide', true);
    });
    const offConsents = useConsentsStore.subscribe((state, prev) => {
      if (state.note === 'done' && prev.note !== 'done') cues.own('decide', true);
    });
    return () => {
      offRequests();
      offConsents();
    };
  }, [cues]);

  return useMemo(() => ({ present: cues.present, open: cues.open, close: cues.close }), [cues]);
}
