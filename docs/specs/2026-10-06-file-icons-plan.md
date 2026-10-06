# Значки файлов и папок — план реализации

> **Для исполнителей-агентов:** обязательный скилл — superpowers:subagent-driven-development (рекомендуется) или superpowers:executing-plans; задачи выполняются по одной. Шаги — чекбоксы (`- [ ]`) для учёта.

**Цель:** значки Material Icon Theme у файлов и папок в пяти местах окна (дерево, вкладки, ⌘P, «Изменения», поиск по файлам). Всё знание о наборе собрано в отдельном пакете `@parley/file-icons`.

**Устройство:**
- Новый workspace-пакет `packages/file-icons` выбирает значок по имени и пути: таблица — манифест `material-icon-theme`, правила — как в VS Code.
- Его плагин Vite отдаёт SVG в dev и кладёт весь набор в сборку рендерера.
- Окно знает только две функции пакета и тонкий компонент `FileTypeIcon`.

**Стек:** TypeScript 5.9 (NodeNext), pnpm workspace, Vite 5 / electron-vite 5, React 18, Vitest 2, Playwright (E2E), npm `material-icon-theme` 5.39.0.

**Спека:** `docs/specs/2026-10-06-file-icons-design.md` (коммит 37f02df). Исполнитель читает спеку и план вместе.

**Рабочее место:** worktree `.claude/worktrees/file-icons`, ветка `feat/file-icons` от `master` cec7dcb. Все команды запускаются из корня worktree. Коммит на каждую задачу, без пуша.

## Общие ограничения

- `material-icon-theme` подключается с точной версией `5.39.0` (без `^`) и только в `packages/file-icons/package.json`. Импортировать `material-icon-theme` можно только внутри `packages/file-icons/`.
- Окно подключает `@parley/file-icons` в `devDependencies`, не в `dependencies`. Страж — `packages/desktop/src/package-deps.test.ts`.
- Значок — `<img alt="" draggable={false}>` с атрибутом `data-file-icon`. Размер в списках — 16 px, во вкладках — 14 px.
- Адрес значка относительный: `file-icons/<имя>.svg`. Каталог задан одной константой `FILE_ICONS_DIR = 'file-icons'` в пакете.
- Новых текстов интерфейса нет. Комментарии и названия тестов — по-русски, тексты окна — по-английски (правило проекта).
- Коммиты в стиле репозитория (`feat(file-icons): …`, `feat(desktop): …`), сообщение по-русски, в конце строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Подготовка worktree перед задачей 1 — один раз: `pnpm install`, затем `pnpm build`. Пакеты `core`, `protocol` и `host` собираются в `dist/`, без этого тесты окна не найдут `@parley/core`.

## Фокус ревью

Случаи, которые спека подразумевает, но обычные тесты легко пропустят. Тест на каждый уже вписан в задачу-владельца.

1. **Вырожденные имена** — `''`, `'foo.'`, `'...'`, имя без точки. Ожидается общий значок `file.svg` без исключений. Задача 1, тест «неизвестное и вырожденное имя».
2. **Путь папки с хвостовым слэшем и глубокой вложенностью** — `packages/app/src/`. Ожидается значок по последнему сегменту (`folder-src.svg`). Задача 1, тест «по последнему сегменту пути».
3. **Симлинк в дереве.** На файл — `Link2`, без картинки. На папку — значок папки по имени. Задача 4.
4. **Переименованный файл в «Изменениях»** — значок по новому пути, а не по старому (`src/b.js → src/b.ts` даёт значок TypeScript). Задача 6.
5. **Вкладка файла с обрезанным названием в палитре** — значок берётся по полному пути вкладки (`filePath`), а не по обрезанному `title`. Задача 5.

---

### Задача 1: пакет `@parley/file-icons` и правила выбора значка

**Файлы:**
- Создать: `packages/file-icons/package.json`
- Создать: `packages/file-icons/tsconfig.json`
- Создать: `packages/file-icons/src/dir.ts`
- Создать: `packages/file-icons/src/index.ts`
- Тест: `packages/file-icons/src/index.test.ts`
- Изменится: `pnpm-lock.yaml` (через `pnpm install`)

**Интерфейсы:**
- Получает: ничего.
- Отдаёт (`@parley/file-icons`):
  - `type IconTheme = 'dark' | 'light'`;
  - `const FILE_ICONS_DIR = 'file-icons'`;
  - `fileIconUrl(path: string, theme: IconTheme): string`;
  - `folderIconUrl(path: string, open: boolean, theme: IconTheme): string`.
  - Обе функции возвращают строку вида `file-icons/nodejs.svg`.

- [ ] **Шаг 1: Создать пакет.**

`packages/file-icons/package.json`:

```json
{
  "name": "@parley/file-icons",
  "version": "0.5.2",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest"
  },
  "dependencies": {
    "material-icon-theme": "5.39.0"
  }
}
```

`packages/file-icons/tsconfig.json`. Опция `resolveJsonModule` нужна для импорта манифеста. Проверено макетом: `tsc` NodeNext, node, Vitest и сборка Vite принимают `import … with { type: 'json' }`.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

`packages/file-icons/src/dir.ts` — отдельный модуль. Плагин (задача 2) берёт константу отсюда и не тянет манифест в процесс конфига:

```ts
/** Каталог значков в сборке рендерера, рядом с `index.html`; его же отдаёт dev-сервер (спека 4.2). */
export const FILE_ICONS_DIR = 'file-icons';
```

Затем из корня worktree:

```bash
pnpm install
```

Ожидается: `material-icon-theme 5.39.0` в `packages/file-icons/node_modules`, `pnpm-lock.yaml` изменился.

- [ ] **Шаг 2: Написать падающие тесты.**

`packages/file-icons/src/index.test.ts`:

