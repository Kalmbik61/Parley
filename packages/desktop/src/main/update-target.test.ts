import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  archiveName,
  assetUrl,
  besideApp,
  bundleOf,
  installRefusal,
  parseStagingName,
  probeLockf,
  stagingDir,
  type InstallRefusalInput,
} from './update-target.js';

const EXE = '/Applications/Parley.app/Contents/MacOS/Parley';

describe('archiveName', () => {
  it.each([
    ['arm64', 'parley-macos-arm64.zip'],
    ['x64', 'parley-macos-x64.zip'],
    ['ia32', null],
    ['', null],
  ])('%s -> %s', (arch, expected) => {
    expect(archiveName(arch)).toBe(expected);
  });

  // SU-24: имя в коде равно artifactName из electron-builder.yml с подставленной архитектурой
  it('SU-24: совпадает с artifactName из electron-builder.yml для обеих архитектур', async () => {
    const yml = await readFile(fileURLToPath(new URL('../../electron-builder.yml', import.meta.url)), 'utf8');
    const m = /^\s*artifactName:\s*(\S+)\s*$/m.exec(yml);
    expect(m).not.toBeNull();
    for (const arch of ['arm64', 'x64']) {
      expect(archiveName(arch)).toBe(m![1]!.replace('${arch}', arch).replace('${ext}', 'zip'));
    }
  });
});

describe('assetUrl', () => {
  it('собирает адрес из констант', () => {
    expect(assetUrl('1.2.3', 'parley-macos-arm64.zip')).toBe(
      'https://github.com/Kalmbik61/Parley/releases/download/v1.2.3/parley-macos-arm64.zip',
    );
    expect(assetUrl('0.10.0', 'SHA256SUMS.txt')).toBe(
      'https://github.com/Kalmbik61/Parley/releases/download/v0.10.0/SHA256SUMS.txt',
    );
  });

  it.each(['1.2', 'v1.2.3', '1.2.3-beta.1', '1.2.3/../x', '', '1.2.3\n', 'a.b.c'])('версия %j — исключение', (v) => {
    expect(() => assetUrl(v, 'x.zip')).toThrow();
  });
});

describe('bundleOf', () => {
  it('разбирает путь исполняемого файла', () => {
    expect(bundleOf(EXE)).toEqual({ parent: '/Applications', name: 'Parley', app: '/Applications/Parley.app' });
    expect(bundleOf('/Users/me/My Apps/Parley.app/Contents/MacOS/Parley')).toEqual({
      parent: '/Users/me/My Apps',
      name: 'Parley',
      app: '/Users/me/My Apps/Parley.app',
    });
  });

  it('приложение в корне', () => {
    expect(bundleOf('/Parley.app/Contents/MacOS/Parley')).toEqual({ parent: '/', name: 'Parley', app: '/Parley.app' });
  });

  it.each([
    '/usr/local/bin/parley',
    '/Applications/Parley.app/Contents/Resources/Parley',
    '/Applications/Parley.app/Contents/MacOS/',
    '/Applications/Parley/Contents/MacOS/Parley',
    '/Applications/.app/Contents/MacOS/Parley',
    '/Applications/Parley.app/Contents/MacOS/x/Parley',
    'Parley.app/Contents/MacOS/Parley',
    '',
  ])('%j — null', (p) => {
    expect(bundleOf(p)).toBeNull();
  });
});

describe('besideApp и stagingDir', () => {
  const bundle = bundleOf(EXE)!;

  it('имена по спеке §5.5', () => {
    expect(besideApp(bundle)).toEqual({
      old: '/Applications/.Parley.app.old',
      result: '/Applications/.Parley.app.result',
      lock: '/Applications/.Parley.app.swap',
    });
  });

  it('каталог подготовки по спеке §5.3', () => {
    expect(stagingDir(bundle, 4242, 3)).toBe('/Applications/.Parley.app.update-4242-3');
  });
});

