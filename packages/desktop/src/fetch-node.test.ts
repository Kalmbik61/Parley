/**
 * Скрипт встроенного Node (`scripts/fetch-node.mjs`, V3 плана релиза 0.1.0): сверка по `SHASUMS256.txt`
 * обязательна, из архива берутся два файла — `bin/node` и `LICENSE` (бинарь без текста лицензии раздавать
 * нельзя), а при любом сбое в `build/node` ничего не остаётся. Сеть подменена: настоящий nodejs.org тесты
 * не трогают, а архив собран тут же системным `tar`.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ARCHS,
  DEFAULT_OUT_ROOT,
  NODE_VERSION,
  fetchNode,
  machOArch,
  parseArchs,
  parseShasums,
  sha256,
  tarballName,
} from '../scripts/fetch-node.mjs';

const run = promisify(execFile);
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Arch = 'arm64' | 'x64';
const VERSION = '22.0.0';
const BASE = 'https://mirror.test/dist';
/** Текст `LICENSE` из подставного архива: настоящий начинается так же, а дальше идут лицензии V8, OpenSSL, ICU. */
const NODE_LICENSE = 'Node.js is licensed for use as follows:\n\nMIT License. Copyright Node.js contributors.\n';

/** Заголовок 64-битного Mach-O: магия `0xfeedfacf` и `cputype` (ARM64 — 0x0100000c, x86_64 — 0x01000007). */
function machoHeader(arch: Arch): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
  return header;
}

