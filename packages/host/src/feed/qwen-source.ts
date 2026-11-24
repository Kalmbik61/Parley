/**
 * Qwen Code transcript read from a remembered byte offset (spec 2026-11-11, 3.5). Only lines ended by a newline are
 * consumed: an unfinished last line (also one cut in the middle of a multi-byte character) waits for its continuation,
 * kept as bytes. A shorter file (recreated) is read from the start. The first read of a big file takes only a tail of at
 * most `seedMaxBytes`; its first, possibly partial, line is dropped.
 */

import { open } from 'node:fs/promises';
import { parseQwenLine, type QwenRecord } from '@parley/core';

export const QWEN_SEED_MAX_BYTES = 32 * 1024 * 1024;

export interface QwenTail {
  readonly file: string;
  /** New complete records since the previous call; the first call reads from the start. A missing file gives `[]`. */
  read(): Promise<QwenRecord[]>;
}

export function createQwenTail(file: string, options: { seedMaxBytes?: number } = {}): QwenTail {
  const seedMax = options.seedMaxBytes ?? QWEN_SEED_MAX_BYTES;
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
          .map(parseQwenLine)
          .filter((record): record is QwenRecord => record !== null);
      } finally {
        await handle.close();
      }
    },
  };
}
