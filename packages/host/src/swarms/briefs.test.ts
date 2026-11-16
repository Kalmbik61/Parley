import { describe, expect, it } from 'vitest';
import { memberBrief, queenBrief, waveLetter } from './briefs.js';
import type { WaveEntry } from './briefs.js';

const entry = (name: string, sessionId: string, outcome: WaveEntry['outcome'], slice: string | null = null): WaveEntry => ({ name, sessionId, slice, outcome });
const CLOSING =
  "Coverage is the member's own estimate. Check the hand-ins against the objective, then either add members with swarm_add (a drone for a gap, verifiers for the claims) or call report with the combined result and name what stays uncovered.";

describe('waveLetter (спека «видимые дыры», 3.5)', () => {
  it('все участники волны covered: заголовок «all N members», блока Not closed нет', () => {
    const wave = [1, 2, 3, 4].map((n) => entry(`Drone ${n}`, `s-0${n + 1}`, 'covered', `slice ${n}`));
    expect(waveLetter({ swarmId: 'sw-03', wave, earlierNotClosed: 0, left: null })).toBe(
      ['Wave finished in swarm sw-03: all 4 members handed in and declared full coverage.', CLOSING].join('\n'),
    );
  });

  it('смесь исходов: счёт по порядку, только ненулевые; open печатается как did not hand in и считается с missing', () => {
    const wave = [
      entry('Drone 1', 's-411', 'covered', 'core'),
      entry('Drone 2', 's-412', 'partial', 'host/sessions'),
      entry('Drone 3', 's-413', 'covered'),
      entry('Drone 4', 's-414', 'partial', 'desktop'),
      entry('Drone 5', 's-415', 'unstated'),
      entry('Drone 6', 's-416', 'missing', 'mobile'),
      entry('Verifier 1', 's-417', 'failed', 'claims'),
      entry('Verifier 2', 's-418', 'open'),
    ];
    expect(waveLetter({ swarmId: 'sw-03', wave, earlierNotClosed: 0, left: null })).toBe([
      'Wave finished in swarm sw-03: 8 members — 2 covered, 2 partial, 1 coverage not stated, 1 reported failure, 2 did not hand in.',
      'Not closed:',
      '- Drone 2 (s-412) "host/sessions": partial',
      '- Drone 4 (s-414) "desktop": partial',
      '- Drone 5 (s-415): coverage not stated',
      '- Drone 6 (s-416) "mobile": did not hand in',
      '- Verifier 1 (s-417) "claims": reported failure',
      '- Verifier 2 (s-418): did not hand in',
      CLOSING,
    ].join('\n'));
  });

  it('только ненулевые счётчики: спека, пример «3 covered, 2 partial, 1 did not hand in»', () => {
    const wave = [
      ...[1, 2, 3].map((n) => entry(`Drone ${n}`, `s-${n}`, 'covered')),
      entry('Drone 4', 's-4', 'partial'), entry('Drone 5', 's-5', 'partial'), entry('Drone 6', 's-416', 'missing', 'mobile'),
    ];
    const text = waveLetter({ swarmId: 'sw-03', wave, earlierNotClosed: 0, left: null });
    expect(text.split('\n')[0]).toBe('Wave finished in swarm sw-03: 6 members — 3 covered, 2 partial, 1 did not hand in.');
    expect(text).toContain('- Drone 6 (s-416) "mobile": did not hand in');
  });

  it('участник без среза — без кавычек и лишних пробелов', () => {
    const text = waveLetter({ swarmId: 'sw-01', wave: [entry('Drone 1', 's-02', 'partial')], earlierNotClosed: 0, left: null });
    expect(text).toContain('\n- Drone 1 (s-02): partial\n');
  });

  it('строка Earlier waves — когда в прежних волнах есть не covered; иначе её нет', () => {
    const wave = [entry('Drone 3', 's-04', 'covered')];
    const earlier = waveLetter({ swarmId: 'sw-01', wave, earlierNotClosed: 2, left: null });
    expect(earlier).toBe([
      'Wave finished in swarm sw-01: 1 member handed in and declared full coverage.',
      'Earlier waves: 2 members not closed; your register says which of those gaps are closed since.',
      CLOSING,
    ].join('\n'));
    expect(waveLetter({ swarmId: 'sw-01', wave, earlierNotClosed: 0, left: null })).not.toContain('Earlier waves');
  });

  it('блок Not closed идёт раньше Earlier waves, Left — перед последней строкой', () => {
    const lines = waveLetter({
      swarmId: 'sw-01', wave: [entry('Drone 3', 's-04', 'partial')], earlierNotClosed: 1, left: { sessions: 9, swarmSessions: 16, minutes: 71 },
    }).split('\n');
    expect(lines).toEqual([
      'Wave finished in swarm sw-01: 1 member — 1 partial.',
      'Not closed:',
      '- Drone 3 (s-04): partial',
      'Earlier waves: 1 member not closed; your register says which of those gaps are closed since.',
      'Left: 9 of 16 swarm sessions, 71 min.',
      CLOSING,
    ]);
  });

  it('строка Left: с лимитом, без срока и без лимитов', () => {
    const wave = [entry('Drone 1', 's-02', 'covered')];
    const withLimit = waveLetter({ swarmId: 'sw-01', wave, earlierNotClosed: 0, left: { sessions: 9, swarmSessions: 16, minutes: 71 } });
    expect(withLimit).toContain('\nLeft: 9 of 16 swarm sessions, 71 min.\n');
    const noTime = waveLetter({ swarmId: 'sw-01', wave, earlierNotClosed: 0, left: { sessions: 0, swarmSessions: 16, minutes: null } });
    expect(noTime).toContain('\nLeft: 0 of 16 swarm sessions, no time limit.\n');
    expect(waveLetter({ swarmId: 'sw-01', wave, earlierNotClosed: 0, left: null })).not.toContain('Left:');
  });
});

