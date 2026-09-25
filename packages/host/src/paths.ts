import path from 'node:path';
import { harnasHome } from '@harnas/core';

/** Файлы одного хоста: всё лежит в `<HARNAS_HOME>/host/`. */
export interface HostPaths {
  dir: string;
  socket: string;
  token: string;
  pid: string;
  log: string;
}

/**
 * `sockaddr_un.sun_path` на macOS — 104 байта вместе с завершающим нулём.
 * Берём 103, чтобы гарантированно влезть с запасом в один байт.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

export function hostPaths(home: string = harnasHome()): HostPaths {
  const dir = path.join(home, 'host');
  return {
    dir,
    socket: path.join(dir, 'host.sock'),
    token: path.join(dir, 'host.token'),
    pid: path.join(dir, 'host.pid'),
    log: path.join(dir, 'host.log'),
  };
}
