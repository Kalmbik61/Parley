import { describe, expect, it } from 'vitest';
import * as fe from './follow-end';

const K = ['a', 'b', 'c', 'd', 'e'];
const more = (n: number): string[] => [...K, ...Array.from({ length: n }, (_, i) => `n${i}`)];
const atEnd = (content = 1000): fe.ScrollMetrics => ({ offset: content - 100, content, viewport: 100 });
const middle: fe.ScrollMetrics = { offset: 300, content: 1000, viewport: 100 };

/** A feed whose first rows arrived at t=0 and whose pin has ended. */
function settled(): fe.FollowState {
  let s = fe.contentChanged(fe.open(), 0, K).state;
  s = fe.tick(s, 1000);
  return fe.scrolled(s, atEnd(), 2000, K);
}

describe('follow the end: pin (A44)', () => {
  it('is pinned and at the bottom after open, with nothing to scroll yet', () => {
    const s = fe.open();
    expect(s.pinned).toBe(true);
    expect(s.atBottom).toBe(true);
    expect(fe.pinDeadline(s, 0)).toBeNull();
  });

  it('scrolls to the end on every height growth while pinned, instantly', () => {
    let s = fe.open();
    for (const now of [10, 60, 200, 450]) {
      const step = fe.contentChanged(s, now, K);
      expect(step.scroll).toBe('instant');
      expect(step.state.pinned).toBe(true);
      s = step.state;
    }
  });

  it('the pin ends after 500 ms without a height change', () => {
    const s = fe.contentChanged(fe.open(), 100, K).state;
    expect(fe.tick(s, 100 + fe.PIN_QUIET_MS - 1).pinned).toBe(true);
    expect(fe.tick(s, 100 + fe.PIN_QUIET_MS).pinned).toBe(false);
    expect(fe.pinDeadline(s, 100)).toBe(fe.PIN_QUIET_MS);
  });

  it('each growth restarts the quiet spell', () => {
    let s = fe.contentChanged(fe.open(), 0, K).state;
    s = fe.contentChanged(s, 400, K).state;
    s = fe.contentChanged(s, 800, K).state;
    expect(fe.tick(s, 1200).pinned).toBe(true);
    expect(fe.tick(s, 1300).pinned).toBe(false);
  });

  it('the pin ends at the 3 s cap even if the height keeps changing', () => {
    let s = fe.open();
    for (let t = 0; t < fe.PIN_MAX_MS; t += 200) s = fe.contentChanged(s, t, K).state;
    expect(fe.tick(s, fe.PIN_MAX_MS - 100).pinned).toBe(true);
    expect(fe.tick(s, fe.PIN_MAX_MS).pinned).toBe(false);
  });

  it('M3: a skeleton does not start the pin; data after 2 s, rows grow: every scroll is instant and the pin holds', () => {
    let s = fe.open();
    const skeleton = fe.contentChanged(s, 16, []);
    expect(skeleton.scroll).toBe('none');
    expect(fe.pinDeadline(skeleton.state, 16)).toBeNull();
    expect(fe.tick(skeleton.state, 2000).pinned).toBe(true);
    s = skeleton.state;
    for (const now of [2000, 2050, 2200, 2400]) {
      const step = fe.contentChanged(s, now, K);
      expect(step.scroll).toBe('instant');
      s = step.state;
    }
    expect(fe.tick(s, 2800).pinned).toBe(true);
    expect(fe.tick(s, 2900).pinned).toBe(false);
  });

  it('a touch ends the pin at once', () => {
    const s = fe.dragBegan(fe.contentChanged(fe.open(), 10, K).state);
    expect(s.pinned).toBe(false);
    expect(s.touching).toBe(true);
  });
});

