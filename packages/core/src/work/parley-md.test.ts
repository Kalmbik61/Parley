import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PARLEY_MD_MARKER, processParleyMd, readParleyMd } from './parley-md.js';

let project: string;
beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'parley-md-'));
});
afterEach(async () => {
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
