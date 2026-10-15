/**
 * Вызовы сжатия из окна (спека 2026-10-15, 5.1): только по клику человека. Отказ хоста и ошибка — тост; `quiet`
 * гасит тосты отказов, когда итог показывает `Compact all` одним тостом.
 */

import { toast } from 'sonner';
import type { CompactResult, SessionRef } from '@parley/protocol';
import type { ParleyBridge } from '../../../shared/bridge.js';
import { decodeIpcError } from '../../../shared/ipc-error.js';
import { errorText, S } from '../../../shared/strings.js';

export async function compactSession(
  bridge: ParleyBridge,
  ref: SessionRef,
  label: string,
  instructions: string | null,
  options: { quiet?: boolean } = {},
): Promise<CompactResult | null> {
  try {
    const result = await bridge.call('sessions.compact', { ref, instructions });
    if (result.state === 'refused' && options.quiet !== true) {
      toast(result.reason === 'asleep' ? S.context.refusedAsleep(label) : S.context.refusedUnknownScreen(label));
    }
    return result;
  } catch (error) {
    toast(errorText(decodeIpcError(error).code, S.context.compactAction));
    return null;
  }
}

export async function cancelCompaction(bridge: ParleyBridge, ref: SessionRef): Promise<void> {
  try {
    await bridge.call('sessions.cancelCompact', { ref });
  } catch (error) {
    toast(errorText(decodeIpcError(error).code, S.context.cancelAction));
  }
}
