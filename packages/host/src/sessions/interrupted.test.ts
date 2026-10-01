import { describe, expect, it } from 'vitest';
import { bareEvent, type EventRecord, type WorkEntry } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { findInterrupted } from './interrupted.js';

const event = (name: string, notificationType: string | null = null): EventRecord => ({
  ...bareEvent('2026-09-26T00:00:00.000Z', name),
  notificationType,
});

const entryOf = (sessions: Array<{ id: string; lifecycle: string }>): WorkEntry =>
  ({
    projectPath: '/tmp/p',
    map: { work: { id: 'w-01' }, sessions },
  }) as unknown as WorkEntry;

describe('findInterrupted', () => {
  it('9: журнал обрывается на UserPromptSubmit — в списке; на Stop — нет', async () => {
    const journals: Record<string, readonly EventRecord[] | null> = {
      // Прервана посреди хода.
      's-01': [event('SessionStart'), event('UserPromptSubmit')],
      // Ход закончен штатно.
      's-02': [event('SessionStart'), event('UserPromptSubmit'), event('Stop')],
      // Простой после Stop — всё ещё не прервана.
      's-03': [event('UserPromptSubmit'), event('Stop'), event('Notification', 'idle_prompt')],
      // Журнала нет — прерванной её не назвать.
      's-04': null,
      // Живая: не спящая, в список не идёт, даже если журнал оборван.
      's-05': [event('UserPromptSubmit')],
      // Сессия вышла сама.
      's-06': [event('UserPromptSubmit'), event('SessionEnd')],
    };
    const entry = entryOf([
      { id: 's-01', lifecycle: 'sleeping' },
      { id: 's-02', lifecycle: 'sleeping' },
      { id: 's-03', lifecycle: 'sleeping' },
      { id: 's-04', lifecycle: 'sleeping' },
      { id: 's-05', lifecycle: 'active' },
      { id: 's-06', lifecycle: 'sleeping' },
    ]);

    const refs = await findInterrupted([entry], async (ref: SessionRef) => journals[ref.sessionId] ?? null);

    expect(refs).toEqual([{ projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-01' }]);
  });

  it('строки ожидания wait_for (их пишет MCP-сервер, не Claude) конец хода не меняют', async () => {
    const journals: Record<string, readonly EventRecord[] | null> = {
      // Ход закончился, а запоздалый конец ожидания дописан после Stop: не прервана.
      's-01': [event('UserPromptSubmit'), event('Stop'), event('ParleyWaitEnd')],
      // Хост упал посреди ожидания: последний хук — UserPromptSubmit, прервана.
      's-02': [event('UserPromptSubmit'), event('ParleyWaitStart')],
      // Начало и конец ожидания внутри хода, дальше ход оборван.
      's-03': [
        event('UserPromptSubmit'),
        event('ParleyWaitStart'),
        event('ParleyWaitEnd'),
        event('SubagentStart'),
      ],
    };
    const entry = entryOf([
      { id: 's-01', lifecycle: 'sleeping' },
      { id: 's-02', lifecycle: 'sleeping' },
      { id: 's-03', lifecycle: 'sleeping' },
    ]);

    const refs = await findInterrupted(
      [entry],
      async (ref: SessionRef) => journals[ref.sessionId] ?? null,
    );

    expect(refs.map((ref) => ref.sessionId)).toEqual(['s-02', 's-03']);
  });
});