```ts
/**
 * Правила выбора значка (спека значков 2026-10-06, 4.3 и 7.1): полное имя важнее расширения,
 * составное расширение важнее простого, регистр не важен, составные ключи из двух сегментов,
 * варианты `_light` в светлой теме, файл значка — из `iconPath`. Последний блок проверяет весь
 * манифест: любой адрес, который отдают функции, есть среди файлов набора.
 */

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import manifest from 'material-icon-theme/dist/material-icons.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { FILE_ICONS_DIR, fileIconUrl, folderIconUrl, type IconTheme } from './index.js';

const file = (path: string, theme: IconTheme = 'dark'): string => fileIconUrl(path, theme);
const folder = (path: string, open: boolean, theme: IconTheme = 'dark'): string => folderIconUrl(path, open, theme);

describe('fileIconUrl', () => {
  it('полное имя важнее расширения', () => {
    expect(file('package.json')).toBe('file-icons/nodejs.svg');
    expect(file('tsconfig.json')).toBe('file-icons/tsconfig.svg');
    expect(file('pyproject.toml')).toBe('file-icons/python-misc.svg');
  });

  it('регистр не важен', () => {
    expect(file('README.MD')).toBe('file-icons/readme.svg');
    expect(file('Dockerfile')).toBe('file-icons/docker.svg');
    expect(file('.gitignore')).toBe('file-icons/git.svg');
  });

  it('составное расширение важнее простого', () => {
    expect(file('foo.test.ts')).toBe('file-icons/test-ts.svg');
    expect(file('index.d.ts')).toBe('file-icons/typescript-def.svg');
    expect(file('App.tsx')).toBe('file-icons/react_ts.svg');
  });

  it('берётся последний сегмент пути', () => {
    expect(file('a/b/c.ts')).toBe('file-icons/typescript.svg');
    expect(file('docs/notes/x.md')).toBe('file-icons/markdown.svg');
  });

  it('составной ключ из двух последних сегментов', () => {
    expect(file('a/.devcontainer/devcontainer.json')).toBe('file-icons/container.clone.svg');
    expect(file('devcontainer.json')).toBe('file-icons/json.svg');
  });

  it('неизвестное и вырожденное имя — общий значок (фокус ревью 1)', () => {
    for (const name of ['x.unknownext', 'noext', 'foo.', '...', '', 'a/b/']) {
      expect(file(name), name).toBe('file-icons/file.svg');
    }
  });

  it('светлая тема: вариант _light, где он есть', () => {
    expect(file('config.toml', 'light')).toBe('file-icons/toml_light.svg');
    expect(file('config.toml', 'dark')).toBe('file-icons/toml.svg');
    expect(file('package.json', 'light')).toBe('file-icons/nodejs.svg');
  });

  it('значок-клон: имя файла из iconPath, а не из id', () => {
    expect(file('x.sty')).toBe('file-icons/sty.clone.svg');
  });
});

describe('folderIconUrl', () => {
  it('src закрытая и открытая', () => {
    expect(folder('src', false)).toBe('file-icons/folder-src.svg');
    expect(folder('src', true)).toBe('file-icons/folder-src-open.svg');
  });

  it('по последнему сегменту пути, хвостовой слэш не мешает (фокус ревью 2)', () => {
    expect(folder('packages/app/src/', false)).toBe('file-icons/folder-src.svg');
    expect(folder('a/node_modules', false)).toBe('file-icons/folder-node.svg');
  });

  it('составной ключ: .github/ISSUE_TEMPLATE', () => {
    expect(folder('.github/ISSUE_TEMPLATE', false)).toBe('file-icons/folder-template.svg');
    expect(folder('.github/ISSUE_TEMPLATE', true)).toBe('file-icons/folder-template-open.svg');
  });

  it('светлая тема: .idea — вариант _light', () => {
    expect(folder('.idea', false, 'light')).toBe('file-icons/folder-intellij_light.svg');
    expect(folder('.idea', false, 'dark')).toBe('file-icons/folder-intellij.svg');
  });

  it('неизвестная папка — общий значок', () => {
    expect(folder('zzz-unknown', false)).toBe('file-icons/folder.svg');
    expect(folder('zzz-unknown', true)).toBe('file-icons/folder-open.svg');
    expect(folder('', false)).toBe('file-icons/folder.svg');
  });
});

describe('каждый адрес есть в наборе (спека 7.1)', () => {
  it('все ключи манифеста в обеих темах ведут к существующему SVG', () => {
    type Table = Record<string, string>;
    type Kinds = { fileNames: Table; fileExtensions: Table; folderNames: Table; folderNamesExpanded: Table };
    const m = manifest as unknown as Kinds & { light: Kinds };
    const iconsDir = join(dirname(createRequire(import.meta.url).resolve('material-icon-theme/package.json')), 'icons');
    const icons = new Set(readdirSync(iconsDir));
    const urls = new Set<string>();
    for (const theme of ['dark', 'light'] as const) {
      for (const key of [...Object.keys(m.fileNames), ...Object.keys(m.light.fileNames)]) urls.add(fileIconUrl(key, theme));
      for (const key of [...Object.keys(m.fileExtensions), ...Object.keys(m.light.fileExtensions)]) urls.add(fileIconUrl(`x.${key}`, theme));
      for (const key of [...Object.keys(m.folderNames), ...Object.keys(m.light.folderNames)]) {
        urls.add(folderIconUrl(key, false, theme));
        urls.add(folderIconUrl(key, true, theme));
      }
    }
    const missing = [...urls].filter((url) => !icons.has(url.slice(`${FILE_ICONS_DIR}/`.length)));
    expect(missing).toEqual([]);
    expect(urls.size).toBeGreaterThan(500);
  });
});
```

- [ ] **Шаг 3: Убедиться, что тесты падают.**

Запуск: `pnpm --filter @parley/file-icons test`
Ожидается: FAIL — `Failed to resolve import "./index.js"` или «does not provide an export named 'fileIconUrl'».

- [ ] **Шаг 4: Написать реализацию.**

`packages/file-icons/src/index.ts`:

```ts
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
```

Замечание: имя `'a/b/'` из теста «вырожденное имя» превращается в сегменты `['a', 'b']`. Последний сегмент `b` не находится ни в `fileNames`, ни среди расширений, поэтому получается `file.svg`.

- [ ] **Шаг 5: Убедиться, что тесты проходят, и собрать пакет.**

Запуск: `pnpm --filter @parley/file-icons test`
Ожидается: PASS, 14 тестов.

Запуск: `pnpm --filter @parley/file-icons build && ls packages/file-icons/dist`
Ожидается: `dir.js dir.d.ts index.js index.d.ts` (и `.map`), без ошибок `tsc`.

Запуск: `pnpm lint`
Ожидается: без ошибок.

- [ ] **Шаг 6: Коммит.**

```bash
git add packages/file-icons pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(file-icons): пакет значков файлов и папок на Material Icon Theme — правила выбора как в VS Code

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 2: плагин сборки и подключение к окну

**Файлы:**
- Создать: `packages/file-icons/src/vite.ts`
- Тест: `packages/file-icons/src/vite.test.ts`
- Изменить: `packages/file-icons/package.json` (вход `./vite`, `devDependencies.vite`)
- Изменить: `packages/desktop/package.json` (`devDependencies["@parley/file-icons"]`)
- Изменить: `packages/desktop/electron.vite.config.ts` (импорт и `renderer.plugins`)
- Изменится: `pnpm-lock.yaml`

**Интерфейсы:**
- Получает: `FILE_ICONS_DIR` из `src/dir.ts` (задача 1).
- Отдаёт (`@parley/file-icons/vite`): `fileIcons(): Plugin` (тип `Plugin` из `vite`).

- [ ] **Шаг 1: Добавить вход и зависимость для типов Vite.**

В `packages/file-icons/package.json`:
- в `exports` добавить строку `"./vite": "./dist/vite.js"`;
- добавить `"devDependencies": { "vite": "^5.4.21" }`. Это та же версия, что у окна; нужна только для типов `Plugin`, `Connect`, `ViteDevServer`.

```json
  "exports": {
    ".": "./dist/index.js",
    "./vite": "./dist/vite.js"
  },