describe('follow the end: position, growth and our own scroll (M1)', () => {
  it('a scroll event caused by growth does not leave the bottom', () => {
    let s = settled();
    s = fe.contentChanged(s, 3000, K).state;
    // The rows grew: the offset is now far from the new end, in the very next scroll event.
    s = fe.scrolled(s, { offset: 900, content: 2000, viewport: 100 }, 3010, K);
    expect(s.atBottom).toBe(true);
  });

  it('a scroll event after our own scroll does not leave the bottom', () => {
    let s = settled();
    s = fe.keepEnd(s, 3000).state;
    // Our scroll lands while the size changes under it: the offset is far from the new end, the event is not the human's.
    s = fe.scrolled(s, { offset: 900, content: 1400, viewport: 100 }, 3300, K);
    expect(s.atBottom).toBe(true);
  });

  it('a quote jump leaves the bottom, and the next growth does not drag the feed back', () => {
    let s = fe.left(settled(), K);
    s = fe.scrolled(s, middle, 3000, K);
    expect(s.atBottom).toBe(false);
    const step = fe.contentChanged(s, 4000, more(1));
    expect(step.scroll).toBe('none');
    expect(step.state.away).toBe(1);
  });

  it('a status-bar tap (a scroll to the start with no drag, no growth, no scroll of ours) leaves the bottom', () => {
    let s = settled();
    s = fe.scrolled(s, { offset: 400, content: 1000, viewport: 100 }, 5000, K);
    expect(s.atBottom).toBe(false);
    s = fe.scrolled(s, { offset: 0, content: 1000, viewport: 100 }, 5100, K);
    expect(s.atBottom).toBe(false);
  });

  it('VoiceOver scrolling (no drag) away from the end is a position change', () => {
    const s = fe.scrolled(settled(), middle, 5000, K);
    expect(s.atBottom).toBe(false);
  });

  it('a position back near the end returns to the bottom and clears the count', () => {
    let s = fe.scrolled(settled(), middle, 5000, K);
    s = fe.contentChanged(s, 6000, more(2)).state;
    expect(s.away).toBe(2);
    s = fe.scrolled(s, atEnd(), 7000, more(2));
    expect(s.atBottom).toBe(true);
    expect(s.away).toBe(0);
  });

  it('while pinned, a position change without a touch is ignored', () => {
    const s = fe.contentChanged(fe.open(), 0, K).state;
    expect(fe.scrolled(s, middle, 400, K).atBottom).toBe(true);
  });
});

describe('follow the end: VoiceOver inside the echo window (N6)', () => {
  it('an upward move far from the end with the same height leaves the bottom even right after growth', () => {
    let s = settled();
    s = fe.scrolled(s, atEnd(), 2500, K);
    s = fe.contentChanged(s, 3000, K).state;
    // 20 ms after the growth: inside the echo window.
    s = fe.scrolled(s, { offset: 300, content: 1000, viewport: 100 }, 3020, K);
    expect(s.atBottom).toBe(false);
  });

  it('a downward move inside the window (our own scroll, growth echo) stays at the bottom', () => {
    let s = fe.scrolled(settled(), { offset: 700, content: 1000, viewport: 100 }, 2500, K);
    s = fe.jumped(s, 3000, K).state;
    s = fe.scrolled(s, { offset: 800, content: 1000, viewport: 100 }, 3020, K);
    expect(s.atBottom).toBe(true);
  });
});

describe('follow the end: a finger on the feed (M2)', () => {
  it('growth during a touch scrolls nothing and is remembered', () => {
    let s = fe.dragBegan(settled());
    s = fe.scrolled(s, { offset: 930, content: 1000, viewport: 100 }, 3000, K);
    const step = fe.contentChanged(s, 3100, more(1));
    expect(step.scroll).toBe('none');
    expect(step.state.pendingGrowth).toBe(true);
  });

  it('on release, one scroll to the end if the human is still at the bottom', () => {
    const s = fe.contentChanged(fe.dragBegan(settled()), 3100, more(1)).state;
    const step = fe.dragEnded(s, atEnd(1100), 3200, more(1), false);
    expect(step.scroll).toBe('instant');
    expect(step.state.pendingGrowth).toBe(false);
  });

  it('on release away from the bottom: no scroll, the growth is forgotten', () => {
    const s = fe.contentChanged(fe.dragBegan(settled()), 3100, more(1)).state;
    const step = fe.dragEnded(s, middle, 3200, more(1), false);
    expect(step.scroll).toBe('none');
    expect(step.state.atBottom).toBe(false);
    expect(step.state.pendingGrowth).toBe(false);
  });

  it('a momentum end while the finger is down is ignored', () => {
    const s = fe.dragBegan(settled());
    const step = fe.momentumEnded(s, middle, 3000, K);
    expect(step.state).toBe(s);
    expect(step.scroll).toBe('none');
  });

  it('with momentum the human\'s scroll goes on until the momentum ends; then one scroll if still at the bottom', () => {
    const s = fe.contentChanged(fe.dragBegan(settled()), 3100, more(1)).state;
    const released = fe.dragEnded(s, atEnd(1100), 3200, more(1), true);
    expect(released.scroll).toBe('none');
    expect(released.state.momentum).toBe(true);
    expect(fe.contentChanged(released.state, 3250, more(2)).scroll).toBe('none');
    const done = fe.momentumEnded(released.state, atEnd(1100), 3400, more(1));
    expect(done.scroll).toBe('instant');
    expect(done.state.momentum).toBe(false);
  });

  it('the momentum end of our own scroll does not clear the protection of the scroll (A44c)', () => {
    const s = fe.keepEnd(settled(), 3000).state;
    const step = fe.momentumEnded(s, middle, 3100, K);
    expect(step.state.atBottom).toBe(true);
    expect(step.state.ownUntil).toBe(s.ownUntil);
  });

  it('keepEnd does nothing during a gesture', () => {
    expect(fe.keepEnd(fe.dragBegan(settled()), 3000).scroll).toBe('none');
  });
});

