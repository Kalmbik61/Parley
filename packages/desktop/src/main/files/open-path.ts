/**
 * «Открыть в приложении» и «Показать в Finder» (спека 10.8, кусок 5.2).
 *
 * `shell.openPath` на macOS — двойной клик Finder: `.command` выполняется в Terminal,
 * `.app` запускается, `.py` без бита x открывает Python Launcher и исполняется, а у
 * файлов, созданных агентом, нет карантина, и Gatekeeper не спросит. Запрещающий
 * список неполон по устройству, поэтому открывается только белый список; всё прочее
 * показывается в Finder. Цена — часть безобидных файлов не открывается отсюда.
 */
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { FilesDeniedError, type RootsRegistry } from '../roots.js';

/** Белый список «открыть в приложении» (спека 10.8): расширения без точки, в нижнем регистре. */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // картинки; `svg` — нет: браузер по умолчанию исполнит его скрипты, а в окне его покажет превью (спека 10.6)
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'ico',
  'pdf',
  // простой текст и данные
  'txt', 'md', 'markdown', 'rtf', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'log',
  // документы
  'docx', 'xlsx', 'pptx', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp',
  // медиа
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'mp4', 'mov', 'm4v', 'webm',
]);

/** Любой бит исполнения — владельцу, группе или прочим. */
const ANY_EXECUTE_BIT = 0o111;

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

/** Имена — самого пути и его realpath; isDirectory и mode — stat по ссылке. */
export function openVerdict(paths: Array<{ name: string; isDirectory: boolean; mode: number }>): 'open' | 'reveal' {
  const opens = paths.every(({ name, isDirectory, mode }) => {
    // Каталог без расширения Finder откроет папкой; с расширением — бандл (`Foo.app`), он запустился бы.
    if (isDirectory) return extensionOf(name) === '';
    // Бит x главнее белого списка: `notes.txt` 0755 мог бы исполниться.
    if ((mode & ANY_EXECUTE_BIT) !== 0) return false;
    return OPENABLE_EXTENSIONS.has(extensionOf(name));
  });
  return opens ? 'open' : 'reveal';
}

export interface OpenPathDeps {
  roots: RootsRegistry;
  /** `shell.openPath`: '' — успех, иначе текст ошибки. */
  openPath: (absPath: string) => Promise<string>;
  showItemInFolder: (absPath: string) => void;
}

/**
 * `app.openPath`: путь внутри корня любой работы (свою работу проверил `files.locate`),
 * затем белый список. `~` раскрывает main. Открывается realpath: имя и права проверены
 * у него, а не у ссылки, которую могли перенаправить.
 */
export async function openOrReveal(absPath: string, deps: OpenPathDeps): Promise<'opened' | 'revealed'> {
  const expanded = deps.roots.expandHome(absPath);
  const real = await deps.roots.insideAnyRoot(expanded);
  if (real === null) throw new FilesDeniedError(`outside of workspace roots: ${absPath}`);
  // `stat`, а не `lstat`: у самой ссылки на macOS режим 0755, и любой симлинк ушёл бы в reveal.
  const info = await stat(real);
  const verdict = openVerdict([
    { name: path.basename(expanded), isDirectory: info.isDirectory(), mode: info.mode },
    { name: path.basename(real), isDirectory: info.isDirectory(), mode: info.mode },
  ]);
  if (verdict === 'reveal') {
    deps.showItemInFolder(expanded);
    return 'revealed';
  }
  // TOCTOU: между stat и открытием агент мог подменить файл (например, симлинком на
  // исполняемое снаружи). Перед самым openPath — снова realpath и проверка корней, lstat
  // того же пути и тот же dev/ino. Остаток окна до shell.openPath закрыть нельзя: он
  // принимает путь, а не дескриптор (спека 10.8).
  const again = await deps.roots.insideAnyRoot(expanded);
  const now = again === real ? await lstat(real).catch(() => null) : null;
  if (now === null || now.isSymbolicLink() || now.dev !== info.dev || now.ino !== info.ino) {
    deps.showItemInFolder(expanded);
    return 'revealed';
  }
  const failure = await deps.openPath(real);
  // Текст `shell.openPath` на русской macOS локализован — он уходит только в консоль.
  if (failure !== '') throw new Error(`openPath failed: ${failure}`);
  return 'opened';
}

/** `app.showInFinder`: только внутри корня любой работы; показывается сам путь (ссылка — как ссылка). */
export async function revealInFinder(absPath: string, deps: Pick<OpenPathDeps, 'roots' | 'showItemInFolder'>): Promise<void> {
  const expanded = deps.roots.expandHome(absPath);
  if ((await deps.roots.insideAnyRoot(expanded)) === null) {
    throw new FilesDeniedError(`outside of workspace roots: ${absPath}`);
  }
  deps.showItemInFolder(expanded);
}
