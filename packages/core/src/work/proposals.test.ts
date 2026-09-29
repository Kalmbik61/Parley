import { describe, expect, it } from 'vitest';
import { recipientsOf, unreadFor } from './letters.js';
import { addSession, transitionSession } from './map.js';
import {
  ACCEPTED_LETTER,
  ACCEPTED_LINE,
  PROPOSAL_TEXT_MAX,
  ProposalConflictError,
  resolveProposal,
  RETURNED_LETTER,
  setProposal,
} from './proposals.js';
import { addRoom, RoomRuleError } from './rooms.js';
import { HUMAN, SYSTEM, type Room, type WorkMap } from './types.js';

const emptyMap = (): WorkMap => ({
  schemaVersion: 2,
  work: {
    id: 'w-0001',
    title: 'Платежи',
    goal: '',
    status: 'active',
    createdAt: '2026-09-29T10:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
  },
  sessions: [],
  messages: [],
  rooms: [],
});

/** Три сессии и комната человека r-01 {s-01, s-02, s-03}; ведущий — s-01. */
function threeInRoom(lead: string | null = 's-01'): WorkMap {
  const map = emptyMap();
  for (const label of ['архитектор', 'бэкенд', 'ревью']) {
    addSession(map, { provider: 'claude', label, task: 'x' });
  }
  addRoom(map, { title: 'Возвраты', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead });
  return map;
}

const room = (map: WorkMap): Room => map.rooms[0] as Room;

describe('setProposal', () => {
  const AT = '2026-09-29T12:00:00.000Z';

  it('ведущий кладёт решение в слот комнаты: p-01, rev 0', () => {
    const map = threeInRoom();
    const result = setProposal(map, 'r-01', 's-01', 'Итог: сначала контракт, потом код.', AT);

    expect(result).toEqual({ proposalId: 'p-01', rev: 0 });
    expect(room(map).proposal).toEqual({
      id: 'p-01',
      from: 's-01',
      text: 'Итог: сначала контракт, потом код.',
      rev: 0,
      at: AT,
    });
  });

  it('решение — слот, а не письмо: лента остаётся как была', () => {
    const map = threeInRoom();
    setProposal(map, 'r-01', 's-01', 'решение');
    expect(map.messages).toEqual([]);
  });

  it('повтор до ответа человека заменяет текст: тот же id, rev + 1, новое время', () => {
    const map = threeInRoom();
    setProposal(map, 'r-01', 's-01', 'первая редакция', AT);
    const again = setProposal(map, 'r-01', 's-01', 'вторая редакция', '2026-09-29T12:05:00.000Z');
    const third = setProposal(map, 'r-01', 's-01', 'третья редакция', '2026-09-29T12:06:00.000Z');

    expect(again).toEqual({ proposalId: 'p-01', rev: 1 });
    expect(third).toEqual({ proposalId: 'p-01', rev: 2 });
    expect(room(map).proposal).toEqual({
      id: 'p-01',
      from: 's-01',
      text: 'третья редакция',
      rev: 2,
      at: '2026-09-29T12:06:00.000Z',
    });
  });

  it('после ответа человека — новый id, а не старый: p-<n> не переиспользуется', () => {
    const map = threeInRoom();
    setProposal(map, 'r-01', 's-01', 'раз');
    resolveProposal(map, 'r-01', 'p-01', 'return', 'мало');
    const next = setProposal(map, 'r-01', 's-01', 'два');
    expect(next).toEqual({ proposalId: 'p-02', rev: 0 });

    resolveProposal(map, 'r-01', 'p-02', 'accept');
    expect(setProposal(map, 'r-01', 's-01', 'три').proposalId).toBe('p-03');
  });

  it('счётчик — work.proposalSeq: id не откатывается, даже если решений в комнатах нет', () => {
    const map = threeInRoom();
    map.work.proposalSeq = 7;
    expect(setProposal(map, 'r-01', 's-01', 'x').proposalId).toBe('p-08');
    expect(map.work.proposalSeq).toBe(8);
  });

  it('ведущий по умолчанию (lead: null) — первый из members', () => {
    const map = threeInRoom(null);
    expect(() => setProposal(map, 'r-01', 's-02', 'x')).toThrow(RoomRuleError);
    expect(setProposal(map, 'r-01', 's-01', 'x').proposalId).toBe('p-01');
  });

  it('не ведущий — ошибка, слот не тронут', () => {
    const map = threeInRoom();
    expect(() => setProposal(map, 'r-01', 's-02', 'я тоже хочу')).toThrow(RoomRuleError);
    expect(() => setProposal(map, 'r-01', 's-02', 'я тоже хочу')).toThrow(/не ведущий/);
    expect(room(map).proposal).toBeNull();
    expect(map.work.proposalSeq).toBeUndefined();
  });

  it('участник и не участник комнаты — оба не ведущие', () => {
    const map = threeInRoom();
    addSession(map, { provider: 'claude', label: 'чужая', task: 'x' });
    expect(() => setProposal(map, 'r-01', 's-04', 'x')).toThrow(/не ведущий/);
    expect(() => setProposal(map, 'r-01', HUMAN, 'x')).toThrow(/не ведущий/);
  });

  it('закрытая комната (ни одного живого участника) — ошибка', () => {
    const map = threeInRoom();
    for (const id of ['s-01', 's-02', 's-03']) transitionSession(map, id, 'closed');
    expect(() => setProposal(map, 'r-01', 's-01', 'x')).toThrow(RoomRuleError);
    expect(() => setProposal(map, 'r-01', 's-01', 'x')).toThrow(/закрыта/);
    expect(room(map).proposal).toBeNull();
  });

  it('закрытая сессия-ведущий решения не приносит, хотя комната жива', () => {
    const map = threeInRoom();
    transitionSession(map, 's-01', 'closed');
    expect(() => setProposal(map, 'r-01', 's-01', 'x')).toThrow(/закрыта/);
  });

  it('нет комнаты — ошибка', () => {
    expect(() => setProposal(threeInRoom(), 'r-09', 's-01', 'x')).toThrow(/нет в карте/);
  });

  it('текст 1..10000: пустой и из одних пробелов — нет, 10000 знаков — да, 10001 — нет', () => {
    const map = threeInRoom();
    expect(() => setProposal(map, 'r-01', 's-01', '')).toThrow(/1–10000/);
    expect(() => setProposal(map, 'r-01', 's-01', ' \n\t')).toThrow(/1–10000/);
    expect(() => setProposal(map, 'r-01', 's-01', 'я'.repeat(PROPOSAL_TEXT_MAX + 1))).toThrow(/1–10000/);
    expect(PROPOSAL_TEXT_MAX).toBe(10_000);
    expect(setProposal(map, 'r-01', 's-01', 'я'.repeat(PROPOSAL_TEXT_MAX)).rev).toBe(0);
  });

  it('неудачный вызов номера не тратит: после ошибки первое решение всё равно p-01', () => {
    const map = threeInRoom();
    expect(() => setProposal(map, 'r-01', 's-02', 'x')).toThrow();
    expect(setProposal(map, 'r-01', 's-01', 'x').proposalId).toBe('p-01');
  });
});

