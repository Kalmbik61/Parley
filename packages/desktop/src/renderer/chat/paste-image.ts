/**
 * Скриншот из буфера обмена → файл в drops/ (main) → путь. Общий для поля «Chat» и поля комнаты:
 * отказы и «картинку не прочитать» показываются здесь же тостами, вызывающему остаётся только `null`.
 */

import { toast } from 'sonner';
import type { ParleyBridge } from '../../shared/bridge.js';
import { decodeIpcError } from '../../shared/ipc-error.js';
import { errorText, S } from '../../shared/strings.js';

export async function pasteClipboardImage(bridge: ParleyBridge): Promise<string | null> {
  try {
    const saved = await bridge.app.saveDropImage('clipboard');
    // Окно видело картинку в буфере, а main её не прочитал — без тоста вставка выглядела бы пустой.
    if (saved === null) toast.error(S.terminal.imageUnreadable);
    return saved;
  } catch (error) {
    const { code, message } = decodeIpcError(error);
    console.warn('[parley] saveDropImage', message);
    toast.error(code === 'drops:too-large' ? S.terminal.imageTooLarge : errorText(code, S.errors.actions.saveScreenshot));
    return null;
  }
}
