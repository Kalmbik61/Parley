import { access, stat } from 'node:fs/promises';
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import type { HostPaths } from '@parley/host';
import type { SpawnedHost } from './host-connection.js';

const require = createRequire(import.meta.url);

/**
 * Пути хоста — то же самое, что `hostPaths()` из `@parley/host`, но
 * посчитанное здесь без импорта самого пакета: `@parley/host` при загрузке
 * (даже ради одного `hostPaths`) тянет за собой `host.ts` → `pty-manager` →
 * `node-pty`, а Electron нативных модулей грузить не должен (спека 3.2).
 * Тип `HostPaths` берём импортом только типа — он стирается при сборке и
 * рантайм-зависимости от пакета не создаёт.
 */
export function hostPaths(home: string = parleyHome()): HostPaths {
  const dir = path.join(home, 'host');
  return {
    dir,
    socket: path.join(dir, 'host.sock'),
    token: path.join(dir, 'host.token'),
    pid: path.join(dir, 'host.pid'),
    log: path.join(dir, 'host.log'),
  };
}

/**
 * Путь к точке входа хоста. В dev — обычный workspace-пакет `@parley/host`.
 * В собранном `.app` (`packaged: true`) пакета `@parley/host` в приложении
 * нет вовсе (кусок 1.13, электрон-билдер его исключает — вместе с node-pty),
 * поэтому путь собирается напрямую до `Resources/host`, куда `dist`
 * раскладывает `pnpm deploy` хоста.
 */
export function resolveHostEntry(options: { packaged: boolean; resourcesPath: string }): string {
  if (options.packaged) {
    return path.join(options.resourcesPath, 'host', 'dist', 'main.js');
  }
  return require.resolve('@parley/host/main');
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
 *
 * `stderrFile` — куда дописывается stderr хоста. Падение мимо логгера (необработанное
 * исключение) иначе не оставляет следа: `host.log` пишет только сам хост.
 */
export function spawnHost(options: {
  env: NodeJS.ProcessEnv;
  entry: string;
  nodeBin: string;
  stderrFile: string;
}): SpawnedHost {
  // Каталог хоста при первом запуске ещё не создан — его права хост потом выставит сам.
  mkdirSync(path.dirname(options.stderrFile), { recursive: true, mode: 0o700 });
  const stderr = openSync(options.stderrFile, 'a', 0o600);
  try {
    const child = spawn(options.nodeBin, [options.entry], {
      env: options.env,
      detached: true,
      stdio: ['ignore', 'ignore', stderr],
    });
    child.unref();
    // Окно не запускает второй хост, пока этот жив (раунд lane-r4). 'exit' приходит и у
    // отвязанного процесса, пока жив main; 'error' — не запустился вовсе.
    let running = true;
    child.once('exit', () => {
      running = false;
    });
    child.once('error', () => {
      running = false;
    });
    return { isRunning: () => running };
  } finally {
    closeSync(stderr);
  }
}
