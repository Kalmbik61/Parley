import { describe, expect, it } from 'vitest';
import { bareEvent, type EventRecord, type WorkEntry } from '@parley/core';
import type { SessionRef } from '@parley/protocol';
import { findInterrupted } from './interrupted.js';

const event = (name: string, notificationType: string | null = null): EventRecord => ({
  ...bareEvent('2026-09-26T00:00:00.000Z', name),
  notificationType,
});

const entryOf = (sessions: Array<{ id: string; lifecycle: string; autoSleep?: object | null; queued?: object | null }>): WorkEntry =>
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

  it('усыплённая хостом посреди хода не прервана: поднимать её человеку не предлагают', async () => {
    const slept = { reason: 'idle', at: '2026-10-31T12:00:00.000Z', waitTarget: null };
    const entry = entryOf([
      // Хост остановил процесс, пока агент ждал в wait_for: последний хук хода не Stop, но это не обрыв.
      { id: 's-01', lifecycle: 'sleeping', autoSleep: slept },
      // Остановил человек посреди хода — прервана, как раньше; пустой ключ сна ничего не меняет.
      { id: 's-02', lifecycle: 'sleeping' },
      { id: 's-03', lifecycle: 'sleeping', autoSleep: null },
    ]);

    const refs = await findInterrupted([entry], async () => [event('UserPromptSubmit'), event('ParleyWaitStart')]);

    expect(refs.map((ref) => ref.sessionId)).toEqual(['s-02', 's-03']);
  });

  it('сессия в очереди машины не прервана: её продолжит очередь, поднимать её человеку не предлагают', async () => {
    const queued = { class: 'agent', mode: 'resume', by: 'wake', at: '2026-10-31T12:00:00.000Z', reason: 'machine-limit', live: 18, limit: 18 };
    const entry = entryOf([
      // Запуск ждёт слота: журнал оборван посреди хода, но процесса не было и поднимет её очередь.
      { id: 's-01', lifecycle: 'sleeping', queued },
      { id: 's-02', lifecycle: 'sleeping' },
      // Пустой ключ очереди ничего не меняет.
      { id: 's-03', lifecycle: 'sleeping', queued: null },
    ]);

    const refs = await findInterrupted([entry], async () => [event('UserPromptSubmit')]);

    expect(refs.map((ref) => ref.sessionId)).toEqual(['s-02', 's-03']);
  });

  it('отметка хоста ParleyPermissionAnswered после Stop сессию прерванной не делает', async () => {
    const entry = entryOf([
      { id: 's-01', lifecycle: 'sleeping' },
      { id: 's-02', lifecycle: 'sleeping' },
    ]);
    const journals: Record<string, readonly EventRecord[]> = {
      's-01': [event('UserPromptSubmit'), event('Stop'), event('ParleyPermissionAnswered')],
      // Отметка посреди хода его не заканчивает: прервана по-прежнему.
      's-02': [event('UserPromptSubmit'), event('ParleyPermissionAnswered')],
    };

    const refs = await findInterrupted([entry], async (ref: SessionRef) => journals[ref.sessionId] ?? null);

    expect(refs).toEqual([{ projectPath: '/tmp/p', workId: 'w-01', sessionId: 's-02' }]);
  });

  it('сессия codex без строк notify в журнале событий не считается прерванной', async () => {
    // У Codex журнал `events/` не пишет никто (`notify` не подменяется): журнала нет (null) или он пуст.
    const entry = entryOf([{ id: 's-01', lifecycle: 'sleeping' }]);

    expect(await findInterrupted([entry], async () => null)).toEqual([]);
    expect(await findInterrupted([entry], async () => [])).toEqual([]);
  });

  it('архивная работа в список не идёт: её сессии до Reopen не поднимаются', async () => {
    const entry = {
      projectPath: '/tmp/p',
      map: { work: { id: 'w-01', status: 'archived' }, sessions: [{ id: 's-01', lifecycle: 'sleeping' }] },
    } as unknown as WorkEntry;

    const refs = await findInterrupted([entry], async () => [event('UserPromptSubmit')]);

    expect(refs).toEqual([]);
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

  describe('субагенты (Parley 0.2.0)', () => {
    const hook = (name: string, extra: Partial<EventRecord> = {}): EventRecord => ({
      ...event(name),
      ...extra,
    });
    const running = (id: string, type = 'subagent') => ({
      id,
      type,
      status: 'running',
      agentType: 'general-purpose',
      description: `задача ${id}`,
    });
    const interruptedIds = async (journals: Record<string, readonly EventRecord[] | null>) => {
      const entry = entryOf(Object.keys(journals).map((id) => ({ id, lifecycle: 'sleeping' })));
      const refs = await findInterrupted(
        [entry],
        async (ref: SessionRef) => journals[ref.sessionId] ?? null,
      );
      return refs.map((ref) => ref.sessionId);
    };

    it('служебные SubagentStart и SubagentStop после Stop не делают простаивающую сессию прерванной', async () => {
      expect(
        await interruptedIds({
          // Помощник Claude Code остановился уже после конца хода: его события — не ход.
          's-01': [
            event('UserPromptSubmit'),
            event('Stop'),
            hook('SubagentStop', { agentId: 'helper' }),
            hook('SubagentStart', { agentId: 'helper-2' }),
            hook('SubagentStop', { agentId: 'helper-2' }),
          ],
          // Посреди хода субагент ещё работает: последнее событие хода — UserPromptSubmit, прервана.
          's-02': [event('UserPromptSubmit'), hook('SubagentStart', { agentId: 'a' })],
        }),
      ).toEqual(['s-02']);
    });

    it('лид закончил ход, а фоновые субагенты работали, — хост упал: сессия прервана', async () => {
      expect(
        await interruptedIds({
          's-01': [
            event('UserPromptSubmit'),
            hook('Stop', { backgroundTasks: [running('a')] }),
            hook('SubagentStop', { agentId: 'helper' }),
          ],
        }),
      ).toEqual(['s-01']);
    });

    it('фоновые успели закончиться (снимок пуст, остановка по id, не субагенты) — не прервана', async () => {
      expect(
        await interruptedIds({
          's-01': [
            event('UserPromptSubmit'),
            hook('Stop', { backgroundTasks: [running('a')] }),
            hook('SubagentStop', { agentId: 'a', backgroundTasks: [] }),
          ],
          // Снимок последнего события отстал, но остановка своего id была.
          's-02': [
            event('UserPromptSubmit'),
            hook('Stop', { backgroundTasks: [running('a')] }),
            hook('SubagentStop', { agentId: 'a', backgroundTasks: [running('a')] }),
          ],
          // Фоновая команда — не субагент: работа лида не прервана.
          's-03': [
            event('UserPromptSubmit'),
            hook('Stop', { backgroundTasks: [running('sh', 'shell')] }),
          ],
          // Работающих нет вовсе.
          's-04': [event('UserPromptSubmit'), hook('Stop', { backgroundTasks: [] })],
        }),
      ).toEqual([]);
    });

    it('SessionEnd — штатный выход: фоновые в его снимке работу лида не «прерывают»', async () => {
      expect(
        await interruptedIds({
          's-01': [
            event('UserPromptSubmit'),
            hook('Stop', { backgroundTasks: [running('a')] }),
            hook('SessionEnd', { backgroundTasks: [running('a')] }),
          ],
        }),
      ).toEqual([]);
    });

    it('давность не важна: фоновые работали при падении, и пусть журнал молчит неделю — прервана', async () => {
      const old = (name: string, extra: Partial<EventRecord> = {}): EventRecord => ({
        ...hook(name, extra),
        at: '2026-01-01T00:00:00.000Z',
      });
      expect(
        await interruptedIds({
          's-01': [old('UserPromptSubmit'), old('Stop', { backgroundTasks: [running('a')] })],
        }),
      ).toEqual(['s-01']);
    });
  });
});
