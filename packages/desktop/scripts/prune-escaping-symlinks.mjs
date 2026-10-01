#!/usr/bin/env node
// Убирает из каталога симлинки, чья цель лежит за его пределами (и оборванные тоже).
//
// Зачем. После `pnpm deploy` хоста в `out/host/node_modules/.pnpm/node_modules/@parley/host` лежит ссылка
// на сам workspace-пакет хоста: путь у неё относительный и ведёт из `out/host` наверх, в исходное дерево.
// В собранном приложении тот же каталог лежит на другой глубине (`Contents/Resources/host`), и ссылка
// указывает в пустоту. Раньше это никому не мешало, а с подписью ad-hoc (`identity: '-'`) electron-builder
// обходит всё приложение и делает `stat` каждого файла — оборванная ссылка роняет сборку с ENOENT.
// Хосту эта ссылка не нужна: никто не грузит `@parley/host` из своих зависимостей.
//
// Использование: `node scripts/prune-escaping-symlinks.mjs <каталог>`; печатает, что удалила.

import { realpathSync } from 'node:fs';
import { readdir, readlink, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isInside = (root, target) => target === root || target.startsWith(root + path.sep);

/**
 * Удаляет симлинки каталога `directory`, которые ведут за его пределы или никуда. Остальные (внутри
 * каталога, как весь `node_modules` pnpm) остаются. Возвращает список удалённых: `{ link, target }`.
 */
export async function pruneEscapingSymlinks(directory) {
  const root = await realpath(directory);
  const removed = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(full).catch(() => null);
        if (target === null || !isInside(root, target)) {
          removed.push({ link: path.relative(root, full), target: await readlink(full) });
          await rm(full);
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  }

  await walk(root);
  return removed;
}

async function main() {
  const directory = process.argv[2];
  if (directory === undefined) {
    throw new Error('нужен каталог: node scripts/prune-escaping-symlinks.mjs <каталог>');
  }
  for (const { link, target } of await pruneEscapingSymlinks(path.resolve(directory))) {
    console.log(`удалена ссылка за пределами каталога: ${link} → ${target}`);
  }
}

// Запуск из командной строки; при импорте (тест) ничего не делается.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`prune-escaping-symlinks: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
