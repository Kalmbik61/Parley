import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRef } from '@parley/protocol';
import { fakePty, type FakePty } from '../../test/fake-pty.js';
import { HostError } from '../errors.js';
import type { SwitchLock } from '../sessions/sessions-service.js';
import type { RolloutRecord } from '@parley/core';
import { compactCommand, createCompactionService, type CompactionDeps } from './compaction-service.js';
import type { CompactionTrack } from './context-view.js';

const ref: SessionRef = { projectPath: '/tmp/project', workId: 'w-01', sessionId: 's-01' };

describe('compactCommand (спека 5.3)', () => {
  it('фокус — одна строка без управляющих символов', () => {
    expect(compactCommand('claude', 'a\n\tb\x1b[31m c ')).toBe('/compact a b c');
  });
  it('пусто или null — голый /compact', () => {
    expect(compactCommand('claude', '   ')).toBe('/compact');
    expect(compactCommand('claude', null)).toBe('/compact');
  });
  it('хвостовой @ или / токен закрывается пробелом, чтобы меню не забрало Enter', () => {
    expect(compactCommand('claude', 'look at @src/a.ts')).toBe('/compact look at @src/a.ts ');
    expect(compactCommand('claude', 'see /docs')).toBe('/compact see /docs ');
    expect(compactCommand('claude', 'a@b.c done')).toBe('/compact a@b.c done');
  });
  it('Codex — всегда голый /compact', () => {
    expect(compactCommand('codex', 'focus')).toBe('/compact');
  });
  it('длиннее 350 знаков — bad_request', () => {
    expect(compactCommand('claude', 'я'.repeat(350))).toBe(`/compact ${'я'.repeat(350)}`);
    expect(() => compactCommand('claude', 'я'.repeat(351))).toThrow(HostError);
  });
});

