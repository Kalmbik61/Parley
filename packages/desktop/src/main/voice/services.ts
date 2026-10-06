/**
 * Службы голосового ввода main (спека 4.2): модели, распознавание, микрофон — за одним интерфейсом, чтобы IPC не знал,
 * настоящие они или подменные. Подмена (`PARLEY_VOICE=fake`, только E2E) «скачивает» сразу, микрофон даёт и
 * распознаёт в заданный текст — движок и сеть E2E не нужны.
 */
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  VOICE_MODELS,
  voiceModel,
  type DownloadProgress,
  type DownloadResult,
  type MicStatus,
  type TranscribeRequest,
  type TranscribeResult,
  type VoiceModelId,
} from '../../shared/voice-types.js';
import type { Engine } from './engine.js';
import type { ModelStore } from './models.js';
import { createTranscriber, runEngine, type RunEngine } from './transcribe.js';

export interface VoiceServices {
  listModels(): Promise<VoiceModelId[]>;
  download(id: VoiceModelId, onProgress: (progress: DownloadProgress) => void): Promise<DownloadResult>;
  cancel(id: VoiceModelId): void;
  remove(id: VoiceModelId): Promise<void>;
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  micStatus(): MicStatus;
  requestMic(): Promise<boolean>;
  openMicSettings(): Promise<void>;
}

export interface VoiceServiceDeps {
  models: ModelStore;
  engine(): Engine | null;
  mic: { status(): MicStatus; request(): Promise<boolean>; openSettings(): Promise<void> };
  log(message: string): void;
  run?: RunEngine;
  tmpDir?: string;
}

export function createVoiceServices(deps: VoiceServiceDeps): VoiceServices {
  const transcribe = createTranscriber({
    engine: deps.engine,
    modelPath: (id) => deps.models.path(id),
    exists: (file) => access(file).then(() => true, () => false),
    run: deps.run ?? runEngine,
    tmpDir: deps.tmpDir ?? tmpdir(),
    log: deps.log,
  });
  return {
    listModels: () => deps.models.list(),
    download: (id, onProgress) => deps.models.download(id, onProgress),
    cancel: (id) => deps.models.cancel(id),
    remove: (id) => deps.models.remove(id),
    transcribe,
    micStatus: () => deps.mic.status(),
    requestMic: () => deps.mic.request(),
    openMicSettings: () => deps.mic.openSettings(),
  };
}

export function createFakeVoiceServices(text: string): VoiceServices {
  const downloaded = new Set<VoiceModelId>();
  return {
    listModels: async () => VOICE_MODELS.filter((model) => downloaded.has(model.id)).map((model) => model.id),
    download: async (id, onProgress) => {
      const { bytes } = voiceModel(id);
      onProgress({ id, receivedBytes: bytes, totalBytes: bytes });
      downloaded.add(id);
      return { ok: true };
    },
    cancel: () => undefined,
    remove: async (id) => {
      downloaded.delete(id);
    },
    transcribe: async () => ({ text }),
    micStatus: () => 'granted',
    requestMic: async () => true,
    openMicSettings: async () => undefined,
  };
}
