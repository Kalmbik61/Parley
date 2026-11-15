import path from 'node:path';

/**
 * Самообновление: адреса, имена рядом с приложением и «можно ли заменить себя» (спека self-update §3, §5.2, §5.3,
 * §5.5). Чистые функции без обращения к диску, кроме `probeLockf`, который запускает переданную функцию запуска.
 */

const RELEASES_BASE = 'https://github.com/Kalmbik61/Parley/releases/download';
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** Имя архива релиза под архитектуру запущенной сборки; другая архитектура — `null`. */
export function archiveName(arch: string): string | null {
  return arch === 'arm64' || arch === 'x64' ? `parley-macos-${arch}.zip` : null;
}

/** Адрес файла релиза (решение 5); версия не вида `X.Y.Z` — исключение. */
export function assetUrl(version: string, file: string): string {
  if (!VERSION_RE.test(version)) throw new Error(`bad version: ${version}`);
  return `${RELEASES_BASE}/v${version}/${file}`;
}

export interface Bundle {
  /** Каталог, в котором лежит приложение. */
  parent: string;
  /** Имя приложения без `.app`. */
  name: string;
  /** Путь приложения: `<parent>/<name>.app`. */
  app: string;
}

/** Приложение по пути исполняемого файла `<каталог>/<имя>.app/Contents/MacOS/<файл>`; другой вид — `null`. */
export function bundleOf(exePath: string): Bundle | null {
  if (!path.isAbsolute(exePath)) return null;
  const parts = exePath.split('/');
  // ['', ...каталог, '<имя>.app', 'Contents', 'MacOS', '<файл>']
  const n = parts.length;
  if (n < 5) return null;
  const [appDir, contents, macos, file] = [parts[n - 4], parts[n - 3], parts[n - 2], parts[n - 1]];
  if (contents !== 'Contents' || macos !== 'MacOS' || !file || !appDir || !appDir.endsWith('.app')) return null;
  const name = appDir.slice(0, -'.app'.length);
  if (!name) return null;
  const parent = parts.slice(0, n - 4).join('/') || '/';
  return { parent, name, app: path.join(parent, appDir) };
}

/** Имена рядом с приложением (§5.5): прежнее приложение, итог, замок замены. */
export function besideApp(bundle: Bundle): { old: string; result: string; lock: string } {
  const base = `.${bundle.name}.app`;
  return {
    old: path.join(bundle.parent, `${base}.old`),
    result: path.join(bundle.parent, `${base}.result`),
    lock: path.join(bundle.parent, `${base}.swap`),
  };
}

/** Каталог подготовки попытки `n` процесса `pid` рядом с приложением (§5.3). */
export function stagingDir(bundle: Bundle, pid: number, n: number): string {
  return path.join(bundle.parent, `.${bundle.name}.app.update-${pid}-${n}`);
}

/** Разбор имени каталога подготовки (без пути) для старта окна; чужое имя — `null`. */
export function parseStagingName(name: string, bundleName: string): { pid: number; n: number } | null {
  const prefix = `.${bundleName}.app.update-`;
  if (!name.startsWith(prefix)) return null;
  const m = /^(\d+)-(\d+)$/.exec(name.slice(prefix.length));
  if (!m) return null;
  return { pid: Number(m[1]), n: Number(m[2]) };
}

export type InstallRefusal =
  | 'platform' // не macOS
  | 'not_packaged' // несобранное окно
  | 'bad_path' // исполняемый файл не внутри `<имя>.app/Contents/MacOS/`
  | 'volume' // образ диска
  | 'translocated' // AppTranslocation
  | 'not_writable' // нет права записи в каталог или в приложение
  | 'no_lockf'; // lockf без формы с дескриптором

export interface InstallRefusalInput {
  platform: string;
  packaged: boolean;
  /** Путь исполняемого файла после `realpath`. */
  exePath: string;
  canWrite(path: string): boolean;
  lockfWorks: boolean;
}

/** Можно ли заменить себя (§5.2): `null` — можно, иначе первая причина отказа. */
export function installRefusal(input: InstallRefusalInput): InstallRefusal | null {
  if (input.platform !== 'darwin') return 'platform';
  if (!input.packaged) return 'not_packaged';
  const bundle = bundleOf(input.exePath);
  if (!bundle) return 'bad_path';
  if (bundle.app.startsWith('/Volumes/')) return 'volume';
  if (bundle.app.includes('/AppTranslocation/')) return 'translocated';
  if (!input.canWrite(bundle.parent) || !input.canWrite(bundle.app)) return 'not_writable';
  if (!input.lockfWorks) return 'no_lockf';
  return null;
}

/**
 * Пробный вызов `lockf -s -t 0 <fd>` на открытом дескрипторе оболочки (форма, на которой стоит замок замены, §5.5).
 * `run` запускает программу и возвращает код выхода (`null` — запуск не удался).
 */
export async function probeLockf(
  run: (file: string, args: string[]) => Promise<number | null>,
  file: string,
): Promise<boolean> {
  const code = await run('/bin/sh', ['-c', 'exec 9>"$1" && /usr/bin/lockf -s -t 0 9', 'sh', file]);
  return code === 0;
}
