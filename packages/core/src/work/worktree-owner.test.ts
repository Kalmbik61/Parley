import { describe, expect, it } from 'vitest';
import type { WorkMap } from './types.js';
import { sessionWorktreeFinished } from './worktree-owner.js';

/** Карта из одной сессии `s-01` — ровно те поля, которые читает правило. */
function mapWith(options: {
  lifecycle?: string;
  workStatus?: string;
  room?: { archivedAt?: string | null };
  result?: string | null;
}): WorkMap {
  return {
    schemaVersion: 2,
    work: { status: options.workStatus ?? 'active' },
    sessions: [{ id: 's-01', lifecycle: options.lifecycle ?? 'active', result: options.result ?? null }],
    rooms: options.room === undefined ? [] : [{ id: 'r-01', members: ['s-01'], ...options.room }],
  } as unknown as WorkMap;
}

describe('sessionWorktreeFinished', () => {
  it('закрытая — true', () => {
    expect(sessionWorktreeFinished(mapWith({ lifecycle: 'closed' }), 's-01')).toBe(true);
  });

  it('спящая без комнаты — false', () => {
    expect(sessionWorktreeFinished(mapWith({ lifecycle: 'sleeping' }), 's-01')).toBe(false);
  });

  it('спящая в архивной комнате — true', () => {
    const map = mapWith({ lifecycle: 'sleeping', room: { archivedAt: '2026-11-03T00:00:00.000Z' } });
    expect(sessionWorktreeFinished(map, 's-01')).toBe(true);
  });

  it('активная в открытой комнате — false', () => {
    expect(sessionWorktreeFinished(mapWith({ room: { archivedAt: null } }), 's-01')).toBe(false);
  });

  it('работа в архиве — true', () => {
    expect(sessionWorktreeFinished(mapWith({ workStatus: 'archived' }), 's-01')).toBe(true);
  });

  it('итог accepted у активной — false', () => {
    expect(sessionWorktreeFinished(mapWith({ result: 'accepted' }), 's-01')).toBe(false);
  });
});