```

```json
  "devDependencies": {
    "vite": "^5.4.21"
  }
```

Запуск: `pnpm install`

- [ ] **Шаг 2: Написать падающие тесты.**

`packages/file-icons/src/vite.test.ts`:

```ts
/**
 * Плагин сборки значков (спека значков 4.4 и 7.1): сборка выпускает все SVG набора и LICENSE под
 * `file-icons/`, dev-сервер отдаёт известный файл и пропускает дальше всё прочее, включая `../`.
 */

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Connect, ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { fileIcons } from './vite.js';

const iconsDir = join(dirname(createRequire(import.meta.url).resolve('material-icon-theme/package.json')), 'icons');
const svgs = readdirSync(iconsDir).filter((name) => name.endsWith('.svg'));

interface Emitted {
  fileName: string;
  source: Buffer;
}

function emitted(): Emitted[] {
  const files: Emitted[] = [];
  const hook = fileIcons().generateBundle as unknown as (this: { emitFile(file: Emitted): void }) => void;
  hook.call({ emitFile: (file) => files.push(file) });
  return files;
}

function middleware(): Connect.NextHandleFunction {
  let handler: Connect.NextHandleFunction | undefined;
  const server = {
    middlewares: {
      use: (fn: Connect.NextHandleFunction) => {
        handler = fn;
      },
    },
  } as unknown as ViteDevServer;
  (fileIcons().configureServer as unknown as (server: ViteDevServer) => void)(server);
  if (handler === undefined) throw new Error('обработчик dev-сервера не подключён');
  return handler;
}

const handle = middleware();

