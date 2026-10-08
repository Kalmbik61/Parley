/**
 * Журнал Codex хвостом (спека 2026-10-07, 5.3): с запомненной позиции байтов; неполная последняя строка (в том числе
 * разрезанная посреди многобайтового символа) ждёт продолжения — остаток хранится байтами. Файл стал короче
 * (пересоздан) — чтение с начала. Первое чтение большого файла — только хвост не больше `seedMaxBytes`: первая неполная
 * строка хвоста отбрасывается.
 */

import { open } from 'node:fs/promises';
import { parseRolloutLine, type RolloutRecord } from '@parley/core';

export const ROLLOUT_SEED_MAX_BYTES = 32 * 1024 * 1024;

export interface RolloutTail {
  readonly file: string;
  /** Новые законченные строки с прошлого вызова; первый вызов — с начала (или с хвоста не больше `seedMaxBytes`). Файла нет — []. */
  read(): Promise<RolloutRecord[]>;
}

export function createRolloutTail(file: string, options: { seedMaxBytes?: number } = {}): RolloutTail {
  const seedMax = options.seedMaxBytes ?? ROLLOUT_SEED_MAX_BYTES;
  let offset = -1;
  let rest: Buffer = Buffer.alloc(0);
  return {
    file,
    async read() {
      let handle;
      try {
        handle = await open(file, 'r');
      } catch {
        return [];
      }
      try {
        const { size } = await handle.stat();
        let dropFirst = false;
        if (offset === -1) {
          offset = size > seedMax ? size - seedMax : 0;
          dropFirst = offset > 0;
        } else if (size < offset) {
          offset = 0;
          rest = Buffer.alloc(0);
        }
        if (size === offset) return [];
        const chunk = Buffer.alloc(size - offset);
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        offset += bytesRead;
        let data = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
        if (dropFirst) {
          const first = data.indexOf(0x0a);
          data = first === -1 ? Buffer.alloc(0) : data.subarray(first + 1);
        }
        const end = data.lastIndexOf(0x0a);
        if (end === -1) {
          rest = data;
          return [];
        }
        rest = Buffer.from(data.subarray(end + 1));
        return data
          .subarray(0, end)
          .toString('utf8')
          .split('\n')
          .map(parseRolloutLine)
          .filter((record): record is RolloutRecord => record !== null);
      } finally {
        await handle.close();
      }
    },
  };
}
