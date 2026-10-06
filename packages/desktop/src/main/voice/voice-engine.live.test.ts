/**
 * Проба на настоящем whisper-cli (спека 8): пропускается, пока нет движка (`fetch-whisper` или brew) и модели base
 * в ~/.parley/desktop/voice/models. Фразы делает `say`, перевод в 16 кГц — `afconvert`. Запускать локально перед
 * релизом: `pnpm --filter @parley/desktop exec vitest run src/main/voice/voice-engine.live.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFileSync, resolveEngine } from './engine.js';
import { voiceModelsDir } from './models.js';
import { createTranscriber, runEngine } from './transcribe.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const engine = resolveEngine({
  isPackaged: false,
  resourcesPath: '',
  devDir: path.resolve(dirname, '../../../build/whisper', `darwin-${process.arch}`),
  pathEnv: process.env.PATH,
  isFile: isFileSync,
});
const model = path.join(voiceModelsDir(), 'ggml-base.bin');
const ready = process.platform === 'darwin' && engine !== null && existsSync(model);

function phrase(voice: string, text: string): ArrayBuffer {
  const dir = mkdtempSync(path.join(tmpdir(), 'parley-live-'));
  try {
    execFileSync('say', ['-v', voice, '-o', path.join(dir, 'p.aiff'), text]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(dir, 'p.aiff'), path.join(dir, 'p.wav')]);
    const wav = readFileSync(path.join(dir, 'p.wav'));
    const data = wav.indexOf('data');
    return wav.subarray(data + 8).buffer.slice(wav.byteOffset + data + 8) as ArrayBuffer;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ready)('настоящий whisper-cli (base)', () => {
  const transcribe = createTranscriber({
    engine: () => engine,
    modelPath: () => model,
    exists: async (file) => existsSync(file),
    run: runEngine,
    tmpDir: tmpdir(),
    log: (message) => console.warn(message),
  });

  it('английская фраза — ключевые слова на месте', async () => {
    const started = Date.now();
    const result = await transcribe({ pcm: phrase('Samantha', 'Refactor the authentication middleware'), language: 'en', model: 'base' });
    console.log(`base en: ${Date.now() - started} ms`, result);
    expect('text' in result && /middleware/i.test(result.text)).toBe(true);
  }, 120_000);

  it('тишина — no_speech', async () => {
    await expect(transcribe({ pcm: new ArrayBuffer(16_000 * 2 * 3), language: 'auto', model: 'base' })).resolves.toEqual({ error: 'no_speech' });
  }, 120_000);
});
