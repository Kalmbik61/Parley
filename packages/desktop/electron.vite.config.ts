import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname as dirOf, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileIcons } from '@parley/file-icons/vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

const dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Данные pdf.js для превью PDF (кусок 7.5, спека 10.6): `cmaps/` (CJK) и `standard_fonts/` из
 * `pdfjs-dist` — в сборку рендерера под `pdfjs/`, рядом с `index.html`. Без них CJK и стандартные
 * шрифты рисуются неверно, а CDN окно не использует. В `pnpm dev:desktop` те же файлы отдаёт
 * dev-сервер по тем же адресам.
 *
 * Шрифты Liberation (`LiberationSans-*`, GPLv2 с исключением для шрифтов) не копируются (fix-7.5):
 * GPL в `.app` не берём, а pdf.js в окне их и не просит — с `useSystemFonts` Helvetica без
 * встраивания он рисует системным шрифтом. Шрифты Foxit (BSD-3) нужны для Symbol и ZapfDingbats.
 */
function pdfjsAssets(): Plugin {
  const root = dirOf(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const dirs = ['cmaps', 'standard_fonts'];
  const shipped = (dir: string): string[] =>
    readdirSync(join(root, dir)).filter((name) => !/^(LiberationSans-|LICENSE_LIBERATION$)/.test(name));
  return {
    name: 'parley-pdfjs-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/pdfjs\/(cmaps|standard_fonts)\/([\w.-]+)$/.exec(request.url?.split('?')[0] ?? '');
        const dir = match?.[1];
        const name = match?.[2];
        if (dir === undefined || name === undefined || !shipped(dir).includes(name)) {
          next();
          return;
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        response.end(readFileSync(join(root, dir, name)));
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        // Вместе с LICENSE* каталога: текст лицензии лежит рядом со своими файлами (NOTICE).
        for (const name of shipped(dir)) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
        }
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Прелоад в песочнице (`sandbox: true`, см. security.ts) Electron
      // грузит не через обычный модульный загрузчик — `import` там не
      // работает, даже когда package.json пакета говорит "type": "module".
      // Форсируем CommonJS независимо от типа пакета.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), tailwindcss(), pdfjsAssets(), fileIcons()],
    build: {
      rollupOptions: {
        input: resolve(dirname, 'src/renderer/index.html'),
      },
    },
  },
});