describe('чистые функции скрипта', () => {
  it('parseShasums разбирает строки «sha256␣␣имя» и пропускает остальное', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const sums = parseShasums(`${a}  node-v22.0.0-darwin-arm64.tar.gz\n\nмусор\n${b}  node-v22.0.0-darwin-x64.tar.gz\n`);

    expect(sums.get('node-v22.0.0-darwin-arm64.tar.gz')).toBe(a);
    expect(sums.get('node-v22.0.0-darwin-x64.tar.gz')).toBe(b);
    expect(sums.size).toBe(2);
  });

  it('machOArch узнаёт arm64 и x64 по заголовку, остальное — null', () => {
    expect(machOArch(machoHeader('arm64'))).toBe('arm64');
    expect(machOArch(machoHeader('x64'))).toBe('x64');
    expect(machOArch(Buffer.from('#!/bin/sh\n'))).toBeNull();
    expect(machOArch(Buffer.alloc(4))).toBeNull();
  });

  it('parseArchs: без аргументов — архитектура машины, дубли сворачиваются, чужая — ошибка', () => {
    expect(parseArchs([], 'arm64')).toEqual(['arm64']);
    expect(parseArchs(['x64', 'arm64', 'x64'])).toEqual(['x64', 'arm64']);
    expect(() => parseArchs(['ia32'])).toThrow(/ia32/);
  });

  it('версия закреплена константой: Node 22.x, а не «последняя на момент сборки»', () => {
    expect(NODE_VERSION).toMatch(/^22\.\d+\.\d+$/);
    expect(ARCHS).toEqual(['arm64', 'x64']);
    expect(tarballName(NODE_VERSION, 'arm64')).toBe(`node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
  });
});

describe('fetchNode', () => {
  let work: string;
  let out: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'fn-'));
    out = path.join(work, 'out', 'node');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(work, { recursive: true, force: true });
  });

  /**
   * Настоящий `.tar.gz` как у nodejs.org: каталог `node-v…-darwin-<arch>` с `bin/node`, `LICENSE` и лишними
   * файлами. `license: null` — архив без `LICENSE`.
   */
  async function makeTarball(
    arch: Arch,
    binary: Buffer,
    license: string | null = NODE_LICENSE,
  ): Promise<Buffer> {
    const top = `node-v${VERSION}-darwin-${arch}`;
    const src = path.join(work, 'src');
    await mkdir(path.join(src, top, 'bin'), { recursive: true });
    await mkdir(path.join(src, top, 'include'), { recursive: true });
    await writeFile(path.join(src, top, 'bin', 'node'), binary);
    await writeFile(path.join(src, top, 'bin', 'npm'), 'лишнее');
    if (license !== null) await writeFile(path.join(src, top, 'LICENSE'), license);
    await writeFile(path.join(src, top, 'CHANGELOG.md'), 'лишнее');
    await writeFile(path.join(src, top, 'include', 'node.h'), 'лишнее');
    const archive = path.join(work, `${top}.tar.gz`);
    await run('tar', ['-czf', archive, '-C', src, top]);
    return readFile(archive);
  }

  /** Подставная сеть: адрес → тело; все обращения копятся в `calls`. */
  function fakeNetwork(files: Record<string, Buffer | string>) {
    const calls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      calls.push(url);
      const body = files[url];
      return body === undefined ? new Response('нет такого', { status: 404 }) : new Response(body);
    };
    return { calls, fetchImpl };
  }

  /** Всё, что выкладывает nodejs.org для версии: архив и `SHASUMS256.txt` с его sha256 (или с чужим). */
  async function mirror(
    arch: Arch,
    options: { header?: Arch; shasum?: string | null; license?: string | null } = {},
  ) {
    const binary = Buffer.concat([machoHeader(options.header ?? arch), Buffer.from('тело node')]);
    const tarball = await makeTarball(arch, binary, options.license);
    const name = tarballName(VERSION, arch);
    const shasum = options.shasum === undefined ? sha256(tarball) : options.shasum;
    const sums = shasum === null ? 'ffff  другой-файл.tar.gz\n' : `${shasum}  ${name}\n`;
    return {
      binary,
      tarball,
      network: fakeNetwork({
        [`${BASE}/v${VERSION}/${name}`]: tarball,
        [`${BASE}/v${VERSION}/SHASUMS256.txt`]: sums,
      }),
    };
  }

  const fetchArm64 = (fetchImpl: (url: string) => Promise<Response>) =>
    fetchNode({ arch: 'arm64', version: VERSION, baseUrl: BASE, outRoot: out, fetchImpl, log: () => undefined, sleep: async () => undefined });

  it('retries a transient nested network cause with bounded delays and safe diagnostics', async () => {
    const { network } = await mirror('arm64');
    const failure = Object.assign(new TypeError('fetch failed secret-diagnostic'), {
      cause: new AggregateError([Object.assign(new Error('secret-path'), { code: 'ETIMEDOUT' })]),
    });
    const fetchImpl = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockImplementation(network.fetchImpl);
    const log = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await fetchNode({ arch: 'arm64', version: VERSION, baseUrl: BASE, outRoot: out, fetchImpl, log, sleep })).toBe('fetched');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    const messages = log.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain(`checksums ${BASE}/v${VERSION}/SHASUMS256.txt: network failure (ETIMEDOUT)`);
    expect(messages).not.toContain('secret-');
    const signals = fetchImpl.mock.calls.slice(0, 3).map(([, options]) => (options as RequestInit).signal);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]).toBe(signals[2]);
  });

  it.each([408, 429, 500, 503, 599])('retries transient HTTP %s and still verifies the downloaded archive', async (status) => {
    const { network } = await mirror('arm64');
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('secret-body', { status })).mockImplementation(network.fetchImpl);
    expect(await fetchArm64(fetchImpl)).toBe('fetched');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a failed archive body read without using a partial download', async () => {
    const { network, binary } = await mirror('arm64');
    const fetchImpl = vi.fn().mockImplementationOnce(network.fetchImpl).mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) {
        controller.error(Object.assign(new Error('secret-body-error'), { code: 'ECONNRESET' }));
      },
    }))).mockImplementation(network.fetchImpl);
    expect(await fetchArm64(fetchImpl)).toBe('fetched');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(out, 'darwin-arm64', 'bin', 'node'))).toEqual(binary);
  });

  it('stops after three transient failures without leaking messages or creating output', async () => {
    const failure = Object.assign(new Error('secret-message'), { cause: Object.assign(new Error('secret-cause'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    const fetchImpl = vi.fn().mockRejectedValue(failure);
    const error = await fetchArm64(fetchImpl).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`checksums ${BASE}/v${VERSION}/SHASUMS256.txt: network failure (UND_ERR_CONNECT_TIMEOUT) (attempt 3/3)`);
    expect(String(error)).not.toContain('secret-');
    expect(error).not.toHaveProperty('cause');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await readdir(out).catch(() => [])).toEqual([]);
  });

  it('retries a plain fetch failure when no cause code is available', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(fetchArm64(fetchImpl)).rejects.toThrow(/network failure.*attempt 3\/3/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry unknown or TLS errors or print their causes', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('secret-certificate-path'), { code: 'CERT_HAS_EXPIRED' }),
    }));
    await expect(fetchArm64(fetchImpl)).rejects.toThrow(`checksums ${BASE}/v${VERSION}/SHASUMS256.txt: network failure (attempt 1/3)`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops on the shared deadline instead of adding another ten-minute attempt', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetchImpl = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('secret-timeout'), { code: 'ETIMEDOUT' });
    });
    await expect(fetchArm64(fetchImpl)).rejects.toThrow(/checksums.*download timeout.*attempt 1\/3/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10 * 60 * 1000);
  });

  it.each([400, 401, 403, 404])('does not retry nontransient HTTP %s', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('secret-body', { status }));
    await expect(fetchArm64(fetchImpl)).rejects.toThrow(`HTTP ${status} (attempt 1/3)`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('скачивает, сверяет sha256 с SHASUMS256.txt и кладёт bin/node и LICENSE в darwin-<arch>', async () => {
    const { binary, network } = await mirror('arm64');

    expect(await fetchArm64(network.fetchImpl)).toBe('fetched');

    // Сначала SHASUMS256.txt, потом архив — оба с адреса версии.
    expect(network.calls).toEqual([
      `${BASE}/v${VERSION}/SHASUMS256.txt`,
      `${BASE}/v${VERSION}/${tarballName(VERSION, 'arm64')}`,
    ]);
    const file = path.join(out, 'darwin-arm64', 'bin', 'node');
    expect(await readFile(file)).toEqual(binary);
    expect((await stat(file)).mode & 0o777).toBe(0o755);
    // Только bin/node и LICENSE: ни npm, ни CHANGELOG, ни include; временного каталога тоже не осталось.
    expect((await readdir(path.join(out, 'darwin-arm64'))).sort()).toEqual(['LICENSE', 'bin']);
    expect(await readdir(path.join(out, 'darwin-arm64', 'bin'))).toEqual(['node']);
    expect((await readdir(out)).sort()).toEqual(['darwin-arm64', 'darwin-arm64.json']);
    // Текст лицензии Node — тот, что в архиве: он поедет в Resources/node/LICENSE рядом с бинарём.
    expect(await readFile(path.join(out, 'darwin-arm64', 'LICENSE'), 'utf8')).toBe(NODE_LICENSE);
    const marker = JSON.parse(await readFile(path.join(out, 'darwin-arm64.json'), 'utf8')) as Record<
      string,
      string
    >;
    expect(marker.licenseSha256).toBe(sha256(Buffer.from(NODE_LICENSE)));
  });

  it('в архиве нет LICENSE — ошибка, и в каталоге сборки ничего нет: бинарь без лицензии не раздаём', async () => {
    const { network } = await mirror('arm64', { license: null });

    await expect(fetchArm64(network.fetchImpl)).rejects.toThrow();
    expect(network.calls).toHaveLength(2);
    expect(await readdir(out).catch(() => [])).toEqual([]);
  });

  it('LICENSE пуст — ошибка', async () => {
    const { network } = await mirror('arm64', { license: '' });

    await expect(fetchArm64(network.fetchImpl)).rejects.toThrow(/LICENSE: пустой файл/);
    expect(network.calls).toHaveLength(2);
    expect(await readdir(out).catch(() => [])).toEqual([]);
  });

  it('прежний кэш без LICENSE (до того, как лицензия поехала с бинарём) заменяется, а не считается свежим', async () => {
    const { network } = await mirror('arm64');
    await fetchArm64(network.fetchImpl);
    network.calls.length = 0;

    // Состояние старого скрипта: бинарь на месте, записи без суммы лицензии, файла LICENSE нет.
    await rm(path.join(out, 'darwin-arm64', 'LICENSE'));
    const marker = JSON.parse(await readFile(path.join(out, 'darwin-arm64.json'), 'utf8')) as Record<
      string,
      string
    >;
    delete marker.licenseSha256;
    await writeFile(path.join(out, 'darwin-arm64.json'), JSON.stringify(marker));

    expect(await fetchArm64(network.fetchImpl)).toBe('fetched');
    expect(await readFile(path.join(out, 'darwin-arm64', 'LICENSE'), 'utf8')).toBe(NODE_LICENSE);
  });

  it('подменённый LICENSE в кэше — качает заново', async () => {
    const { network } = await mirror('arm64');
    await fetchArm64(network.fetchImpl);
    await writeFile(path.join(out, 'darwin-arm64', 'LICENSE'), 'подмена');

    expect(await fetchArm64(network.fetchImpl)).toBe('fetched');
    expect(await readFile(path.join(out, 'darwin-arm64', 'LICENSE'), 'utf8')).toBe(NODE_LICENSE);
  });

  it('повторный запуск с файлом на месте ничего не качает; изменённый файл — качает заново', async () => {
    const { network } = await mirror('arm64');
    await fetchArm64(network.fetchImpl);
    network.calls.length = 0;

    expect(await fetchArm64(network.fetchImpl)).toBe('cached');
    expect(network.calls).toEqual([]);

    await writeFile(path.join(out, 'darwin-arm64', 'bin', 'node'), 'подмена');
    expect(await fetchArm64(network.fetchImpl)).toBe('fetched');
    expect(network.calls).toHaveLength(2);
  });

  it('sha256 архива не совпал с SHASUMS256.txt — ошибка, и в каталоге сборки ничего нет', async () => {
    const { network } = await mirror('arm64', { shasum: '0'.repeat(64) });

    await expect(fetchArm64(network.fetchImpl)).rejects.toThrow(/sha256.*SHASUMS256\.txt/);
    expect(network.calls).toHaveLength(2);
    expect(await readdir(out).catch(() => [])).toEqual([]);
  });

  it('в SHASUMS256.txt нет строки архива — ошибка: «нечем сверить» не значит «можно без сверки»', async () => {
    const { network } = await mirror('arm64', { shasum: null });

    await expect(fetchArm64(network.fetchImpl)).rejects.toThrow(/нет строки/);
    expect(await readdir(out).catch(() => [])).toEqual([]);
  });

  it('сеть ответила ошибкой — ошибка с адресом', async () => {
    const network = fakeNetwork({});

    await expect(fetchArm64(network.fetchImpl)).rejects.toThrow(/SHASUMS256\.txt: HTTP 404/);
    expect(network.calls).toHaveLength(1);
  });

  it('в архиве arm64 лежит бинарь x64 — ошибка: архитектуры перепутать нельзя', async () => {
    const { network } = await mirror('arm64', { header: 'x64' });

    await expect(fetchArm64(network.fetchImpl)).rejects.toThrow(/Mach-O arm64.*x64/);
    expect(network.calls).toHaveLength(2);
    expect(await readdir(out).catch(() => [])).toEqual([]);
  });
});

describe('сборка кладёт файл туда, где его ищет окно', () => {
  const builder = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');

  it('скрипт пишет в build/node/darwin-<arch>, extraResources несёт каталог в Resources/node целиком', () => {
    expect(DEFAULT_OUT_ROOT).toBe(path.join(desktopRoot, 'build', 'node'));
    // `from` — каталог архитектуры цели, `to: node`: так bin/node становится Resources/node/bin/node,
    // тем самым путём, который берёт `bundledNodeBin` (`main/host-launcher.ts`), а LICENSE — Resources/node/LICENSE.
    expect(builder).toMatch(/- from: build\/node\/darwin-\$\{arch\}\n\s+to: node\n/);
    // Без `filter`: каталог уезжает целиком, и лицензия вместе с бинарём.
    expect(builder).not.toMatch(/- from: build\/node\/darwin-\$\{arch\}\n\s+to: node\n\s+filter:/);
  });
});