function get(url: string): { response: { setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; next: ReturnType<typeof vi.fn> } {
  const response = { setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  handle({ url } as never, response as never, next);
  return { response, next };
}

describe('fileIcons — сборка', () => {
  it('кладёт все SVG набора и LICENSE в file-icons/', () => {
    const files = emitted();
    expect(files.map((file) => file.fileName).sort()).toEqual([...svgs.map((name) => `file-icons/${name}`), 'file-icons/LICENSE'].sort());
    expect(files.find((file) => file.fileName === 'file-icons/LICENSE')?.source.toString()).toContain('Copyright (c) 2025 Material Extensions');
  });
});

describe('fileIcons — dev-сервер', () => {
  it('отдаёт известный SVG с типом image/svg+xml, хвост ?… не мешает', () => {
    const { response, next } = get('/file-icons/nodejs.svg?v=1');
    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/svg+xml');
    expect(String(response.end.mock.calls[0]?.[0])).toMatch(/^<svg/);
  });

  it('каждый файл набора проходит фильтр адреса', () => {
    for (const name of svgs) expect(get(`/file-icons/${name}`).next, name).not.toHaveBeenCalled();
  });

  it('чужие пути пропускает дальше, ничего не отдавая', () => {
    for (const url of ['/file-icons/../package.json', '/file-icons/nope.svg', '/file-icons/LICENSE', '/file-icons/a/b.svg', '/index.html']) {
      const { response, next } = get(url);
      expect(next, url).toHaveBeenCalledOnce();
      expect(response.end, url).not.toHaveBeenCalled();
    }
  });
});
```

- [ ] **Шаг 3: Убедиться, что тесты падают.**

Запуск: `pnpm --filter @parley/file-icons test`
Ожидается: FAIL в `vite.test.ts` — `Failed to resolve import "./vite.js"`. Тесты `index.test.ts` проходят.

- [ ] **Шаг 4: Написать плагин.**

`packages/file-icons/src/vite.ts`:

```ts
/**
 * Плагин сборки значков (спека значков 4.4) — как `pdfjsAssets()` окна: dev-сервер отдаёт
 * `/file-icons/<имя>.svg` из пакета `material-icon-theme`, сборка кладёт весь каталог `icons/` и
 * `LICENSE` набора в `file-icons/` рядом с `index.html`. Отбора нет: какие имена встретятся в
 * проектах, заранее не знать (решение 1 спеки).
 *
 * Конфиг electron-vite оставляет пакеты внешними, поэтому `import.meta.url` здесь — путь этого файла
 * в `packages/file-icons/dist`, и `material-icon-theme` ищется из папки пакета.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { FILE_ICONS_DIR } from './dir.js';

export function fileIcons(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('material-icon-theme/package.json'));
  const iconsDir = join(root, 'icons');
  const names = new Set(readdirSync(iconsDir).filter((name) => name.endsWith('.svg')));
  const url = new RegExp(`^/${FILE_ICONS_DIR}/([\\w.-]+\\.svg)$`);
  return {
    name: 'parley-file-icons',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = url.exec(request.url?.split('?')[0] ?? '')?.[1];
        if (name === undefined || !names.has(name)) {
          next();
          return;
        }
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(readFileSync(join(iconsDir, name)));
      });
    },
    generateBundle() {
      for (const name of names) {
        this.emitFile({ type: 'asset', fileName: `${FILE_ICONS_DIR}/${name}`, source: readFileSync(join(iconsDir, name)) });
      }
      // Текст MIT набора — рядом с его файлами (спека 6).
      this.emitFile({ type: 'asset', fileName: `${FILE_ICONS_DIR}/LICENSE`, source: readFileSync(join(root, 'LICENSE')) });
    },
  };
}
```

- [ ] **Шаг 5: Убедиться, что тесты проходят, и собрать пакет.**

Запуск: `pnpm --filter @parley/file-icons test && pnpm --filter @parley/file-icons build`
Ожидается: PASS (все тесты обоих файлов), в `dist/` появились `vite.js` и `vite.d.ts`.

- [ ] **Шаг 6: Подключить плагин к окну.**

В `packages/desktop/package.json`, в `devDependencies`, по алфавиту — после `"@monaco-editor/react"`, перед `"@playwright/test"`:

```json
    "@parley/file-icons": "workspace:*",
```

В `packages/desktop/electron.vite.config.ts` добавить импорт после `import { defineConfig, externalizeDepsPlugin } from 'electron-vite';`:

```ts
import { fileIcons } from '@parley/file-icons/vite';
```

и плагин в рендерер:

```ts
    plugins: [react(), tailwindcss(), pdfjsAssets(), fileIcons()],
```

Запуск: `pnpm install`

- [ ] **Шаг 7: Проверить сборку окна и стража зависимостей.**

Запуск: `pnpm --filter @parley/desktop build && ls packages/desktop/out/renderer/file-icons | wc -l && ls packages/desktop/out/renderer/file-icons/nodejs.svg packages/desktop/out/renderer/file-icons/LICENSE`
Ожидается: сборка без ошибок, `1252` (1251 SVG и LICENSE), оба файла на месте.

Запуск: `pnpm --filter @parley/desktop exec vitest run src/package-deps.test.ts`
Ожидается: PASS.

- [ ] **Шаг 8: Коммит.**

```bash
git add packages/file-icons packages/desktop/package.json packages/desktop/electron.vite.config.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(file-icons): плагин Vite кладёт набор значков в сборку окна и отдаёт его в dev

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 3: компонент `FileTypeIcon`

**Файлы:**
- Создать: `packages/desktop/src/renderer/components/FileTypeIcon.tsx`
- Тест: `packages/desktop/src/renderer/components/FileTypeIcon.test.tsx`
- Изменить: `packages/desktop/tsconfig.web.json` (ссылка на `../file-icons`)

**Интерфейсы:**
- Получает: `fileIconUrl`, `folderIconUrl` из `@parley/file-icons` (задача 1); `useUiStore` из `packages/desktop/src/renderer/store/ui.ts` (поле `dark: boolean`).
- Отдаёт: `FileTypeIcon(props: FileTypeIconProps): JSX.Element`, где `FileTypeIconProps = { path: string; kind?: 'file' | 'folder'; open?: boolean; size?: number; fileKind?: string }`. Картинка `<img data-file-icon>`; при `fileKind` у неё есть `data-file-kind`.

- [ ] **Шаг 1: Написать падающий тест.**

`packages/desktop/src/renderer/components/FileTypeIcon.test.tsx`:

```tsx
/**
 * Значок файла или папки (спека значков 2026-10-06, раздел 5): адрес — из `@parley/file-icons`, тема —
 * из `useUiStore` и переключается на лету, как у `AgentIcon`; картинка декоративная и не перетаскивается.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useUiStore } from '../store/ui.js';
import { FileTypeIcon } from './FileTypeIcon.js';

beforeEach(() => useUiStore.setState({ dark: true }));
afterEach(cleanup);

const imageOf = (container: HTMLElement): HTMLImageElement | null => container.querySelector('img[data-file-icon]');

describe('FileTypeIcon', () => {
  it('файл — значок по имени, адрес относительный от index.html', () => {
    const { container } = render(<FileTypeIcon path="src/package.json" />);
    expect(imageOf(container)?.getAttribute('src')).toBe('file-icons/nodejs.svg');
  });

  it('папка — закрытая и открытая', () => {
    const closed = render(<FileTypeIcon path="src" kind="folder" />);
    expect(imageOf(closed.container)?.getAttribute('src')).toBe('file-icons/folder-src.svg');
    closed.unmount();
    const open = render(<FileTypeIcon path="src" kind="folder" open />);
    expect(imageOf(open.container)?.getAttribute('src')).toBe('file-icons/folder-src-open.svg');
  });

  it('тема переключается на лету: в светлой — вариант _light', () => {
    const { container } = render(<FileTypeIcon path="config.toml" />);
    expect(imageOf(container)?.getAttribute('src')).toBe('file-icons/toml.svg');
    act(() => useUiStore.setState({ dark: false }));
    expect(imageOf(container)?.getAttribute('src')).toBe('file-icons/toml_light.svg');
  });

  it('декоративный квадрат: alt пустой, не перетаскивается, 16 по умолчанию, size меняет сторону', () => {
    const small = render(<FileTypeIcon path="a.ts" />);
    const image = imageOf(small.container);
    expect(image?.getAttribute('alt')).toBe('');
    expect(image?.getAttribute('draggable')).toBe('false');
    expect(image?.getAttribute('width')).toBe('16');
    expect(image?.getAttribute('height')).toBe('16');
    small.unmount();
    const tab = render(<FileTypeIcon path="a.ts" size={14} />);
    expect(imageOf(tab.container)?.getAttribute('width')).toBe('14');
  });

  it('fileKind — метка data-file-kind; без него метки нет', () => {
    const marked = render(<FileTypeIcon path="x.md" fileKind="markdown" />);
    expect(imageOf(marked.container)?.getAttribute('data-file-kind')).toBe('markdown');
    marked.unmount();
    const plain = render(<FileTypeIcon path="x.md" />);
    expect(imageOf(plain.container)?.hasAttribute('data-file-kind')).toBe(false);
  });
});
```

- [ ] **Шаг 2: Убедиться, что тест падает.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/FileTypeIcon.test.tsx`
Ожидается: FAIL — `Failed to resolve import "./FileTypeIcon.js"`.

- [ ] **Шаг 3: Написать компонент.**

`packages/desktop/src/renderer/components/FileTypeIcon.tsx`:

```tsx
/**
 * Значок файла или папки (спека значков 2026-10-06, раздел 5): адрес SVG даёт пакет `@parley/file-icons`,
 * окно о наборе ничего не знает. Тема — из `useUiStore`, как у значка провайдера (`AgentIcon`), и
 * переключается на лету.
 *
 * Картинка `<img>`, а не встроенный `<svg>`: внутри файлов набора повторяются `id`, встроенные они бы
 * столкнулись. Значок декоративный — имя стоит рядом, поэтому `alt` пустой. Перетаскивать его нельзя:
 * строки дерева перетаскиваются целиком.
 */

import { fileIconUrl, folderIconUrl } from '@parley/file-icons';
import { useUiStore } from '../store/ui.js';

export interface FileTypeIconProps {
  /** Имя или путь от корня: значок ищется по имени и по двум последним сегментам пути. */
  path: string;
  kind?: 'file' | 'folder';
  /** У папки: раскрыта ли — у раскрытой свой значок. */
  open?: boolean;
  /** Сторона квадрата, px: 16 в списках, 14 во вкладках (спека 3). */
  size?: number;
  /** Вид файла вкладки (`files/file-kind.ts`) — метка `data-file-kind`, за неё держатся тесты вкладок. */
  fileKind?: string;
}

export function FileTypeIcon({ path, kind = 'file', open = false, size = 16, fileKind }: FileTypeIconProps): JSX.Element {
  const theme = useUiStore((state) => (state.dark ? 'dark' : 'light'));
  const src = kind === 'folder' ? folderIconUrl(path, open, theme) : fileIconUrl(path, theme);
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      data-file-icon=""
      data-file-kind={fileKind}
      className="block shrink-0"
      style={{ width: size, height: size }}
    />
  );
}
```

В `packages/desktop/tsconfig.web.json` добавить ссылку на проект пакета:

```json
  "references": [{ "path": "../protocol" }, { "path": "../core" }, { "path": "../file-icons" }]
```

- [ ] **Шаг 4: Убедиться, что тест проходит и типы сходятся.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/components/FileTypeIcon.test.tsx`
Ожидается: PASS, 5 тестов.

Запуск: `pnpm typecheck`
Ожидается: без ошибок.

- [ ] **Шаг 5: Коммит.**

```bash
git add packages/desktop/src/renderer/components/FileTypeIcon.tsx packages/desktop/src/renderer/components/FileTypeIcon.test.tsx packages/desktop/tsconfig.web.json
git commit -m "$(cat <<'EOF'
feat(desktop): компонент FileTypeIcon — значок файла или папки из @parley/file-icons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 4: дерево файлов

**Файлы:**
- Изменить: `packages/desktop/src/renderer/files/Tree.tsx` (импорт lucide в строке 18, разметка значка в строках 174–181)
- Тест: `packages/desktop/src/renderer/files/Tree.test.tsx`

**Интерфейсы:**
- Получает: `FileTypeIcon` из `../components/FileTypeIcon.js` (задача 3).
- Отдаёт: строка дерева `[data-tree-path]` по порядку детей:
  1. место под шеврон: у папки шеврон, у файла пусто;
  2. значок: `img[data-file-icon]`, у симлинка на файл — `span` с `Link2`;
  3. имя;
  4. буква git, если она есть.

- [ ] **Шаг 1: Написать падающие тесты.**

В `packages/desktop/src/renderer/files/Tree.test.tsx` добавить импорт рядом с другими импортами стора:

```tsx
import { useUiStore } from '../store/ui.js';
```

и в конец файла:

```tsx
describe('Tree — значки (спека значков 3.1)', () => {
  const rowOf = (name: string): Element | null | undefined => screen.getByText(name).closest('[data-tree-path]');
  const iconOf = (name: string): string | null | undefined => rowOf(name)?.querySelector('img[data-file-icon]')?.getAttribute('src');

  beforeEach(() => useUiStore.setState({ dark: true }));

  it('папка: шеврон и значок папки, у раскрытой — свой; файл: значок по имени', async () => {
    bridge.setDir(ROOT, '', [entry('src', { kind: 'dir' }), entry('package.json')]);
    bridge.setDir(ROOT, 'src', [entry('main.ts')]);
    renderTree();
    await screen.findByText('package.json');
    expect(iconOf('src')).toBe('file-icons/folder-src.svg');
    expect(iconOf('package.json')).toBe('file-icons/nodejs.svg');

    fireEvent.click(screen.getByText('src'));
    await screen.findByText('main.ts');
    expect(iconOf('src')).toBe('file-icons/folder-src-open.svg');
    expect(iconOf('main.ts')).toBe('file-icons/typescript.svg');
  });

  it('значки в одном столбике: у файла пустое место под шеврон, затем значок', async () => {
    bridge.setDir(ROOT, '', [entry('src', { kind: 'dir' }), entry('a.ts')]);
    renderTree();
    await screen.findByText('a.ts');
    const file = rowOf('a.ts');
    expect(file?.children[0]?.childElementCount).toBe(0);
    expect(file?.children[1]?.tagName).toBe('IMG');
    const folder = rowOf('src');
    expect(folder?.children[0]?.querySelector('svg')).not.toBeNull();
    expect(folder?.children[1]?.tagName).toBe('IMG');
  });

  it('симлинк на файл — Link2 вместо значка; симлинк на папку — значок папки по имени (фокус ревью 3)', async () => {
    bridge.setDir(ROOT, '', [entry('docs', { kind: 'symlink', target: 'dir' }), entry('readme', { kind: 'symlink', target: 'file' })]);
    renderTree();
    await screen.findByText('readme');
    const link = rowOf('readme');
    expect(link?.querySelector('img[data-file-icon]')).toBeNull();
    expect(link?.children[1]?.querySelector('svg')).not.toBeNull();
    expect(iconOf('docs')).toBe('file-icons/folder-docs.svg');
  });
});
```

- [ ] **Шаг 2: Убедиться, что тесты падают.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/files/Tree.test.tsx`
Ожидается: FAIL трёх новых тестов (картинок `img[data-file-icon]` в дереве ещё нет). Старые тесты проходят.

- [ ] **Шаг 3: Поменять разметку строки.**

В `Tree.tsx` строку 18:

```tsx
import { ChevronDown, ChevronRight, File as FileIcon, Link2 } from 'lucide-react';
```

заменить на:

```tsx
import { ChevronDown, ChevronRight, Link2 } from 'lucide-react';
```

и добавить импорт рядом с `import { cn } from '../lib/cn.js';`:

```tsx
import { FileTypeIcon } from '../components/FileTypeIcon.js';
```

Блок значка в `Row` (строки 174–181):

```tsx
          <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
            {row.dir ? (
              expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />
            ) : row.entry.kind === 'symlink' ? (
              <Link2 className="size-3" />
            ) : (
              <FileIcon className="size-3" />
            )}
          </span>
```

заменить на:

```tsx
          {/* Место под шеврон есть и у файла — значки стоят ровным столбиком (спека значков 3.1). */}
          <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
            {row.dir ? expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : null}
          </span>
          {row.dir ? (
            <FileTypeIcon path={row.path} kind="folder" open={expanded} />
          ) : row.entry.kind === 'symlink' ? (
            // Симлинк на файл — `Link2`: значок по имени скрыл бы, что это ссылка.
            <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
              <Link2 className="size-3" />
            </span>
          ) : (
            <FileTypeIcon path={row.path} />
          )}
```

- [ ] **Шаг 4: Убедиться, что тесты дерева проходят.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/files/Tree.test.tsx src/renderer/files/FilesPanel.test.tsx`
Ожидается: PASS, все тесты, включая три новых.

- [ ] **Шаг 5: Коммит.**

```bash
git add packages/desktop/src/renderer/files/Tree.tsx packages/desktop/src/renderer/files/Tree.test.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): значки Material в дереве файлов — у папки шеврон и значок, у файла значок по имени

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 5: вкладки файлов и палитра ⌘P

