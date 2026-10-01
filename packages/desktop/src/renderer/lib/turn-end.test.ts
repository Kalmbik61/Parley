/**
 * Конец хода по смене живой активности (Parley 0.2.0): `working` перешёл во что-то другое — или остался
 * `working`, но лида теперь держат одни фоновые субагенты (`heldByBackground` стало `true`).
 */

import { describe, expect, it } from 'vitest';
import type { SessionActivity } from '@parley/core';
import { workingEnded } from './turn-end.js';

const live = (
  activity: SessionActivity['activity'],
  heldByBackground = false,
): SessionActivity => ({
  activity,
  subagents: 0,
  tasks: [],
  waitingFor: null,
  heldByBackground,
  turnEndedAt: null,
  lastEventAt: null,
  source: 'hooks',
  exited: false,
  hooksMissing: false,
});

describe('workingEnded', () => {
  it('working перешёл в unseen, idle, blocked или пропал — ход окончен', () => {
    for (const next of ['unseen', 'idle', 'blocked'] as const) {
      expect(workingEnded(live('working'), live(next)), next).toBe(true);
    }
    expect(workingEnded(live('working'), undefined)).toBe(true);
  });

  it('working без удержания стал working с удержанием фоновыми — ход лида окончен', () => {
    expect(workingEnded(live('working'), live('working', true))).toBe(true);
  });

  it('остальные переходы концом хода не считаются', () => {
    // Удержание продолжается или началось раньше.
    expect(workingEnded(live('working', true), live('working', true))).toBe(false);
    // Ход начался заново, фоновые идут: удержание снято, а не включено.
    expect(workingEnded(live('working', true), live('working'))).toBe(false);
    expect(workingEnded(live('working'), live('working'))).toBe(false);
    // До `working` ничего не шло.
    expect(workingEnded(live('idle'), live('working'))).toBe(false);
    expect(workingEnded(live('idle'), live('working', true))).toBe(false);
    expect(workingEnded(undefined, live('working', true))).toBe(false);
    expect(workingEnded(undefined, undefined)).toBe(false);
  });

  it('хост прежней версии флага не присылает: working → working концом хода не считается', () => {
    const old = (activity: SessionActivity['activity']): SessionActivity => {
      const value: Partial<SessionActivity> = live(activity);
      delete value.heldByBackground;
      return value as SessionActivity;
    };

    expect(workingEnded(old('working'), old('working'))).toBe(false);
    expect(workingEnded(old('working'), old('idle'))).toBe(true);
  });
});
