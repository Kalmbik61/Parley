import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refKey } from '@parley/protocol';
import type { ConsentCard, FolderTrustCard, SessionRef } from '@parley/protocol';
import { createConsentsService } from './consents-service.js';
import type { ConsentsService, HeldLaunch } from './consents-service.js';

let home = '';
let services: ConsentsService[] = [];
let broadcasts: Array<{ event: string; data: unknown }> = [];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-consents-'));
  broadcasts = [];
});

afterEach(async () => {
  for (const service of services) service.stop();
  services = [];
  await rm(home, { recursive: true, force: true });
});

const ref = (sessionId: string): SessionRef => ({ projectPath: '/p', workId: 'w-01', sessionId });
const hold = (sessionId: string, mode: HeldLaunch['mode'] = 'launch'): HeldLaunch => ({
  ref: ref(sessionId),
  mode,
  by: 'S01',
});
const requestedBy: FolderTrustCard['requestedBy'] = { source: 'agent', sessionId: 's-01', workId: 'w-01', label: 'Ruslan' };
const input = { projectPath: '/p', folder: '/real/p', requestedBy };

function build(overrides: Partial<Parameters<typeof createConsentsService>[0]> = {}) {
  const trust = { grant: vi.fn(async () => undefined) };
  const continueLaunch = vi.fn<(hold: HeldLaunch) => Promise<void>>(async () => {});
  const refuseLaunch = vi.fn<(hold: HeldLaunch) => Promise<void>>(async () => {});
  const isLive = vi.fn<(ref: SessionRef) => Promise<boolean>>(async () => false);
  const switchAgent = vi.fn<(ref: SessionRef, request: { requestId: string; provider: string; model: string | null; by: string }) => Promise<unknown>>(async () => ({ outcome: 'started' }));
  const tellRequester = vi.fn<(ref: SessionRef, to: string, text: string) => Promise<void>>(async () => {});
  const noticeFailure = vi.fn<(ref: SessionRef, text: string) => void>();
  const service = createConsentsService({
    home,
    host: {
      broadcast: (event, data) => broadcasts.push({ event, data }),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
    trust,
    continueLaunch,
    refuseLaunch,
    isLive,
    switchAgent,
    tellRequester,
    noticeFailure,
    ...overrides,
  });
  services.push(service);
  return { service, trust, continueLaunch, refuseLaunch, isLive, switchAgent, tellRequester, noticeFailure };
}

describe('ConsentsService', () => {
  it('request: одна карточка на папку, второй запрос добавляет удержание', async () => {
    const { service, continueLaunch } = build();

    const first = service.request(input, hold('s-02'));
    const second = service.request({ ...input, requestedBy: { source: 'resume' } }, hold('s-03', 'resume'));

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ id: 'c-01', kind: 'folder-trust', folder: '/real/p', state: 'pending', requestedBy });
    expect(service.list()).toHaveLength(1);

    await service.decide(first.id, 'allow');
    expect(continueLaunch).toHaveBeenCalledTimes(2);
    expect(continueLaunch.mock.calls.map(([launch]) => refKey(launch.ref))).toEqual([
      refKey(ref('s-02')),
      refKey(ref('s-03')),
    ]);
  });

  it('request: тот же запуск дважды — одно удержание; другая папка — другая карточка', async () => {
    const { service, continueLaunch } = build();

    const card = service.request(input, hold('s-02'));
    service.request(input, hold('s-02'));
    const other = service.request({ ...input, projectPath: '/q', folder: '/real/q' }, hold('s-04'));

    expect(other.id).toBe('c-02');
    await service.decide(card.id, 'allow');
    expect(continueLaunch).toHaveBeenCalledTimes(1);
  });

  it('decide(allow): trust.grant один раз, continueLaunch по каждому удержанию, второе решение — applied: false', async () => {
    const { service, trust, continueLaunch, refuseLaunch } = build();
    const card = service.request(input, hold('s-02'));
    service.request(input, hold('s-03'));

    const result = await service.decide(card.id, 'allow', 'telegram');

    expect(result).toEqual({ applied: true, state: 'allowed' });
    expect(trust.grant).toHaveBeenCalledTimes(1);
    expect(trust.grant).toHaveBeenCalledWith('/real/p', 'telegram');
    expect(continueLaunch).toHaveBeenCalledTimes(2);
    expect(refuseLaunch).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);

    expect(await service.decide(card.id, 'deny')).toEqual({ applied: false, state: 'allowed' });
    expect(await service.decide(card.id, 'allow')).toEqual({ applied: false, state: 'allowed' });
    expect(trust.grant).toHaveBeenCalledTimes(1);
    expect(continueLaunch).toHaveBeenCalledTimes(2);
  });

  it('decide: по умолчанию доверие записывается от окна', async () => {
    const { service, trust } = build();
    const card = service.request(input, hold('s-02'));

    await service.decide(card.id, 'allow');

    expect(trust.grant).toHaveBeenCalledWith('/real/p', 'window');
  });

  it('decide(deny): refuseLaunch по каждому удержанию, доверие не пишется', async () => {
    const { service, trust, continueLaunch, refuseLaunch } = build();
    const card = service.request(input, hold('s-02'));
    service.request(input, hold('s-03'));

    expect(await service.decide(card.id, 'deny')).toEqual({ applied: true, state: 'denied' });

    expect(refuseLaunch).toHaveBeenCalledTimes(2);
    expect(trust.grant).not.toHaveBeenCalled();
    expect(continueLaunch).not.toHaveBeenCalled();
    expect(await service.decide(card.id, 'allow')).toEqual({ applied: false, state: 'denied' });
  });

  it('decide: два нажатия подряд, не дожидаясь первого, — доверие и запуски один раз', async () => {
    const { service, trust, continueLaunch } = build();
    const card = service.request(input, hold('s-02'));

    const [first, second] = await Promise.all([service.decide(card.id, 'allow'), service.decide(card.id, 'allow')]);

    expect([first.applied, second.applied].sort()).toEqual([false, true]);
    expect(trust.grant).toHaveBeenCalledTimes(1);
    expect(continueLaunch).toHaveBeenCalledTimes(1);
  });

  it('decide(allow): доверие не записалось — ошибка наружу, карточка остаётся ждать', async () => {
    const trust = { grant: vi.fn(async () => { throw new Error('диск полон'); }) };
    const { service, continueLaunch } = build({ trust });
    const card = service.request(input, hold('s-02'));

    await expect(service.decide(card.id, 'allow')).rejects.toThrow('диск полон');

    expect(service.list().map((item) => item.id)).toEqual([card.id]);
    expect(continueLaunch).not.toHaveBeenCalled();
  });

  it('сбой продолжения одного запуска не мешает остальным и не ломает ответ', async () => {
    const continueLaunch = vi.fn(async (launch: HeldLaunch) => {
      if (launch.ref.sessionId === 's-02') throw new Error('не поднялась');
    });
    const { service } = build({ continueLaunch });
    const card = service.request(input, hold('s-02'));
    service.request(input, hold('s-03'));

    expect(await service.decide(card.id, 'allow')).toEqual({ applied: true, state: 'allowed' });
    expect(continueLaunch).toHaveBeenCalledTimes(2);
  });

  it('незнакомая карточка — applied: false, а не ошибка', async () => {
    const { service } = build();

    expect((await service.decide('c-99', 'allow')).applied).toBe(false);
  });

  it('onChange: request даёт upsert, decide — removed; отписка работает', async () => {
    const { service } = build();
    const changes: Array<{ upsert: ConsentCard[]; removed: string[] }> = [];
    const off = service.onChange((change) => changes.push(change));

    const card = service.request(input, hold('s-02'));
    service.request(input, hold('s-03'));
    await service.decide(card.id, 'allow');
    off();
    service.request({ ...input, folder: '/real/q' }, hold('s-04'));

    expect(changes).toHaveLength(2);
    expect(changes[0]?.upsert.map((item) => item.id)).toEqual([card.id]);
    expect(changes[0]?.removed).toEqual([]);
    expect(changes[1]).toEqual({ upsert: [], removed: [card.id] });
    expect(broadcasts.map((item) => item.event)).toEqual(['consents.changed', 'consents.changed', 'consents.changed']);
  });

  it('consents.json: версия 1, права 0600, карточка и удержания переживают перезапуск сервиса', async () => {
    const first = build();
    const card = first.service.request(input, hold('s-02'));
    first.service.request(input, hold('s-03', 'resume'));
    first.service.stop();

    const file = path.join(home, 'consents.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number; cards: ConsentCard[]; holds: Record<string, HeldLaunch[]> };
    expect(raw.version).toBe(1);
    expect(raw.holds[card.id]).toHaveLength(2);

    const second = build();
    expect(second.service.list()).toEqual([card]);
    await second.service.decide(card.id, 'allow');
    expect(second.continueLaunch.mock.calls.map(([launch]) => [launch.ref.sessionId, launch.mode])).toEqual([
      ['s-02', 'launch'],
      ['s-03', 'resume'],
    ]);
  });

  it('после перезапуска удержание живой или закрытой сессии (isLive → true) отброшено, карточка без удержаний — тоже', async () => {
    const first = build();
    const card = first.service.request(input, hold('s-02'));
    first.service.request(input, hold('s-03'));
    const lonely = first.service.request({ ...input, projectPath: '/q', folder: '/real/q' }, hold('s-04'));
    first.service.stop();

    const isLive = vi.fn(async (target: SessionRef) => target.sessionId !== 's-03');
    const second = build({ isLive });
    await vi.waitFor(() => expect(second.service.list().map((item) => item.id)).toEqual([card.id]));

    await second.service.decide(card.id, 'allow');
    expect(second.continueLaunch.mock.calls.map(([launch]) => launch.ref.sessionId)).toEqual(['s-03']);
    expect(lonely.id).not.toBe(card.id);
  });

  it('повреждённый файл — пустое состояние, запись нового запроса работает', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(home, 'consents.json'), '{ не json', 'utf8');
    const { service } = build();

    expect(service.list()).toEqual([]);
    expect(service.request(input, hold('s-02')).id).toBe('c-01');
  });

  it('номера карточек сквозные и переживают перезапуск', async () => {
    const first = build();
    const card = first.service.request(input, hold('s-02'));
    await first.service.decide(card.id, 'deny');
    first.service.stop();

    const second = build();
    expect(second.service.request(input, hold('s-05')).id).toBe('c-02');
  });
});