describe('createCompactionService (спека 5.2–5.5)', () => {
  let pty: FakePty;
  let state: string;
  let lastEventAt: string | null;
  let held: boolean;
  let inFlight: boolean;
  let logFile: string | null;
  let tailReads: RolloutRecord[][];
  let tailsMade: string[];
  let activityListeners: Array<(target: SessionRef) => void>;
  let tracks: CompactionTrack[];
  let notices: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    pty = fakePty();
    state = 'idle';
    lastEventAt = new Date(1000).toISOString();
    held = false;
    inFlight = false;
    logFile = '/tmp/rollout.jsonl';
    tailReads = [];
    tailsMade = [];
    activityListeners = [];
    tracks = [];
    notices = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function service() {
    const lock = Object.assign(
      <T,>(_target: SessionRef, run: () => Promise<T>): Promise<T> => {
        held = true;
        return run().finally(() => {
          held = false;
        });
      },
      { held: () => held },
    ) as unknown as SwitchLock;
    const deps: CompactionDeps = {
      host: {
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        broadcast: ((_event: string, data: { kind: string }) => {
          notices.push(data.kind);
        }) as unknown as CompactionDeps['host']['broadcast'],
      },
      pty: pty.manager,
      activity: {
        get: () => ({ activity: { activity: state, lastEventAt }, metrics: null }),
        onChange: (listener: (target: SessionRef) => void) => {
          activityListeners.push(listener);
          return () => undefined;
        },
        setCompaction: (_target: SessionRef, track: CompactionTrack) => {
          tracks.push(track);
        },
        logFile: () => logFile,
      } as unknown as CompactionDeps['activity'],
      exclusive: lock,
      wake: { inFlight: () => inFlight, enterDelayMs: 500 },
      timeoutMs: 60_000,
      codexTimeoutMs: 600_000,
      codexPollMs: 2_000,
      codexTail: (file: string) => {
        tailsMade.push(file);
        return { read: async () => tailReads.shift() ?? [] };
      },
    };
    const created = createCompactionService(deps);
    created.start();
    return created;
  }
  const poke = (): void => {
    for (const listener of activityListeners) listener(ref);
  };
  const phase = () => tracks.at(-1)?.phase ?? null;

  it('свободный агент — печать `/compact <фокус>` и Enter, started, фаза running, замок взят', async () => {
    const s = service();
    expect(s.compact(ref, 'Focus on room "Auth"')).toEqual({ state: 'started' });
    expect(phase()).toBe('running');
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact Focus on room "Auth"', '\r']);
    expect(s.holds(ref)).toBe(true);
    expect(held).toBe(true);
  });

  it('PostCompact — замок снят, конец сжатия записан', async () => {
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(500);
    s.onHook(ref, { hook_event_name: 'PostCompact', trigger: 'manual' });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.holds(ref)).toBe(false);
    expect(held).toBe(false);
    expect(tracks.at(-1)).toEqual({ phase: null, finishedAt: expect.any(String) });
  });

  it('PostCompact без просьбы (автосжатие CLI) — конец сжатия записан, фазы нет', () => {
    const s = service();
    s.onHook(ref, { hook_event_name: 'PostCompact', trigger: 'auto' });
    expect(tracks.at(-1)).toEqual({ phase: null, finishedAt: expect.any(String) });
    s.onHook(ref, { hook_event_name: 'Stop' });
    expect(tracks).toHaveLength(1);
  });

  it('занятый агент — pending; печать на первом idle', async () => {
    state = 'working';
    const s = service();
    expect(s.compact(ref, 'x')).toEqual({ state: 'pending' });
    expect(phase()).toBe('pending');
    expect(s.holds(ref)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual([]);
    state = 'idle';
    poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact x', '\r']);
  });

  it.each([
    ['диалог на экране (blocked)', () => { state = 'blocked'; }, () => { state = 'idle'; }],
    ['черновик человека', () => { pty.humanDraft = true; }, () => { pty.humanDraft = false; }],
    ['смена модели или effort', () => { held = true; }, () => { held = false; }],
    ['указатель письма в полёте', () => { inFlight = true; }, () => { inFlight = false; }],
  ])('%s — ждёт и уходит, когда помеха снята', async (_name, set, clear) => {
    set();
    const s = service();
    expect(s.compact(ref, 'x').state).toBe('pending');
    poke();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual([]);
    clear();
    poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact x', '\r']);
  });

  it('ни одного хука с запуска — refused unknown-screen; процесса нет — asleep', () => {
    lastEventAt = null;
    expect(service().compact(ref, 'x')).toEqual({ state: 'refused', reason: 'unknown-screen' });
    pty.live = false;
    expect(service().compact(ref, 'x')).toEqual({ state: 'refused', reason: 'asleep' });
  });

  it('Cancel снимает ждущую просьбу; без просьбы — false', async () => {
    state = 'working';
    const s = service();
    s.compact(ref, 'x');
    expect(s.cancel(ref)).toBe(true);
    expect(phase()).toBeNull();
    expect(s.holds(ref)).toBe(false);
    state = 'idle';
    poke();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pty.writes).toEqual([]);
    expect(s.cancel(ref)).toBe(false);
  });

  it('вторая просьба заменяет текст ждущей', async () => {
    state = 'working';
    const s = service();
    s.compact(ref, 'a');
    s.compact(ref, 'b');
    state = 'idle';
    poke();
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact b', '\r']);
  });

  it('Codex — голый /compact и Enter через 60 мс', async () => {
    pty.provider = 'codex';
    const s = service();
    s.compact(ref, 'Focus');
    await vi.advanceTimersByTimeAsync(60);
    expect(pty.writes).toEqual(['/compact', '\r']);
  });

  const rec = (type: string, at: string): RolloutRecord => ({ ordinal: null, at, type, payload: {} });

  it('Codex — записи, бывшие в файле до печати (первое чтение), сжатие не заканчивают', async () => {
    pty.provider = 'codex';
    const s = service();
    s.compact(ref, null);
    tailReads.push([rec('compacted', '2026-01-01T00:00:00.000Z')]);
    await vi.advanceTimersByTimeAsync(60);
    expect(tailsMade).toEqual(['/tmp/rollout.jsonl']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.holds(ref)).toBe(true);
  });

  it('Codex — compacted после печати заканчивает сжатие на следующем опросе, finishedAt — её время', async () => {
    pty.provider = 'codex';
    const s = service();
    s.compact(ref, null);
    tailReads.push([]);
    await vi.advanceTimersByTimeAsync(60);
    tailReads.push([rec('event_msg', '2026-10-16T10:00:00.000Z'), rec('compacted', '2026-10-16T10:00:05.000Z')]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(s.holds(ref)).toBe(false);
    expect(tracks.at(-1)).toEqual({ phase: null, finishedAt: '2026-10-16T10:00:05.000Z' });
    expect(notices).toEqual([]);
  });

  it('Codex — не падает по таймауту Claude, падает compact-failed по codexTimeoutMs', async () => {
    pty.provider = 'codex';
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(s.holds(ref)).toBe(true);
    expect(notices).toEqual([]);
    await vi.advanceTimersByTimeAsync(560_000);
    expect(s.holds(ref)).toBe(false);
    expect(notices).toEqual(['compact-failed']);
  });

  it('Codex — logFile null: без исключений, конец по таймауту', async () => {
    pty.provider = 'codex';
    logFile = null;
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tailsMade).toEqual([]);
    expect(s.holds(ref)).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(s.holds(ref)).toBe(false);
    expect(notices).toEqual(['compact-failed']);
  });

  it('нет отчёта до таймаута — compact-failed, замок снят', async () => {
    const s = service();
    s.compact(ref, null);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.holds(ref)).toBe(false);
    expect(held).toBe(false);
    expect(notices).toEqual(['compact-failed']);
  });

  it('человек начал печатать в паузе перед Enter — compact-failed, Enter не ушёл', async () => {
    const s = service();
    s.compact(ref, null);
    pty.emitDraft(ref);
    await vi.advanceTimersByTimeAsync(500);
    expect(pty.writes).toEqual(['/compact']);
    expect(notices).toEqual(['compact-failed']);
    expect(s.holds(ref)).toBe(false);
  });

  it('процесс вышел, пока просьба ждала — compact-cancelled', () => {
    state = 'working';
    const s = service();
    s.compact(ref, 'x');
    pty.emitExit(ref);
    expect(notices).toEqual(['compact-cancelled']);
    expect(s.holds(ref)).toBe(false);
    expect(phase()).toBeNull();
  });
});
