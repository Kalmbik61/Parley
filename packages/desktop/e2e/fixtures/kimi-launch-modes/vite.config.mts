import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: '../../../out/kimi-launch-modes-fixture', emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 5417, strictPort: true },
});
