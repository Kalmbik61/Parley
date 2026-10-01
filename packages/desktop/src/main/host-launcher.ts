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
 * Встроенный node собранного приложения — `Contents/Resources/node/bin/node`. Его кладёт туда
 * `extraResources` electron-builder: файл своей архитектуры из `build/node/darwin-<arch>`, который
 * готовит `scripts/fetch-node.mjs` (Node 22 с nodejs.org, сверка по `SHASUMS256.txt`).
 */
export function bundledNodeBin(resourcesPath: string): string {
  return path.join(resourcesPath, 'node', 'bin', 'node');
}

/**
 * Каким node запускается хост. Хост и всё, что он поднимает сам (сервер MCP, строка статуса,
 * `notify` Codex), берут `process.execPath` хоста — то есть именно этот node.
 *
 * В собранном приложении (`packaged`) — встроенный node, если файл на месте: системный человеку
 * не нужен. Нет файла (сборка без `fetch-node`), а также в разработке — `node` из PATH
 * логин-шелла (`captureShellEnv`). Бинарь Electron не годится: хост — обычный node-процесс,
 * без `ELECTRON_RUN_AS_NODE`. `null` — не нашёлся ни встроенный, ни системный.
 */
export async function resolveNodeBin(
  env: NodeJS.ProcessEnv,
  app?: { packaged: boolean; resourcesPath: string },
): Promise<string | null> {
  if (app?.packaged === true) {
    const bundled = bundledNodeBin(app.resourcesPath);
    if (await isExecutableFile(bundled)) return bundled;
  }
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
 * `nodeBin` — `node`, найденный `resolveNodeBin` (встроенный или системный); вызывающий
 * код обязан проверить его на `null` раньше, сюда попадает только найденный путь. Путь и
 * `entry` могут содержать пробелы (приложение лежит там, куда его положил человек): процесс
 * запускается без оболочки, аргументами.
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
