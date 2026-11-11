/**
 * Проверка собранных .app (`scripts/release/verify-packaged-apps.sh`, P2 плана релиза 0.1.0, правки ревью F): что
 * лежит в приложении, без чего оно не запустится у человека, — встроенный Node нужной архитектуры с текстом его
 * лицензии, хост, нативные файлы node-pty своей архитектуры (и никакого `build/Release`), лицензии.
 *
 * Скрипт идёт в `release.yml` перед загрузкой в черновик, а прогнать его целиком можно только на macOS после
 * двух сборок по полгигабайта. Тест гоняет настоящий `bash` по подставному дереву: утилиты macOS (`codesign`,
 * `plutil`, `lipo`, `arch`, `uname`) — скрипты в начале `PATH`, `.app` — каталоги с крошечными файлами, у
 * которых архитектура записана строкой `# ARCH:…`, а встроенный node — shell-скрипт, который отвечает на
 * `--version` и `-e`. Так проверяется логика скрипта (что он требует и что отвергает), а не сборка.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NODE_VERSION } from '../scripts/fetch-node.mjs';

// Каждый тест — десяток запусков bash и подставных утилит; под нагрузкой полного прогона пяти секунд по умолчанию мало.
vi.setConfig({ testTimeout: 30_000 });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = path.join(repoRoot, 'scripts', 'release', 'verify-packaged-apps.sh');
const desktopVersion = (
  JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'desktop', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

type Arch = 'arm64' | 'x64';
/** Как архитектуру называет `lipo -archs`. */
const LIPO: Record<Arch, string> = { arm64: 'arm64', x64: 'x86_64' };
/** Каталоги вывода electron-builder: arm64 — `mac-arm64`, x64 — `mac`. */
const OUT: Record<Arch, string> = { arm64: 'mac-arm64', x64: 'mac' };

function put(file: string, content: string, mode = 0o644): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, mode);
}

interface AppOptions {
  /** Версия, которую встроенный node называет на `--version`. */
  nodeVersion?: string;
  /** `require('node-pty')` под встроенным node отказывает. */
  loadFails?: boolean;
  /**
   * Что встроенный node печатает на проверку запуска Code Mode (`--input-type=module -e …`). По умолчанию arm64 — `ok`,
   * x64 — отказ по архитектуре. Это ответ ПОДСТАВНОГО node: тест проверяет логику скрипта, а не нативную проверку.
   */
  launchVerdict?: string;
  /** Проверка запуска падает (node выходит с кодом 1). */
  launchFails?: boolean;
}

/** Каталог @parley/core внутри хоста — так его раскладывает pnpm deploy. */
const coreDir = (resources: string): string =>
  path.join(resources, 'host', 'node_modules', '.pnpm', '@parley+core@file+packages+core', 'node_modules', '@parley', 'core');
const probeFile = (resources: string): string => path.join(coreDir(resources), 'native', 'darwin-arm64', 'procinfo-probe');
const manifestFile = (resources: string): string => path.join(coreDir(resources), 'native', 'darwin-arm64', 'manifest.json');
/** Нативная проверка Code Mode: arm64 в обоих приложениях (deploy хоста один), манифест с её sha256. */
function putProbe(resources: string, arch = 'arm64'): void {
  const body = `# ARCH:${arch}\nprocinfo probe\n`;
  put(probeFile(resources), body, 0o755);
  put(manifestFile(resources), JSON.stringify({ v: 1, arch: 'arm64', binarySha256: createHash('sha256').update(body).digest('hex') }));
}

/** Копия @parley/core в мосте Remote access — так её раскладывает pnpm deploy моста (план T9b-packaging). */
const remoteCoreDir = (resources: string): string =>
  path.join(resources, 'remote', 'node_modules', '.pnpm', '@parley+core@file+packages+core', 'node_modules', '@parley', 'core');
const CORE_PACKAGE = JSON.stringify({ name: '@parley/core', version: '0.0.0' });

