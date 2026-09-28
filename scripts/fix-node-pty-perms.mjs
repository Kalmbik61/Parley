#!/usr/bin/env node
// node-pty кладёт в prebuilds вспомогательный бинарь spawn-helper, но pnpm распаковывает
// его без бита исполнения. Без +x любой spawn падает с невнятным «posix_spawnp failed».
// Чиним после установки; на Windows helper не нужен.
//
// Аргументы — каталоги пакетов вне дерева установки: тогда чинится node-pty, который видят они, а не
// дерево. `dist` окна раскладывает хост через `pnpm deploy` в `packages/desktop/out/host` — node-pty
// там новая копия из стора, снова без +x, и postinstall корня до неё не доходит.

import { chmod, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') process.exit(0);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2).map((dir) => path.resolve(dir));

/** Каталоги node-pty: пакет ставится в workspace-пакеты, а реальные файлы — в стор pnpm. */
async function findNodePtyDirs() {
  if (targets.length > 0) {
    // Ровно та копия, которую загрузит пакет каталога, — его собственный node_modules, без поиска
    // Node: тот через NODE_PATH (его ставят обёртки pnpm) нашёл бы node-pty дерева. Нет её —
    // realpath бросает, и скрипт падает: иначе .app уехал бы с хостом, который не запускает агентов.
    return Promise.all(
      targets.map((target) => realpath(path.join(target, 'node_modules', 'node-pty'))),
    );
  }

  const found = new Set();

  // node-pty в дереве — зависимость хоста: корень его не видит, поэтому ищем от пакета хоста.
  for (const from of [repoRoot, path.join(repoRoot, 'packages', 'host')]) {
    try {
      const require = createRequire(path.join(from, 'package.json'));
      found.add(path.dirname(require.resolve('node-pty/package.json')));
    } catch {
      // в этом месте пакета нет — идём дальше
    }
  }

  // Фолбэк на стор pnpm: там лежат сами файлы, на которые ссылаются симлинки.
  const store = path.join(repoRoot, 'node_modules', '.pnpm');
  try {
    for (const entry of await readdir(store)) {
      if (entry.startsWith('node-pty@')) {
        found.add(path.join(store, entry, 'node_modules', 'node-pty'));
      }
    }
  } catch {
    // не pnpm или стора нет
  }

  return [...found];
}

let fixed = 0;

for (const dir of await findNodePtyDirs()) {
  const prebuilds = path.join(dir, 'prebuilds');
  let platforms;
  try {
    platforms = await readdir(prebuilds);
  } catch {
    continue;
  }

  for (const platform of platforms) {
    const helper = path.join(prebuilds, platform, 'spawn-helper');
    try {
      const info = await stat(helper);
      if ((info.mode & 0o111) === 0) {
        await chmod(helper, 0o755);
        fixed++;
      }
    } catch {
      // хелпера для этой платформы нет — нормально
    }
  }
}

if (fixed > 0) console.log(`node-pty: выставлен +x на spawn-helper (${fixed})`);
