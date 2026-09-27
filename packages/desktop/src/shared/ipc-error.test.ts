import { describe, expect, it } from 'vitest';
import { decodeIpcError, encodeIpcError, type IpcErrorInfo } from './ipc-error.js';

describe('encodeIpcError / decodeIpcError', () => {
  it('decodeIpcError(encodeIpcError(x)) равен x', () => {
    const x: IpcErrorInfo = { code: 'conflict', message: 'у работы есть живая сессия' };
    expect(decodeIpcError(encodeIpcError(x))).toEqual(x);
  });

  it('ошибка с префиксом Electron читается', () => {
    const inner = encodeIpcError({ code: 'not_found', message: 'нет живого PTY' });
    const wrapped = new Error(`Error invoking remote method 'host:call': Error: ${inner.message}`);
    expect(decodeIpcError(wrapped)).toEqual({ code: 'not_found', message: 'нет живого PTY' });
  });

  it('чужая ошибка (не наша encodeIpcError) → { code: "failed", message }', () => {
    const foreign = new Error('boom');
    expect(decodeIpcError(foreign)).toEqual({ code: 'failed', message: 'boom' });
  });

  it('объект с полем code напрямую (подставной мост) читается без JSON', () => {
    expect(decodeIpcError({ code: 'bad_request', message: 'plain' })).toEqual({
      code: 'bad_request',
      message: 'plain',
    });
  });

  it('строка без метки и без code → { code: "failed", message: <строка> }', () => {
    expect(decodeIpcError('plain string')).toEqual({ code: 'failed', message: 'plain string' });
  });

  it('мусор после метки harnas-error: не JSON — падает в общий разбор', () => {
    const broken = new Error('harnas-error:{not json');
    const result = decodeIpcError(broken);
    expect(result.code).toBe('failed');
    expect(result.message).toBe(broken.message);
  });
});
