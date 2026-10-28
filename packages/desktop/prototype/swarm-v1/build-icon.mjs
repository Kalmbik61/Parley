#!/usr/bin/env node
/**
 * Пересборка живой иконки роя в `index.html` (спека роя v1, 7.5).
 *
 *   pnpm install                                   # один раз: нужен esbuild, он приходит вместе с vite
 *   node packages/desktop/prototype/swarm-v1/build-icon.mjs
 *
 * Собирает `swarm-icon.entry.ts` (настоящие `island/swarm/engine.ts` и `spec.ts`, без React) в один IIFE и кладёт его
 * в `index.html` между метками `swarm-icon:begin` / `swarm-icon:end`, чтобы прототип остался самодостаточным файлом.
 * Движок поменялся — запустите скрипт снова. Метки уже в `index.html`; на странице скрипт зовёт `SwarmIcons.sync()`.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..', '..');
// esbuild — зависимость vite окна; своей записи в package.json у него нет.
const esbuild = createRequire(createRequire(join(desktop, 'package.json')).resolve('vite'))('esbuild');

const built = await esbuild.build({
  entryPoints: [join(here, 'swarm-icon.entry.ts')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  write: false,
});
const code = built.outputFiles[0].text.trim().replace(/<\/script/gi, '<\\/script');

const file = join(here, 'index.html');
const html = readFileSync(file, 'utf8');
const begin = '<!-- swarm-icon:begin -->';
const end = '<!-- swarm-icon:end -->';
const from = html.indexOf(begin);
const to = html.indexOf(end);
if (from === -1 || to === -1 || to < from) throw new Error(`index.html: нет меток ${begin} … ${end}`);
writeFileSync(file, `${html.slice(0, from + begin.length)}\n<script>${code}</script>\n${html.slice(to)}`);
console.log(`swarm-icon: ${(code.length / 1024).toFixed(1)} KiB → index.html`);
