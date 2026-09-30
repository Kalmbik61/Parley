/**
 * Тесты 1–4 куска 2.4 плана окна («вся почта работы»): вся переписка, а не
 * поддерево; ярлык сессии не протекает в подписи участников; блок решений
 * режется на пять и «раньше»; непрочитанность — только по адресату.
 */

import { describe, expect, it } from 'vitest';
import type { Message, WorkEntry, WorkSession } from '@parley/core';
import { mailView } from './mail-view.js';

function session(id: string, label: string, parent: string | null = null): WorkSession {
  return {
    id,
    provider: 'claude',
    label,
    task: '',
    parent,
    contextFrom: [],
    lifecycle: 'active',
    result: null,
    resultAt: null,
    closedAt: null,
    history: [],
    startedAt: null,
    endedAt: null,
    pid: null,
    startedAtProcess: null,
    launchedBy: 'host',
    providerSessionId: null,
    metrics: null,
    summary: null,
    summarySource: null,
    artifacts: [],
    agent: null,
  };
}

function message(partial: Partial<Message> & Pick<Message, 'id' | 'from' | 'to' | 'at'>): Message {
  return {
    roomId: null,
    text: 'текст',
    kind: 'note',
    readBy: {},
    ...partial,
  };
}

function entryWith(sessions: WorkSession[], messages: Message[]): WorkEntry {
  return {
    projectPath: '/tmp/w-01',
    map: {
      schemaVersion: 2,
      rooms: [],
      work: { id: 'w-01', title: 'Работа', goal: '', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      sessions,
      messages,
    },
  };
}

const providers = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
];

describe('mailView — тест 1: вся почта работы, а не поддерево', () => {
  it('в ленте письма и корня, и обеих ветвей вложенных сессий', () => {
    const entry = entryWith(
      [session('s-01', 'план'), session('s-02', 'бэкенд', 's-01'), session('s-03', 'фронт', 's-01')],
      [
        message({ id: 'm-1', from: 's-01', to: ['s-02'], at: '2026-01-01T10:00:00.000Z' }),
        message({ id: 'm-2', from: 's-01', to: ['s-03'], at: '2026-01-01T10:01:00.000Z' }),
        message({ id: 'm-3', from: 's-02', to: ['s-03'], at: '2026-01-01T10:02:00.000Z' }),
      ],
    );

    const view = mailView(entry, providers, {});
    expect(view.letters.map((letter) => letter.id)).toEqual(['m-1', 'm-2', 'm-3']);
  });
});

describe('mailView — тест 2: длинный ярлык сессии не протекает в ленту', () => {
  it('ни подпись участника, ни строки писем не содержат ярлык из 200 знаков', () => {
    const hugeLabel = 'я'.repeat(200);
    const entry = entryWith(
      [session('s-01', hugeLabel)],
      [message({ id: 'm-1', from: 's-01', to: ['human'], at: '2026-01-01T10:00:00.000Z', text: 'привет' })],
    );

    const view = mailView(entry, providers, {});
    const haystack = [...view.participants, ...view.letters.flatMap((letter) => [letter.from, letter.to, letter.text])];
    for (const line of haystack) expect(line).not.toContain(hugeLabel);
  });
});

describe('mailView — тест 3: решений семь → пять и «+2 раньше»', () => {
  it('показывает последние пять решений, остальные — счётом', () => {
    const messages: Message[] = [];
    for (let index = 0; index < 7; index += 1) {
      messages.push(
        message({
          id: `d-${index}`,
          from: 's-01',
          to: ['human'],
          at: `2026-01-01T10:0${index}:00.000Z`,
          kind: 'decision',
          text: `решение ${index}`,
        }),
      );
    }
    const entry = entryWith([session('s-01', 'план')], messages);

    const view = mailView(entry, providers, {});
    expect(view.decisions.shown).toHaveLength(5);
    expect(view.decisions.earlier).toBe(2);
    expect(view.decisions.shown.map((letter) => letter.id)).toEqual(['d-2', 'd-3', 'd-4', 'd-5', 'd-6']);
  });
});

describe('mailView — тест 4: непрочитанность только по адресату', () => {
  it('▤ только когда хотя бы один адресат ещё не прочёл; прочитанное — unread: false', () => {
    const entry = entryWith(
      [session('s-01', 'план'), session('s-02', 'бэкенд')],
      [
        message({ id: 'm-unread', from: 's-01', to: ['s-02'], at: '2026-01-01T10:00:00.000Z', readBy: {} }),
        message({
          id: 'm-read',
          from: 's-01',
          to: ['s-02'],
          at: '2026-01-01T10:01:00.000Z',
          readBy: { 's-02': '2026-01-01T10:02:00.000Z' },
        }),
      ],
    );

    const view = mailView(entry, providers, {});
    const unread = view.letters.find((letter) => letter.id === 'm-unread');
    const read = view.letters.find((letter) => letter.id === 'm-read');
    expect(unread?.unread).toBe(true);
    expect(read?.unread).toBe(false);
  });
});