describe('resolveProposal: accept', () => {
  const AT = '2026-09-29T13:00:00.000Z';

  function proposed(): WorkMap {
    const map = threeInRoom();
    setProposal(map, 'r-01', 's-01', 'Итог: контракт, код, тесты. @s02 — код, @s03 — ревью.');
    return map;
  }

  it('решение становится сообщением decision от ведущего всей комнате', () => {
    const map = proposed();
    const { messageId } = resolveProposal(map, 'r-01', 'p-01', 'accept', undefined, AT);

    const decision = map.messages.find((message) => message.id === messageId);
    expect(decision).toMatchObject({
      roomId: 'r-01',
      from: 's-01',
      to: [],
      kind: 'decision',
      text: 'Итог: контракт, код, тесты. @s02 — код, @s03 — ревью.',
      at: AT,
    });
    // Рассылка: адресаты — остальные участники, сам ведущий себе не пишет.
    expect(recipientsOf(decision as NonNullable<typeof decision>, map).sort()).toEqual(['s-02', 's-03']);
  });

  it('добавляется системное «You accepted the decision»; слот очищен', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'accept', undefined, AT);

    const system = map.messages.filter((message) => message.from === SYSTEM);
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ roomId: 'r-01', kind: 'note', text: ACCEPTED_LINE, at: AT });
    expect(ACCEPTED_LINE).toBe('You accepted the decision');
    expect(room(map).proposal).toBeNull();
  });

  it('ведущему уходит письмо о принятии — от человека, в комнате', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'accept', undefined, AT);

    const letters = map.messages.filter((message) => message.from === HUMAN);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ roomId: 'r-01', to: ['s-01'], kind: 'note', text: ACCEPTED_LETTER, at: AT });
    expect(ACCEPTED_LETTER).toBe('Decision accepted.');
    expect(unreadFor(map, 's-01').map((message) => message.text)).toEqual([ACCEPTED_LETTER]);
  });

  it('участники получают decision непрочитанным, а системную строку — нет: её никто не «читает»', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'accept');

    for (const id of ['s-02', 's-03']) {
      expect(unreadFor(map, id).map((message) => message.kind)).toEqual(['decision']);
    }
  });

  it('человек сам принял решение: его ни decision, ни системная строка непрочитанными не значатся', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'accept', undefined, AT);

    const shown = map.messages.filter((message) => message.from !== HUMAN);
    expect(shown).toHaveLength(2);
    for (const message of shown) expect(message.readBy).toEqual({ [HUMAN]: AT });
  });

  it('порядок ленты: decision, системная строка, письмо ведущему; ответ — id решения', () => {
    const map = proposed();
    const { messageId } = resolveProposal(map, 'r-01', 'p-01', 'accept');

    expect(map.messages.map((message) => message.from)).toEqual(['s-01', SYSTEM, HUMAN]);
    expect(messageId).toBe(map.messages[0]?.id);
  });

  it('ведущий сменился после предложения: решение подписано автором, письмо идёт нынешнему ведущему', () => {
    const map = proposed();
    // s-01 ушёл из комнаты, ведущим стал первый из оставшихся.
    room(map).members = ['s-02', 's-03'];
    room(map).lead = null;
    resolveProposal(map, 'r-01', 'p-01', 'accept');

    expect(map.messages.find((message) => message.kind === 'decision')?.from).toBe('s-01');
    expect(map.messages.find((message) => message.from === HUMAN)?.to).toEqual(['s-02']);
  });
});

