#!/usr/bin/env node
// Движок нейроголоса помощника (план 3b, B03, E7): `speech` из speech.cpp — его режим `speech worker` синтезирует
// Qwen3-TTS. Только arm64: на Intel Mac помощник отвечает текстом (решение человека), поэтому для x64 скрипт ничего
// не делает. Исходник берётся `git clone` и `submodule update` на закреплённых коммитах: архив тега не содержит
// подмодуль ggml, а побайтовой стабильности архивов GitHub не обещает. Оба коммита (хеши git — та же проверка
// содержимого, что sha256 архива у whisper), версия и чистота дерева сверяются. Сборка cmake — Metal со встроенной
// библиотекой шейдеров, статически, без -march=native, — кладёт в `build/speech/darwin-arm64/`:
// `bin/speech`, `lib/libspeech.<N>.dylib`, `LICENSE` speech.cpp и `licenses/` сторонних частей сборки (ggml,
// cpp-httplib, miniaudio). electron-builder (`extraResources`) кладёт каталог в `Contents/Resources/speech`.
//
// Использование: `node scripts/fetch-speech.mjs [arm64] [x64]` — без аргументов архитектура этой машины. Повторный
// запуск ничего не собирает, пока запись `build/speech/darwin-arm64.json` совпадает с версией, обоими коммитами и
// отпечатком флагов cmake, а `bin/speech` и `LICENSE` на месте.
// Нужны git и cmake: в релизе они есть на раннере macOS, локально — `brew install cmake`.

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { machOArch, parseArchs, sha256 } from './fetch-node.mjs';

const run = promisify(execFile);

/** Закреплённая версия (спайк B01, 2026-10-27). Новая версия — осознанная правка трёх строк ниже. */
export const SPEECH_VERSION = '0.9.0';
export const SPEECH_COMMIT = '49f022a48bc1c7e797aa64dd08d2d9655baf299e';
/** Подмодуль `ggml` speech.cpp — форк nyosegawa/ggml; коммит записан в дереве SPEECH_COMMIT и сверяется после клона. */
export const GGML_COMMIT = 'cbdeccfd49ec9c702c175c273d36c47520cf4710';
export const SPEECH_REPO = 'https://github.com/nyosegawa/speech.cpp.git';
export const GGML_REPO = 'https://github.com/nyosegawa/ggml.git';

/** Лицензии сторонних частей, которые входят в `speech`: путь в исходнике → имя в `licenses/`. */
const THIRD_PARTY_LICENSES = [
  ['ggml/LICENSE', 'ggml-LICENSE'],
  ['vendor/cpp-httplib/LICENSE', 'cpp-httplib-LICENSE'],
  ['vendor/miniaudio/LICENSE', 'miniaudio-LICENSE'],
];

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_ROOT = path.join(desktopRoot, 'build', 'speech');

/**
 * Флаги cmake: release-флаги speech.cpp для macOS (`-DCMAKE_BUILD_TYPE=Release -DGGML_METAL_EMBED_LIBRARY=ON
 * -DGGML_NATIVE=OFF`, как в B01) плюс явные arm64, Metal, статический ggml и macOS 12 — без неё `minos` бинаря
 * равен SDK раннера, и на старых macOS движок не запустился бы.
 */
export function cmakeArgs(sourceDir, buildDir) {
  return [
    '-S', sourceDir, '-B', buildDir,
    '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0',
    '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON',
  ];
}

/** Отпечаток флагов cmake: смена флагов меняет его и пересобирает движок. */
export function cmakeArgsHash() {
  return sha256(cmakeArgs('', '').join(' '));
}

/** Исходник — ровно закреплённые коммиты speech.cpp и ggml, версия из `VERSION`, без посторонних правок. */
export function verifySource({ speechCommit, ggmlCommit, version, dirty }) {
  if (speechCommit !== SPEECH_COMMIT) throw new Error(`speech.cpp commit mismatch: ${speechCommit}`);
  if (ggmlCommit !== GGML_COMMIT) throw new Error(`ggml commit mismatch: ${ggmlCommit}`);
  if (version !== SPEECH_VERSION) throw new Error(`speech.cpp version mismatch: ${version}`);
  if (dirty !== '') throw new Error(`speech.cpp checkout is not clean:\n${dirty}`);
}

