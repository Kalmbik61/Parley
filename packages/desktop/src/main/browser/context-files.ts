/**
 * Файлы-контексты браузера в main (спека браузера 3.6): окно присылает готовый Markdown (`shared/context-markdown.ts`)
 * и путь снимка, main пишет `drops/context/<вид>-<метка>-<4 hex>.md` и переносит снимок рядом — то же имя с `.png`.
 *
 * Как у `drops.ts#saveImage`: права 0600, `open(…, 'wx')` — занятое имя (и подложенная ссылка) не перезаписывается,
 * берётся новое. Снимок принимается только обычным файлом `.png` прямо в `drops/`: так окно не перенесёт чужой файл.
 * Путь снимка в шапку подставляет main (`fillScreenshot`): имя файла знает только он.
 */

import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parleyHome } from '@parley/core';
import { CONTEXT_LIMITS, contextLabel, fillScreenshot, isContextKind, type ContextKind } from '../../shared/context-markdown.js';
import { CONTEXT_SUBDIR, dropsDir } from '../drops.js';
import { HostError } from '../host-connection.js';

/** Сколько раз пробуем новое имя, если занято: 65536 имён на метку — хватит с запасом. */
const MAX_ATTEMPTS = 32;
/** Метка из окна до чистки: длиннее не бывает у своих шаблонов, это страж формы, а не предел спеки. */
const MAX_RAW_LABEL = 400;
const MAX_PATH = 4096;

/** `~/.parley/desktop/drops/context` — рядом со скриншотами `drops/`. */
export function contextDir(home: string = parleyHome()): string {
  return path.join(dropsDir(home), CONTEXT_SUBDIR);
}

function badRequest(message: string): HostError {
  return new HostError('bad_request', message);
}

function readImagePath(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length <= MAX_PATH && path.isAbsolute(value) ? value : undefined;
}

/** Форма `browser:save-context` из окна; не та — `bad_request` до записи. */
export function parseContextInput(value: unknown): { kind: ContextKind; label: string; markdown: string; imagePath: string | null } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badRequest('invalid context file');
  const source = value as Record<string, unknown>;
  const { kind, label, markdown } = source;
  const imagePath = readImagePath(source.imagePath);
  if (!isContextKind(kind) || typeof label !== 'string' || label.length > MAX_RAW_LABEL || typeof markdown !== 'string' || imagePath === undefined) {
    throw badRequest('invalid context file');
  }
  return { kind, label, markdown, imagePath };
}

/** Снимок — обычный файл `.png` прямо в `drops/`, не ссылка. */
async function checkImage(imagePath: string, drops: string): Promise<void> {
  if (!path.isAbsolute(imagePath) || path.extname(imagePath) !== '.png' || path.dirname(path.resolve(imagePath)) !== path.resolve(drops)) {
    throw badRequest('screenshot is not a PNG in drops/');
  }
  const info = await lstat(imagePath).catch(() => null);
  if (info === null || !info.isFile()) throw badRequest('screenshot is not a regular file');
}

export async function saveContextFile(input: {
  kind: ContextKind;
  label: string;
  markdown: string;
  imagePath: string | null;
  dir: string;
  dropsDir: string;
  random?: () => number;
}): Promise<{ mdPath: string; pngPath: string | null }> {
  if (Buffer.byteLength(input.markdown, 'utf8') > CONTEXT_LIMITS.markdown) throw badRequest('context file is too large');
  if (input.imagePath !== null) await checkImage(input.imagePath, input.dropsDir);
  const label = contextLabel(input.label);
  const random = input.random ?? Math.random;
  await mkdir(input.dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const hex = Math.floor(random() * 0x10000)
      .toString(16)
      .padStart(4, '0')
      .slice(-4);
    const base = `${input.kind}-${label}-${hex}`;
    const mdPath = path.join(input.dir, `${base}.md`);
    let handle;
    try {
      handle = await open(mdPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    // Путь снимка известен заранее — его имя строится от `base`, — поэтому сперва пишется .md, а снимок переезжает после: не
    // записался .md (диск полон) — снимок так и лежит в drops/, а не осиротел в context/ без файла, который на него ссылается.
    const pngPath = input.imagePath === null ? null : path.join(input.dir, `${base}.png`);
    try {
      await handle.writeFile(fillScreenshot(input.markdown, pngPath), 'utf8');
      if (input.imagePath !== null && pngPath !== null) {
        // Принимается любой .png из `drops/`, не только от saveImage (0600): права снимка ставятся здесь, как у .md.
        await chmod(input.imagePath, 0o600);
        // Тот же каталог `drops/` — тот же диск: rename без копии.
        await rename(input.imagePath, pngPath);
      }
    } catch (error) {
      await handle.close();
      await unlink(mdPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    return { mdPath, pngPath };
  }
  throw new Error(`no free file name in ${input.dir}`);
}