describe('follow the end: the window shrinks (M4)', () => {
  it('a shrink with the human at the bottom scrolls to the end instantly', () => {
    let s = settled();
    s = fe.viewportChanged(s, 700, 3000).state;
    const step = fe.viewportChanged(s, 400, 4000);
    expect(step.scroll).toBe('instant');
  });

  it('the scroll event of the resize does not leave the bottom', () => {
    let s = fe.viewportChanged(fe.viewportChanged(settled(), 700, 3000).state, 400, 4000).state;
    s = fe.scrolled(s, { offset: 900, content: 1000, viewport: 400 }, 4020, K);
    expect(s.atBottom).toBe(true);
  });

  it('no scroll when the human is away, touching, or when the window grows', () => {
    const away = fe.scrolled(settled(), middle, 3000, K);
    expect(fe.viewportChanged(fe.viewportChanged(away, 700, 3100).state, 400, 3200).scroll).toBe('none');
    const touching = fe.dragBegan(settled());
    expect(fe.viewportChanged(fe.viewportChanged(touching, 700, 3100).state, 400, 3200).scroll).toBe('none');
    expect(fe.viewportChanged(fe.viewportChanged(settled(), 400, 3100).state, 700, 3200).scroll).toBe('none');
  });
});

describe('follow the end: new items and Jump to latest', () => {
  it('new items while not at the bottom count for Jump to latest', () => {
    let s = fe.scrolled(settled(), middle, 5000, K);
    s = fe.contentChanged(s, 6000, more(3)).state;
    expect(s.away).toBe(3);
  });

  it('new items at the bottom do not count: they are followed', () => {
    const step = fe.contentChanged(settled(), 6000, more(1));
    expect(step.scroll).toBe('animated');
    expect(step.state.away).toBe(0);
  });

  it('m1: the count follows item keys: earlier pages at the top and a re-read do not distort it', () => {
    let s = fe.scrolled(settled(), middle, 5000, K);
    // Two earlier pages land at the top.
    const withOlder = ['o1', 'o2', 'o3', ...K];
    expect(fe.contentChanged(s, 6000, withOlder).state.away).toBe(0);
    // One new item after them.
    s = fe.contentChanged(s, 6100, [...withOlder, 'z']).state;
    expect(s.away).toBe(1);
    // The window of a re-read room moved: the anchor is gone, the count stays.
    expect(fe.contentChanged(s, 6200, ['x', 'y', 'z']).state.away).toBe(1);
  });

  it('"Jump to latest" goes to the end, follows again and clears the count', () => {
    let s = fe.scrolled(settled(), middle, 5000, K);
    s = fe.contentChanged(s, 6000, more(3)).state;
    const step = fe.jumped(s, 6100, more(3));
    expect(step.scroll).toBe('animated');
    expect(step.state.atBottom).toBe(true);
    expect(step.state.away).toBe(0);
    expect(fe.contentChanged(step.state, 6200, more(4)).scroll).toBe('animated');
  });
});

