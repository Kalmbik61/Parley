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
  // Встроенный node: shell-скрипт с отметкой архитектуры; `-e` — загрузка node-pty.
  put(
    path.join(resources, 'node', 'bin', 'node'),
    `#!/bin/sh\n${marker}case "$1" in\n  --version) echo "v${options.nodeVersion ?? NODE_VERSION}" ;;\n  -e) exit ${options.loadFails === true ? 1 : 0} ;;\nesac\n`,
    0o755,
  );
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
  tool('codesign', 'exit 0');
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
});