/**
 * Минимальный app.asar: заголовок — pickle Chromium (u32 4, u32 размер pickle заголовка, u32 размер его данных, u32 длина
 * строки, JSON с выравниванием до 4), затем данные файлов. `files` — путь внутри архива → содержимое; `unpacked` — те, что
 * лежат в app.asar.unpacked.
 */
function putAsar(resources: string, files: Record<string, string>, unpacked: Record<string, string> = {}): void {
  const header: { files: Record<string, unknown> } = { files: {} };
  const node = (rel: string): Record<string, unknown> => {
    let at = header as { files: Record<string, unknown> };
    const parts = rel.split('/');
    for (const part of parts.slice(0, -1)) at = (at.files[part] ??= { files: {} }) as { files: Record<string, unknown> };
    return at.files as Record<string, unknown>;
  };
  const data: Buffer[] = [];
  let offset = 0;
  for (const [rel, body] of Object.entries(files)) {
    const buf = Buffer.from(body);
    node(rel)[rel.split('/').pop()!] = { size: buf.length, offset: String(offset) };
    data.push(buf);
    offset += buf.length;
  }
  for (const [rel, body] of Object.entries(unpacked)) {
    node(rel)[rel.split('/').pop()!] = { size: Buffer.byteLength(body), unpacked: true };
    put(path.join(resources, 'app.asar.unpacked', rel), body, rel.endsWith('procinfo-probe') ? 0o755 : 0o644);
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded, 4);
  head.writeUInt32LE(4 + padded, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  put(path.join(resources, 'app.asar'), '');
  writeFileSync(path.join(resources, 'app.asar'), Buffer.concat([head, ...data]));
}

/** Три копии @parley/core, как в собранном приложении: хост, мост и app.asar окна с распакованной проверкой. */
function putCoreCopies(resources: string): void {
  put(path.join(coreDir(resources), 'package.json'), CORE_PACKAGE);
  const remote = remoteCoreDir(resources);
  put(path.join(remote, 'package.json'), CORE_PACKAGE);
  put(path.join(remote, 'native', 'darwin-arm64', 'procinfo-probe'), '# ARCH:arm64\nprocinfo probe\n', 0o755);
  putAsar(
    resources,
    { 'package.json': JSON.stringify({ name: '@parley/desktop' }), 'node_modules/@parley/core/package.json': CORE_PACKAGE },
    { 'node_modules/@parley/core/native/darwin-arm64/procinfo-probe': '# ARCH:arm64\nprocinfo probe\n' },
  );
}

let work = '';
let dist = '';
let log = '';
/** Подставные утилиты — один каталог на весь файл: каждый новый исполняемый файл macOS проверяет при первом запуске. */
let fakeBin = '';

/** Собранное приложение, каким его ждёт скрипт: всё на месте и своей архитектуры. */
function makeApp(arch: Arch, options: AppOptions = {}): string {
  const app = path.join(dist, OUT[arch], 'Parley.app');
  const resources = path.join(app, 'Contents', 'Resources');
  const marker = `# ARCH:${LIPO[arch]}\n`;
  put(
    path.join(app, 'Contents', 'Info.plist'),
    `CFBundleIdentifier=dev.parley.desktop\nCFBundleShortVersionString=${desktopVersion}\n`,
  );
  // Встроенный node: shell-скрипт с отметкой архитектуры; `-e` — загрузка node-pty, `--input-type=module` — проверка
  // запуска Code Mode (печатает заданный вердикт).
  const verdict = options.launchVerdict ?? (arch === 'arm64' ? 'ok' : 'refused: unsupported platform darwin/x64');
  put(
    path.join(resources, 'node', 'bin', 'node'),
    `#!/bin/sh\n${marker}case "$1" in\n  --version) echo "v${options.nodeVersion ?? NODE_VERSION}" ;;\n  -e) exit ${options.loadFails === true ? 1 : 0} ;;\n  --input-type=module) printf '%s\\n' '${verdict}'; exit ${options.launchFails === true ? 1 : 0} ;;\nesac\n`,
    0o755,
  );
  putProbe(resources);
  putCoreCopies(resources);
  put(path.join(resources, 'node', 'LICENSE'), 'Node.js is licensed for use as follows: MIT\n');
  // Движок голосового ввода: `--help` отвечает кодом 0 (запускается только у родной архитектуры).
  put(
    path.join(resources, 'whisper', 'bin', 'whisper-cli'),
    `#!/bin/sh\n${marker}[ "$1" = "--help" ] && exit 0\nexit 1\n`,
    0o755,
  );
  put(path.join(resources, 'whisper', 'ggml-silero-v6.2.0.bin'), 'vad\n');
  put(path.join(resources, 'whisper', 'LICENSE'), 'MIT\n');
  put(path.join(resources, 'host', 'dist', 'main.js'), '// host\n');
  const prebuilds = path.join(
    resources,
    'host',
    'node_modules',
    'node-pty',
    'prebuilds',
    `darwin-${arch}`,
  );
  put(path.join(prebuilds, 'pty.node'), marker);
  put(path.join(prebuilds, 'spawn-helper'), marker, 0o755);
  for (const license of ['NOTICE', 'licenses/Figtree-OFL.txt', 'licenses/Caprasimo-OFL.txt']) {
    put(path.join(resources, license), 'license\n');
  }
  return resources;
}

function makeFakeTools(): void {
  const tool = (name: string, body: string): void =>
    put(path.join(fakeBin, name), `#!/bin/sh\n${body}\n`, 0o755);
  // codesign -v ФАЙЛ (подпись нативной проверки) отказывает при FAKE_PROBE_SIG_BAD=1; --verify --deep --strict — всегда успех.
  tool('codesign', '[ "$1" = "-v" ] && [ "${FAKE_PROBE_SIG_BAD:-0}" = "1" ] && { echo "invalid signature" >&2; exit 1; }\nexit 0');
  // plutil -extract KEY raw -o - FILE: ключи лежат в поддельном Info.plist строками KEY=значение.
  tool('plutil', 'grep "^$2=" "$6" | cut -d= -f2-');
  // lipo -archs FILE: архитектура — в строке `# ARCH:…` файла.
  tool('lipo', `sed -n 's/^# ARCH://p' "$2" | head -n 1`);
  tool('uname', 'echo "${FAKE_UNAME:-arm64}"');
  // arch -x86_64 КОМАНДА…: «Rosetta» есть, пока FAKE_ROSETTA не 0; запуск пишется в журнал.
  tool(
    'arch',
    '[ "$1" = "-x86_64" ] || exit 2\nshift\n[ "${FAKE_ROSETTA:-1}" = "1" ] || { echo "arch: Bad CPU type in executable" >&2; exit 86; }\necho "arch -x86_64 $*" >> "$FAKE_LOG"\nexec "$@"',
  );
  // otool -L FILE: печатает только системные библиотеки; `FAKE_OTOOL_RPATH=1` добавляет библиотеку сборки (@rpath) и
  // следом ещё мегабайт вывода тем же процессом (`exec`): grep -q закрывает конвейер на первой находке, otool получает SIGPIPE (под pipefail
  // конвейер — 141), и проверка, которая на этом строится, пропускает находку.
  tool(
    'otool',
    'echo "$2:"\necho "\\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)"\nif [ "${FAKE_OTOOL_RPATH:-0}" = "1" ]; then\n  echo "\\t@rpath/libggml.dylib (compatibility version 0.0.0)"\n  exec awk \'BEGIN { for (i = 0; i < 20000; i++) print "\\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)" }\'\nfi\nexit 0',
  );
  // Настоящий node нужен самому скрипту (`node -p` для версии окна и закреплённой версии Node).
  symlinkSync(process.execPath, path.join(fakeBin, 'node'));
}

function run(env: Record<string, string> = {}) {
  const result = spawnSync('bash', [script, dist], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_LOG: log,
      ...env,
    },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const logged = (): string => {
  try {
    return readFileSync(log, 'utf8');
  } catch {
    return '';
  }
};

beforeAll(() => {
  fakeBin = mkdtempSync(path.join(tmpdir(), 'verify-apps-bin-'));
  makeFakeTools();
});

afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true });
});

beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'verify-apps-'));
  dist = path.join(work, 'dist');
  log = path.join(work, 'arch.log');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('verify-packaged-apps.sh', () => {
  it('исправные приложения — проходят; на arm64 с Rosetta встроенный node запускается у обоих', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run();

    expect(status, out).toBe(0);
    expect(out).toContain('mac-arm64: ok');
    expect(out).toContain('mac: ok');
    expect(out).toContain(`mac-arm64: embedded node v${NODE_VERSION} runs and loads node-pty`);
    expect(out).toContain(`mac: embedded node v${NODE_VERSION} runs and loads node-pty`);
    // x64 запущен именно через `arch -x86_64`, а arm64 — напрямую.
    const calls = logged();
    expect(calls).toContain(
      path.join(dist, 'mac', 'Parley.app', 'Contents', 'Resources', 'node', 'bin', 'node'),
    );
    expect(calls).not.toContain(path.join(dist, 'mac-arm64'));
  });

  it('x64 под Rosetta whisper-cli не запускает: он собран с AVX2, а Rosetta его не исполняет', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run();

    expect(status, out).toBe(0);
    expect(logged()).not.toContain('whisper-cli');
  });

  it('whisper-cli родной архитектуры не запускается — отказ', () => {
    const resources = makeApp('arm64');
    makeApp('x64');
    put(
      path.join(resources, 'whisper', 'bin', 'whisper-cli'),
      '#!/bin/sh\n# ARCH:arm64\nexit 1\n',
      0o755,
    );

    const { status, out } = run();

    expect(status).toBe(1);
    expect(out).toContain('mac-arm64: whisper-cli does not start');
  });

  it('whisper-cli ссылается на библиотеки сборки (@rpath) — отказ', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run({ FAKE_OTOOL_RPATH: '1' });

    expect(status).toBe(1);
    expect(out).toContain('whisper-cli links libraries from the build (@rpath)');
  });

  it('без whisper-cli — отказ с понятной причиной', () => {
    const resources = makeApp('arm64');
    makeApp('x64');
    rmSync(path.join(resources, 'whisper', 'bin', 'whisper-cli'));

    const { status, out } = run();

    expect(status).not.toBe(0);
    expect(out).toContain('whisper-cli');
  });

  it.each(['ggml-silero-v6.2.0.bin', 'LICENSE'])(
    'без %s в Resources/whisper — отказ',
    (file) => {
      const resources = makeApp('arm64');
      makeApp('x64');
      rmSync(path.join(resources, 'whisper', file));

      const { status, out } = run();

      expect(status).toBe(1);
      expect(out).toContain(`Contents/Resources/whisper/${file}`);
    },
  );

  it('нет Rosetta — x64 проверен по файлам, его node не запускается, скрипт предупреждает и проходит', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run({ FAKE_ROSETTA: '0' });

    expect(status, out).toBe(0);
    expect(out).toMatch(/^::warning::Rosetta is not available/m);
    expect(out).toContain('mac: ok');
    expect(out).not.toContain('mac: embedded node');
    expect(logged()).not.toContain('Parley.app');
  });

  it('машина x86_64 запускает только своё (x64) приложение и Rosetta не спрашивает', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run({ FAKE_UNAME: 'x86_64' });

    expect(status, out).toBe(0);
    expect(out).toContain(`mac: embedded node v${NODE_VERSION} runs and loads node-pty`);
    expect(out).not.toContain('mac-arm64: embedded node');
    expect(logged()).toBe('');
  });

  it.each(['arm64', 'x64'] as const)(
    'в приложении %s нет текста лицензии Node (Resources/node/LICENSE) — отказ',
    (arch) => {
      const resources = makeApp(arch);
      makeApp(arch === 'arm64' ? 'x64' : 'arm64');
      rmSync(path.join(resources, 'node', 'LICENSE'));

      const { status, out } = run();

      expect(status).toBe(1);
      expect(out).toMatch(/^::error::.*has no Contents\/Resources\/node\/LICENSE/m);
    },
  );

  it('пустой LICENSE — тоже отказ', () => {
    const resources = makeApp('arm64');
    makeApp('x64');
    writeFileSync(path.join(resources, 'node', 'LICENSE'), '');

    const { status, out } = run();

    expect(status).toBe(1);
    expect(out).toContain('node/LICENSE');
  });

  it.each(['Release', 'Debug'])(
    'у node-pty есть build/%s/pty.node — отказ: он грузится раньше prebuilds и ломает приложение другой архитектуры',
    (kind) => {
      makeApp('arm64');
      const resources = makeApp('x64');
      put(
        path.join(resources, 'host', 'node_modules', 'node-pty', 'build', kind, 'pty.node'),
        '# ARCH:arm64\n',
      );

      const { status, out } = run();

      expect(status).toBe(1);
      expect(out).toContain(`node-pty has build/${kind}/*.node`);
    },
  );

  it('пустой каталог build у node-pty (без .node) — не повод для отказа', () => {
    makeApp('arm64');
    const resources = makeApp('x64');
    mkdirSync(path.join(resources, 'host', 'node_modules', 'node-pty', 'build', 'Release'), {
      recursive: true,
    });

    const { status, out } = run();

    expect(status, out).toBe(0);
  });

  it.each(['pty.node', 'spawn-helper'])(
    'нативный файл node-pty %s в приложении x64 не x64 — отказ, хотя лежит в каталоге darwin-x64',
    (file) => {
      makeApp('arm64');
      const resources = makeApp('x64');
      put(
        path.join(resources, 'host', 'node_modules', 'node-pty', 'prebuilds', 'darwin-x64', file),
        '# ARCH:arm64\n',
        0o755,
      );

      const { status, out } = run();

      expect(status).toBe(1);
      expect(out).toContain(`node-pty ${file} for darwin-x64 is not a x86_64 binary`);
    },
  );

  it('x64: встроенный node другой версии — отказ (скрипт запускает его через Rosetta, а не верит каталогу)', () => {
    makeApp('arm64');
    makeApp('x64', { nodeVersion: '20.0.0' });

    const { status, out } = run();

    expect(status).toBe(1);
    expect(out).toContain(`mac: the embedded node is not v${NODE_VERSION}`);
  });

  it('x64: node-pty не грузится под встроенным node — отказ', () => {
    makeApp('arm64');
    makeApp('x64', { loadFails: true });

    const { status, out } = run();

    expect(status).toBe(1);
    expect(out).toContain('mac: node-pty does not load under the embedded node');
  });

  it('arm64: встроенный node другой версии или node-pty не грузится — отказ, как и прежде', () => {
    makeApp('x64');
    makeApp('arm64', { nodeVersion: '20.0.0' });
    expect(run().out).toContain(`mac-arm64: the embedded node is not v${NODE_VERSION}`);

    rmSync(dist, { recursive: true, force: true });
    makeApp('x64');
    makeApp('arm64', { loadFails: true });
    expect(run().out).toContain('mac-arm64: node-pty does not load');
  });

  it('приложение x64 не собрано — отказ с путём', () => {
    makeApp('arm64');

    const { status, out } = run();

    expect(status).toBe(1);
    expect(out).toMatch(/^::error::.*mac\/Parley\.app was not built/m);
  });

  it('Code Mode: обе архитектуры несут проверку; arm64 получает EPERM, x64 под Rosetta отказывается по архитектуре', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run();

    expect(status, out).toBe(0);
    expect(out).toContain('mac-arm64: Code Mode launch probe denied foreign process info (EPERM)');
    expect(out).toContain('mac: Code Mode refuses this architecture (refused: unsupported platform darwin/x64)');
    // x64 проверялся через `arch -x86_64`, как и его node.
    expect(logged()).toContain('arch -x86_64');
  });

  it('машина x86_64: своё x64-приложение отказывает по архитектуре без Rosetta', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run({ FAKE_UNAME: 'x86_64' });

    expect(status, out).toBe(0);
    expect(out).toContain('mac: Code Mode refuses this architecture');
    expect(out).not.toContain('mac-arm64: Code Mode launch probe');
  });

  const fileCases: [string, (resources: string) => void, string][] = [
    ['нет бинаря проверки', (r) => rmSync(probeFile(r)), 'the Code Mode probe is missing'],
    ['нет манифеста', (r) => rmSync(manifestFile(r)), 'the Code Mode probe manifest is missing'],
    ['байты бинаря не совпадают с манифестом (переподписан?)', (r) => writeFileSync(probeFile(r), '# ARCH:arm64\nresigned\n'), 'bytes differ from its manifest'],
    ['бинарь не arm64', (r) => putProbe(r, 'x86_64'), 'the Code Mode probe is not an arm64 binary'],
    ['нет @parley/core в хосте', (r) => rmSync(path.join(r, 'host', 'node_modules', '.pnpm'), { recursive: true }), '@parley/core is missing from the host'],
  ];
  it.each(fileCases)('Code Mode: %s — отказ', (_label, breakIt, message) => {
    for (const arch of ['arm64', 'x64'] as const) {
      rmSync(dist, { recursive: true, force: true });
      const resources = makeApp(arch);
      makeApp(arch === 'arm64' ? 'x64' : 'arm64');
      breakIt(resources);

      const { status, out } = run();

      expect(status, `${arch}: ${out}`).toBe(1);
      expect(out).toContain(message);
    }
  });

  it('Code Mode: подпись проверки не проходит codesign -v — отказ', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run({ FAKE_PROBE_SIG_BAD: '1' });

    expect(status).toBe(1);
    expect(out).toContain('the Code Mode probe signature is not valid');
  });

  // Вердикты подставного node: отказ, частичный EPERM (только одна из двух проверок), мусор, пустота, сбой запуска.
  const arm64Verdicts: [string, AppOptions][] = [
    ['чужой kinfo_proc читается', { launchVerdict: 'refused: launch probe: foreign kinfo_proc not denied (errno 0)' }],
    ['EPERM только у одной из двух проверок', { launchVerdict: 'refused: launch probe: foreign KERN_PROCARGS2 not denied (errno 0)' }],
    ['другой errno', { launchVerdict: 'refused: launch probe: foreign kinfo_proc not denied (errno 22)' }],
    ['проверка не собрана', { launchVerdict: 'refused: native probe not built' }],
    ['мусор вместо вердикта', { launchVerdict: 'PARLEY_PROCINFO_PROBE_STARTED 1' }],
    ['пустой вывод', { launchVerdict: '' }],
    ['ok с хвостом', { launchVerdict: 'ok but partial' }],
    ['проверка упала', { launchFails: true }],
  ];
  it.each(arm64Verdicts)('Code Mode arm64: %s — отказ (fail-closed)', (_label, options) => {
    makeApp('arm64', options);
    makeApp('x64');

    const { status, out } = run();

    expect(status, out).toBe(1);
    expect(out).toMatch(/^::error::mac-arm64: (the Code Mode launch proof did not run|Code Mode launch proof: expected ok)/m);
  });

  // Копии @parley/core (план T9b-packaging, предложение §3, пункты 1 и 4): ровно хост, мост и app.asar; signIgnore покрывает
  // настоящий путь каждой проверки на диске.
  const copyCases: [string, (resources: string) => void, string][] = [
    ['четвёртая копия', (r) => put(path.join(r, 'extra', 'node_modules', '@parley', 'core', 'package.json'), CORE_PACKAGE), 'found: asar, host, remote, unknown:extra/node_modules/@parley/core'],
    ['нет копии моста', (r) => rmSync(path.join(r, 'remote'), { recursive: true }), 'found: asar, host'],
    ['вторая копия в хосте', (r) => put(path.join(r, 'host', 'node_modules', '@parley', 'core', 'package.json'), CORE_PACKAGE), 'found: asar, host, host, remote'],
    ['нет копии в app.asar', (r) => putAsar(r, { 'package.json': '{}' }), 'found: host, remote'],
    [
      'проверка по пути, который signIgnore не покрывает',
      (r) => put(path.join(remoteCoreDir(r), 'native', 'darwin-arm64-old', 'procinfo-probe'), '# ARCH:arm64\n', 0o755),
      'mac.signIgnore does not match these probe paths',
    ],
  ];
  it.each(copyCases)('Code Mode: %s — отказ', (_label, breakIt, message) => {
    for (const arch of ['arm64', 'x64'] as const) {
      rmSync(dist, { recursive: true, force: true });
      const resources = makeApp(arch);
      makeApp(arch === 'arm64' ? 'x64' : 'arm64');
      breakIt(resources);

      const { status, out } = run();

      expect(status, `${arch}: ${out}`).toBe(1);
      expect(out).toContain(message);
    }
  });

  it('Code Mode: исправные копии называются в выводе, signIgnore покрывает все три проверки на диске', () => {
    makeApp('arm64');
    makeApp('x64');

    const { status, out } = run();

    expect(status, out).toBe(0);
    expect(out).toContain('mac-arm64: @parley/core copies: asar, host, remote');
    expect(out).toContain('mac-arm64: mac.signIgnore covers 3 probe paths');
  });

  it.each([
    ['x64-процесс согласился', 'ok'],
    ['x64 отказал по другой причине', 'refused: native probe hash mismatch'],
    ['пустой вывод', ''],
  ])('Code Mode x64: %s — отказ', (_label, launchVerdict) => {
    makeApp('arm64');
    makeApp('x64', { launchVerdict });

    const { status, out } = run();

    expect(status, out).toBe(1);
    expect(out).toMatch(/^::error::mac: Code Mode launch proof: expected refuse/m);
  });
});