describe('ConsentsService: карточка agent-switch', () => {
  const ask = {
    ref: ref('s-03'),
    provider: 'codex',
    providerLabel: 'Codex',
    model: 'gpt-6-astra',
    reason: 'the Claude limit is near',
    requestedBy: { sessionId: 's-01', label: 'Lead' },
  };

  it('requestSwitch: карточка ждёт, ничего не меняет; повтор той же просьбы — та же карточка', () => {
    const { service, switchAgent } = build();
    const first = service.requestSwitch(ask);
    expect(first).toMatchObject({ id: 'c-01', kind: 'agent-switch', state: 'pending', projectPath: '/p', ...ask });
    expect(service.requestSwitch({ ...ask, reason: 'again' }).id).toBe(first.id);
    expect(service.requestSwitch({ ...ask, provider: 'claude' }).id).not.toBe(first.id);
    expect(service.list()).toHaveLength(2);
    expect(switchAgent).not.toHaveBeenCalled();
    expect(broadcasts.filter((item) => item.event === 'consents.changed')).toHaveLength(2);
  });

  it('allow из любого канала: switchAgent с id карточки как requestId, от имени просившего', async () => {
    const { service, switchAgent, tellRequester } = build();
    const card = service.requestSwitch(ask);
    expect(await service.decide(card.id, 'allow', 'telegram')).toEqual({ applied: true, state: 'allowed' });
    await vi.waitFor(() => expect(switchAgent).toHaveBeenCalledTimes(1));
    expect(switchAgent).toHaveBeenCalledWith(ref('s-03'), { requestId: card.id, provider: 'codex', model: 'gpt-6-astra', force: true, by: 's-01' });
    expect(tellRequester).not.toHaveBeenCalled();
    expect(service.list()).toEqual([]);
    // Второе решение по той же карточке ничего не повторяет.
    expect((await service.decide(card.id, 'allow')).applied).toBe(false);
    expect(switchAgent).toHaveBeenCalledTimes(1);
  });

  it('карточка без модели: в switchAgent нет model (умолчание роли), force остаётся', async () => {
    const { service, switchAgent } = build();
    const card = service.requestSwitch({ ...ask, model: null });
    await service.decide(card.id, 'allow');
    await vi.waitFor(() => expect(switchAgent).toHaveBeenCalledTimes(1));
    const request = switchAgent.mock.calls[0]![1];
    expect(request).not.toHaveProperty('model');
    expect(request).toMatchObject({ force: true, provider: 'codex' });
  });

  it('deny: письмо просившему «@human declined», замены нет', async () => {
    const { service, switchAgent, tellRequester } = build();
    const card = service.requestSwitch(ask);
    expect(await service.decide(card.id, 'deny')).toEqual({ applied: true, state: 'denied' });
    await vi.waitFor(() => expect(tellRequester).toHaveBeenCalledTimes(1));
    expect(tellRequester).toHaveBeenCalledWith(ref('s-03'), 's-01', '@human declined to continue @s03 on Codex. Nothing changed.');
    expect(switchAgent).not.toHaveBeenCalled();
  });

  it('ошибка замены: письмо просившему и уведомление окну', async () => {
    const { service, tellRequester, noticeFailure } = build({
      switchAgent: async () => {
        throw new Error('Wait until the agent is idle');
      },
    });
    const card = service.requestSwitch(ask);
    await service.decide(card.id, 'allow');
    await vi.waitFor(() => expect(tellRequester).toHaveBeenCalledTimes(1));
    expect(tellRequester.mock.calls[0]?.[2]).toBe('@human allowed continuing @s03 on Codex, but the switch failed: Wait until the agent is idle');
    expect(noticeFailure).toHaveBeenCalledWith(ref('s-03'), 'continuing s-03 on Codex failed: Wait until the agent is idle');
  });

  it('карточка переживает перезапуск хоста, а карточка папки и карточка замены не смешиваются', async () => {
    const first = build();
    const card = first.service.requestSwitch(ask);
    first.service.request(input, hold('s-02'));
    first.service.stop();
    const second = build();
    expect(second.service.list().map((item) => [item.id, item.kind])).toEqual([[card.id, 'agent-switch'], ['c-02', 'folder-trust']]);
    await second.service.decide(card.id, 'allow');
    await vi.waitFor(() => expect(second.switchAgent).toHaveBeenCalledTimes(1));
    expect(second.continueLaunch).not.toHaveBeenCalled();
  });
});
