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
