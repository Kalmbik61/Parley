#!/usr/bin/env node
// Встроенный Node 22 для собранного окна (план релиза 0.1.0, V3): человеку не нужен свой node —
// окно запускает хост этим (`src/main/host-launcher.ts`, `Resources/node/bin/node`).
//
// Для каждой архитектуры скачивает `node-v<версия>-darwin-<arch>.tar.gz` с nodejs.org/dist, сверяет
// его sha256 со строкой `SHASUMS256.txt` той же версии (не сошлось — ошибка, в `build/node` ничего
// не остаётся) и достаёт из архива два файла: `bin/node` в `build/node/darwin-<arch>/bin/node` и
// `LICENSE` в `build/node/darwin-<arch>/LICENSE`. Лицензия едет с бинарём: это MIT самого Node.js и
// лицензии библиотек, которые в него входят (V8, OpenSSL, ICU и других), а они требуют уведомления
// и текста лицензии при раздаче бинаря. Каталог скрыт от git, а `extraResources` electron-builder
// (`electron-builder.yml`) кладёт его в `Contents/Resources/node` приложения своей архитектуры.
//
// Использование: `node scripts/fetch-node.mjs [arm64] [x64]` — без аргументов только архитектура
// этой машины; релизная сборка просит обе. Повторный запуск ничего не качает, пока оба файла на месте
// и совпадают с записью `build/node/darwin-<arch>.json` (версия и sha256 файлов).

/* global fetch, AbortSignal */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);

/**
 * Закреплённая версия: последняя 22.x на 2026-10-01 (https://nodejs.org/dist/index.json, ветка Jod).
 * Новая версия — осознанная правка этой строки: плавающей «последней» у релиза нет.
 */
export const NODE_VERSION = '22.23.3';

export const NODE_DIST_URL = 'https://nodejs.org/dist';

/** Архитектуры macOS-сборок: имена как у electron-builder (`${arch}`) и в именах архивов Node. */
export const ARCHS = ['arm64', 'x64'];

/** Скачивание целиком — архив около 45 МБ; зависший канал не должен держать сборку вечно. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH',
  'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_ROOT = path.join(desktopRoot, 'build', 'node');

export const tarballName = (version, arch) => `node-v${version}-darwin-${arch}.tar.gz`;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** `SHASUMS256.txt`: строки `<sha256>  <имя файла>` → Map имя → sha256. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (match !== null) sums.set(match[2], match[1]);
  }
  return sums;
}

/** Архитектура 64-битного Mach-O по заголовку (`cputype` — `CPU_TYPE_ARM64` и `CPU_TYPE_X86_64`); иначе null. */
export function machOArch(binary) {
  if (binary.length < 8 || binary.readUInt32LE(0) !== 0xfeedfacf) return null;
  const cpu = binary.readUInt32LE(4);
  if (cpu === 0x0100000c) return 'arm64';
  if (cpu === 0x01000007) return 'x64';
  return null;
}

/** Аргументы командной строки → список архитектур; без аргументов — архитектура этой машины. */
export function parseArchs(args, current = process.arch) {
  const archs = args.length > 0 ? args : [current];
  for (const arch of archs) {
    if (!ARCHS.includes(arch)) {
      throw new Error(`неизвестная архитектура «${arch}», допустимы: ${ARCHS.join(', ')}`);
    }
  }
  return [...new Set(archs)];
}

/** Undici may wrap connection errors in a cause/AggregateError; inspect only bounded code fields. */
function networkCode(error) {
  const pending = [error];
  for (let inspected = 0; pending.length > 0 && inspected < 8; inspected++) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object') continue;
    if (TRANSIENT_NETWORK_CODES.has(current.code)) return current.code;
    if (current.cause !== undefined) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 4));
  }
  return null;
}

async function download(url, fetchImpl, stage, log, sleep) {
  // Retries share the original deadline, rather than adding ten minutes per attempt.
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    let failure;
    let retry;
    try {
      const response = await fetchImpl(url, { signal });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      failure = `${stage} ${url}: HTTP ${response.status} (attempt ${attempt}/${DOWNLOAD_ATTEMPTS})`;
      retry = response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599;
      // Release a failed response before opening the next request.
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      const code = networkCode(error);
      failure = `${stage} ${url}: ${signal.aborted ? 'download timeout' : `network failure${code === null ? '' : ` (${code})`}`} (attempt ${attempt}/${DOWNLOAD_ATTEMPTS})`;
      // A plain fetch failure can be transient. Unknown causes (including TLS failures) fail closed.
      retry = !signal.aborted && (code !== null || error instanceof TypeError && error.message === 'fetch failed' && error.cause === undefined);
    }
    if (!retry || attempt === DOWNLOAD_ATTEMPTS) throw new Error(failure);
    const waitMs = attempt * 1000;
    log(`${failure}; retrying in ${waitMs} ms`);
    try {
      await sleep(waitMs, signal);
    } catch {
      throw new Error(`${stage} ${url}: ${signal.aborted ? 'download timeout' : 'retry wait failed'}`);
    }
  }
}

