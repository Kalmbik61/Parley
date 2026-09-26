#!/usr/bin/env node
// node-pty кладёт в prebuilds вспомогательный бинарь spawn-helper, но pnpm распаковывает
// его без бита исполнения. Без +x любой spawn падает с невнятным «posix_spawnp failed».
// Чиним после установки; на Windows helper не нужен.

import { chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') process.exit(0);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Каталоги node-pty: пакет ставится в workspace-пакеты, а реальные файлы — в стор pnpm. */
async function findNodePtyDirs() {
  const found = new Set();

  for (const from of [
    repoRoot,
    path.join(repoRoot, 'packages', 'tui'),
    // Хост завёл свой node-pty в 1.6 — та же версия обычно дедуплицируется в
    // один каталог стора со скопом tui, но полагаться на это не стоит.
    path.join(repoRoot, 'packages', 'host'),
  ]) {
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
