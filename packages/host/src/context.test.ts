import { describe, expect, it, vi } from 'vitest';
import { createHostContext } from './context.js';
import type { HostPaths } from './paths.js';

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
