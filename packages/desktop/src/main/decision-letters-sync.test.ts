/**
 * Страж синхронности ответа на решение с окном. Окно узнаёт, что решение вернули на доработку, по началу письма человека
 * ведущему (`renderer/attention/derive.ts#roomDecisionReturned`) и держит свои копии литералов `RETURNED_LETTER`,
 * `ACCEPTED_LETTER` и `HUMAN`: рендерер берёт из core только типы. Здесь письма пишет настоящий core — поменяет он слова
 * письма или их автора, тест упадёт и напомнит поправить окно, а не оставит уведомления молча врать «collected
 * positions» после возврата.
 *
 * Лежит в `main/` по той же причине, что `agent-guide-sync.test.ts`: только процесс main тянет `@harnas/core` значением.
 */

import { addRoom, addSession, HUMAN, resolveProposal, setProposal, type WorkMap } from '@harnas/core';
import { describe, expect, it } from 'vitest';
import { roomDecisionReturned } from '../renderer/attention/derive.js';

function roomOfThree(): WorkMap {
  const map: WorkMap = {
    schemaVersion: 2,
    work: { id: 'w-0001', title: 'W', goal: '', status: 'active', createdAt: '2026-09-30T10:00:00.000Z', updatedAt: '2026-09-30T10:00:00.000Z' },
    sessions: [],
    messages: [],
    rooms: [],
  };
  for (const label of ['a', 'b', 'c']) addSession(map, { provider: 'claude', label, task: 'x' });
  addRoom(map, { title: 'R', creator: HUMAN, members: ['s-01', 's-02', 's-03'], lead: 's-01' });
  return map;
}

describe('ответ человека на решение — слова core и признак окна', () => {
  it('возврат с заметкой и без — roomDecisionReturned видит его; принятие — нет', () => {
    const map = roomOfThree();

    const first = setProposal(map, 'r-01', 's-01', 'решение');
    resolveProposal(map, 'r-01', first.proposalId, 'return', { note: 'добавь тесты' });
    expect(roomDecisionReturned(map, 'r-01')).toBe(true);

    const second = setProposal(map, 'r-01', 's-01', 'решение 2');
    resolveProposal(map, 'r-01', second.proposalId, 'return');
    expect(roomDecisionReturned(map, 'r-01')).toBe(true);

    const third = setProposal(map, 'r-01', 's-01', 'решение 3');
    resolveProposal(map, 'r-01', third.proposalId, 'accept');
    expect(roomDecisionReturned(map, 'r-01')).toBe(false);
  });
});
