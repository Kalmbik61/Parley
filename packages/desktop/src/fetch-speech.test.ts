import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cmakeArgs,
  cmakeArgsHash,
  GGML_COMMIT,
  GGML_REPO,
  isUpToDate,
  main,
  SPEECH_COMMIT,
  SPEECH_REPO,
  SPEECH_VERSION,
  verifySource,
} from '../scripts/fetch-speech.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

describe('fetch-speech (план 3b, B03, E7)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'fetch-speech-test-'));
    dirs.push(dir);
    return dir;
  }

  it('версия и оба коммита закреплены (спайк B01)', () => {
    expect(SPEECH_VERSION).toBe('0.9.0');
    expect(SPEECH_COMMIT).toBe('49f022a48bc1c7e797aa64dd08d2d9655baf299e');
    expect(GGML_COMMIT).toBe('cbdeccfd49ec9c702c175c273d36c47520cf4710');
    expect(SPEECH_REPO).toBe('https://github.com/nyosegawa/speech.cpp.git');
    expect(GGML_REPO).toBe('https://github.com/nyosegawa/ggml.git');
  });

  it('исходник сверяется: коммит speech.cpp, коммит ggml, версия и чистое дерево', () => {
    const ok = { speechCommit: SPEECH_COMMIT, ggmlCommit: GGML_COMMIT, version: '0.9.0', dirty: '' };
    expect(() => verifySource(ok)).not.toThrow();
    expect(() => verifySource({ ...ok, speechCommit: 'f'.repeat(40) })).toThrow(/speech\.cpp commit/);
    expect(() => verifySource({ ...ok, ggmlCommit: 'f'.repeat(40) })).toThrow(/ggml commit/);
    expect(() => verifySource({ ...ok, version: '0.9.1' })).toThrow(/version/);
    expect(() => verifySource({ ...ok, dirty: ' M CMakeLists.txt' })).toThrow(/not clean/);
  });

  it('arm64 — Metal со встроенной библиотекой шейдеров, статически, без -march=native', () => {
    const args = cmakeArgs('/src', '/b');
    expect(args.slice(0, 4)).toEqual(['-S', '/src', '-B', '/b']);
    expect(args).toEqual(
      expect.arrayContaining([
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_OSX_ARCHITECTURES=arm64',
        '-DGGML_METAL=ON',
        '-DGGML_METAL_EMBED_LIBRARY=ON',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DGGML_NATIVE=OFF',
      ]),
    );
    expect(args.join(' ')).not.toMatch(/march=native/);
  });

  describe('повторный запуск', () => {
    /** Каталог `darwin-arm64` с движком, как его оставляет сборка. */
    function builtDir(): string {
      const dir = tempDir();
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin', 'speech'), '');
      writeFileSync(path.join(dir, 'LICENSE'), '');
      return dir;
    }

    const expected = {
      version: '0.9.0',
      speechCommit: SPEECH_COMMIT,
      ggmlCommit: GGML_COMMIT,
      cmakeSha256: cmakeArgsHash(),
    };

    it('ничего не собирает, пока отметка и файлы на месте', () => {
      expect(isUpToDate({ ...expected }, expected, builtDir())).toBe(true);
      expect(isUpToDate({ ...expected, version: '0.8.0' }, expected, builtDir())).toBe(false);
      expect(isUpToDate({ ...expected, speechCommit: 'other' }, expected, builtDir())).toBe(false);
      expect(isUpToDate({ ...expected, ggmlCommit: 'other' }, expected, builtDir())).toBe(false);
      expect(isUpToDate(null, expected, builtDir())).toBe(false);
    });

    it('пересобирает, если нет bin/speech или LICENSE', () => {
      const noBin = builtDir();
      rmSync(path.join(noBin, 'bin', 'speech'));
      expect(isUpToDate({ ...expected }, expected, noBin)).toBe(false);
      const noLicense = builtDir();
      rmSync(path.join(noLicense, 'LICENSE'));
      expect(isUpToDate({ ...expected }, expected, noLicense)).toBe(false);
    });

    it('пересобирает, если сменились флаги cmake', () => {
      expect(isUpToDate({ ...expected, cmakeSha256: 'other' }, expected, builtDir())).toBe(false);
      expect(cmakeArgsHash()).toMatch(/^[0-9a-f]{64}$/);
      // Отпечаток — от флагов, а не от путей исходника и сборки: временный каталог меняется с каждым запуском.
      expect(cmakeArgsHash()).toBe(cmakeArgsHash());
    });
  });

  it('x64 пропускается: ничего не качает, не собирает и не создаёт (Intel — только текст)', async () => {
    const out = tempDir();
    await main(['x64'], out);
    expect(readdirSync(out)).toEqual([]);
  });

  it('скрипт fetch-speech есть в package.json окна', () => {
    const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['fetch-speech']).toBe('node scripts/fetch-speech.mjs');
  });

  it('NOTICE называет speech.cpp, ggml, сторонние части сборки и Qwen3-TTS (Apache-2.0, Qwen Team, Alibaba Cloud)', () => {
    const notice = readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
    expect(notice).toContain('\nspeech.cpp\n');
    expect(notice).toContain(SPEECH_COMMIT);
    expect(notice).toContain('Copyright (c) 2026 Sakasegawa');
    expect(notice).toContain(GGML_COMMIT);
    expect(notice).toContain('Copyright (c) 2023-2026 The ggml authors');
    expect(notice).toContain('cpp-httplib');
    expect(notice).toContain('Copyright (c) 2017 yhirose');
    expect(notice).toContain('miniaudio');
    expect(notice).toContain('Copyright 2026 David Reid');
    expect(notice).toContain('\nQwen3-TTS\n');
    expect(notice).toContain('Qwen Team, Alibaba Cloud');
    expect(notice).toContain('Apache License, Version 2.0');
    expect(notice).toContain('packages/desktop/src/main/assistant/licenses/Qwen3-TTS-LICENSE.txt');
    expect(notice).toContain('Contents/Resources/licenses/Qwen3-TTS-LICENSE.txt');
  });

  it('текст лицензии Qwen3-TTS — Apache-2.0 без правок', () => {
    const license = readFileSync(
      path.join(desktopRoot, 'src', 'main', 'assistant', 'licenses', 'Qwen3-TTS-LICENSE.txt'),
      'utf8',
    );
    expect(license).toMatch(/^\s+Apache License\n\s+Version 2\.0, January 2004\n/);
    expect(license).toContain('END OF TERMS AND CONDITIONS');
    expect(license).toContain('Copyright 2026 Alibaba Cloud');
  });

  it('build/speech скрыт от git', () => {
    expect(readFileSync(path.join(repoRoot, '.gitignore'), 'utf8')).toMatch(/^packages\/desktop\/build\/speech\/$/m);
  });
});
