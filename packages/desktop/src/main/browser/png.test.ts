import { describe, expect, it } from 'vitest';
import { pngSize } from './png.js';

function header(width: number, height: number): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.writeUInt32BE(13, 8);
  data.write('IHDR', 12, 'ascii');
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

describe('pngSize', () => {
  it('читает размер из IHDR; не PNG — ошибка', () => {
    expect(pngSize(header(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(() => pngSize(Buffer.from('not a png at all, definitely not a png'))).toThrow('Not a PNG');
    expect(() => pngSize(header(1, 1).subarray(0, 20))).toThrow('Not a PNG');
  });
});
