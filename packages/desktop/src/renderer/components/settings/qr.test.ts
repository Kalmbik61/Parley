import { describe, expect, it } from 'vitest';
import { qrSvg } from './qr.js';

describe('qrSvg', () => {
  it('отдаёт SVG-строку', async () => {
    const svg = await qrSvg('https://t.me/parley_bot?start=ABC123');
    expect(svg.startsWith('<svg')).toBe(true);
  });
});
