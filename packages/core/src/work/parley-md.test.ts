import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createParleyMd,
  ensureParleyMd,
  PARLEY_MD_MARKER,
  processParleyMd,
  readParleyMd,
} from './parley-md.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});

let project: string;
beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-md-'));
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  vi.mocked(rename).mockReset();
  vi.mocked(rm).mockReset();
  vi.mocked(writeFile).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation(actual.open);
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.mocked(rm).mockImplementation(actual.rm);
  vi.mocked(writeFile).mockImplementation(actual.writeFile);
  await rm(project, { recursive: true, force: true });
});

describe('PARLEY.md preprocessing', () => {
  it('a commented template and nested empty sections cost no context', () => {
    expect(
      processParleyMd('\uFEFF# Team\r\n<!-- template -->\r\n## Empty\r\n### Child\r\n').text,
    ).toBe('');
  });

  it('keeps nonempty ancestors and fenced code, removes only outside comments', () => {
    const source =
      '# Team\n## Empty\n### Empty child\n<!-- gone -->\n## Keep\n### Child\nRule <!-- hidden\n  ``` ignored while inside comment\n--> stays\n\n```md\n<!-- literal -->\n# literal\n\n\n```\n\n~~~\n<!-- also literal -->\n~~~\n';
    const text = processParleyMd(source).text;
    expect(text).toBe(
      '# Team\n\n## Keep\n### Child\nRule  stays\n\n```md\n<!-- literal -->\n# literal\n\n\n```\n\n~~~\n<!-- also literal -->\n~~~',
    );
  });

  it('fence close must match its character and at least its opening length', () => {
    const source = '````\n```\n<!-- literal -->\n~~~\n````\n<!-- gone -->\nRule';
    expect(processParleyMd(source).text).toBe('````\n```\n<!-- literal -->\n~~~\n````\n\nRule');
  });

  it('truncates on a line boundary including the marker inside the UTF-8 ceiling', () => {
    const result = processParleyMd('Ж'.repeat(8000) + '\n' + '🙂'.repeat(10000));
    expect(result.text).toBe('Ж'.repeat(8000) + '\n' + PARLEY_MD_MARKER);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(32768);
    expect(result.warnings.map((warning) => warning.code)).toEqual(['parley-md-truncated']);
    expect(result.text).not.toContain('�');
  });

  it('a single overlong line becomes a marker, never a broken scalar or oversized output', () => {
    const result = processParleyMd('🙂'.repeat(10000));
    expect(result.text).toBe(PARLEY_MD_MARKER);
  });

  it('normalizes BOM and CRLF, collapses outside blank lines and never expands imports', () => {
    expect(processParleyMd('\uFEFF\r\n# Team\r\n\r\n\r\n@private/file\r\n').text).toBe(
      '# Team\n\n@private/file',
    );
  });
});

describe('PARLEY.md read', () => {
  it.skipIf(process.platform === 'win32')(
    'a FIFO is unreadable and never waits for a writer',
    async () => {
      await promisify(execFile)('/usr/bin/mkfifo', [path.join(project, 'PARLEY.md')]);
      expect((await readParleyMd(project)).warnings[0]?.code).toBe('parley-md-unreadable');
    },
  );

  it('absence is empty, a directory produces a safe warning', async () => {
    expect(await readParleyMd(project)).toEqual({ text: '', warnings: [] });
    await mkdir(path.join(project, 'PARLEY.md'));
    const result = await readParleyMd(project);
    expect(result.text).toBe('');
    expect(result.warnings[0]?.code).toBe('parley-md-unreadable');
    expect(result.warnings[0]?.message).not.toContain(project);
  });

  it('follows readable symlinks and distinguishes a broken link from absence', async () => {
    await writeFile(path.join(project, 'rules.md'), 'One rule');
    await symlink('rules.md', path.join(project, 'PARLEY.md'));
    expect((await readParleyMd(project)).text).toBe('One rule');
    await rm(path.join(project, 'rules.md'));
    expect((await readParleyMd(project)).warnings[0]?.code).toBe('parley-md-unreadable');
  });
});