/** Отметка совпадает с ожидаемой, и результат сборки на месте: без `bin/speech` или `LICENSE` — пересборка. */
export function isUpToDate(stamp, expected, outDir) {
  return (
    stamp !== null &&
    stamp.version === expected.version &&
    stamp.speechCommit === expected.speechCommit &&
    stamp.ggmlCommit === expected.ggmlCommit &&
    stamp.cmakeSha256 === expected.cmakeSha256 &&
    existsSync(path.join(outDir, 'bin', 'speech')) &&
    existsSync(path.join(outDir, 'LICENSE'))
  );
}

async function readStamp(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const git = async (args) => (await run('git', args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

/** Клон speech.cpp на SPEECH_COMMIT с подмодулем ggml и сверка обоих коммитов. */
async function checkout(sourceDir) {
  await git(['clone', '--filter=blob:none', '--no-checkout', SPEECH_REPO, sourceDir]);
  await git(['-C', sourceDir, 'checkout', '--detach', SPEECH_COMMIT]);
  await git(['-C', sourceDir, 'submodule', 'update', '--init', '--filter=blob:none']);
  verifySource({
    speechCommit: await git(['-C', sourceDir, 'rev-parse', 'HEAD']),
    ggmlCommit: await git(['-C', path.join(sourceDir, 'ggml'), 'rev-parse', 'HEAD']),
    version: (await readFile(path.join(sourceDir, 'VERSION'), 'utf8')).trim(),
    dirty: await git(['-C', sourceDir, 'status', '--porcelain', '--ignore-submodules=none']),
  });
}

async function buildArm64(outRoot) {
  const outDir = path.join(outRoot, 'darwin-arm64');
  const stampFile = path.join(outRoot, 'darwin-arm64.json');
  const expected = {
    version: SPEECH_VERSION,
    speechCommit: SPEECH_COMMIT,
    ggmlCommit: GGML_COMMIT,
    cmakeSha256: cmakeArgsHash(),
  };
  if (isUpToDate(await readStamp(stampFile), expected, outDir)) {
    console.log('fetch-speech: darwin-arm64 is up to date');
    return;
  }
  const work = await mkdtemp(path.join(tmpdir(), 'fetch-speech-'));
  try {
    const sourceDir = path.join(work, 'speech.cpp');
    const buildDir = path.join(work, 'build');
    await checkout(sourceDir);
    await run('cmake', cmakeArgs(sourceDir, buildDir), { maxBuffer: 64 * 1024 * 1024 });
    // `speech-cli` — исполняемый файл `speech`, `speech` — общая библиотека libspeech; проверки speech.cpp не нужны.
    await run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'speech-cli', 'speech', '-j'], {
      maxBuffer: 256 * 1024 * 1024,
    });
    const built = path.join(buildDir, 'speech');
    if (machOArch(await readFile(built)) !== 'arm64') throw new Error('speech is not an arm64 binary');
    // Настоящий файл libspeech.<версия C API>.dylib, без символических ссылок на него.
    const lib = (await readdir(buildDir)).find((name) => /^libspeech\.\d+\.dylib$/.test(name));
    if (lib === undefined) throw new Error('libspeech was not built');

    await rm(outDir, { recursive: true, force: true });
    for (const dir of ['bin', 'lib', 'licenses']) await mkdir(path.join(outDir, dir), { recursive: true });
    await copyFile(built, path.join(outDir, 'bin', 'speech'));
    await chmod(path.join(outDir, 'bin', 'speech'), 0o755);
    await copyFile(path.join(buildDir, lib), path.join(outDir, 'lib', lib));
    await copyFile(path.join(sourceDir, 'LICENSE'), path.join(outDir, 'LICENSE'));
    for (const [from, to] of THIRD_PARTY_LICENSES) {
      await copyFile(path.join(sourceDir, from), path.join(outDir, 'licenses', to));
    }
    await writeFile(stampFile, `${JSON.stringify(expected)}\n`);
    console.log(`fetch-speech: darwin-arm64 ready (${outDir})`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2), outRoot = DEFAULT_OUT_ROOT) {
  for (const arch of parseArchs(args)) {
    if (arch === 'arm64') await buildArm64(outRoot);
    else console.log(`fetch-speech: darwin-${arch} skipped — the neural voice ships for Apple silicon only`);
  }
}

// `realpath`: `import.meta.url` — настоящий путь файла, а `argv[1]` мог прийти через символическую ссылку.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`fetch-speech: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
