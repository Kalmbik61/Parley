/**
 * Каналы `voice:*` (спека 4.2). Аргументы проверяются до служб: id модели — из каталога, язык — из списка Whisper
 * (он уходит в argv движка), PCM — чётной длины и не больше двух минут с запасом. Прогресс скачивания уходит
 * отправителю каналом `voice:progress`.
 */
import type { IpcMain } from 'electron';
import { isVoiceLanguage, isVoiceModelId, type VoiceModelId } from '../../shared/voice-types.js';
import { HostError } from '../host-connection.js';
import { withIpcError } from '../ipc.js';
import type { VoiceServices } from './services.js';

/** 2 минуты 5 секунд Int16 моно 16 кГц: предел записи окна (2 мин) с запасом. */
export const MAX_PCM_BYTES = 16_000 * 2 * 125;

export function toArrayBuffer(value: unknown): ArrayBuffer | null {
  let buffer: ArrayBuffer | null = null;
  if (value instanceof ArrayBuffer) buffer = value;
  else if (ArrayBuffer.isView(value)) buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  if (buffer === null || buffer.byteLength === 0 || buffer.byteLength % 2 !== 0 || buffer.byteLength > MAX_PCM_BYTES) return null;
  return buffer;
}

function modelId(value: unknown): VoiceModelId {
  if (!isVoiceModelId(value)) throw new HostError('bad_request', `unknown voice model: ${String(value)}`);
  return value;
}

interface Sender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export function registerVoiceIpc({ ipcMain, services }: { ipcMain: Pick<IpcMain, 'handle'>; services: VoiceServices }): void {
  ipcMain.handle('voice:list-models', withIpcError(() => services.listModels()));
  ipcMain.handle(
    'voice:download-model',
    withIpcError((event, id) => {
      const sender = (event as { sender: Sender }).sender;
      return services.download(modelId(id), (progress) => {
        if (!sender.isDestroyed()) sender.send('voice:progress', progress);
      });
    }),
  );
  ipcMain.handle('voice:cancel-download', withIpcError((_event, id) => services.cancel(modelId(id))));
  ipcMain.handle('voice:remove-model', withIpcError((_event, id) => services.remove(modelId(id))));
  ipcMain.handle(
    'voice:transcribe',
    withIpcError((_event, request) => {
      const source = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
      const pcm = toArrayBuffer(source.pcm);
      if (pcm === null || !isVoiceLanguage(source.language)) throw new HostError('bad_request', 'bad transcribe request');
      return services.transcribe({ pcm, language: source.language, model: modelId(source.model) });
    }),
  );
  ipcMain.handle('voice:mic-status', withIpcError(() => services.micStatus()));
  ipcMain.handle('voice:request-mic', withIpcError(() => services.requestMic()));
  ipcMain.handle('voice:open-mic-settings', withIpcError(() => services.openMicSettings()));
}
