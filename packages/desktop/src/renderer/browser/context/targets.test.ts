import { describe, expect, it } from 'vitest';
import { makeRoom, makeSession, makeWork } from '../../test-utils/work-fixtures.js';
import { defaultTarget, isTargetAlive, resolveTarget, targetKey, targetName, targetOptions } from './targets.js';

// Архивная комната (PR #40): лента читается, поля ввода нет. `makeRoom` поля `archivedAt` не знает — комната из него открыта.
const ARCHIVED = { ...makeRoom('r-09', 'old design'), archivedAt: '2026-10-09T10:00:00.000Z' };

const WORK = makeWork('w-01', {
  sessions: [
    makeSession('s-01', 'planner', { lifecycle: 'closed' }),
    makeSession('s-02', 'backend'),
    makeSession('s-03', 'codex helper', { provider: 'codex' }),
    makeSession('s-04', 'sleeper', { lifecycle: 'sleeping' }),
  ],
  rooms: [makeRoom('r-01', 'review room'), ARCHIVED, makeRoom('r-02', 'design')],
});

// Сессия Codex здесь — без Chat (Codex ниже 0.160.0 или хост без `feed-codex`, PR #36): решает `feedAvailableNow`, не имя провайдера.
const chat = (provider: string): boolean | null => (provider === 'claude' ? true : provider === 'codex' ? false : null);

describe('targetOptions (спека браузера 4.5)', () => {
  it('сессии без закрытых: ярлык, провайдер, вид chat | terminal; комнаты — открытые, без провайдера (архивной r-09 в меню нет)', () => {
    const { sessions, rooms } = targetOptions(WORK, chat);
    expect(sessions.map((option) => [option.key, option.name, option.title, option.provider, option.mode])).toEqual([
      ['session:s-02', 'S02', 'S02 backend', 'claude', 'chat'],
      ['session:s-03', 'S03', 'S03 codex helper', 'codex', 'terminal'],
      ['session:s-04', 'S04', 'S04 sleeper', 'claude', 'chat'],
    ]);
    expect(rooms.map((option) => [option.key, option.name, option.title, option.provider, option.mode])).toEqual([
      ['room:r-01', 'review room', 'review room', null, null],
      ['room:r-02', 'design', 'design', null, null],
    ]);
  });

  it('доступность Chat неизвестна — вид не помечен', () => {
    expect(targetOptions(WORK, () => null).sessions.map((option) => option.mode)).toEqual([null, null, null]);
  });

  it('имена по умолчанию (PR #40): сессия с меткой «new session» — в меню `S05 Roman`, в кнопке и тосте `S05`', () => {
    const work = makeWork('w-06', { sessions: [makeSession('s-05', 'new session')] });
    expect(targetOptions(work, chat).sessions.map((option) => [option.name, option.title])).toEqual([['S05', 'S05 Roman']]);
  });
});

describe('defaultTarget и resolveTarget', () => {
  it('умолчание: сессия в фокусе; закрытая в фокусе — первая живая; живых нет — первая комната; ничего — null', () => {
    expect(defaultTarget(WORK, 's-03')).toEqual({ kind: 'session', sessionId: 's-03' });
    expect(defaultTarget(WORK, 's-01')).toEqual({ kind: 'session', sessionId: 's-02' });
    expect(defaultTarget(WORK, null)).toEqual({ kind: 'session', sessionId: 's-02' });
    const noLive = makeWork('w-02', { sessions: [makeSession('s-04', 'sleeper', { lifecycle: 'sleeping' })], rooms: [makeRoom('r-07', 'x')] });
    expect(defaultTarget(noLive, null)).toEqual({ kind: 'room', roomId: 'r-07' });
    expect(defaultTarget(makeWork('w-03'), null)).toBeNull();
  });

  it('живая сохранённая цель — она; пропавшая (закрыта, удалена) — умолчание и fellBack', () => {
    expect(resolveTarget(WORK, { kind: 'room', roomId: 'r-02' }, null)).toEqual({ target: { kind: 'room', roomId: 'r-02' }, fellBack: false });
    expect(resolveTarget(WORK, { kind: 'session', sessionId: 's-01' }, 's-03')).toEqual({ target: { kind: 'session', sessionId: 's-03' }, fellBack: true });
    expect(resolveTarget(WORK, { kind: 'room', roomId: 'r-99' }, null)).toEqual({ target: { kind: 'session', sessionId: 's-02' }, fellBack: true });
    expect(resolveTarget(WORK, undefined, null)).toEqual({ target: { kind: 'session', sessionId: 's-02' }, fellBack: false });
  });

  it('имя и ключ цели; isTargetAlive', () => {
    expect(targetName(WORK, { kind: 'session', sessionId: 's-02' })).toBe('S02');
    expect(targetName(WORK, { kind: 'room', roomId: 'r-01' })).toBe('review room');
    expect(targetKey({ kind: 'room', roomId: 'r-01' })).toBe('room:r-01');
    expect(targetKey({ kind: 'session', sessionId: 's-02' })).toBe('session:s-02');
    expect(isTargetAlive(WORK, { kind: 'session', sessionId: 's-01' })).toBe(false);
    expect(isTargetAlive(WORK, { kind: 'session', sessionId: 's-04' })).toBe(true);
    expect(isTargetAlive(WORK, { kind: 'room', roomId: 'r-99' })).toBe(false);
  });
});

describe('архивные комнаты (PR #40): в них нет поля ввода, вложению там некуда лечь', () => {
  it('архивная — не живая цель; сохранённая в ней цель откатывается, как пропавшая', () => {
    expect(isTargetAlive(WORK, { kind: 'room', roomId: 'r-09' })).toBe(false);
    expect(resolveTarget(WORK, { kind: 'room', roomId: 'r-09' }, null)).toEqual({ target: { kind: 'session', sessionId: 's-02' }, fellBack: true });
    expect(resolveTarget(WORK, { kind: 'room', roomId: 'r-09' }, 's-03')).toEqual({ target: { kind: 'session', sessionId: 's-03' }, fellBack: true });
  });

  it('умолчанием не бывает: первая комната — открытая, а единственная архивная — это «целиться некуда»', () => {
    const archivedFirst = makeWork('w-04', { rooms: [ARCHIVED, makeRoom('r-03', 'open')] });
    expect(defaultTarget(archivedFirst, null)).toEqual({ kind: 'room', roomId: 'r-03' });
    expect(defaultTarget(makeWork('w-05', { rooms: [ARCHIVED] }), null)).toBeNull();
    expect(resolveTarget(makeWork('w-05', { rooms: [ARCHIVED] }), { kind: 'room', roomId: 'r-09' }, null)).toEqual({ target: null, fellBack: true });
  });
});