**Файлы:**
- Изменить: `packages/desktop/src/renderer/layout/Tab.tsx` (импорт lucide в строке 28; `fileKind` в строке 36; таблица `FILE_ICONS` в строках 59–67; `case 'file'` в `TabIcon`, строки 90–94)
- Изменить: `packages/desktop/src/renderer/palette/documents.ts` (поле `filePath` в `PaletteDoc`; документы вкладок, около строки 153)
- Изменить: `packages/desktop/src/renderer/files/quick-open.ts` (документ файла, строка 23)
- Изменить: `packages/desktop/src/renderer/palette/Palette.tsx` (`RowIcon`, строки 71–75)
- Тест: `packages/desktop/src/renderer/layout/Tab.test.tsx`, `packages/desktop/src/renderer/palette/documents.test.ts`, `packages/desktop/src/renderer/files/quick-open.test.ts`, `packages/desktop/src/renderer/palette/Palette.test.tsx`

**Интерфейсы:**
- Получает: `FileTypeIcon` (задача 3).
- Отдаёт: `PaletteDoc.filePath?: string`. Он есть у документов файлов: и у вкладки файла, и у пункта ⌘P. У прочих документов его нет.

- [ ] **Шаг 1: Написать падающие тесты.**

В `Tab.test.tsx`, в тест `'точка «не сохранён» по meta.dirty; значок по виду файла; полный путь — в title'`, после строки с `data-file-kind` добавить:

```tsx
    // Спека значков 3.2: значок Material по имени файла, 14 px.
    expect(el.querySelector('img[data-file-icon]')?.getAttribute('src')).toBe('file-icons/markdown.svg');
    expect(el.querySelector('img[data-file-icon]')?.getAttribute('width')).toBe('14');
```

В `quick-open.test.ts`, внутри `describe('fileDocuments (тест 1)', …)`:

