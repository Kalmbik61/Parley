/**
 * Сохранение архива диагностики из окна (задача 12 плана диагностики хоста): тост успеха с действием
 * «Show in Finder» и тост ошибки по коду, без необработанного отказа.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { encodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';
import { createFakeBridge } from '../test-utils/fake-bridge.js';
import { PROFILE_SECONDS, runSaveDiagnostics } from './diagnostics-flow.js';

vi.mock('sonner', () => ({ toast: vi.fn() }));
afterEach(() => vi.mocked(toast).mockClear());

describe('runSaveDiagnostics', () => {
  it('профиль в окне — 20 секунд, как у хоста', () => {
    expect(PROFILE_SECONDS).toBe(20);
  });

  it('успех — toast saved с действием Show in Finder, которое зовёт showInFinder(file); результат возвращается', async () => {
    const bridge = createFakeBridge();
    const file = '/Users/test/Downloads/parley-diagnostics-20261016-123456.zip';
    bridge.setSaveDiagnosticsAnswer({ file, hostResponded: true });

    const result = await runSaveDiagnostics(bridge, { profile: false });

    expect(result).toEqual({ file, hostResponded: true });
    expect(bridge.saveDiagnosticsCalls).toEqual([{ profile: false }]);
    expect(toast).toHaveBeenCalledTimes(1);
    const [text, options] = vi.mocked(toast).mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(text).toBe(S.diagnostics.saved);
    expect(options.action.label).toBe(S.diagnostics.showInFinder);
    expect(bridge.revealedPaths).toEqual([]);
    options.action.onClick();
    expect(bridge.revealedPaths).toEqual([file]);
  });

  it('profile: true доходит до app.saveDiagnostics', async () => {
    const bridge = createFakeBridge();
    await runSaveDiagnostics(bridge, { profile: true });
    expect(bridge.saveDiagnosticsCalls).toEqual([{ profile: true }]);
  });

  it('ошибка — toast errorText по коду и null, тоста успеха нет', async () => {
    const bridge = createFakeBridge();
    bridge.setSaveDiagnosticsAnswer(encodeIpcError({ code: 'internal', message: 'сбой' }));

    const result = await runSaveDiagnostics(bridge, { profile: false });

    expect(result).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(errorText('internal', S.errors.actions.saveDiagnostics));
    expect(vi.mocked(toast).mock.calls[0]?.[0]).toBe("Couldn't save diagnostics: host error.");
  });
});
