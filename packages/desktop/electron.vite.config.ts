import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const dirname = fileURLToPath(new URL('.', import.meta.url));

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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve(dirname, 'src/renderer/index.html'),
      },
    },
  },
});