// verify-code-mode-package.mjs — инструмент проверки, а не код продукта (s-292, m-7351): его не импортирует и не называет ни
// один файл, который едет в приложение или его собирает, — только два скрипта проверки, этот тест и документы.
describe('verify-code-mode-package.mjs не входит в продукт', () => {
  it('его называют только скрипты проверки релиза, этот тест и документы', () => {
    const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
    expect(tracked.status, tracked.stderr).toBe(0);
    const files = tracked.stdout.split('\0').filter(Boolean);
    files.push('scripts/release/verify-code-mode-package.mjs', 'scripts/release/verify-code-mode-package.sh');
    const allowed = new Set([
      'scripts/release/verify-code-mode-package.mjs',
      'scripts/release/verify-code-mode-package.sh',
      'scripts/release/verify-packaged-apps.sh',
      'packages/desktop/src/verify-packaged-apps.test.ts',
    ]);
    const naming = [...new Set(files)].filter((f) => {
      if (allowed.has(f) || f.startsWith('docs/') || f.startsWith('.parley/')) return false;
      let text: string;
      try {
        text = readFileSync(path.join(repoRoot, f), 'utf8');
      } catch {
        return false;
      }
      return text.includes('verify-code-mode-package');
    });
    expect(naming).toEqual([]);
    expect(files).toContain('packages/desktop/electron-builder.yml');
  });
});
