import { describe, expect, it, vi } from 'vitest';
import { encodeLine } from '@parley/protocol';
import type { Client } from './client.js';
import { createHostContext } from './context.js';
import type { HostPaths } from './paths.js';

// Шпион кодировщика кадров: рассылка с готовой строкой не должна кодировать событие ещё раз.
vi.mock('@parley/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@parley/protocol')>();
  return { ...actual, encodeLine: vi.fn(actual.encodeLine) };
});

const handle = () => {
  const onIdleChange = vi.fn<(idle: boolean) => void>();
  const created = createHostContext({
    version: '0.0.0',
    paths: { dir: '', socket: '', token: '', pid: '', log: '' } as HostPaths,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    onIdleChange,
    registerShutdownHook: () => {},
    requestShutdown: async () => {},
  });
  return { ...created, onIdleChange };
};

describe('HostContext.hold', () => {
  it('hold("telegram", true) держит хост от простоя и не считается живой сессией', () => {
    const { context, onIdleChange } = handle();
    context.hold('telegram', true);
    expect(onIdleChange).toHaveBeenLastCalledWith(false);
    expect(context.liveSessions()).toBe(0);

    context.hold('telegram', false);
    expect(onIdleChange).toHaveBeenLastCalledWith(true);
  });

  it('простой наступает, только когда нет клиентов, занятых ключей и удержаний', () => {
    const { context, onIdleChange } = handle();
    context.busy('pty:1', true);
    context.hold('telegram', true);
    expect(context.liveSessions()).toBe(1);

    context.busy('pty:1', false);
    expect(onIdleChange).toHaveBeenLastCalledWith(false);
    context.hold('telegram', false);
    expect(onIdleChange).toHaveBeenLastCalledWith(true);
  });
});

describe('HostContext.broadcast', () => {
  const fakeClient = (id: string, withSendLine: boolean): Client => ({
    id,
    name: id,
    features: new Set<string>(),
    send: vi.fn(() => true),
    ...(withSendLine ? { sendLine: vi.fn(() => true) } : {}),
    writableLength: () => 0,
    close: () => {},
  });

  it('broadcast с готовой строкой шлёт её как есть: оба клиента получают одну строку, кодировщик не вызван', () => {
    const { context, addClient } = handle();
    const first = fakeClient('a', true);
    const second = fakeClient('b', true);
    addClient(first);
    addClient(second);
    vi.mocked(encodeLine).mockClear();

    const line = '{"event":"rooms.mail","data":{}}\n';
    context.broadcast('wake.changed', { paused: false }, undefined, line);

    expect(first.sendLine).toHaveBeenCalledTimes(1);
    expect(first.sendLine).toHaveBeenCalledWith(line);
    expect(second.sendLine).toHaveBeenCalledTimes(1);
    expect(second.sendLine).toHaveBeenCalledWith(line);
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).not.toHaveBeenCalled();
    expect(encodeLine).not.toHaveBeenCalled();
  });

  it('клиент без sendLine получает send({event, data}), даже когда строка готова', () => {
    const { context, addClient } = handle();
    const old = fakeClient('old', false);
    const modern = fakeClient('new', true);
    addClient(old);
    addClient(modern);

    context.broadcast('wake.changed', { paused: true }, undefined, '{"event":"wake.changed"}\n');

    expect(old.send).toHaveBeenCalledTimes(1);
    expect(old.send).toHaveBeenCalledWith({ event: 'wake.changed', data: { paused: true } });
    expect(modern.sendLine).toHaveBeenCalledTimes(1);
    expect(modern.send).not.toHaveBeenCalled();
  });

  it('без строки и с фильтром only: send({event, data}) только тем, кого пропустил фильтр', () => {
    const { context, addClient } = handle();
    const wanted = fakeClient('wanted', true);
    const other = fakeClient('other', true);
    addClient(wanted);
    addClient(other);

    context.broadcast('wake.changed', { paused: false }, (client) => client.id === 'wanted');

    expect(wanted.send).toHaveBeenCalledTimes(1);
    expect(wanted.send).toHaveBeenCalledWith({ event: 'wake.changed', data: { paused: false } });
    expect(wanted.sendLine).not.toHaveBeenCalled();
    expect(other.send).not.toHaveBeenCalled();
    expect(other.sendLine).not.toHaveBeenCalled();
  });
});
