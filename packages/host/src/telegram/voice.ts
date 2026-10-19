/**
 * Голосовые из Telegram (план B, задача 9): скачать → декодировать OGG/Opus (WASM) → 16 кГц моно WAV →
 * тот же `whisper-cli`, что в окне. Звук не покидает Mac; временные файлы 0600 удаляются в `finally`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BotApi } from './api.js';
import { downsampleTo16k, pcm16ToWav } from './wav.js';

export const VOICE_MAX_SECONDS = 120;
export const VOICE_MAX_BYTES = 20 * 1024 * 1024;

/** Ровно то, что собирает окно (`desktop/src/main/voice/transcribe.ts`). */
export function whisperArgs(engine: { bin: string; vadModel: string }, input: { model: string; wav: string; language: string }): string[] {
  return ['-m', input.model, '-f', input.wav, '-l', input.language, '-nt', '-np', '-sns', '--vad', '-vm', engine.vadModel];
}

export interface VoiceDeps {
  api: Pick<BotApi, 'call' | 'download'>;
  tmpDir: string;
  engine: { bin: string; vadModel: string } | null;
  language(): string;
  model(): string | null;
  decode?(bytes: Uint8Array): Promise<{ channelData: Float32Array[]; sampleRate: number }>;
  spawn?: typeof nodeSpawn;
  log(line: string): void;
}

export type VoiceResult = { text: string } | { error: 'off' | 'too-long' | 'failed' | 'no-speech' };

const defaultDecode: NonNullable<VoiceDeps['decode']> = async (bytes) => {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const decoder = new OggOpusDecoder();
  try {
    await decoder.ready;
    const { channelData, sampleRate } = await decoder.decodeFile(bytes);
    return { channelData, sampleRate };
  } finally {
    decoder.free();
  }
};

export function createVoiceTranscriber(deps: VoiceDeps): { transcribe(fileId: string, durationSec: number): Promise<VoiceResult> } {
  const decode = deps.decode ?? defaultDecode;
  const spawn = deps.spawn ?? nodeSpawn;
  /** Расшифровки идут по одной. */
  let tail: Promise<unknown> = Promise.resolve();

  const run = (bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> =>
    new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-256_000);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-64_000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });

  const job = async (fileId: string, durationSec: number, engine: { bin: string; vadModel: string }, model: string): Promise<VoiceResult> => {
    const id = randomUUID();
    const oga = path.join(deps.tmpDir, `${id}.oga`);
    const wav = path.join(deps.tmpDir, `${id}.wav`);
    try {
      await mkdir(deps.tmpDir, { recursive: true, mode: 0o700 });
      const info = await deps.api.call<{ file_path?: string }>('getFile', { file_id: fileId });
      if (typeof info.file_path !== 'string') throw new Error('getFile returned no file_path');
      await deps.api.download(info.file_path, oga, VOICE_MAX_BYTES);
      const decoded = await decode(await readFile(oga));
      const channels = decoded.channelData;
      const first = channels[0];
      if (first === undefined) throw new Error('decoder returned no channels');
      const mono = new Float32Array(first.length);
      for (const channel of channels) for (let i = 0; i < mono.length; i += 1) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
      await writeFile(wav, pcm16ToWav(downsampleTo16k(mono, decoded.sampleRate)), { mode: 0o600 });
      const result = await run(engine.bin, whisperArgs(engine, { model, wav, language: deps.language() }), 60_000 + durationSec * 1000);
      if (result.timedOut || result.code !== 0) {
        deps.log(`whisper-cli ${result.timedOut ? 'timed out' : `exited with ${String(result.code)}`}: ${result.stderr}`);
        return { error: 'failed' };
      }
      const text = result.stdout.trim();
      return text === '' ? { error: 'no-speech' } : { text };
    } catch (error) {
      deps.log(`voice transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      return { error: 'failed' };
    } finally {
      await Promise.all([rm(oga, { force: true }), rm(wav, { force: true })]).catch(() => undefined);
    }
  };

  return {
    transcribe(fileId, durationSec) {
      const model = deps.model();
      if (deps.engine === null || model === null) return Promise.resolve({ error: 'off' });
      if (durationSec > VOICE_MAX_SECONDS) return Promise.resolve({ error: 'too-long' });
      const engine = deps.engine;
      const next = tail.then(() => job(fileId, durationSec, engine, model));
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
