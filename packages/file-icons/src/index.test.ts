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
