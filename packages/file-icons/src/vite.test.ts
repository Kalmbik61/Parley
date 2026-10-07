/**
 * Плагин сборки значков (спека значков 4.4 и 7.1): сборка выпускает все SVG набора и LICENSE под
 * `file-icons/`, dev-сервер отдаёт известный файл и пропускает дальше всё прочее, включая `../`.
 */

import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Connect, ViteDevServer } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { fileIcons } from './vite.js';

const iconsDir = join(dirname(createRequire(import.meta.url).resolve('material-icon-theme/package.json')), 'icons');
const svgs = readdirSync(iconsDir).filter((name) => name.endsWith('.svg'));

interface Emitted {
  fileName: string;
  source: Buffer;
}

function emitted(): Emitted[] {
  const files: Emitted[] = [];
  const hook = fileIcons().generateBundle as unknown as (this: { emitFile(file: Emitted): void }) => void;
  hook.call({ emitFile: (file) => files.push(file) });
  return files;
}

function middleware(): Connect.NextHandleFunction {
  let handler: Connect.NextHandleFunction | undefined;
  const server = {
    middlewares: {
      use: (fn: Connect.NextHandleFunction) => {
        handler = fn;
      },
    },
  } as unknown as ViteDevServer;
  (fileIcons().configureServer as unknown as (server: ViteDevServer) => void)(server);
  if (handler === undefined) throw new Error('обработчик dev-сервера не подключён');
  return handler;
}

const handle = middleware();

function get(url: string): { response: { setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }; next: ReturnType<typeof vi.fn> } {
  const response = { setHeader: vi.fn(), end: vi.fn() };
  const next = vi.fn();
  handle({ url } as never, response as never, next);
  return { response, next };
}

describe('fileIcons — сборка', () => {
  it('кладёт все SVG набора и LICENSE в file-icons/', () => {
    const files = emitted();
    expect(files.map((file) => file.fileName).sort()).toEqual([...svgs.map((name) => `file-icons/${name}`), 'file-icons/LICENSE'].sort());
    expect(files.find((file) => file.fileName === 'file-icons/LICENSE')?.source.toString()).toContain('Copyright (c) 2025 Material Extensions');
  });
});

describe('fileIcons — dev-сервер', () => {
  it('отдаёт известный SVG с типом image/svg+xml, хвост ?… не мешает', () => {
    const { response, next } = get('/file-icons/nodejs.svg?v=1');
    expect(next).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'image/svg+xml');
    expect(String(response.end.mock.calls[0]?.[0])).toMatch(/^<svg/);
  });

  it('каждый файл набора проходит фильтр адреса', () => {
    for (const name of svgs) expect(get(`/file-icons/${name}`).next, name).not.toHaveBeenCalled();
  });

  it('чужие пути пропускает дальше, ничего не отдавая', () => {
    for (const url of ['/file-icons/../package.json', '/file-icons/nope.svg', '/file-icons/LICENSE', '/file-icons/a/b.svg', '/index.html']) {
      const { response, next } = get(url);
      expect(next, url).toHaveBeenCalledOnce();
      expect(response.end, url).not.toHaveBeenCalled();
    }
  });
});
