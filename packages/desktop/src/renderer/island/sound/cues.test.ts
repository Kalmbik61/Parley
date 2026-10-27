/**
 * Политика сигналов острова (#9 §3.5, §6.4): ключи, остывание и слияние, зазор 90/400 мс, бюджет Done, приоритет,
 * правила под речью и счётчик `__parleyIslandCues`. Часы поддельные: время передаётся числом.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  CUE_COOLDOWN_MS,
  CUE_GAP_MS,
  CUE_MAX_WAIT_MS,
  DONE_BUDGET,
  DONE_BUDGET_MS,
  EMPTY_CUE_HISTORY,
  createCuePolicy,
  decideCues,
  type CueDecision,
  type CueHistory,
  type CueRequest,
  type IslandSignal,
} from './cues.js';

let seq = 0;
/** Сигнал с новым ключом; `eligible` по умолчанию true. */
function cue(signal: IslandSignal, extra: Partial<CueRequest> = {}): CueRequest {
  seq += 1;
  return { signal, key: `${signal}:${seq}`, eligible: true, ...extra };
}

/** Прогон сигналов по одному на поддельных часах: `[время, сигнал]` → решения по порядку. */
function run(steps: Array<[number, CueRequest]>, speaking = false): CueDecision[] {
  let history: CueHistory = EMPTY_CUE_HISTORY;
  const out: CueDecision[] = [];
  for (const [now, request] of steps) {
    const next = decideCues(history, [request], { now, speaking });
    history = next.history;
    out.push(...next.decisions);
  }
  return out;
}

const verdicts = (decisions: CueDecision[]): string[] => decisions.map((d) => d.verdict);

describe('decideCues: S3, пачки', () => {
  it('пять Done за 300 мс — один звук, четыре сливаются; разрешение через 340 мс звучит', () => {
    const decisions = run([
      [0, cue('done')],
      [75, cue('done')],
      [150, cue('done')],
      [225, cue('done')],
      [300, cue('done')],
      [340, cue('permission')],
    ]);
    expect(verdicts(decisions)).toEqual(['play', 'merge', 'merge', 'merge', 'merge', 'play']);
    expect(decisions.slice(1, 5).map((d) => (d.verdict === 'merge' ? d.merged : 0))).toEqual([1, 2, 3, 4]);
    expect(decisions[5]).toMatchObject({ verdict: 'play', delayMs: 0 });
  });

  it('четвёртый Done за 10 с молчит, после окна бюджета звучит снова', () => {
    const decisions = run([
      [0, cue('done')],
      [2_000, cue('done')],
      [4_000, cue('done')],
      [6_000, cue('done')],
      [DONE_BUDGET_MS, cue('done')],
    ]);
    expect(DONE_BUDGET).toBe(3);
    expect(DONE_BUDGET_MS).toBe(10_000);
    expect(verdicts(decisions)).toEqual(['play', 'play', 'play', 'skip', 'play']);
    expect(decisions[3]).toMatchObject({ verdict: 'skip', reason: 'budget' });
  });

  it('запросы и ошибки бюджетом не ограничены', () => {
    const decisions = run([
      [0, cue('error')],
      [2_000, cue('error')],
      [4_000, cue('error')],
      [6_000, cue('error')],
      [0 + 7_000, cue('permission')],
      [8_200, cue('permission')],
      [9_400, cue('permission')],
      [9_900, cue('question')],
    ]);
    expect(verdicts(decisions)).toEqual(Array(8).fill('play'));
  });
});

describe('decideCues: ключи', () => {
  it('повтор ключа молчит и через любое время', () => {
    const first = cue('permission');
    const decisions = run([
      [0, first],
      [60_000, { ...first }],
    ]);
    expect(verdicts(decisions)).toEqual(['play', 'skip']);
    expect(decisions[1]).toMatchObject({ reason: 'repeat' });
  });

  it('ключ занимает и тихий сигнал: позже тот же ключ не звучит', () => {
    const quiet = cue('done', { eligible: false });
    const decisions = run([
      [0, quiet],
      [5_000, { ...quiet, eligible: true }],
    ]);
    expect(decisions.map((d) => (d.verdict === 'skip' ? d.reason : d.verdict))).toEqual(['ineligible', 'repeat']);
  });

  it('тихий сигнал не трогает остывание и бюджет', () => {
    const decisions = run([
      [0, cue('done', { eligible: false })],
      [10, cue('done')],
    ]);
    expect(verdicts(decisions)).toEqual(['skip', 'play']);
  });
});