describe('follow the end: reveal (A44b)', () => {
  const end = (content: number): fe.ScrollMetrics => ({ offset: content - 100, content, viewport: 100 });
  const landedAt = (content: number, now: number): fe.FollowState => {
    const s = fe.contentChanged(fe.open(), 0, K, content).state;
    return fe.scrolled(s, end(content), now, K);
  };

  it('starts hidden, also on a re-open of the same screen', () => {
    expect(fe.open().revealed).toBe(false);
    expect(fe.revealCheck(landedAt(3000, 10), 200).revealed).toBe(true);
    expect(fe.open().revealed).toBe(false);
  });

  it('reveals one frame after the last growth once the pin\'s scroll has landed at the end', () => {
    const s = landedAt(3000, 10);
    expect(fe.revealCheck(s, fe.REVEAL_FRAME_MS - 1).revealed).toBe(false);
    expect(fe.revealCheck(s, fe.REVEAL_FRAME_MS).revealed).toBe(true);
    const grown = fe.contentChanged(s, 20, K, 3100).state;
    expect(fe.revealCheck(grown, 20 + fe.REVEAL_FRAME_MS).revealed).toBe(false); // the scroll event saw the old height
    expect(fe.revealDeadline(grown, 20)).toBe(fe.REVEAL_FRAME_MS);
    expect(fe.revealCheck(fe.scrolled(grown, end(3100), 60, K), 20 + fe.REVEAL_FRAME_MS).revealed).toBe(true);
  });

  it('a quiet spell is not enough while the list is not at the end (estimated heights): it waits for the cap', () => {
    const s = fe.scrolled(fe.contentChanged(fe.open(), 0, K, 3000).state, { offset: 1000, content: 3000, viewport: 100 }, 10, K);
    expect(fe.revealCheck(s, 200).revealed).toBe(false);
    expect(fe.revealDeadline(s, 200)).toBe(fe.REVEAL_CAP_MS - 200);
    expect(fe.revealCheck(s, fe.REVEAL_CAP_MS).revealed).toBe(true);
  });

  it('reveals at the cap since the first rows, whatever keeps growing', () => {
    let s = fe.contentChanged(fe.open(), 0, K, 3000).state;
    for (let t = 20; t < fe.REVEAL_CAP_MS; t += 20) s = fe.contentChanged(s, t, K, 3000 + t).state;
    expect(fe.revealCheck(s, fe.REVEAL_CAP_MS - 1).revealed).toBe(false);
    expect(fe.revealCheck(s, fe.REVEAL_CAP_MS).revealed).toBe(true);
  });

  it('a skeleton-only phase starts no cap', () => {
    const s = fe.contentChanged(fe.open(), 0, [], 200).state;
    expect(fe.revealDeadline(s, 10_000)).toBeNull();
    expect(fe.revealCheck(s, 10_000).revealed).toBe(false);
    const rows = fe.contentChanged(s, 10_000, K, 3000).state;
    expect(fe.revealCheck(rows, 10_000 + fe.REVEAL_CAP_MS - 1).revealed).toBe(false);
    expect(fe.revealCheck(rows, 10_000 + fe.REVEAL_CAP_MS).revealed).toBe(true);
  });

  it('a feed that fits the window shows at once; a long one does not', () => {
    const laidOut = fe.viewportChanged(fe.open(), 800, 0).state;
    expect(fe.contentChanged(laidOut, 1, K, 500).state.revealed).toBe(true);
    expect(fe.contentChanged(laidOut, 1, K, 3000).state.revealed).toBe(false);
  });

  it('a long feed whose first drawn rows look short is not revealed until it is measured (critic ПB1)', () => {
    const long = Array.from({ length: 200 }, (_, i) => `r${i}`);
    const laidOut = fe.viewportChanged(fe.open(), 760, 0).state;
    const first = fe.contentChanged(laidOut, 1, long, 640).state; // only the first rows are drawn: 640 pt < 760 pt
    expect(first.revealed).toBe(false);
    expect(fe.revealCheck(fe.viewportChanged(first, 760, 2).state, 3).revealed).toBe(false);
    const window30 = long.slice(-30);
    expect(fe.contentChanged(laidOut, 1, window30, 640).state.revealed).toBe(true); // a whole 30-row window that fits
  });

  it('a short feed shows at once whichever of the size and the layout event came first (critic m3)', () => {
    const sizeFirst = fe.contentChanged(fe.open(), 0, K, 500).state;
    expect(sizeFirst.revealed).toBe(false);
    expect(fe.viewportChanged(sizeFirst, 800, 1).state.revealed).toBe(true);
    expect(fe.revealCheck(fe.viewportChanged(fe.contentChanged(fe.open(), 0, K, 3000).state, 800, 1).state, 2).revealed).toBe(false);
  });

  it('a touch shows the list', () => {
    expect(fe.dragBegan(fe.open()).revealed).toBe(true);
  });
});

