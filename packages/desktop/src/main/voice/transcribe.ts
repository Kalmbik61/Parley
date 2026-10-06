/**
 * Распознавание записи (спека 4.2, 6.4): PCM окна → временный WAV (0600) → `whisper-cli` → текст через фильтр
 * галлюцинаций. WAV удаляется в `finally` при любом исходе; оставшиеся после падения окна подчищает
 * `removeStaleRecordings` при старте.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TranscribeRequest, TranscribeResult, VoiceModelId } from '../../shared/voice-types.js';
import type { Engine } from './engine.js';
import { cleanTranscript } from './result-filter.js';
import { pcm16ToWav, SAMPLE_RATE } from './wav.js';

export const WAV_PREFIX = 'parley-voice-';

export function whisperArgs(engine: Engine, input: { model: string; wav: string; language: string }): string[] {
  return ['-m', input.model, '-f', input.wav, '-l', input.language, '-nt', '-np', '-sns', '--vad', '-vm', engine.vadModel];
}

/** 60 с на загрузку модели и разгон плюс длина самой записи (спека 4.2). */
export function transcribeTimeoutMs(durationMs: number): number {
  return 60_000 + Math.ceil(durationMs);
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type RunEngine = (bin: string, args: string[], timeoutMs: number) => Promise<RunResult>;

/** stderr — только хвост: журнал движка на длинной записи большой, а нужен он лишь для диагностики. */
const MAX_STDERR = 64_000;
/** stdout — тоже хвост: текст двухминутной записи на два порядка короче, лимит страхует от зациклившегося движка. */
const MAX_STDOUT = 256_000;

/** Запущенные движки: на выходе приложения их убивает `killRunningEngines`, чтобы они не осиротели. */
const running = new Set<ChildProcess>();

export function killRunningEngines(): void {
  for (const child of running) child.kill('SIGKILL');
}

export const runEngine: RunEngine = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-MAX_STDOUT);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (error) => {
      running.delete(child);
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
    });
    child.on('close', (code) => {
      running.delete(child);
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export interface TranscriberDeps {
  engine(): Engine | null;
  modelPath(id: VoiceModelId): string;
  exists(file: string): Promise<boolean>;
  run: RunEngine;
  tmpDir: string;
  log(message: string): void;
}

export function createTranscriber(deps: TranscriberDeps): (request: TranscribeRequest) => Promise<TranscribeResult> {
  return async (request) => {
    const engine = deps.engine();
    if (engine === null) return { error: 'engine_missing' };
    const model = deps.modelPath(request.model);
    if (!(await deps.exists(model))) return { error: 'model_missing' };
    const pcm = Buffer.from(request.pcm);
    const durationMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
    const wav = path.join(deps.tmpDir, `${WAV_PREFIX}${randomUUID()}.wav`);
    try {
      await writeFile(wav, pcm16ToWav(pcm), { mode: 0o600 });
      const result = await deps.run(engine.bin, whisperArgs(engine, { model, wav, language: request.language }), transcribeTimeoutMs(durationMs));
      if (result.timedOut || result.code !== 0) {
        deps.log(`whisper-cli ${result.timedOut ? 'timed out' : `exited with ${String(result.code)}`}: ${result.stderr}`);
        return { error: 'failed' };
      }
      const text = cleanTranscript(result.stdout);
      return text === null ? { error: 'no_speech' } : { text };
    } catch (error) {
      deps.log(`whisper-cli failed: ${error instanceof Error ? error.message : String(error)}`);
      return { error: 'failed' };
    } finally {
      await rm(wav, { force: true }).catch(() => undefined);
    }
  };
}

/** Записи, оставшиеся после падения окна посреди распознавания (спека 4.2, «Уборка при старте»). */
export async function removeStaleRecordings(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(WAV_PREFIX) && name.endsWith('.wav'))
      .map((name) => rm(path.join(dir, name), { force: true }).catch(() => undefined)),
  );
}