describe('decideCues: остывание по виду', () => {
  const table: Array<[IslandSignal, number]> = [
    ['done', 2_000],
    ['permission', 1_200],
    ['question', 1_200],
    ['plan', 1_200],
    ['error', 2_000],
    ['start', 3_000],
    ['hover', 600],
  ];

  it.each(table)('%s: %i мс', (signal, ms) => {
    expect(CUE_COOLDOWN_MS[signal]).toBe(ms);
    const decisions = run([
      [0, cue(signal)],
      [ms - 1, cue(signal)],
      [ms, cue(signal)],
    ]);
    expect(verdicts(decisions)).toEqual(['play', 'merge', 'play']);
  });

  it('у остальных сигналов остывания нет: держит только зазор', () => {
    const decisions = run([
      [0, cue('decide')],
      [CUE_GAP_MS, cue('decide')],
    ]);
    expect(verdicts(decisions)).toEqual(['play', 'play']);
  });

  it('остывание у каждого вида своё', () => {
    const decisions = run([
      [0, cue('permission')],
      [100, cue('question')],
      [200, cue('plan')],
    ]);
    expect(verdicts(decisions)).toEqual(['play', 'play', 'play']);
  });

  it('счёт слияний начинается заново после следующего звука', () => {
    const decisions = run([
      [0, cue('hover')],
      [100, cue('hover')],
      [600, cue('hover')],
      [700, cue('hover')],
    ]);
    expect(decisions[3]).toMatchObject({ verdict: 'merge', merged: 1 });
  });
});

describe('decideCues: зазор 90/400 мс', () => {
  it('соседние сигналы не ближе 90 мс; ждать дольше 400 мс — не звучит', () => {
    const now = 1_000;
    const { decisions } = decideCues(
      EMPTY_CUE_HISTORY,
      [cue('error'), cue('permission'), cue('question'), cue('plan'), cue('done'), cue('decide')],
      { now, speaking: false },
    );
    expect(CUE_GAP_MS).toBe(90);
    expect(CUE_MAX_WAIT_MS).toBe(400);
    expect(decisions.map((d) => (d.verdict === 'play' ? d.delayMs : d.verdict))).toEqual([0, 90, 180, 270, 360, 'skip']);
    expect(decisions[5]).toMatchObject({ reason: 'busy' });
  });

  it('сигнал, который не дождался очереди, не тратит остывание', () => {
    const decisions = run([
      [0, cue('error')],
      [0, cue('permission')],
      [0, cue('question')],
      [0, cue('plan')],
      [0, cue('done')],
      [0, cue('start')],
      [500, cue('start')],
    ]);
    expect(decisions[5]).toMatchObject({ verdict: 'skip', reason: 'busy' });
    expect(decisions[6]).toMatchObject({ verdict: 'play', delayMs: 0 });
  });

  it('зазор отсчитывается от запланированного, а не от вызова', () => {
    const decisions = run([
      [0, cue('decide')],
      [50, cue('speak')],
      [100, cue('listen-start')],
    ]);
    expect(decisions.map((d) => (d.verdict === 'play' ? d.delayMs : -1))).toEqual([0, 40, 80]);
  });
});

describe('decideCues: приоритет', () => {
  it('в одной пачке важный сигнал идёт первым, решения — в порядке входа', () => {
    const { decisions } = decideCues(EMPTY_CUE_HISTORY, [cue('hover'), cue('done'), cue('error')], {
      now: 0,
      speaking: false,
    });
    expect(decisions.map((d) => (d.verdict === 'play' ? d.delayMs : -1))).toEqual([180, 90, 0]);
  });

  it('важный сигнал не ждёт менее важного', () => {
    const decisions = run([
      [0, cue('decide')],
      [0, cue('speak')],
      [10, cue('permission')],
      [20, cue('error')],
    ]);
    // разрешение не ждёт `speak`, ошибка не ждёт разрешения
    expect(decisions.map((d) => (d.verdict === 'play' ? d.delayMs : -1))).toEqual([0, 90, 0, 0]);
  });

  it('менее важный ждёт более важного', () => {
    const decisions = run([
      [0, cue('error')],
      [10, cue('hover')],
    ]);
    expect(decisions[1]).toMatchObject({ verdict: 'play', delayMs: 80 });
  });
});

