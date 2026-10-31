import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Синхронный `ensureDir` для журнала: каталог файла 0700. */
export function ensureDirSync(file: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