```ts
  it('документ несёт путь для значка (спека значков 3.3)', () => {
    const [doc] = fileDocuments(ROOT, ['src/deep/package.json'], () => {});
    expect(doc?.filePath).toBe('src/deep/package.json');
  });
```

В `documents.test.ts`, в конец файла:

```ts
describe('вкладка файла — путь для значка (спека значков 3.3)', () => {
  it('filePath — полный путь вкладки, даже когда название обрезано; у прочих документов его нет (фокус ревью 5)', () => {
    const w = makeWork('w-01', { projectPath: '/tmp/a', title: 'Файлы', sessions: [makeSession('s-01', 'main')] });
    const path = `src/${'very-long-file-name-'.repeat(12)}index.json`;
    const fileTab = { kind: 'file' as const, id: tabId.file({ kind: 'project' }, path), root: { kind: 'project' as const }, path };
    const docs = build({ works: [w], layouts: { [keyOf(w)]: openTab(layoutWith('s-01'), fileTab) } });
    const doc = docs.find((candidate) => candidate.id === `tab:${keyOf(w)}\n${fileTab.id}`);
    expect(doc?.icon).toBe('file');
    expect(doc?.title).not.toBe(path.slice(path.lastIndexOf('/') + 1));
    expect(doc?.filePath).toBe(path);
    expect(docs.filter((candidate) => candidate.icon !== 'file').every((candidate) => candidate.filePath === undefined)).toBe(true);
  });
});
```

Строка `expect(doc?.title).not.toBe(…)` подтверждает, что название вкладки обрезано (`truncateTitle` в `layout/tab-meta.ts`). Если она падает, имя в тесте недостаточно длинное: удлинить `repeat`, пока название не начнёт обрезаться.

В `Palette.test.tsx`, внутри `describe('Palette — файлы: ⌘P и префикс / (тест 5 куска 7.4)', …)`:

```tsx
  it('строка файла — значок по имени файла (спека значков 3.3)', async () => {
    setup([w]);
    bridge.setLsFiles(root, { paths: ['src/package.json'], truncated: false });
    act(() => usePaletteStore.getState().openWith('default'));
    renderPalette();
    await type('/package');
    await waitFor(() => expect(headings()).toEqual(['Files']));
    expect(screen.getAllByRole('option')[0]?.querySelector('img[data-file-icon]')?.getAttribute('src')).toMatch(/nodejs\.svg$/);
  });
```

- [ ] **Шаг 2: Убедиться, что тесты падают.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/layout/Tab.test.tsx src/renderer/palette/documents.test.ts src/renderer/files/quick-open.test.ts src/renderer/palette/Palette.test.tsx`
Ожидается: FAIL четырёх новых проверок (нет `img[data-file-icon]`, `filePath` равен `undefined`).

- [ ] **Шаг 3: Вкладки.**

В `Tab.tsx`:

1. Строка 28. Убрать lucide-значки файлов:

```tsx
import { GitCompare, Globe, Hash, Mail as MailIcon, X } from 'lucide-react';
```

2. Строка 36. Тип `FileKind` больше не нужен:

```tsx
import { fileKind } from '../files/file-kind.js';
```

3. Добавить импорт рядом с `import { AgentStateDot } from '../components/AgentStateDot.js';`:

```tsx
import { FileTypeIcon } from '../components/FileTypeIcon.js';
```

4. Удалить блок целиком:

```tsx
/** Значок вкладки файла по виду (спека 5.3): вид — по расширению, `files/file-kind.ts`. */
const FILE_ICONS: Record<FileKind, typeof FileCode> = {
  text: FileCode,
  markdown: FileText,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  image: FileImage,
  pdf: FileType,
};

```

5. В `TabIcon` заменить ветку `case 'file'`:

```tsx
    case 'file': {
      const kind = tab.kind === 'file' ? fileKind(tab.path) : 'text';
      const Icon = FILE_ICONS[kind];
      return <Icon data-file-kind={kind} className={ICON} aria-hidden="true" />;
    }
```

на:

```tsx
    case 'file': {
      // Значок Material по имени файла (спека значков 3.2); вид файла остаётся меткой — по нему выбирается тело вкладки.
      const path = tab.kind === 'file' ? tab.path : '';
      return <FileTypeIcon path={path} size={14} fileKind={fileKind(path)} />;
    }
```

`fileKind('')` возвращает `'text'`, как прежняя ветка для вкладки без пути.

- [ ] **Шаг 4: Палитра.**

В `documents.ts`, в `interface PaletteDoc`, после поля `icon: PaletteIcon;`:

```ts
  /** Файл (вкладка файла, ⌘P): путь для значка по имени (спека значков 3.3) — название вкладки бывает обрезано. */
  filePath?: string;
```

В документах вкладок, сразу после строки `icon: meta.icon,`:

```ts
            ...(tab.kind === 'file' ? { filePath: tab.path } : {}),
```

В `quick-open.ts`, после `icon: 'file',`:

```ts
    filePath: path,
```

В `Palette.tsx` добавить импорт рядом с другими импортами `../components/…`:

```tsx
import { FileTypeIcon } from '../components/FileTypeIcon.js';
```

и в `RowIcon`, после строки с `AgentStateDot`:

```tsx
  if (doc.filePath !== undefined) return <FileTypeIcon path={doc.filePath} />;
```

Ключ `file` в таблице `ICONS` остаётся: его требует тип `Record<Exclude<PaletteIcon, 'terminal'>, …>`.

- [ ] **Шаг 5: Убедиться, что тесты проходят.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/layout src/renderer/palette src/renderer/files/quick-open.test.ts`
Ожидается: PASS, все тесты.

Запуск: `pnpm typecheck`
Ожидается: без ошибок; неиспользованных импортов lucide нет.

- [ ] **Шаг 6: Коммит.**