describe('decideCues: V2, правила под речью', () => {
  const speakingRun = (signal: IslandSignal): CueDecision => run([[0, cue(signal)]], true)[0] as CueDecision;

  it.each<IslandSignal>(['hover', 'open', 'close', 'unmute'])('микро и интерфейс молчат: %s', (signal) => {
    expect(speakingRun(signal)).toMatchObject({ verdict: 'skip', reason: 'speech' });
  });

  it.each<IslandSignal>(['start', 'done', 'decide', 'listen-start', 'listen-end', 'speak'])(
    'работа и итог на 10 дБ тише, голос не приглушают: %s',
    (signal) => {
      expect(speakingRun(signal)).toMatchObject({ verdict: 'play', gainDb: -10, duckVoice: false });
    },
  );

  it.each<IslandSignal>(['permission', 'question', 'plan', 'error'])(
    'внимание в полную силу и приглушает голос: %s',
    (signal) => {
      expect(speakingRun(signal)).toMatchObject({ verdict: 'play', gainDb: 0, duckVoice: true });
    },
  );

  it.each<IslandSignal>(['hover', 'start', 'done', 'permission', 'error'])('без речи — полная сила, голос не трогают: %s', (signal) => {
    expect(run([[0, cue(signal)]])[0]).toMatchObject({ verdict: 'play', gainDb: 0, duckVoice: false });
  });

  it('под речью ограничения §3.5 действуют как обычно', () => {
    const decisions = run(
      [
        [0, cue('done')],
        [100, cue('done')],
      ],
      true,
    );
    expect(verdicts(decisions)).toEqual(['play', 'merge']);
  });
});

describe('decideCues: чистота', () => {
  it('не меняет переданную историю', () => {
    const before = decideCues(EMPTY_CUE_HISTORY, [cue('done')], { now: 0, speaking: false }).history;
    const snapshot = JSON.stringify(before);
    decideCues(before, [cue('done'), cue('permission')], { now: 3_000, speaking: false });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(EMPTY_CUE_HISTORY.keys).toEqual([]);
  });

  it('одна история и одно время — одно решение', () => {
    const request = cue('plan');
    const a = decideCues(EMPTY_CUE_HISTORY, [request], { now: 500, speaking: true });
    const b = decideCues(EMPTY_CUE_HISTORY, [request], { now: 500, speaking: true });
    expect(a).toEqual(b);
  });
});

describe('createCuePolicy', () => {
  const counter = (): Record<string, Record<string, number>> | undefined =>
    (globalThis as { __parleyIslandCues?: Record<string, Record<string, number>> }).__parleyIslandCues;

  beforeEach(() => {
    (globalThis as { __parleyIslandCues?: unknown }).__parleyIslandCues = undefined;
  });

  it('держит историю между вызовами по своим часам и речи', () => {
    let now = 10_000;
    let speaking = false;
    const policy = createCuePolicy({ now: () => now, speaking: () => speaking });
    expect(policy.decide([cue('done')])).toMatchObject([{ verdict: 'play' }]);
    now += 300;
    expect(policy.decide([cue('done')])).toMatchObject([{ verdict: 'merge', merged: 1 }]);
    speaking = true;
    now += 40;
    expect(policy.decide([cue('permission')])).toMatchObject([{ verdict: 'play', duckVoice: true }]);
  });

  it('каждое решение попадает в globalThis.__parleyIslandCues — это читает E2E', () => {
    let now = 0;
    const policy = createCuePolicy({ now: () => now, speaking: () => false });
    const repeated = cue('permission');
    for (let i = 0; i < 5; i += 1) {
      policy.decide([cue('done')]);
      now += 75;
    }
    now = 340;
    policy.decide([repeated]);
    policy.decide([{ ...repeated }]);
    expect(counter()).toEqual({
      done: { play: 1, merge: 4, skip: 0 },
      permission: { play: 1, merge: 0, skip: 1 },
    });
  });
});
