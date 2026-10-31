import path from 'node:path';
import { parleyHome } from '@parley/core';

/** Файлы моста: всё лежит в `<дом>/remote/` (спека 5.2). */
export interface RemotePaths {
  dir: string;
  remoteJson: string;
  keysJson: string;
  devicesJson: string;
  audit: string;
  auditArchive: string;
  controlSocket: string;
  controlToken: string;
  pid: string;
  log: string;
}

/** `sockaddr_un.sun_path` на macOS — 104 байта с нулём; берём 103. */
export const MAX_SOCKET_PATH_BYTES = 103;

/** `home` задают тесты; без него — `parleyHome()` (`~/.parley`). */
export function remotePaths(home: string = parleyHome()): RemotePaths {
  const dir = path.join(home, 'remote');
  const paths: RemotePaths = {
    dir,
    remoteJson: path.join(dir, 'remote.json'),
    keysJson: path.join(dir, 'keys.json'),
    devicesJson: path.join(dir, 'devices.json'),
    audit: path.join(dir, 'audit.jsonl'),
    auditArchive: path.join(dir, 'audit.jsonl.1'),
    controlSocket: path.join(dir, 'control.sock'),
    controlToken: path.join(dir, 'control.token'),
    pid: path.join(dir, 'bridge.pid'),
    log: path.join(dir, 'bridge.log'),
  };
  if (Buffer.byteLength(paths.controlSocket) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`control socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes`);
  }
  return paths;
}