```bash
git add packages/desktop/src/renderer/layout/Tab.tsx packages/desktop/src/renderer/layout/Tab.test.tsx packages/desktop/src/renderer/palette packages/desktop/src/renderer/files/quick-open.ts packages/desktop/src/renderer/files/quick-open.test.ts
git commit -m "$(cat <<'EOF'
feat(desktop): значки Material во вкладках файлов и в палитре ⌘P

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 6: «Изменения» и поиск по файлам

**Файлы:**
- Изменить: `packages/desktop/src/renderer/review/ChangesPanel.tsx` (`FileRow`, строки 87–90)
- Изменить: `packages/desktop/src/renderer/review/FileDiffSection.tsx` (заголовок, строки 380–383)
- Изменить: `packages/desktop/src/renderer/files/SearchPanel.tsx` (заголовок группы, строки 244–245)
- Тест: `packages/desktop/src/renderer/review/ChangesPanel.test.tsx`, `packages/desktop/src/renderer/review/FileDiffSection.test.tsx`, `packages/desktop/src/renderer/files/SearchPanel.test.tsx`

**Интерфейсы:**
- Получает: `FileTypeIcon` (задача 3).
- Отдаёт: ничего нового — в строках появляется `img[data-file-icon]`.

- [ ] **Шаг 1: Написать падающие тесты.**

`ChangesPanel.test.tsx`, в конец файла:

```tsx
describe('Значки файлов (спека значков 3.4)', () => {
  it('строка — значок по пути; у переименованного — по новому имени (фокус ревью 4)', async () => {
    bridge.setHandler('worktrees.diff', () =>
      diff({ files: [file('package.json'), { path: 'src/b.ts', status: 'R', oldPath: 'src/b.js', additions: 1, deletions: 0 }] }),
    );
    renderPanel();
    await screen.findByText('package.json');
    const iconOf = (text: string): string | null | undefined =>
      screen.getByText(text).closest('button')?.querySelector('img[data-file-icon]')?.getAttribute('src');
    expect(iconOf('package.json')).toMatch(/nodejs\.svg$/);
    expect(iconOf('src/b.ts')).toMatch(/typescript\.svg$/);
  });
});
```

`FileDiffSection.test.tsx`, внутри `describe('FileDiffSection', …)`:

```tsx
  it('заголовок — значок файла по пути (спека значков 3.4)', () => {
    render(<FileDiffSection {...props(M('src/package.json'), { live: false })} />);
    expect(document.querySelector('img[data-file-icon]')?.getAttribute('src')).toMatch(/nodejs\.svg$/);
  });
```

`SearchPanel.test.tsx`, внутри `describe('SearchPanel (тест 2)', …)`:

```tsx
  it('заголовок группы — значок файла по пути (спека значков 3.5)', async () => {
    bridge.setGrepResult(result([{ path: 'src/package.json', hits: [{ line: 1, column: 1, text: 'foo', ranges: [[0, 3]] }] }]));
    render(<SearchPanel bridge={bridge} root={ROOT} />);
    await type('foo');
    await wait(250);
    expect(screen.getByTitle('src/package.json').querySelector('img[data-file-icon]')?.getAttribute('src')).toMatch(/nodejs\.svg$/);
  });
```

- [ ] **Шаг 2: Убедиться, что тесты падают.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/review/ChangesPanel.test.tsx src/renderer/review/FileDiffSection.test.tsx src/renderer/files/SearchPanel.test.tsx`
Ожидается: FAIL трёх новых тестов (картинки нет).

- [ ] **Шаг 3: Добавить значок в три строки.**

В каждый из трёх файлов — импорт:

```tsx
import { FileTypeIcon } from '../components/FileTypeIcon.js';
```

`ChangesPanel.tsx`, `FileRow` — между буквой статуса и путём:

```tsx
        <span className="w-3 shrink-0 font-mono text-[11px] font-bold text-muted-foreground" title={FILE_STATUS[file.status] ?? file.status}>
          {file.status}
        </span>
        <FileTypeIcon path={file.path} />
        <span className="min-w-0 flex-1 truncate">{file.path}</span>
```

`FileDiffSection.tsx`, заголовок — между буквой статуса и путём:

```tsx
        <span className="w-3 shrink-0 font-mono text-muted-foreground" title={FILE_STATUS[file.status] ?? file.status}>
          {file.status}
        </span>
        <FileTypeIcon path={file.path} />
        <span className="min-w-0 flex-1 truncate font-mono" title={title}>
```

`SearchPanel.tsx`, заголовок группы — после шеврона:

```tsx
                {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                <FileTypeIcon path={file.path} />
                <span className="min-w-0 flex-1 truncate">{file.path}</span>
```

У переименованного файла `file.path` — новый путь, у удалённого — тот путь, что показан в строке (спека 3.4). Отдельной ветки для них не нужно.

- [ ] **Шаг 4: Убедиться, что тесты проходят.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/renderer/review src/renderer/files`
Ожидается: PASS, все тесты.

- [ ] **Шаг 5: Коммит.**

```bash
git add packages/desktop/src/renderer/review/ChangesPanel.tsx packages/desktop/src/renderer/review/ChangesPanel.test.tsx packages/desktop/src/renderer/review/FileDiffSection.tsx packages/desktop/src/renderer/review/FileDiffSection.test.tsx packages/desktop/src/renderer/files/SearchPanel.tsx packages/desktop/src/renderer/files/SearchPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(desktop): значки Material в «Изменениях», в заголовке диффа и в поиске по файлам

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 7: NOTICE и TODOS

**Файлы:**
- Изменить: `NOTICE` (новый раздел после раздела «Значки провайдеров»)
- Изменить: `TODOS.md` (раздел 5)
- Тест: `packages/desktop/src/notice.test.ts`

**Интерфейсы:**
- Получает: версию `material-icon-theme` из `packages/file-icons/package.json` (задача 1).
- Отдаёт: ничего.

- [ ] **Шаг 1: Написать падающий тест.**

В `packages/desktop/src/notice.test.ts`, внутри `describe('NOTICE и лицензии в сборке (ревью M7)', …)`, последним тестом:

```ts
  // Спека значков 2026-10-06, раздел 6: набор едет в сборку целиком, его MIT требует уведомления. Версия в
  // NOTICE сверяется с зависимостью пакета: подняли версию набора — правится и NOTICE (спека 4.5).
  it('NOTICE: Material Icon Theme — пакет и версия, куда копируется, правообладатель и текст MIT', () => {
    const iconsPkg = JSON.parse(readFileSync(path.join(repoRoot, 'packages', 'file-icons', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const version = iconsPkg.dependencies['material-icon-theme'];
    const start = notice.indexOf('\nMaterial Icon Theme\n');
    expect(start, 'раздел «Material Icon Theme»').toBeGreaterThan(-1);
    const section = notice.slice(start);
    expect(section).toContain(`\`material-icon-theme\` ${version}`);
    expect(section).toContain('packages/desktop/out/renderer/file-icons/');
    expect(section).toContain('Copyright (c) 2025 Material Extensions');
    expect(section).toContain('Permission is hereby granted, free of charge');
  });
```

- [ ] **Шаг 2: Убедиться, что тест падает.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/notice.test.ts`
Ожидается: FAIL — «раздел «Material Icon Theme»: expected -1 to be greater than -1».

- [ ] **Шаг 3: Добавить раздел в NOTICE.**

В `NOTICE` сразу после раздела «Значки провайдеров» вставить блок. Он заканчивается строкой «не изменял и не выдаёт за свои.» и пустой строкой, перед линией раздела «Monaco Editor». Ширина строк до 80 символов, как в остальных разделах. Фраза `` `material-icon-theme` 5.39.0 `` стоит в одной строке, без переноса: на неё смотрит тест.

```
------------------------------------------------------------------------------
Material Icon Theme
------------------------------------------------------------------------------

Значки файлов и папок окна — набор Material Icon Theme из пакета npm
`material-icon-theme` 5.39.0
(https://github.com/material-extensions/vscode-material-icon-theme). Пакет
packages/file-icons берёт из него таблицу соответствий dist/material-icons.json
и все файлы icons/*.svg, а сборка рендерера кладёт их без правок в
packages/desktop/out/renderer/file-icons/ вместе с файлом LICENSE набора.

Значки технологий и продуктов в наборе — знаки их владельцев. Проект их не
изменял и не выдаёт за свои.

<полный текст файла packages/file-icons/node_modules/material-icon-theme/LICENSE>

```

