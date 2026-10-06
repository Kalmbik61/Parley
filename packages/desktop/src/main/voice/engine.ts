/**
 * Где движок голосового ввода (спека 4.2): у собранного окна — `Contents/Resources/whisper` (кладёт
 * `scripts/fetch-whisper.mjs`, задача 12 плана); в разработке — `build/whisper/darwin-<arch>`, а без него
 * `whisper-cli` из PATH (`brew install whisper-cpp`) с моделью VAD из того же `build/whisper`. Так же ищется node
 * для хоста (`host-launcher.ts`).
 */
import { statSync } from 'node:fs';
import path from 'node:path';

/** Модель VAD Silero — та, что кладёт `fetch-whisper.mjs` (сверяет `fetch-whisper.test.ts`). */
export const VAD_MODEL_FILE = 'ggml-silero-v6.2.0.bin';

export interface Engine {
  bin: string;
  vadModel: string;
}

export interface EngineLocation {
  isPackaged: boolean;
  resourcesPath: string;
  /** `build/whisper/darwin-<arch>` пакета окна. */
  devDir: string;
  /** PATH login-оболочки человека (`shell-env.ts`). */
  pathEnv: string | undefined;
  isFile(candidate: string): boolean;
}

export function isFileSync(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveEngine(location: EngineLocation): Engine | null {
  if (location.isPackaged) {
    const dir = path.join(location.resourcesPath, 'whisper');
    const bin = path.join(dir, 'bin', 'whisper-cli');
    const vadModel = path.join(dir, VAD_MODEL_FILE);
    return location.isFile(bin) && location.isFile(vadModel) ? { bin, vadModel } : null;
  }
  const vadModel = path.join(location.devDir, VAD_MODEL_FILE);
  if (!location.isFile(vadModel)) return null;
  const local = path.join(location.devDir, 'bin', 'whisper-cli');
  if (location.isFile(local)) return { bin: local, vadModel };
  for (const dir of (location.pathEnv ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'whisper-cli');
    if (location.isFile(candidate)) return { bin: candidate, vadModel };
  }
  return null;
}
