import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_LIMITS, SCREENSHOT_SLOT } from '../../shared/context-markdown.js';
import { S } from '../../shared/strings.js';
import { contextDir, parseContextInput, saveContextFile } from './context-files.js';

// `open` — обёртка над настоящим: по умолчанию зовёт его, а тест отказа записи подменяет `writeFile` дескриптора одного вызова.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

let base: string;
let drops: string;
let dir: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'hh-context-'));
  drops = path.join(base, 'drops');
  dir = path.join(drops, 'context');
  await mkdir(drops, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const MD = `# Page element — button.save\nURL: http://x/\n${S.contextFile.screenshot(SCREENSHOT_SLOT)}\n\nbody\n`;

/** Случайные числа по очереди: имя файла тогда предсказуемо. */
function sequence(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? 'thrown';
  }
  return 'resolved';
}

describe('contextDir', () => {
  it('~/.parley/desktop/drops/context от дома', () => {
    expect(contextDir('/h')).toBe(path.join('/h', 'desktop', 'drops', 'context'));
  });
});

describe('saveContextFile (спека 3.6)', () => {
  it('md 0600 с именем <вид>-<метка>-<4 hex>.md; снимок переехал из drops/ рядом, путь — в шапке', async () => {
    const png = path.join(drops, '20261007-101010-a1f3.png');
    await writeFile(png, 'png-bytes', { mode: 0o600 });
    const saved = await saveContextFile({ kind: 'element', label: 'button.save', markdown: MD, imagePath: png, dir, dropsDir: drops, random: sequence(0.5) });
    const pngPath = path.join(dir, 'element-button.save-8000.png');
    expect(saved).toEqual({ mdPath: path.join(dir, 'element-button.save-8000.md'), pngPath });
    expect((await stat(saved.mdPath)).mode & 0o777).toBe(0o600);
    expect((await stat(pngPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(pngPath, 'utf8')).toBe('png-bytes');
    expect(await readdir(drops)).toEqual(['context']);
    expect(await readFile(saved.mdPath, 'utf8')).toBe(`# Page element — button.save\nURL: http://x/\nScreenshot: ${pngPath}\n\nbody\n`);
  });

  it('без снимка — pngPath null, строки Screenshot нет', async () => {
    const saved = await saveContextFile({ kind: 'console', label: 'error-boom', markdown: MD, imagePath: null, dir, dropsDir: drops, random: sequence(0) });
    expect(saved).toEqual({ mdPath: path.join(dir, 'console-error-boom-0000.md'), pngPath: null });
    expect(await readFile(saved.mdPath, 'utf8')).not.toContain('Screenshot:');
  });

  it('метка чистится: ../../evil → evil, файл — внутри context/', async () => {
    const saved = await saveContextFile({ kind: 'request', label: '../../evil', markdown: '# x\n', imagePath: null, dir, dropsDir: drops, random: sequence(0) });
    expect(saved.mdPath).toBe(path.join(dir, 'request-evil-0000.md'));
  });

  it('снимок вне drops/, не .png, во вложенном каталоге или ссылкой — bad_request, ничего не записано', async () => {
    const outside = path.join(base, 'outside.png');
    await writeFile(outside, 'x');
    const nested = path.join(drops, 'sub');
    await mkdir(nested);
    await writeFile(path.join(nested, 'a.png'), 'x');
    await writeFile(path.join(drops, 'a.txt'), 'x');
    await symlink(outside, path.join(drops, 'link.png'));
    for (const imagePath of [outside, path.join(nested, 'a.png'), path.join(drops, 'a.txt'), path.join(drops, 'link.png'), path.join(drops, 'missing.png')]) {
      expect(await codeOf(saveContextFile({ kind: 'element', label: 'x', markdown: MD, imagePath, dir, dropsDir: drops })), imagePath).toBe('bad_request');
    }
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    expect((await lstat(path.join(drops, 'link.png'))).isSymbolicLink()).toBe(true);
  });

  it('markdown больше 256 КБ — bad_request', async () => {
    const markdown = 'x'.repeat(CONTEXT_LIMITS.markdown + 1);
    expect(await codeOf(saveContextFile({ kind: 'errors', label: 'x', markdown, imagePath: null, dir, dropsDir: drops }))).toBe('bad_request');
  });

  it('имя занято (в том числе ссылкой) — берётся следующее; цель ссылки цела', async () => {
    await mkdir(dir, { recursive: true });
    const outside = path.join(base, 'target.txt');
    await writeFile(outside, 'чужое');
    await writeFile(path.join(dir, 'console-a-0000.md'), 'занято');
    await symlink(outside, path.join(dir, 'console-a-0001.md'));
    const saved = await saveContextFile({ kind: 'console', label: 'a', markdown: '# x\n', imagePath: null, dir, dropsDir: drops, random: sequence(0, 1 / 0x10000, 2 / 0x10000) });
    expect(saved.mdPath).toBe(path.join(dir, 'console-a-0002.md'));
    expect(await readFile(outside, 'utf8')).toBe('чужое');
  });

  it('снимок получает права 0600, даже если в drops/ он лежал с другими: принимается любой .png оттуда', async () => {
    const png = path.join(drops, 'a.png');
    await writeFile(png, 'png-bytes', { mode: 0o644 });
    const saved = await saveContextFile({ kind: 'element', label: 'x', markdown: MD, imagePath: png, dir, dropsDir: drops, random: sequence(0) });
    expect((await stat(saved.pngPath ?? '')).mode & 0o777).toBe(0o600);
  });

  it('.md не записался (диск полон) — снимок остался в drops/, а не осиротел в context/; пустой .md убран, ошибка не проглочена', async () => {
    const png = path.join(drops, 'a.png');
    await writeFile(png, 'png-bytes');
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementationOnce(async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      handle.writeFile = (): Promise<void> => Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
      return handle;
    });
    await expect(saveContextFile({ kind: 'element', label: 'x', markdown: MD, imagePath: png, dir, dropsDir: drops, random: sequence(0) })).rejects.toHaveProperty('code', 'ENOSPC');
    expect(await readFile(png, 'utf8')).toBe('png-bytes');
    expect(await readdir(dir)).toEqual([]);
  });

  it('снимок не переехал (на его месте каталог) — .md убран, снимок остался в drops/, ошибка не проглочена', async () => {
    const png = path.join(drops, 'a.png');
    await writeFile(png, 'png-bytes');
    // Файл поверх каталога rename не заменит: ошибка приходит уже после того, как .md создан.
    await mkdir(path.join(dir, 'element-x-0000.png'), { recursive: true });
    // Пробрасывается системная ошибка переноса (у неё есть code), а не общее «нет свободного имени» после повторов.
    await expect(saveContextFile({ kind: 'element', label: 'x', markdown: MD, imagePath: png, dir, dropsDir: drops, random: sequence(0) })).rejects.toHaveProperty('code');
    expect(await readdir(dir)).toEqual(['element-x-0000.png']);
    expect(await readFile(png, 'utf8')).toBe('png-bytes');
  });
});

describe('parseContextInput', () => {
  const good = { kind: 'console', label: 'error-boom', markdown: '# x\n', imagePath: null };

  it('верная форма — как есть; абсолютный путь снимка — да', () => {
    expect(parseContextInput(good)).toEqual(good);
    expect(parseContextInput({ ...good, imagePath: '/h/drops/a.png', extra: 1 })).toEqual({ ...good, imagePath: '/h/drops/a.png' });
  });

  it('чужой вид, не строки, относительный путь, слишком длинная метка — bad_request', () => {
    for (const bad of [null, 'x', [], { ...good, kind: 'cookie' }, { ...good, label: 5 }, { ...good, markdown: null }, { ...good, imagePath: 7 }, { ...good, imagePath: 'a.png' }, { ...good, label: 'x'.repeat(401) }]) {
      let code = 'resolved';
      try {
        parseContextInput(bad);
      } catch (error) {
        code = (error as { code?: string }).code ?? 'thrown';
      }
      expect(code, JSON.stringify(bad)).toBe('bad_request');
    }
  });
});