describe('единственное число (3.5)', () => {
  it('один участник — «1 member», несколько — «N members», «all N members»', () => {
    const one = entry('Drone 1', 's-02', 'covered');
    expect(waveLetter({ swarmId: 'sw-03', wave: [one], earlierNotClosed: 0, left: null }).split('\n')[0])
      .toBe('Wave finished in swarm sw-03: 1 member handed in and declared full coverage.');
    expect(waveLetter({ swarmId: 'sw-03', wave: [entry('Drone 1', 's-02', 'partial')], earlierNotClosed: 1, left: null }).split('\n'))
      .toContain('Earlier waves: 1 member not closed; your register says which of those gaps are closed since.');
    expect(waveLetter({ swarmId: 'sw-03', wave: [entry('Drone 1', 's-02', 'partial')], earlierNotClosed: 0, left: null }).split('\n')[0])
      .toBe('Wave finished in swarm sw-03: 1 member — 1 partial.');
    expect(waveLetter({ swarmId: 'sw-03', wave: [one, entry('Drone 2', 's-03', 'covered')], earlierNotClosed: 2, left: null }).split('\n').slice(0, 2)).toEqual([
      'Wave finished in swarm sw-03: all 2 members handed in and declared full coverage.',
      'Earlier waves: 2 members not closed; your register says which of those gaps are closed since.',
    ]);
  });
});

describe('брифы роя (3.7)', () => {
  const queen = queenBrief({ swarmId: 'sw-01', tag: 'Audit', objective: 'Read it', minutes: 90 });

  it('бриф королевы: slice, письмо о конце волны, дыры', () => {
    expect(queen).toContain('- Add members with `swarm_add` (role "drone" with a slice task and a short `slice` name, later role "verifier" to recheck the key claims); the slice task must be self-contained. You cannot create other sessions or another swarm.');
    expect(queen).toContain('- Wait with `wait_for` on a member id or "inbox". Wait for the Parley letter that the wave has finished before you write the final summary: it lists the members that handed in partial coverage or did not hand in, and what is left of the swarm\'s sessions and time. An early `report done` closes the swarm and its still-working members. Read a member\'s result with `get_map {session, field: "summary"}`.');
    expect(queen).toContain('- Members close themselves when they hand in. For a gap worth the time, add one drone for that gap with a narrower task and the predecessor\'s hand-in, or cover it yourself; otherwise name the gap in the summary.');
  });

  it('бриф участника: coverage в report', () => {
    const brief = memberBrief('drone', 'Read core');
    expect(brief).toContain('- Hand in with `report`: status done and `coverage` — "covered" if you read the whole slice and answered its questions, otherwise "partial". In the summary give facts with sources (`path:line` or url) and say what is left unread. If you could not do the task at all, report failed. After that you are closed.');
    expect(brief.startsWith('Read core\n\nSwarm rules (you are a drone of a research swarm):')).toBe(true);
  });
});
