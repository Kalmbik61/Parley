import { describe, expect, it } from 'vitest';
import type { CardRow } from './cards.js';
import { outcomeSpeech } from './service-messages.js';

const card = (view: unknown): CardRow => ({ proposalId: 'p1', kind: 'actions', view }) as unknown as CardRow;
const plan = card({ action: 'actions', id: 'p1', steps: [{ line: 'message to S03 Ruslan' }, { line: 'sleep S03 Ruslan' }] });

describe('готовый текст итога действия — человеку, а не модели', () => {
  it('done, partial, not_done, unknown: имена и сделанное, риск повтора словами; без id карточки и команд модели', () => {
    const texts = [
      outcomeSpeech(plan, { status: 'done', effects: ['message to S03 Ruslan', 'sleep S03 Ruslan'], retry: 'unsafe', reason: null }),
      outcomeSpeech(plan, { status: 'partial', effects: ['message to S03 Ruslan'], retry: 'unsafe', reason: 'stopped at step 2 of 2: the session is gone' }),
      outcomeSpeech(plan, { status: 'not_done', effects: [], retry: 'safe', reason: 'Parley restarted before the action started' }),
      outcomeSpeech(plan, { status: 'unknown', effects: ['message to S03 Ruslan'], retry: 'unsafe', reason: 'Parley restarted during step 2 of 2; later steps did not start' }),
    ];
    expect(texts).toEqual([
      'Done: message to S03 Ruslan; sleep S03 Ruslan.',
      'Only part of it was done: message to S03 Ruslan. Stopped at step 2 of 2: the session is gone. Check what is missing before trying again, so nothing happens twice.',
      'Not done: message to S03 Ruslan; sleep S03 Ruslan. Parley restarted before the action started. Nothing was changed, so it is safe to try again.',
      'Not sure whether this went through: message to S03 Ruslan; sleep S03 Ruslan. Done for sure: message to S03 Ruslan. Parley restarted during step 2 of 2; later steps did not start. Check before trying again: it may already have happened.',
    ]);
    for (const text of texts) expect(text).not.toMatch(/\bp1\b|\(action|repeat it|action_status/i);
  });

  it('одиночное письмо: «Done: message to Auth.»; done с причиной называет её', () => {
    const letter = card({ action: 'message', id: 'p1', target: 'Auth', text: 'x' });
    expect(outcomeSpeech(letter, { status: 'done', effects: ['message to Auth'], retry: 'unsafe', reason: null })).toBe('Done: message to Auth.');
    expect(outcomeSpeech(letter, { status: 'done', effects: [], retry: 'unsafe', reason: 'the message to Auth was sent, but it was not written to the sent log: disk full' })).toBe(
      'Done: message to Auth. Note: the message to Auth was sent, but it was not written to the sent log: disk full.',
    );
  });
});