describe('PARLEY.md creation receipt', () => {
  it('creates the empty-cost template once and records it in the legacy state directory', async () => {
    await mkdir(path.join(project, '.harnas'));
    expect((await ensureParleyMd(project)).created).toBe(true);
    expect((await readParleyMd(project)).text).toBe('');
    expect(
      JSON.parse(await readFile(path.join(project, '.harnas', 'parley-md-receipt.json'), 'utf8')),
    ).toMatchObject({ version: 1, created: true });
    await rm(path.join(project, 'PARLEY.md'));
    expect((await ensureParleyMd(project)).created).toBe(false);
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await createParleyMd(project)).created).toBe(true);
  });

  it('never overwrites an occupied path, including a broken link or directory', async () => {
    await writeFile(path.join(project, 'PARLEY.md'), 'HUMAN RULES');
    expect((await ensureParleyMd(project)).created).toBe(false);
    expect((await createParleyMd(project)).created).toBe(false);
    expect(await readFile(path.join(project, 'PARLEY.md'), 'utf8')).toBe('HUMAN RULES');
    await rm(path.join(project, 'PARLEY.md'));
    await symlink('missing', path.join(project, 'PARLEY.md'));
    expect((await createParleyMd(project)).created).toBe(false);
    expect((await lstat(path.join(project, 'PARLEY.md'))).isSymbolicLink()).toBe(true);
    await rm(path.join(project, 'PARLEY.md'));
    await mkdir(path.join(project, 'PARLEY.md'));
    expect((await createParleyMd(project)).created).toBe(false);
  });

  it('concurrent automatic requests create exactly one file', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureParleyMd(project)));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await readParleyMd(project)).text).toBe('');
  });

  it('failed initial accounting creates nothing and permits a later automatic attempt', async () => {
    await writeFile(path.join(project, '.parley'), 'occupied');
    await expect(ensureParleyMd(project)).rejects.toThrow();
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(path.join(project, '.parley'));
    expect(await ensureParleyMd(project)).toEqual({ created: true });
  });

  it('ENOSPC after exclusive receipt open retains the empty receipt until explicit Create recovers', async () => {
    await mkdir(path.join(project, '.parley'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const receipt = path.join(project, '.parley', 'parley-md-receipt.json');
    let closed = false;
    vi.mocked(open).mockImplementationOnce(async (file, flags, mode) => {
      expect(file).toBe(receipt);
      expect(flags).toBe('wx');
      const handle = await actual.open(file, flags, mode);
      vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(
        Object.assign(new Error('receipt body write failed'), { code: 'ENOSPC' }),
      );
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(ensureParleyMd(project)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(closed).toBe(true);
    expect(await readFile(receipt, 'utf8')).toBe('');
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await ensureParleyMd(project)).toEqual({ created: false, receiptError: true });
    expect(await readFile(receipt, 'utf8')).toBe('');
    expect(await createParleyMd(project)).toEqual({ created: true });
    expect(JSON.parse(await readFile(receipt, 'utf8'))).toMatchObject({ version: 1, created: true });
    expect((await readParleyMd(project)).text).toBe('');
  });

  it('malformed accounting suppresses automatic creation', async () => {
    await mkdir(path.join(project, '.parley'));
    await writeFile(path.join(project, '.parley', 'parley-md-receipt.json'), 'broken');
    expect(await ensureParleyMd(project)).toMatchObject({ created: false, receiptError: true });
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('failed file creation retains its reservation; only explicit Create retries', async () => {
    await mkdir(path.join(project, '.parley'));
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('file creation denied'));
    await expect(ensureParleyMd(project)).rejects.toThrow('file creation denied');
    expect(
      JSON.parse(await readFile(path.join(project, '.parley', 'parley-md-receipt.json'), 'utf8')),
    ).toMatchObject({ version: 1, created: false });
    expect(await ensureParleyMd(project)).toEqual({ created: false });
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await createParleyMd(project)).toEqual({ created: true });
    expect((await readParleyMd(project)).text).toBe('');
  });

  it('never unlinks a receipt after a failed write, even at the former final-check race boundary', async () => {
    await mkdir(path.join(project, '.parley'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const receipt = path.join(project, '.parley', 'parley-md-receipt.json');
    let interleaved = false;
    const explicitCreateAndDelete = async (): Promise<void> => {
      interleaved = true;
      expect(await createParleyMd(project)).toEqual({ created: true });
      expect(JSON.parse(await readFile(receipt, 'utf8')).created).toBe(true);
      await actual.rm(path.join(project, 'PARLEY.md'));
    };
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('automatic write failed'));
    vi.mocked(rm).mockImplementation(async (target, options) => {
      // Reproduce replacement after both old ownership/state checks, just before unlink.
      if (target === receipt && !interleaved) await explicitCreateAndDelete();
      return actual.rm(target, options);
    });
    await expect(ensureParleyMd(project)).rejects.toThrow('automatic write failed');
    // Without the stale unlink branch, the explicit action runs after the failed attempt.
    if (!interleaved) await explicitCreateAndDelete();
    expect(vi.mocked(rm).mock.calls.some(([target]) => target === receipt)).toBe(false);
    expect(JSON.parse(await readFile(receipt, 'utf8')).created).toBe(true);
    expect(await ensureParleyMd(project)).toEqual({ created: false });
    await expect(lstat(path.join(project, 'PARLEY.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a final receipt update failure retains the reservation after successful creation', async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error('receipt update failed'));
    expect(await ensureParleyMd(project)).toMatchObject({ created: true, receiptError: true });
    await rm(path.join(project, 'PARLEY.md'));
    expect((await ensureParleyMd(project)).created).toBe(false);
  });

  it('failed file creation cannot remove a receipt replaced by concurrent explicit Create', async () => {
    await mkdir(path.join(project, '.parley'));
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile).mockImplementationOnce(async () => {
      // The automatic reservation exists; the explicit request replaces it while this write waits.
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
      await createParleyMd(project);
      await rm(path.join(project, 'PARLEY.md'));
      throw new Error('automatic write failed');
    });
    await expect(ensureParleyMd(project)).rejects.toThrow('automatic write failed');
    expect(
      JSON.parse(await readFile(path.join(project, '.parley', 'parley-md-receipt.json'), 'utf8'))
        .created,
    ).toBe(true);
    expect((await ensureParleyMd(project)).created).toBe(false);
  });
});