Вместо последней строки в угловых скобках вставить текст файла `LICENSE` дословно (`cat packages/file-icons/node_modules/material-icon-theme/LICENSE`). Он начинается строками `The MIT License (MIT)` и `Copyright (c) 2025 Material Extensions`.

- [ ] **Шаг 4: Убрать выполненный пункт из TODOS.md.**

В `TODOS.md`:
- удалить пункт целиком — от строки `- **Значки Material для файлов и папок** (просьба пользователя 2026-09-28).` до строки `(\`img-src 'self' data: blob:\`) локальные SVG уже пускает.` включительно;
- заголовок раздела `## 5. Облик: контраст и значки файлов` заменить на `## 5. Облик: контраст`: оставшиеся пункты раздела — о контрасте.

- [ ] **Шаг 5: Убедиться, что тест проходит.**

Запуск: `pnpm --filter @parley/desktop exec vitest run src/notice.test.ts`
Ожидается: PASS, все тесты файла.

- [ ] **Шаг 6: Коммит.**

```bash
git add NOTICE TODOS.md packages/desktop/src/notice.test.ts
git commit -m "$(cat <<'EOF'
docs(notice): Material Icon Theme — источник, версия и MIT; пункт TODO о значках файлов выполнен

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Задача 8: E2E, полный прогон и живая проверка

**Файлы:**
- Изменить: `packages/desktop/e2e/files-sidebar.spec.ts` (тест «длинные имена обрезаны…», около строк 99–106)

**Интерфейсы:**
- Получает: всё из задач 1–7.
- Отдаёт: ничего.

- [ ] **Шаг 1: Добавить в E2E проверку, что картинки реально загрузились.**

В тесте `'длинные имена обрезаны, ничего не вылезает; клик открывает текст файла; ⌘L прячет сайдбар'`, после строки `await expect(sidebar.locator(\`[data-tree-path="${LONG_DIR}"]\`)).toBeVisible();`:

```ts
      // Спека значков 7.3: значки грузятся из сборки — плагин, относительный путь и CSP вместе.
      const loaded = (img: HTMLImageElement): boolean => img.complete && img.naturalWidth > 0;
      const srcIcon = sidebar.locator('[data-tree-path="src"] img[data-file-icon]');
      await expect(srcIcon).toHaveAttribute('src', /folder-src\.svg$/);
      await expect.poll(() => srcIcon.evaluate(loaded)).toBe(true);
```

и после строки `await sidebar.getByText('app.ts', { exact: true }).click();`:

```ts
      const appIcon = sidebar.locator('[data-tree-path="src/app.ts"] img[data-file-icon]');
      await expect(appIcon).toHaveAttribute('src', /typescript\.svg$/);
      await expect.poll(() => appIcon.evaluate(loaded)).toBe(true);
      await expect(sidebar.locator('[data-tree-path="src"] img[data-file-icon]')).toHaveAttribute('src', /folder-src-open\.svg$/);
      const tabIcon = window.getByRole('tab', { name: /app\.ts/ }).locator('img[data-file-icon]');
      await expect.poll(() => tabIcon.evaluate(loaded)).toBe(true);
```

Уже существующие в тесте проверки `overflowOf(window)` теперь проходят и со значками. Это и есть проверка «длинные имена при 800×500»: тест идёт по размерам окна из массива в начале файла.

- [ ] **Шаг 2: Собрать и прогнать E2E.**

Запуск: `pnpm build && pnpm --filter @parley/desktop exec playwright test e2e/files-sidebar.spec.ts`
Ожидается: PASS для всех размеров окна.

Если тест красный не по значкам, прогнать тот же spec на `master` (worktree `.claude/worktrees/e2e-bisect` стоит на cec7dcb) и сравнить. В памяти проекта записаны 2 красных E2E при 800×500 на master. Чужие падения не чинить, а записать в отчёт задачи.

- [ ] **Шаг 3: Полный прогон.**

Запуск: `pnpm test`, `pnpm typecheck`, `pnpm lint`
Ожидается: зелёные.

Запуск: `grep -rln "material-icon-theme" packages --include='*.ts' --include='*.tsx' --include='package.json' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=out | grep -v '^packages/file-icons/'`
Ожидается: пусто — набор упоминается только внутри пакета (приёмка 5 спеки).

Тесты из раздела 6 TODOS.md (`fs.watch`, дебаунс) под нагрузкой бывают нестабильны. Упавший тест перезапустить поодиночке и сравнить с прогоном на `master`, прежде чем считать падение своим.

- [ ] **Шаг 4: Проверить, что набор попал в собранное приложение.**

Запуск: `pnpm --filter @parley/desktop dist --dir`, затем

```bash
npx --yes @electron/asar list packages/desktop/dist/mac-arm64/Parley.app/Contents/Resources/app.asar | grep -c '^/out/renderer/file-icons/'
```

Ожидается: `1252`.

Собранное приложение локально не запускаем: на этой машине его запуск вызывает запросы доступа macOS (TCC). Загрузку значков в упакованном виде подтверждает E2E шага 2: и он, и `.app` грузят `out/renderer/index.html` через `loadFile`, то есть с теми же относительными путями и той же CSP.

- [ ] **Шаг 5: Живая проверка (делает ведущий сессии, не исполнитель).**

Dev-окно (`pnpm dev:desktop` из корня worktree). Проект с длинным путём, длинными именами файлов и папок, с `package.json`, `tsconfig.json`, `src/`, `.github/ISSUE_TEMPLATE`, `config.toml`. Окно 800×500 и шире, обе темы. Проверить по пунктам приёмки спеки (раздел 9):

1. Дерево:
   - столбик значков ровный;
   - у `src/` открытой и закрытой разные значки;
   - длинное имя обрезается «…», значок на месте;
   - игнорируемые строки приглушены вместе со значком.
2. Вкладки: значок 14 px рядом с названием; у несохранённого файла точка не налезает на значок.
3. ⌘P и `/запрос`: значки у файлов, у работ и вкладок терминала — прежние значки.
4. «Изменения»: значок между буквой статуса и путём, `+N −N` не выталкиваются.
5. Поиск по файлам: значок после шеврона, счётчик совпадений на месте.
6. Переключение темы: `config.toml` меняет значок без перезагрузки.

Размеры значков (16/14) при необходимости поправить по результату. Правку закоммитить отдельно: `fix(desktop): размер значков файлов по живой проверке`.

- [ ] **Шаг 6: Коммит E2E.**

```bash
git add packages/desktop/e2e/files-sidebar.spec.ts
git commit -m "$(cat <<'EOF'
test(e2e): значки файлов в дереве и во вкладке реально загружаются из сборки

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
