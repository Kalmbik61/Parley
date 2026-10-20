import type { WebContents } from 'electron';
import { AGENT_LIMITS } from '@parley/protocol';
import { describe, expect, it, vi } from 'vitest';
import { AgentOpError } from './agent-errors.js';
import { createAgentScripts } from './agent-evaluate.js';

const contents = { id: 7, getURL: () => 'http://localhost:5173/' } as unknown as WebContents;
const signal = (): AbortSignal => new AbortController().signal;

interface Setup {
  evaluate?: unknown;
  resolve?: unknown;
  call?: unknown;
  evalMs?: number;
}

// Заглушка отправителя: 'hang' — промис, который не разрешается; 'terminatedAfter' — «Execution was terminated» через 30 мс.
function setup(options: Setup = {}) {
  const answer = (value: unknown): Promise<unknown> => {
    if (value === 'hang') return new Promise(() => undefined);
    if (value === 'terminatedAfter') {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              result: { type: 'object' },
              exceptionDetails: { text: 'Uncaught', exception: { description: 'Execution was terminated' } },
            }),
          30,
        ),
      );
    }
    return Promise.resolve(value);
  };
  const sender = {
    send: vi.fn(async (_id: number, method: string) =>
      method === 'DOM.resolveNode' ? options.resolve : {},
    ),
    sendAgentScript: vi.fn((_id: number, method: string) =>
      answer(method === 'Runtime.evaluate' ? options.evaluate : options.call),
    ),
  };
  const scripts = createAgentScripts({ inspector: sender as never, evalMs: options.evalMs });
  return { scripts, sender };
}

describe('скрипт агента в главном мире (решение владельца 2026-10-20; Фокус ревью 3)', () => {
  it('expression: Runtime.evaluate с returnByValue, awaitPromise, userGesture false и timeout; значение — JSON с типом', async () => {
    const { scripts, sender } = setup({ evaluate: { result: { type: 'object', value: { user: 'ann' } } } });
    const result = await scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'window.__state' }, null, signal());
    expect(sender.sendAgentScript).toHaveBeenCalledWith(7, 'Runtime.evaluate', {
      expression: 'window.__state',
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      timeout: AGENT_LIMITS.evalMs + 1000,
    });
    expect(result).toEqual({
      tab: 't1',
      url: 'http://localhost:5173/',
      outcome: 'value',
      text: '{"user":"ann"}',
      type: 'object',
      truncated: false,
    });
  });

  it('function без ref — вызов выражением; с ref — callFunctionOn над элементом, объект освобождается', async () => {
    const { scripts, sender } = setup({
      evaluate: { result: { type: 'number', value: 1 } },
      resolve: { object: { objectId: 'node-1' } },
      call: { result: { type: 'string', value: 'Ann' } },
    });
    await scripts.evaluateOf(contents, 't1', { tab: 't1', function: '() => 1' }, null, signal());
    expect(sender.sendAgentScript).toHaveBeenLastCalledWith(
      7,
      'Runtime.evaluate',
      expect.objectContaining({ expression: '(() => 1)()' }),
    );
    const value = await scripts.evaluateOf(contents, 't1', { tab: 't1', function: '(el) => el.value', ref: 'e3' }, 42, signal());
    expect(sender.send).toHaveBeenCalledWith(7, 'DOM.resolveNode', { backendNodeId: 42 });
    expect(sender.sendAgentScript).toHaveBeenLastCalledWith(7, 'Runtime.callFunctionOn', {
      objectId: 'node-1',
      functionDeclaration: '(el) => el.value',
      arguments: [{ objectId: 'node-1' }],
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    expect(sender.send).toHaveBeenCalledWith(7, 'Runtime.releaseObject', { objectId: 'node-1' });
    expect(value.text).toBe('"Ann"');
  });

  it('исключение страницы — ответ outcome exception с описанием; undefined — тип undefined', async () => {
    const thrown = setup({
      evaluate: {
        result: { type: 'object' },
        exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: foo is not defined\n    at <anonymous>:1:1' } },
      },
    });
    expect(await thrown.scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'foo' }, null, signal())).toMatchObject({
      outcome: 'exception',
      text: expect.stringContaining('ReferenceError: foo is not defined'),
      type: 'exception',
    });
    const nothing = setup({ evaluate: { result: { type: 'undefined' } } });
    expect(await nothing.scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'void 0' }, null, signal())).toMatchObject({
      outcome: 'value',
      text: 'undefined',
      type: 'undefined',
    });
  });

  it('значение не сериализуется в JSON — подсказка вернуть простое значение', async () => {
    const { scripts } = setup({ evaluate: { result: { type: 'object', description: 'HTMLDivElement' } } });
    const result = await scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'document.body' }, null, signal());
    expect(result).toMatchObject({
      outcome: 'value',
      type: 'object',
      text: 'The value could not be returned as JSON (HTMLDivElement); return a plain value.',
    });
  });

  it('ответ длиннее evalBytes — обрезан, truncated', async () => {
    const { scripts } = setup({ evaluate: { result: { type: 'string', value: 'x'.repeat(AGENT_LIMITS.evalBytes * 2) } } });
    const result = await scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 's' }, null, signal());
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(AGENT_LIMITS.evalBytes);
    expect(result.truncated).toBe(true);
  });

  it('обрезка не рвёт кодовую точку', async () => {
    const { scripts } = setup({ evaluate: { result: { type: 'string', value: 'я'.repeat(AGENT_LIMITS.evalBytes) } } });
    const result = await scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 's' }, null, signal());
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('�');
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(AGENT_LIMITS.evalBytes);
  });

  it('срок вышел или операцию оборвали (Stop) — Runtime.terminateExecution, отказ, результат не отдаётся', async () => {
    const { scripts, sender } = setup({ evaluate: 'hang', evalMs: 20 });
    await expect(scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'while (true) {}' }, null, signal())).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(sender.send).toHaveBeenCalledWith(7, 'Runtime.terminateExecution', {});
    const controller = new AbortController();
    const stopped = setup({ evaluate: 'hang' });
    const pending = stopped.scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'while (true) {}' }, null, controller.signal);
    controller.abort(new AgentOpError('access_denied', 'Stopped by the human (paused by the human).'));
    await expect(pending).rejects.toMatchObject({ code: 'access_denied' });
    expect(stopped.sender.send).toHaveBeenCalledWith(7, 'Runtime.terminateExecution', {});
  });

  it('операцию оборвали до вызова (пауза, выключатель, Stop) — скрипт в страницу не уходит вовсе (Фокус ревью 3; рецензия пачки 2)', async () => {
    const { scripts, sender } = setup({ evaluate: { result: { type: 'number', value: 1 } } });
    const controller = new AbortController();
    controller.abort(new AgentOpError('access_denied', 'The human paused agents in this browser panel (paused by the human).'));
    await expect(scripts.evaluateOf(contents, 't1', { tab: 't1', expression: '1' }, null, controller.signal)).rejects.toMatchObject({ code: 'access_denied' });
    expect(sender.sendAgentScript).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('«Execution was terminated» после своего срока — timeout, а не exception (рецензия M6)', async () => {
    const { scripts } = setup({ evaluate: 'terminatedAfter', evalMs: 20 });
    await expect(scripts.evaluateOf(contents, 't1', { tab: 't1', expression: 'while (true) {}' }, null, signal())).rejects.toMatchObject({
      code: 'timeout',
    });
  });
});
