import { describe, expect, it } from 'vitest';
import { ACK_WAIT_MS, createAckTracker } from './ack.js';

function setup(measurable = true) {
  let now = 0;
  const resolved: Array<[string, boolean | 'unknown']> = [];
  const tracker = createAckTracker({ now: () => now, canMeasurePlayback: () => measurable, onResolved: (id, audible) => resolved.push([id, audible]) });
  return { tracker, resolved, at: (ms: number) => void (now = ms) };
}

describe('AckTracker — правило подтверждений', () => {
  it('откладывает append, пока открытая делегация ждёт подтверждения, и отпускает после слышимого', () => {
    const h = setup();
    h.at(1000);
    h.tracker.open('d1');
    h.at(1500);
    expect(h.tracker.canAppend(null, 'result')).toBe(false);
    h.tracker.modelPlaying(true);
    expect(h.tracker.canAppend(null, 'result')).toBe(true);
    expect(h.tracker.result('d1')).toBe(true);
    expect(h.resolved).toEqual([['d1', true]]);
  });

  it('прогресс своей делегации идёт сразу, чужой и итог — нет', () => {
    const h = setup();
    h.tracker.open('d1');
    expect(h.tracker.canAppend('d1', 'progress')).toBe(true);
    expect(h.tracker.canAppend('d2', 'progress')).toBe(false);
    expect(h.tracker.canAppend('d1', 'result')).toBe(false);
  });

  it('подтверждение так и не прозвучало: через 2,5 с ack_audible = false и append идут', () => {
    const h = setup();
    h.tracker.open('d1');
    h.at(ACK_WAIT_MS - 1);
    expect(h.tracker.canAppend(null, 'result')).toBe(false);
    h.at(ACK_WAIT_MS);
    expect(h.tracker.canAppend(null, 'result')).toBe(true);
    expect(h.tracker.result('d1')).toBe(false);
  });

  it('клиент не измеряет воспроизведение: unknown', () => {
    const h = setup(false);
    h.tracker.open('d1');
    h.at(ACK_WAIT_MS);
    expect(h.tracker.result('d1')).toBe('unknown');
  });

  it('модель говорила всё окно без нового включения: unknown', () => {
    const h = setup();
    h.tracker.modelPlaying(true);
    h.at(100);
    h.tracker.open('d1');
    h.at(ACK_WAIT_MS + 100);
    expect(h.tracker.result('d1')).toBe('unknown');
  });

  it('две делегации: каждое включение звука закрывает по одной', () => {
    const h = setup();
    h.tracker.open('d1');
    h.at(300);
    h.tracker.open('d2');
    h.at(600);
    h.tracker.modelPlaying(true);
    expect(h.tracker.awaiting()).toEqual(['d2']);
    h.tracker.modelPlaying(false);
    h.at(1500);
    h.tracker.modelPlaying(true);
    expect(h.tracker.awaiting()).toEqual([]);
    expect(h.resolved).toEqual([['d1', true], ['d2', true]]);
  });
});
