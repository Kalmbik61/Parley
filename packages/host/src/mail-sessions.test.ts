import { describe, expect, it } from 'vitest';
import { HUMAN } from '@parley/core';
import type { LetterJournal, Message, WorkMap } from '@parley/core';
import { mailSessions } from './mail-sessions.js';

/** Карта из двух комнат: `r-01` с тремя сессиями и `r-02` с одной; остальное правилам адресатов не нужно. */
const map = {
  rooms: [
    { id: 'r-01', members: ['s-01', 's-02', 's-03'], archivedAt: null },
    { id: 'r-02', members: ['s-04'], archivedAt: null },
  ],
} as unknown as WorkMap;

const AT = '2026-10-27T10:00:00.000Z';
const letter = (id: string, from: string, to: string[], roomId: string | null): Message => ({ id, roomId, from, to, at: AT, text: 'x', kind: 'note', readBy: {} }) as Message;
const journal = (part: Partial<LetterJournal>): Pick<{ journal: LetterJournal }, 'journal'> => ({
  journal: { added: [], reads: [], deleted: [], droppedRooms: [], rereadRooms: [], ...part },
});

describe('mailSessions: сессии, чьё непрочитанное изменила запись писем', () => {
  it('рассылка комнаты — участники без отправителя; прямое письмо — адресаты из to', () => {
    expect(mailSessions(journal({ added: [letter('m-1', 's-01', [], 'r-01')] }), map)).toEqual(new Set(['s-02', 's-03']));
    expect(mailSessions(journal({ added: [letter('m-2', 's-01', ['s-04'], null)] }), map)).toEqual(new Set(['s-04']));
  });

  it('отметка прочтения называет читателя', () => {
    expect(mailSessions(journal({ reads: [{ id: 'm-1', reader: 's-02', at: AT }] }), map)).toEqual(new Set(['s-02']));
  });

  it('комната с rereadRooms — все её участники: читателя чужой отметки не назвать', () => {
    expect(mailSessions(journal({ rereadRooms: ['r-01'] }), map)).toEqual(new Set(['s-01', 's-02', 's-03']));
    expect(mailSessions(journal({ rereadRooms: ['r-02', 'r-01'] }), map)).toEqual(new Set(['s-01', 's-02', 's-03', 's-04']));
  });

  it('письма чужой записи: адресаты писем и участники их комнат, без повторов', () => {
    const sessions = mailSessions(journal({ added: [letter('m-3', 's-04', ['s-01'], null), letter('m-4', 's-02', [], 'r-01')], rereadRooms: ['r-01'] }), map);
    expect([...sessions].sort()).toEqual(['s-01', 's-02', 's-03']);
  });

  it('комнаты нет в карте (удалена той же записью) — от неё никого', () => {
    expect(mailSessions(journal({ rereadRooms: ['r-99'] }), map)).toEqual(new Set());
  });

  it('человека нет в ответе: прямое письмо ему, его отметка прочтения, он среди членов комнаты', () => {
    const withHuman = { rooms: [{ id: 'r-01', members: [HUMAN, 's-01'], archivedAt: null }] } as unknown as WorkMap;
    expect(mailSessions(journal({ added: [letter('m-5', 's-01', [HUMAN], null)] }), withHuman)).toEqual(new Set());
    expect(mailSessions(journal({ reads: [{ id: 'm-5', reader: HUMAN, at: AT }] }), withHuman)).toEqual(new Set());
    expect(mailSessions(journal({ added: [letter('m-6', 's-01', [HUMAN, 's-02'], null)], rereadRooms: ['r-01'] }), withHuman)).toEqual(new Set(['s-01', 's-02']));
  });
});
