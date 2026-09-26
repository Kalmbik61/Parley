import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Путь к точке входа хоста в dev-режиме — обычный workspace-пакет
 * `@harnas/host`. Кусок 1.13 добавит здесь же ветку для пути внутри
 * собранного `.app` (`process.resourcesPath/host/dist/main.js`).
 */
export function resolveHostEntry(): string {
  return require.resolve('@harnas/host/main');
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ищет `node` в PATH логин-шелла (`captureShellEnv`), а не в бинаре Electron.
 * `node-pty` хоста собран под ABI системного Node — под Node самого Electron
 * он не загрузится (спека 3.2), так что `ELECTRON_RUN_AS_NODE` здесь не
 * годится в принципе. `null` — в этом PATH `node` не нашёлся вовсе.
 */
export async function resolveNodeBin(env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, 'node');
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Хост переживает окно: процесс отделяется от родителя и не держит его живым.
 *
 * `nodeBin` — системный `node`, найденный `resolveNodeBin`; вызывающий код
 * обязан проверить его на `null` раньше, сюда попадает только найденный путь.
 */
export function spawnHost(options: { env: NodeJS.ProcessEnv; entry: string; nodeBin: string }): void {
  const child = spawn(options.nodeBin, [options.entry], {
    env: options.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