/**
 * Оба файла на месте и совпадают с записью прошлого запуска — повторное скачивание не нужно. Запись без
 * суммы лицензии (сделана до того, как лицензия стала ехать с бинарём) — устаревшая: скачиваем заново.
 */
async function isUpToDate(binaryFile, licenseFile, markerFile, version) {
  try {
    const marker = JSON.parse(await readFile(markerFile, 'utf8'));
    return (
      marker.version === version &&
      marker.binarySha256 === sha256(await readFile(binaryFile)) &&
      typeof marker.licenseSha256 === 'string' &&
      marker.licenseSha256 === sha256(await readFile(licenseFile))
    );
  } catch {
    return false;
  }
}

/**
 * Кладёт `bin/node` и `LICENSE` версии `version` под `<outRoot>/darwin-<arch>/`. Возвращает `'cached'`,
 * если там уже лежат проверенные файлы этой версии, иначе `'fetched'`.
 */
export async function fetchNode({
  arch,
  version = NODE_VERSION,
  baseUrl = NODE_DIST_URL,
  outRoot = DEFAULT_OUT_ROOT,
  fetchImpl = fetch,
  log = console.log,
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  const archDir = path.join(outRoot, `darwin-${arch}`);
  const binaryFile = path.join(archDir, 'bin', 'node');
  const licenseFile = path.join(archDir, 'LICENSE');
  const markerFile = path.join(outRoot, `darwin-${arch}.json`);
  if (await isUpToDate(binaryFile, licenseFile, markerFile, version)) {
    log(`node v${version} darwin-${arch}: уже на месте (${binaryFile})`);
    return 'cached';
  }

  const name = tarballName(version, arch);
  const shasums = parseShasums(
    (await download(`${baseUrl}/v${version}/SHASUMS256.txt`, fetchImpl, 'checksums', log, sleep)).toString('utf8'),
  );
  const expected = shasums.get(name);
  if (expected === undefined) {
    throw new Error(`в SHASUMS256.txt версии v${version} нет строки для ${name}`);
  }
  const tarball = await download(`${baseUrl}/v${version}/${name}`, fetchImpl, 'archive', log, sleep);
  const actual = sha256(tarball);
  if (actual !== expected) {
    throw new Error(`${name}: sha256 ${actual} не совпал с SHASUMS256.txt (${expected})`);
  }

  await mkdir(outRoot, { recursive: true });
  const work = await mkdtemp(path.join(outRoot, '.tmp-'));
  try {
    const archive = path.join(work, name);
    await writeFile(archive, tarball);
    // Два файла из архива: `bin/node` и `LICENSE`. Нет любого из них — `tar` отказывает, и это ошибка:
    // бинарь без текста лицензии раздавать нельзя.
    const top = `node-v${version}-darwin-${arch}`;
    const member = `${top}/bin/node`;
    await run('tar', ['-xzf', archive, '-C', work, member, `${top}/LICENSE`]);
    const extracted = path.join(work, top, 'bin', 'node');
    const extractedLicense = path.join(work, top, 'LICENSE');
    const binary = await readFile(extracted);
    const found = machOArch(binary);
    if (found !== arch) {
      throw new Error(`${member}: ждали Mach-O ${arch}, в файле ${found ?? 'не Mach-O'}`);
    }
    const license = await readFile(extractedLicense);
    if (license.length === 0) throw new Error(`${top}/LICENSE: пустой файл`);
    await chmod(extracted, 0o755);
    await rm(archDir, { recursive: true, force: true });
    await mkdir(path.dirname(binaryFile), { recursive: true });
    await rename(extracted, binaryFile);
    await rename(extractedLicense, licenseFile);
    await writeFile(
      markerFile,
      `${JSON.stringify(
        {
          version,
          tarballSha256: actual,
          binarySha256: sha256(binary),
          licenseSha256: sha256(license),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  log(`node v${version} darwin-${arch}: скачан, sha256 сверен с SHASUMS256.txt (${actual}) → ${archDir} (bin/node, LICENSE)`);
  return 'fetched';
}

async function main() {
  for (const arch of parseArchs(process.argv.slice(2))) await fetchNode({ arch });
}

// Запуск из командной строки; при импорте (тест) ничего не делается. `realpath`: `import.meta.url`
// — настоящий путь файла, а `argv[1]` мог прийти через символическую ссылку.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`fetch-node: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