describe('parseStagingName', () => {
  it.each([
    ['.Parley.app.update-4242-3', 'Parley', { pid: 4242, n: 3 }],
    ['.Parley.app.update-1-1', 'Parley', { pid: 1, n: 1 }],
    ['.My App.app.update-9-10', 'My App', { pid: 9, n: 10 }],
    ['.Other.app.update-9-1', 'Parley', null],
    ['.Parley.app.update-9', 'Parley', null],
    ['.Parley.app.update-9-1-2', 'Parley', null],
    ['.Parley.app.update-a-1', 'Parley', null],
    ['.Parley.app.update--1', 'Parley', null],
    ['.Parley.app.old', 'Parley', null],
    ['Parley.app.update-9-1', 'Parley', null],
    ['', 'Parley', null],
  ])('%j (%s) -> %j', (name, bundleName, expected) => {
    expect(parseStagingName(name, bundleName)).toEqual(expected);
  });

  it('круговой разбор с stagingDir', () => {
    const bundle = bundleOf(EXE)!;
    expect(parseStagingName(path.basename(stagingDir(bundle, 77, 5)), bundle.name)).toEqual({ pid: 77, n: 5 });
  });
});

describe('installRefusal (SU-23)', () => {
  const ok: InstallRefusalInput = {
    platform: 'darwin',
    packaged: true,
    exePath: EXE,
    canWrite: () => true,
    lockfWorks: true,
  };

  it('всё в порядке — null', () => {
    expect(installRefusal(ok)).toBeNull();
  });

  it.each<[string, Partial<InstallRefusalInput>, string]>([
    ['не macOS', { platform: 'linux' }, 'platform'],
    ['несобранное окно', { packaged: false }, 'not_packaged'],
    ['путь не приложения', { exePath: '/usr/local/bin/parley' }, 'bad_path'],
    ['образ диска', { exePath: '/Volumes/Parley/Parley.app/Contents/MacOS/Parley' }, 'volume'],
    [
      'AppTranslocation',
      { exePath: '/private/var/folders/x/AppTranslocation/ABC/d/Parley.app/Contents/MacOS/Parley' },
      'translocated',
    ],
    ['нет записи в каталог', { canWrite: (p) => p !== '/Applications' }, 'not_writable'],
    ['нет записи в приложение', { canWrite: (p) => p !== '/Applications/Parley.app' }, 'not_writable'],
    ['lockf без формы с дескриптором', { lockfWorks: false }, 'no_lockf'],
  ])('%s', (_title, patch, reason) => {
    expect(installRefusal({ ...ok, ...patch })).toBe(reason);
  });

  it('canWrite спрашивают про каталог и про приложение', () => {
    const asked: string[] = [];
    installRefusal({
      ...ok,
      canWrite: (p) => {
        asked.push(p);
        return true;
      },
    });
    expect(asked).toEqual(['/Applications', '/Applications/Parley.app']);
  });
});

describe('probeLockf', () => {
  it('true только при коде 0, запускает оболочку с нужной формой', async () => {
    const calls: Array<[string, string[]]> = [];
    const make = (code: number | null) => async (file: string, args: string[]) => {
      calls.push([file, args]);
      return code;
    };
    expect(await probeLockf(make(0), '/tmp/x.lock')).toBe(true);
    expect(await probeLockf(make(75), '/tmp/x.lock')).toBe(false);
    expect(await probeLockf(make(null), '/tmp/x.lock')).toBe(false);
    expect(calls[0]).toEqual([
      '/bin/sh',
      ['-c', 'exec 9>"$1" && /usr/bin/lockf -s -t 0 9', 'sh', '/tmp/x.lock'],
    ]);
  });

  const onMac = process.platform === 'darwin' ? it : it.skip;
  onMac('только macOS: на настоящем /usr/bin/lockf берёт замок на пустом файле', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'probe-lockf-'));
    try {
      const run = (file: string, args: string[]) =>
        new Promise<number | null>((resolve) => {
          execFile(file, args, (err) => {
            if (!err) resolve(0);
            else resolve(typeof err.code === 'number' ? err.code : null);
          });
        });
      expect(await probeLockf(run, path.join(dir, 'probe.lock'))).toBe(true);
      // каталога нет — открыть файл не выйдет, проба отвечает «нет»
      expect(await probeLockf(run, path.join(dir, 'missing', 'probe.lock'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
