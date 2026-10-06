#!/usr/bin/env node
// Движок голосового ввода для собранного окна (спека 2026-10-06-voice-input-design.md, 4.3): `whisper-cli` из
// whisper.cpp и модель VAD Silero. Для каждой архитектуры скачивает исходник на закреплённом теге, сверяет sha256,
// собирает cmake (arm64 — Metal со встроенной библиотекой шейдеров, x64 — CPU с Accelerate и AVX2; оба статические,
// без -march=native) и кладёт в `build/whisper/darwin-<arch>/`: `bin/whisper-cli`, `ggml-silero-v6.2.0.bin`,
// `LICENSE`. electron-builder (`extraResources`) кладёт каталог в `Contents/Resources/whisper`.
//
// Использование: `node scripts/fetch-whisper.mjs [arm64] [x64]` — без аргументов архитектура этой машины. Повторный
// запуск ничего не собирает, пока запись `build/whisper/darwin-<arch>.json` совпадает с версией и sha256 VAD.
// Нужен cmake: в релизе он есть на раннере macOS, локально — `brew install cmake`.

/* global fetch, AbortSignal */

import { execFile } from 'node:child_process';
import { copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { machOArch, parseArchs, sha256 } from './fetch-node.mjs';

const run = promisify(execFile);

/** Закреплённая версия: последний релиз на 2026-10-06. Новая версия — осознанная правка трёх строк ниже. */
export const WHISPER_VERSION = '1.9.4';
export const WHISPER_SOURCE_SHA256 = '57e280cee375ab02425b806ad5146b99f6eb9357e3c2b31357c8a6af2e2e44ae';
export const WHISPER_SOURCE_URL = `https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v${WHISPER_VERSION}.tar.gz`;

export const VAD_MODEL = {
  file: 'ggml-silero-v6.2.0.bin',
  bytes: 885_098,
  sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin',
};

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_ROOT = path.join(desktopRoot, 'build', 'whisper');

export function cmakeArgs(arch, sourceDir, buildDir) {
  const common = [
    '-S', sourceDir, '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_SDL2=OFF', '-DGGML_NATIVE=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
  ];
  return arch === 'arm64'
    ? [...common, '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON']
    : // x64: AVX2, FMA, F16C, а по умолчанию ggml и BMI2 — нужен Haswell или новее; macOS 12 и так требует Mac 2015+.
      // Rosetta такой бинарь не исполняет (этап 0, SIGILL) — x64 проверяется только на настоящем Intel Mac.
      [...common, '-DCMAKE_OSX_ARCHITECTURES=x86_64', '-DGGML_METAL=OFF', '-DGGML_AVX=ON', '-DGGML_AVX2=ON', '-DGGML_FMA=ON', '-DGGML_F16C=ON'];
}

export function isUpToDate(stamp, expected) {
  return stamp !== null && stamp.version === expected.version && stamp.vadSha256 === expected.vadSha256;
}

async function download(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= 3) throw error;
      console.warn(`fetch-whisper: ${String(error)} — retry ${attempt + 1} of 3`);
    }
  }
}

async function readStamp(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function buildArch(arch, outRoot) {
  const outDir = path.join(outRoot, `darwin-${arch}`);
  const stampFile = path.join(outRoot, `darwin-${arch}.json`);
  const expected = { version: WHISPER_VERSION, vadSha256: VAD_MODEL.sha256 };
  if (isUpToDate(await readStamp(stampFile), expected)) {
    console.log(`fetch-whisper: darwin-${arch} is up to date`);
    return;
  }
  const work = await mkdtemp(path.join(tmpdir(), 'fetch-whisper-'));
  try {
    const tarball = await download(WHISPER_SOURCE_URL);
    if (sha256(tarball) !== WHISPER_SOURCE_SHA256) throw new Error('whisper.cpp source sha256 mismatch');
    const tarPath = path.join(work, 'whisper.tar.gz');
    await writeFile(tarPath, tarball);
    await run('tar', ['-xzf', tarPath, '-C', work]);
    const sourceDir = path.join(work, `whisper.cpp-${WHISPER_VERSION}`);
    const buildDir = path.join(work, `build-${arch}`);
    await run('cmake', cmakeArgs(arch, sourceDir, buildDir), { maxBuffer: 64 * 1024 * 1024 });
    await run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '-j'], { maxBuffer: 256 * 1024 * 1024 });
    const built = path.join(buildDir, 'bin', 'whisper-cli');
    if (machOArch(await readFile(built)) !== arch) throw new Error(`whisper-cli is not a ${arch} binary`);

    const vad = await download(VAD_MODEL.url);
    if (vad.length !== VAD_MODEL.bytes || sha256(vad) !== VAD_MODEL.sha256) throw new Error('VAD model sha256 mismatch');

    await rm(outDir, { recursive: true, force: true });
    await mkdir(path.join(outDir, 'bin'), { recursive: true });
    await copyFile(built, path.join(outDir, 'bin', 'whisper-cli'));
    await chmod(path.join(outDir, 'bin', 'whisper-cli'), 0o755);
    await writeFile(path.join(outDir, VAD_MODEL.file), vad);
    await copyFile(path.join(sourceDir, 'LICENSE'), path.join(outDir, 'LICENSE'));
    await writeFile(stampFile, `${JSON.stringify(expected)}\n`);
    console.log(`fetch-whisper: darwin-${arch} ready (${outDir})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), outRoot = DEFAULT_OUT_ROOT) {
  for (const arch of parseArchs(args)) await buildArch(arch, outRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`fetch-whisper: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
