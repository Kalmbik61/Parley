/**
 * Проба на настоящем `speech worker` (план этапа 3b, §6): пропускается, пока нет сборки `build/speech/darwin-arm64`
 * (`scripts/fetch-speech.mjs`) и весов Q8_0 в ~/.parley/desktop/voice/tts. Запускать локально перед релизом (B26):
 * `pnpm --filter @parley/desktop exec vitest run src/main/assistant/speech-worker.live.test.ts`.
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFileSync } from '../voice/engine.js';
import { createSpeechWorker, resolveSpeech, spawnSpeech } from './speech-worker.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = resolveSpeech({
  isPackaged: false,
  resourcesPath: '',
  devDir: path.resolve(dirname, '../../../build/speech/darwin-arm64'),
  isFile: isFileSync,
});
// Веса читаются из настоящего дома нарочно и только на чтение: песочница теста подменяет `HOME`.
const model = path.join(userInfo().homedir, '.parley', 'desktop', 'voice', 'tts', 'Qwen3-TTS-12Hz-0.6B-CustomVoice-Q8_0.gguf');
const ready = process.platform === 'darwin' && process.arch === 'arm64' && bin !== null && existsSync(model);

describe.skipIf(!ready)('настоящий speech worker (Qwen3-TTS 0.6B Q8_0)', () => {
  const worker = createSpeechWorker({ bin: () => bin, model: () => model, spawn: spawnSpeech, log: () => undefined });

  it('ready с протоколом 3 и частотой 24 кГц', async () => {
    const started = Date.now();
    await expect(worker.start()).resolves.toEqual({ state: 'ready', sampleRate: 24_000 });
    console.log(`ready: ${Date.now() - started} ms`);
  }, 120_000);

  it('фраза синтезируется кусками, отсчёты в [-1, 1]', async () => {
    const started = Date.now();
    let first = 0;
    let samples = 0;
    for await (const chunk of worker.synthesize({ id: 'live-1', text: 'Готово: я открыл пулл-реквест.', voice: 'serena', language: 'ru' })) {
      if (first === 0) first = Date.now() - started;
      samples += chunk.length;
      expect(chunk.every((x) => x >= -1 && x <= 1)).toBe(true);
    }
    console.log(`first chunk ${first} ms, ${samples} samples, total ${Date.now() - started} ms`);
    expect(samples).toBeGreaterThan(24_000);
  }, 60_000);

  it('cancel после первого куска — поток кончается, кусков больше нет', async () => {
    const stream = worker.synthesize({
      id: 'live-2',
      text: 'Сейчас я подробно расскажу, что произошло за последний час: сборка прошла, тесты зелёные.',
      voice: 'ryan',
      language: 'ru',
    });
    let chunks = 0;
    for await (const chunk of stream) {
      expect(chunk.length).toBeGreaterThan(0);
      chunks += 1;
      if (chunks === 1) worker.cancel('live-2');
    }
    expect(chunks).toBe(1);
  }, 60_000);

  it('close — выход с 0', async () => {
    await worker.close();
    expect(worker.status()).toEqual({ state: 'stopped' });
  }, 30_000);
});
