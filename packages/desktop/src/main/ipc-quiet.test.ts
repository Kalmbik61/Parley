import { describe, expect, it, vi } from 'vitest';
import { encodeIpcError } from '../shared/ipc-error.js';
import { isExpectedIpcRefusal, quietExpectedIpcRefusals } from './ipc-quiet.js';

// Ровно так Electron 44 зовёт console.error на отказ обработчика `ipcMain.handle` (проверено живым
// запуском, fix-lane-post п. 4): строка с именем канала и сам брошенный Error.
const electronLine = (channel: string, error: unknown): unknown[] => [`Error occurred in handler for '${channel}':`, error];

describe('isExpectedIpcRefusal', () => {
  it('ожидаемые коды отказа — тихо: bad_request, not_found, conflict, files:denied, drops:too-large', () => {
    for (const code of ['bad_request', 'not_found', 'conflict', 'files:denied', 'drops:too-large']) {
      expect(isExpectedIpcRefusal(electronLine('files:grep', encodeIpcError({ code, message: 'm' })))).toBe(true);
    }
  });

  it('сбои печатаются: failed, internal и прочие коды протокола', () => {
    for (const code of ['failed', 'internal', 'unauthorized', 'protocol_mismatch', 'unknown_method']) {
      expect(isExpectedIpcRefusal(electronLine('host:call', encodeIpcError({ code, message: 'm' })))).toBe(false);
    }
  });

  it('чужая ошибка без метки и чужие строки console.error печатаются', () => {
    expect(isExpectedIpcRefusal(electronLine('files:grep', new Error('boom')))).toBe(false);
    expect(isExpectedIpcRefusal(electronLine('files:grep', 'bad_request'))).toBe(false);
    expect(isExpectedIpcRefusal(['[parley] что-то', encodeIpcError({ code: 'bad_request', message: 'm' })])).toBe(false);
    expect(isExpectedIpcRefusal([encodeIpcError({ code: 'bad_request', message: 'm' })])).toBe(false);
  });
});

describe('quietExpectedIpcRefusals', () => {
  it('глушит только ожидаемый отказ, остальное отдаёт прежнему console.error как есть', () => {
    const error = vi.fn();
    const target = { error };
    quietExpectedIpcRefusals(target);

    target.error(...electronLine('files:grep', encodeIpcError({ code: 'bad_request', message: 'regex' })));
    expect(error).not.toHaveBeenCalled();

    const failure = encodeIpcError({ code: 'failed', message: 'boom' });
    target.error(...electronLine('files:grep', failure));
    target.error('[parley] other', 1);
    expect(error.mock.calls).toEqual([["Error occurred in handler for 'files:grep':", failure], ['[parley] other', 1]]);
  });
});