describe('follow the end: a re-read (A44c)', () => {
  const rows = (n: number): string[] => [...K, ...Array.from({ length: n }, (_, i) => `r${i}`)];
  const shown = (): fe.FollowState => ({ ...settled(), revealed: true });

  it('up to one batch of new rows: pinned again, the growth scrolls instantly, the list stays shown', () => {
    const r = fe.reread(shown(), 5000, rows(3));
    expect(r.reopen).toBe(false);
    expect(r.state.pinned).toBe(true);
    expect(r.state.revealed).toBe(true);
    expect(fe.contentChanged(r.state, 5010, rows(3)).scroll).toBe('instant');
    expect(fe.tick(r.state, 5000 + fe.PIN_QUIET_MS).pinned).toBe(false);
  });

  it('more than one batch: reopened like the first open (hidden, pinned), shown by revealCheck after a landed scroll and a quiet frame, else at the cap', () => {
    const r = fe.reread(shown(), 5000, rows(fe.REREAD_INSTANT_ROWS + 1));
    expect(r.reopen).toBe(true);
    expect(r.state.revealed).toBe(false);
    expect(r.state.pinned).toBe(true);
    const grown = fe.contentChanged(r.state, 5010, rows(11), 2000).state;
    expect(fe.revealCheck(grown, 5010 + fe.REVEAL_FRAME_MS).revealed).toBe(false);
    const landed = fe.scrolled(grown, atEnd(2000), 5100, rows(11));
    expect(fe.revealCheck(landed, 5010 + fe.REVEAL_FRAME_MS).revealed).toBe(true);
    expect(fe.revealCheck(grown, 5010 + fe.REVEAL_CAP_MS).revealed).toBe(true);
  });

  it('the anchor vanished (a folded turn): reopened', () => {
    expect(fe.reread(shown(), 5000, ['x', 'y']).reopen).toBe(true);
  });

  it('away from the end nothing scrolls and the new rows are counted', () => {
    const away = fe.scrolled(shown(), middle, 3000, K);
    expect(away.atBottom).toBe(false);
    const r = fe.reread(away, 5000, rows(7));
    expect(r.reopen).toBe(false);
    expect(r.state.away).toBe(7);
    expect(r.state.pinned).toBe(false);
  });

  it('a mount again at the end reopens; away from the end it leaves the state alone', () => {
    expect(fe.remounted(shown(), K).reopen).toBe(true);
    expect(fe.remounted(shown(), K).state.revealed).toBe(false);
    const away = fe.scrolled(shown(), middle, 3000, K);
    expect(fe.remounted(away, K)).toEqual({ state: away, reopen: false });
  });
});

describe('follow the end: the chase does not break itself (A44c)', () => {
  it('run 3: growth, a momentum end of the cut animation, a silent spell, a frame further down — still at the bottom', () => {
    let s = fe.contentChanged({ ...settled(), pinned: false }, 6000, more(3), 14163).state;
    s = fe.scrolled(s, { offset: 10000, content: 14163, viewport: 800 }, 6001, more(3));
    s = fe.keepEnd(s, 6010).state;
    s = fe.momentumEnded(s, { offset: 10613, content: 14163, viewport: 800 }, 6017, more(3)).state;
    s = fe.scrolled(s, { offset: 11737, content: 14163, viewport: 800 }, 6400, more(3));
    expect(s.atBottom).toBe(true);
  });

  it('a move down with the same height does not leave the bottom; a move up far from the end does (N6)', () => {
    let s = fe.scrolled(settled(), { offset: 800, content: 1000, viewport: 100 }, 9000, K);
    s = fe.scrolled(s, { offset: 850, content: 1000, viewport: 100 }, 9100, K);
    expect(s.atBottom).toBe(true);
    s = fe.scrolled({ ...s, ownUntil: 0 }, { offset: 300, content: 1000, viewport: 100 }, 9200, K);
    expect(s.atBottom).toBe(false);
  });
});