describe('resolveProposal: return', () => {
  const AT = '2026-09-29T13:30:00.000Z';

  function proposed(): WorkMap {
    const map = threeInRoom();
    setProposal(map, 'r-01', 's-01', 'Сначала код, потом контракт.');
    return map;
  }

  it('письмо человека ведущему «Returned for rework: {заметка}»; слот очищен', () => {
    const map = proposed();
    const { messageId } = resolveProposal(map, 'r-01', 'p-01', 'return', 'Контракт первым.', AT);

    expect(map.messages).toHaveLength(1);
    expect(map.messages[0]).toMatchObject({
      id: messageId,
      roomId: 'r-01',
      from: HUMAN,
      to: ['s-01'],
      kind: 'note',
      text: 'Returned for rework: Контракт первым.',
      at: AT,
    });
    expect(room(map).proposal).toBeNull();
    expect(unreadFor(map, 's-01')).toHaveLength(1);
  });

  it('заметки нет или она из одних пробелов — «Returned for rework.»', () => {
    for (const note of [undefined, '', '  \n ']) {
      const map = proposed();
      resolveProposal(map, 'r-01', 'p-01', 'return', note);
      expect(map.messages[0]?.text).toBe('Returned for rework.');
    }
    expect(RETURNED_LETTER).toBe('Returned for rework');
  });

  it('пробелы вокруг заметки обрезаются, внутри остаются', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'return', '  сначала\nконтракт  ');
    expect(map.messages[0]?.text).toBe('Returned for rework: сначала\nконтракт');
  });

  it('возврат не пишет ни decision, ни системной строки', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'return', 'x');
    expect(map.messages.some((message) => message.kind === 'decision' || message.from === SYSTEM)).toBe(false);
  });

  it('после возврата ведущий предлагает заново — новый id', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'return', 'x');
    expect(setProposal(map, 'r-01', 's-01', 'переделал').proposalId).toBe('p-02');
  });
});

describe('resolveProposal: гонка', () => {
  function proposed(): WorkMap {
    const map = threeInRoom();
    setProposal(map, 'r-01', 's-01', 'решение');
    return map;
  }

  it('устаревший или чужой proposalId — ProposalConflictError, карта не тронута', () => {
    const map = proposed();
    const before = JSON.stringify(map);

    expect(() => resolveProposal(map, 'r-01', 'p-99', 'accept')).toThrow(ProposalConflictError);
    expect(() => resolveProposal(map, 'r-01', 'p-99', 'return', 'x')).toThrow(ProposalConflictError);
    expect(JSON.stringify(map)).toBe(before);
  });

  it('повтор на тот же proposalId — conflict, дублей сообщений нет', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'accept');
    const after = JSON.stringify(map);

    expect(() => resolveProposal(map, 'r-01', 'p-01', 'accept')).toThrow(ProposalConflictError);
    expect(() => resolveProposal(map, 'r-01', 'p-01', 'return', 'x')).toThrow(ProposalConflictError);
    expect(JSON.stringify(map)).toBe(after);
    expect(map.messages).toHaveLength(3);
  });

  it('решения в комнате нет вовсе — conflict, а не «нет комнаты»', () => {
    const map = threeInRoom();
    expect(() => resolveProposal(map, 'r-01', 'p-01', 'accept')).toThrow(ProposalConflictError);
  });

  it('переделка до ответа сохраняет id: Accept по свежей карточке проходит', () => {
    const map = proposed();
    setProposal(map, 'r-01', 's-01', 'решение, версия 2');
    resolveProposal(map, 'r-01', 'p-01', 'accept');
    expect(map.messages.find((message) => message.kind === 'decision')?.text).toBe('решение, версия 2');
  });

  it('старый id после нового решения — conflict: карточка успела устареть', () => {
    const map = proposed();
    resolveProposal(map, 'r-01', 'p-01', 'return', 'x');
    setProposal(map, 'r-01', 's-01', 'переделал');
    expect(() => resolveProposal(map, 'r-01', 'p-01', 'accept')).toThrow(ProposalConflictError);
    expect(room(map).proposal?.id).toBe('p-02');
  });

  it('нет комнаты — RoomRuleError (запрос неверен), не конфликт', () => {
    expect(() => resolveProposal(proposed(), 'r-09', 'p-01', 'accept')).toThrow(RoomRuleError);
  });
});
