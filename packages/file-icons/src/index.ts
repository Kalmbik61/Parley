/**
 * Значки файлов и папок окна (спека docs/specs/2026-10-06-file-icons-design.md, раздел 4): набор
 * Material Icon Theme. Пакет — единственное место, которое знает о наборе: окно зовёт только
 * `fileIconUrl` и `folderIconUrl`, а замена набора — правка этого пакета (4.5).
 *
 * Правила повторяют VS Code для манифеста иконок (4.3): регистр не важен, полное имя важнее
 * расширения, составное расширение (`test.ts`) важнее простого, в светлой теме на каждом шаге сначала
 * таблица `light`. `languageIds` не используются: языка файла окно не знает.
 */

import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };
import { FILE_ICONS_DIR } from './dir.js';

export { FILE_ICONS_DIR };

export type IconTheme = 'dark' | 'light';

type Table = Readonly<Record<string, string>>;
type Kind = 'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded';
type Lookup = Record<Kind, ReadonlyMap<string, string>[]>;

/** Нужная окну часть манифеста `dist/material-icons.json`. */
interface Manifest extends Record<Kind, Table> {
  iconDefinitions: Readonly<Record<string, { iconPath: string }>>;
  light: Record<Kind, Table>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const MANIFEST = manifest as unknown as Manifest;
const KINDS: readonly Kind[] = ['fileNames', 'fileExtensions', 'folderNames', 'folderNamesExpanded'];

/** Таблица с ключами в нижнем регистре: в манифесте встречаются `APKBUILD`, `META-INF`. */
function lowered(table: Table): ReadonlyMap<string, string> {
  return new Map(Object.entries(table).map(([key, id]) => [key.toLowerCase(), id]));
}

/** По теме и виду — таблицы в порядке поиска; строятся один раз, при первом вызове. */
let tables: Record<IconTheme, Lookup> | null = null;

function build(): Record<IconTheme, Lookup> {
  const dark = {} as Lookup;
  const light = {} as Lookup;
  for (const kind of KINDS) {
    const base = lowered(MANIFEST[kind]);
    dark[kind] = [base];
    light[kind] = [lowered(MANIFEST.light[kind]), base];
  }
  return { dark, light };
}

function lookup(theme: IconTheme, kind: Kind, key: string): string | undefined {
  tables ??= build();
  for (const table of tables[theme][kind]) {
    const id = table.get(key);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Сегменты пути в нижнем регистре, без пустых: `a/src/` → `['a', 'src']`. */
function segments(path: string): string[] {
  return path
    .toLowerCase()
    .split('/')
    .filter((part) => part !== '');
}

/** Сначала последние два сегмента (`.github/issue_template`), затем одно имя. */
function byPath(theme: IconTheme, kind: Kind, parts: readonly string[]): string | undefined {
  const name = parts.at(-1);
  if (name === undefined) return undefined;
  const parent = parts.at(-2);
  return (parent === undefined ? undefined : lookup(theme, kind, `${parent}/${name}`)) ?? lookup(theme, kind, name);
}

/** Расширения от длинного к короткому: `foo.test.ts` → `test.ts`, затем `ts`; у `.eslintrc` — `eslintrc`. */
function byExtension(theme: IconTheme, name: string): string | undefined {
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const id = lookup(theme, 'fileExtensions', name.slice(dot + 1));
    if (id !== undefined) return id;
  }
  return undefined;
}

/** Адрес SVG по id: имя файла — из `iconPath`, у 72 значков оно не равно id (`sty` → `sty.clone.svg`). */
function urlOf(id: string): string {
  const iconPath = MANIFEST.iconDefinitions[id]?.iconPath ?? `${id}.svg`;
  return `${FILE_ICONS_DIR}/${iconPath.slice(iconPath.lastIndexOf('/') + 1)}`;
}

/** Адрес SVG файла по имени или пути от корня: `src/package.json` → `file-icons/nodejs.svg`. */
export function fileIconUrl(path: string, theme: IconTheme): string {
  const parts = segments(path);
  return urlOf(byPath(theme, 'fileNames', parts) ?? byExtension(theme, parts.at(-1) ?? '') ?? MANIFEST.file);
}

/** Адрес SVG папки по пути от корня; у открытой папки — свой значок. */
export function folderIconUrl(path: string, open: boolean, theme: IconTheme): string {
  const id = byPath(theme, open ? 'folderNamesExpanded' : 'folderNames', segments(path));
  return urlOf(id ?? (open ? MANIFEST.folderExpanded : MANIFEST.folder));
}
