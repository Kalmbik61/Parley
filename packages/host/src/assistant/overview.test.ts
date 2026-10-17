import { describe, expect, it } from 'vitest';
import type { WorkEntry, WorkMap } from '@parley/core';
import type { SessionLive } from '../activity/activity-service.js';
import { detailText, overviewText, resolveTarget, targetsOf, type OverviewSource } from './overview.js';

function session(id: string, label: string, extra: Record<string, unknown> = {}) {
  return { id, label, provider: 'claude', task: `task of ${label}`, summary: null, lifecycle: 'active', ...extra };
}
function entry(projectPath: string, workId: string, title: string, overrides: Partial<WorkMap> = {}): WorkEntry {
  return {
    projectPath,
    map: {
      schemaVersion: 2,
      work: { id: workId, title, goal: '', status: 'active' },
      sessions: [session('s-03', 'S03 Ruslan'), session('s-05', 'S05 Vera')],
      messages: [],
      rooms: [{ id: 'r-1', title: 'Auth', creator: 's-03', members: ['s-03', 's-05'], createdAt: '', lead: 's-03', proposal: null }],
      ...overrides,
    } as unknown as WorkMap,
  };
}
const live = (activity: string, waitingFor: string | null = null): SessionLive =>
  ({ activity: { activity, waitingFor }, metrics: null }) as unknown as SessionLive;

function source(entries: WorkEntry[], states: Record<string, SessionLive>): OverviewSource {
  return { entries, live: (ref) => states[ref.sessionId] };
}

describe('targetsOf и resolveTarget', () => {
  const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': live('idle') });
  it('id по проекту, работе и элементу', () => {
    const ids = targetsOf(src).map((target) => target.id);
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => /^(room|session):[0-9a-f]{6}:w-1:/.test(id))).toBe(true);
  });
  it('находит по id, по имени и по первому слову имени', () => {
    const targets = targetsOf(src);
    const room = targets.find((target) => target.kind === 'room');
    expect(resolveTarget(targets, room?.id ?? '')).toEqual({ target: room });
    expect(resolveTarget(targets, 'auth')).toMatchObject({ target: { kind: 'room', name: 'Auth' } });
    expect(resolveTarget(targets, 'S03')).toMatchObject({ target: { kind: 'session', name: 'S03 Ruslan' } });
  });
  it('неоднозначное имя — ошибка со списком, неизвестное — подсказка', () => {
    const two = targetsOf(source([entry('/p/one', 'w-1', 'Parley'), entry('/p/two', 'w-2', 'Site')], {}));
    expect(resolveTarget(two, 'Auth')).toMatchObject({ error: expect.stringContaining('several') });
    expect(resolveTarget(two, 'Billing')).toMatchObject({ error: expect.stringContaining('parley_overview') });
  });
  it('архивная работа, архивная комната и закрытая сессия — не цели', () => {
    const archived = entry('/p/a', 'w-a', 'Old', { work: { id: 'w-a', title: 'Old', goal: '', status: 'archived' } } as Partial<WorkMap>);
    const roomArchived = entry('/p/b', 'w-b', 'B', {
      rooms: [{ id: 'r-9', title: 'Gone', creator: 's-03', members: [], createdAt: '', lead: null, proposal: null, archivedAt: '2026-10-01' }],
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'closed' })],
    } as unknown as Partial<WorkMap>);
    expect(targetsOf(source([archived, roomArchived], {}))).toEqual([]);
  });
  it('спящая сессия без live — running: false, lifecycle sleeping', () => {
    const sleeping = entry('/p/one', 'w-1', 'Parley', { sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping' })] } as unknown as Partial<WorkMap>);
    const target = targetsOf(source([sleeping], {})).find((item) => item.kind === 'session');
    expect(target).toMatchObject({ running: false, lifecycle: 'sleeping' });
  });
  it('сессия после resume (lifecycle active, activity idle) — running: true', () => {
    const resumed = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('idle') });
    const target = targetsOf(resumed).find((item) => item.kind === 'session' && item.name === 'S03 Ruslan');
    expect(target).toMatchObject({ running: true, lifecycle: 'active' });
  });
  it('живая сессия без выведенной activity — тоже running: true', () => {
    const target = targetsOf(source([entry('/p/one', 'w-1', 'Parley')], {})).find((item) => item.kind === 'session');
    expect(target).toMatchObject({ running: true, lifecycle: 'active' });
  });
});

describe('overviewText', () => {
  it('ждущие человека — первыми, с тем, чего ждут', () => {
    const text = overviewText(source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('working'), 's-05': live('blocked', 'Bash: rm -rf dist') }));
    expect(text).toContain('Work "Parley"');
    expect(text).toContain('Room "Auth"');
    expect(text.indexOf('Session S05 Vera')).toBeLessThan(text.indexOf('Session S03 Ruslan'));
    expect(text).toContain('waiting for: Bash: rm -rf dist');
    expect(text).toMatch(/Session S05 Vera \[[^\]]+\] claude · needs you · /);
    expect(text).toContain('1 need the person');
  });
  it('слова состояний — из единой таблицы: idle у resume, asleep у спящей без live', () => {
    const mixed = entry('/p/one', 'w-1', 'Parley', {
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping' }), session('s-05', 'S05 Vera')],
    } as unknown as Partial<WorkMap>);
    const text = overviewText(source([mixed], { 's-05': live('idle') }));
    expect(text).toMatch(/Session S05 Vera \[[^\]]+\] claude · idle · /);
    expect(text).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · asleep · /);
    expect(text.indexOf('Session S05 Vera')).toBeLessThan(text.indexOf('Session S03 Ruslan'));
  });
  it('завершённая сессия с итогом называется по итогу, а не asleep', () => {
    const finished = entry('/p/one', 'w-1', 'Parley', {
      sessions: [session('s-03', 'S03 Ruslan', { lifecycle: 'sleeping', result: 'done' })],
    } as unknown as Partial<WorkMap>);
    expect(overviewText(source([finished], {}))).toMatch(/Session S03 Ruslan \[[^\]]+\] claude · done · /);
  });
  it('пусто — так и говорит', () => {
    expect(overviewText(source([], {}))).toBe('No works are open in Parley right now.');
  });
  it('длинный снимок срезается по работам с пометкой', () => {
    const many = Array.from({ length: 60 }, (_, index) => entry(`/p/${index}`, `w-${index}`, `Work ${index}`));
    const text = overviewText(source(many, {}), 2000);
    expect(text.length).toBeLessThanOrEqual(2200);
    expect(text).toMatch(/more works not shown/);
  });
});

describe('detailText', () => {
  it('сессия — последний ответ', () => {
    const src = source([entry('/p/one', 'w-1', 'Parley')], { 's-03': live('idle') });
    const target = targetsOf(src).find((item) => item.kind === 'session' && item.name === 'S03 Ruslan');
    expect(detailText(src, target!, 'Тесты зелёные.')).toContain('Last reply: Тесты зелёные.');
  });
  it('комната — последние сообщения', () => {
    const map = entry('/p/one', 'w-1', 'Parley', {
      messages: [{ id: 'm1', roomId: 'r-1', from: 'human', to: [], at: '2026-10-15T10:00:00Z', text: 'Как дела?', kind: 'question', readBy: {} }],
    } as unknown as Partial<WorkMap>);
    const src = source([map], {});
    const room = targetsOf(src).find((item) => item.kind === 'room');
    expect(detailText(src, room!, null)).toContain('Как дела?');
  });
});
