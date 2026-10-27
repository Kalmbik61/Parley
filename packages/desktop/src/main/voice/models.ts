/**
 * Модели Whisper на диске (спека 4.2, 6.2): `~/.parley/desktop/voice/models` рядом с `ui.json`; веса нейроголоса
 * (план 3b, B04) — тем же хранилищем в `~/.parley/desktop/voice/tts`. Скачивание —
 * `net.fetch` main (системный прокси, переадресации Hugging Face на CDN) в `<файл>.part`, sha256 по ходу потока,
 * затем переименование. Обрыв, отмена и чужой sha256 удаляют `.part`; докачки нет. Одна модель качается один раз:
 * повторный вызов получает тот же промис.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import {
  VOICE_MODELS,
  voiceModelUrl,
  type DownloadProgress,
  type DownloadResult,
  type VoiceModel,
  type VoiceModelId,
} from '../../shared/voice-types.js';

export function voiceModelsDir(home: string = parleyHome()): string {
  return path.join(home, 'desktop', 'voice', 'models');
}

export function ttsModelsDir(home: string = parleyHome()): string {
  return path.join(home, 'desktop', 'voice', 'tts');
}

export async function freeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return info.bavail * info.bsize;
}

/**
 * Запись каталога, которую умеет качать хранилище: модель Whisper (`VoiceModel`) или TTS (`TtsModel`). Своего `url`
 * у Whisper нет — его строит `voiceModelUrl`; у TTS адрес закреплён на коммит и лежит в записи.
 */
export interface StoredModel {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  url?: string;
}

export type ModelProgress<Id extends string> = Omit<DownloadProgress, 'id'> & { id: Id };

export interface ModelStoreDeps<M extends StoredModel = VoiceModel> {
  dir: string;
  fetch(url: string, init: { signal: AbortSignal }): Promise<Response>;
  freeBytes(dir: string): Promise<number>;
  /** Каталог моделей; по умолчанию `VOICE_MODELS` (Whisper). */
  catalog?: readonly M[];
}

export interface ModelStore<Id extends string = VoiceModelId> {
  list(): Promise<Id[]>;
  path(id: Id): string;
  download(id: Id, onProgress: (progress: ModelProgress<Id>) => void): Promise<DownloadResult>;
  cancel(id: Id): void;
  remove(id: Id): Promise<void>;
}

/** Прогресс — не чаще раза на мегабайт: окну не нужны тысячи событий на модель в полгигабайта. */
const PROGRESS_STEP = 1024 * 1024;
/** Запас места сверх размера модели (спека 6.2). */
const DISK_MARGIN = 1.1;

export function createModelStore<M extends StoredModel = VoiceModel>(deps: ModelStoreDeps<M>): ModelStore<M['id']> {
  // Без каталога `M` остаётся параметром по умолчанию — `VoiceModel`.
  const catalog = deps.catalog ?? (VOICE_MODELS as readonly StoredModel[] as readonly M[]);
  const inflight = new Map<M['id'], { controller: AbortController; promise: Promise<DownloadResult> }>();

  const modelOf = (id: M['id']): M => {
    const found = catalog.find((model) => model.id === id);
    if (found === undefined) throw new Error(`unknown voice model: ${id}`);
    return found;
  };
  const filePath = (id: M['id']): string => path.join(deps.dir, modelOf(id).file);

  const fetchModel = async (
    model: M,
    controller: AbortController,
    onProgress: (p: ModelProgress<M['id']>) => void,
  ): Promise<DownloadResult> => {
    await mkdir(deps.dir, { recursive: true });
    const needBytes = Math.ceil(model.bytes * DISK_MARGIN);
    if ((await deps.freeBytes(deps.dir)) < needBytes) return { error: 'disk_full', needBytes };
    const final = path.join(deps.dir, model.file);
    const part = `${final}.part`;
    try {
      const response = await deps.fetch(model.url ?? voiceModelUrl(model as VoiceModel), { signal: controller.signal });
      if (!response.ok || response.body === null) return { error: 'network' };
      const hash = createHash('sha256');
      let received = 0;
      let reported = 0;
      const out = await open(part, 'w', 0o600);
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await out.write(chunk);
          hash.update(chunk);
          received += chunk.length;
          if (received - reported >= PROGRESS_STEP) {
            reported = received;
            onProgress({ id: model.id, receivedBytes: received, totalBytes: model.bytes });
          }
        }
      } finally {
        await out.close();
      }
      onProgress({ id: model.id, receivedBytes: received, totalBytes: model.bytes });
      if (received !== model.bytes || hash.digest('hex') !== model.sha256) {
        await rm(part, { force: true });
        return { error: 'corrupted' };
      }
      await rename(part, final);
      return { ok: true };
    } catch {
      await rm(part, { force: true });
      return { error: controller.signal.aborted ? 'cancelled' : 'network' };
    }
  };

  return {
    async list() {
      const present: M['id'][] = [];
      for (const model of catalog) {
        const info = await stat(path.join(deps.dir, model.file)).catch(() => null);
        if (info !== null && info.isFile() && info.size === model.bytes) present.push(model.id);
      }
      return present;
    },
    path: filePath,
    download(id, onProgress) {
      const running = inflight.get(id);
      if (running !== undefined) return running.promise;
      const controller = new AbortController();
      const promise = fetchModel(modelOf(id), controller, onProgress).finally(() => inflight.delete(id));
      inflight.set(id, { controller, promise });
      return promise;
    },
    cancel(id) {
      inflight.get(id)?.controller.abort();
    },
    async remove(id) {
      await rm(filePath(id), { force: true });
    },
  };
}
