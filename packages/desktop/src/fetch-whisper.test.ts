import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cmakeArgs,
  cmakeArgsHash,
  isUpToDate,
  VAD_MODEL,
  WHISPER_SOURCE_SHA256,
  WHISPER_SOURCE_URL,
  WHISPER_VERSION,
} from '../scripts/fetch-whisper.mjs';
import { VAD_MODEL_FILE } from './main/voice/engine.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('fetch-whisper (спека 4.3)', () => {
  it('версия и sha256 закреплены', () => {
    expect(WHISPER_VERSION).toBe('1.9.4');
    expect(WHISPER_SOURCE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(WHISPER_SOURCE_URL).toBe(
      'https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.4.tar.gz',
    );
  });

  it('модель VAD — та, что ищет окно', () => {
    expect(VAD_MODEL.file).toBe(VAD_MODEL_FILE);
    expect(VAD_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('arm64 — Metal со встроенной библиотекой; x64 — без Metal, с AVX2; оба статические и без -march=native', () => {
    const arm = cmakeArgs('arm64', '/src', '/b');
    expect(arm).toEqual(
      expect.arrayContaining([
        '-DCMAKE_OSX_ARCHITECTURES=arm64',
        '-DGGML_METAL=ON',
        '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DGGML_NATIVE=OFF',
      ]),
    );
    const x64 = cmakeArgs('x64', '/src', '/b');
    expect(x64).toEqual(
      expect.arrayContaining([
        '-DCMAKE_OSX_ARCHITECTURES=x86_64',
        '-DGGML_METAL=OFF',
        '-DGGML_AVX2=ON',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DGGML_NATIVE=OFF',
      ]),
    );
    expect(x64).not.toContain('-DGGML_METAL=ON');
  });

  describe('повторный запуск', () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    /** Каталог `darwin-<arch>` с движком и моделью VAD, как его оставляет сборка. */
    function builtDir(): string {
      const dir = mkdtempSync(path.join(tmpdir(), 'fetch-whisper-test-'));
      dirs.push(dir);
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'whisper-cli'), '');
      writeFileSync(path.join(dir, VAD_MODEL.file), '');
      return dir;
    }

    const expected = { version: '1.9.4', vadSha256: VAD_MODEL.sha256, cmakeSha256: cmakeArgsHash('arm64') };

    it('ничего не собирает, пока отметка и файлы на месте', () => {
      expect(isUpToDate({ ...expected }, expected, builtDir())).toBe(true);
      expect(isUpToDate({ ...expected, version: '1.9.3' }, expected, builtDir())).toBe(false);
      expect(isUpToDate(null, expected, builtDir())).toBe(false);
    });

    it('пересобирает, если нет whisper-cli или файла VAD', () => {
      const noCli = builtDir();
      rmSync(path.join(noCli, 'bin', 'whisper-cli'));
      expect(isUpToDate({ ...expected }, expected, noCli)).toBe(false);
      const noVad = builtDir();
      rmSync(path.join(noVad, VAD_MODEL.file));
      expect(isUpToDate({ ...expected }, expected, noVad)).toBe(false);
    });

    it('пересобирает, если сменились флаги cmake', () => {
      expect(isUpToDate({ ...expected, cmakeSha256: 'other' }, expected, builtDir())).toBe(false);
      expect(cmakeArgsHash('arm64')).not.toBe(cmakeArgsHash('x64'));
      expect(cmakeArgsHash('arm64')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('build/whisper скрыт от git', () => {
    expect(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')).toMatch(
      /^packages\/desktop\/build\/whisper\/$/m,
    );
  });
});
