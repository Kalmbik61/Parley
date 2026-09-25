import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Путь к точке входа хоста в dev-режиме — обычный workspace-пакет
 * `@harnas/host`. Кусок 1.13 добавит здесь же ветку для пути внутри
 * собранного `.app` (`process.resourcesPath/host/dist/main.js`).
 */
export function resolveHostEntry(): string {
  return require.resolve('@harnas/host/main');
}

/**
 * Хост переживает окно: процесс отделяется от родителя и не держит его живым.
 *
 * `nodeBin` в деле почти всегда — это `process.execPath`, то есть сам бинарь
 * Electron: отдельного Node.js в собранном приложении нет. Без
 * `ELECTRON_RUN_AS_NODE` этот бинарь попытался бы поднять ещё одно
 * Electron-приложение вместо простого Node-скрипта — сажаем флаг сюда, а не
 * ждём его от вызывающего кода.
 */
export function spawnHost(options: { env: NodeJS.ProcessEnv; entry: string; nodeBin: string }): void {
  const child = spawn(options.nodeBin, [options.entry], {
    env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
