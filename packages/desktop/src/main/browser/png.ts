/** Размер PNG из заголовка IHDR (байты 16–23): без декода картинки на главном потоке. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG image.');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
