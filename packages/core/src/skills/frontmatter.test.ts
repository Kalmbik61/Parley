import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseMarkdownFrontmatter,
  parseTomlDocument,
  parseYamlDocument,
  readMarkdownFrontmatter,
  readTomlDocument,
  readYamlDocument,
} from './frontmatter.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-metadata-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function put(text: string | Uint8Array, name = 'SKILL.md'): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, text);
  return file;
}

function skillBytes(size: number): string {
  const header = '---\ndescription: Valid description\n---\n';
  const bodyBytes = size - Buffer.byteLength(header, 'utf8');
  return header + 'Ж'.repeat(Math.floor(bodyBytes / 2)) + 'a'.repeat(bodyBytes % 2);
}

describe('shared YAML parser', () => {
  it('preserves a complete literal description and real disabled boolean', () => {
    expect(
      parseYamlDocument(
        'description: |\n  first line\n  last line\ndisable-model-invocation: false\n',
      ),
    ).toEqual({
      status: 'valid',
      data: { description: 'first line\nlast line\n', 'disable-model-invocation': false },
    });
  });

  it('decodes folded, quoted and escaped strings without trimming them', () => {
    expect(
      parseYamlDocument(
        'description: >\n  first\n  second\nname: "quote \\" : #"\ntext: "line\\nlast"\n',
      ),
    ).toEqual({
      status: 'valid',
      data: { description: 'first second\n', name: 'quote " : #', text: 'line\nlast' },
    });
  });

  it('preserves string booleans and invalid semantic fields for caller validation', () => {
    expect(
      parseYamlDocument(
        'disable-model-invocation: "false"\ndescription: [one, two]\npolicy:\n  allow_implicit_invocation: false\n',
      ),
    ).toEqual({
      status: 'valid',
      data: {
        'disable-model-invocation': 'false',
        description: ['one', 'two'],
        policy: { allow_implicit_invocation: false },
      },
    });
  });

  it.each(['', 'null', 'description', '- one\n- two', '---\na: 1\n---\nb: 2'])(
    'rejects a non-mapping or multi-document input: %j',
    (text) => {
      expect(parseYamlDocument(text)).toMatchObject({
        status: 'invalid',
        diagnostic: { code: 'invalid-yaml' },
      });
    },
  );

  it('rejects duplicate keys and exposes a position without the private source line', () => {
    const result = parseYamlDocument('secret: TOP_SECRET\nsecret: PRIVATE_TOKEN\n');
    expect(result).toEqual({
      status: 'invalid',
      diagnostic: { code: 'invalid-yaml', line: 2, column: 1 },
    });
    expect(JSON.stringify(result)).not.toMatch(/TOP_SECRET|PRIVATE_TOKEN|secret/);
  });

  it('rejects syntax errors without exception text or source excerpts', () => {
    const result = parseYamlDocument('token: "TOP_SECRET\n');
    expect(result).toMatchObject({ status: 'invalid', diagnostic: { code: 'invalid-yaml' } });
    expect(JSON.stringify(result)).not.toMatch(/TOP_SECRET|token|message|stack/);
  });

  it('allows ordinary aliases but bounds alias expansion', () => {
    expect(parseYamlDocument('a: &a [one, two]\nb: *a\n')).toEqual({
      status: 'valid',
      data: { a: ['one', 'two'], b: ['one', 'two'] },
    });
    const expansion =
      'a: &a [1, 2]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\nd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]\n';
    expect(parseYamlDocument(expansion)).toEqual({
      status: 'invalid',
      diagnostic: { code: 'invalid-yaml' },
    });
  });
});

describe('shared TOML parser', () => {
  it('preserves complete role instructions, ordered config selectors and policy', () => {
    const text =
      'developer_instructions="""\nfirst\nlast Ж\n"""\n[[skills.config]]\nname="one"\nenabled=false\n[[skills.config]]\npath="/tmp/skill/SKILL.md"\nenabled=true\n[policy]\nallow_implicit_invocation=false\n';
    expect(parseTomlDocument(text)).toEqual({
      status: 'valid',
      data: {
        developer_instructions: 'first\nlast Ж\n',
        skills: {
          config: [
            { name: 'one', enabled: false },
            { path: '/tmp/skill/SKILL.md', enabled: true },
          ],
        },
        policy: { allow_implicit_invocation: false },
      },
    });
  });

  it('preserves literal multiline strings, string booleans and large integers', () => {
    expect(
      parseTomlDocument(
        "developer_instructions='''\nfirst\nsecond\n'''\nenabled=\"false\"\nlarge=9223372036854775807\n",
      ),
    ).toEqual({
      status: 'valid',
      data: {
        developer_instructions: 'first\nsecond\n',
        enabled: 'false',
        large: 9223372036854775807n,
      },
    });
  });

  it('rejects duplicate and malformed values with private diagnostics', () => {
    for (const text of ['token="TOP_SECRET"\ntoken="PRIVATE_TOKEN"\n', 'token=["TOP_SECRET"\n']) {
      const result = parseTomlDocument(text);
      expect(result).toMatchObject({ status: 'invalid', diagnostic: { code: 'invalid-toml' } });
      expect(JSON.stringify(result)).not.toMatch(
        /TOP_SECRET|PRIVATE_TOKEN|token|message|codeblock|stack/,
      );
      if (result.status === 'invalid') {
        expect(result.diagnostic.line).toBeGreaterThan(0);
        expect(result.diagnostic.column).toBeGreaterThan(0);
      }
    }
  });

  it('rejects unsafe object keys and excessive inline nesting', () => {
    expect(parseTomlDocument('__proto__.polluted=true')).toMatchObject({
      status: 'invalid',
      diagnostic: { code: 'invalid-toml' },
    });
    expect(parseTomlDocument('value=' + '['.repeat(101) + '1' + ']'.repeat(101))).toMatchObject({
      status: 'invalid',
      diagnostic: { code: 'invalid-toml' },
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('Markdown frontmatter', () => {
  it('accepts BOM and CRLF and excludes body metadata', () => {
    expect(
      parseMarkdownFrontmatter(
        '\ufeff---\r\ndescription: Header\r\n---\r\ndescription: TOP_SECRET\r\nname: body\r\n',
      ),
    ).toEqual({ status: 'valid', data: { description: 'Header' } });
  });

  it.each([
    '# body\n---\nname: body',
    '  ---\ndescription: indented\n---\n',
    '--- not a delimiter\n',
  ])('distinguishes missing initial header: %j', (text) => {
    expect(parseMarkdownFrontmatter(text)).toEqual({ status: 'missing' });
  });

  it.each(['---\ndescription: unfinished', '---\ndescription: header\n  ---\n', '---\n---\nbody'])(
    'rejects an unclosed or non-mapping header: %j',
    (text) => {
      expect(parseMarkdownFrontmatter(text)).toMatchObject({
        status: 'invalid',
        diagnostic: { code: 'invalid-yaml' },
      });
    },
  );

  it('reports YAML positions in the full Markdown document', () => {
    expect(
      parseMarkdownFrontmatter('---\ndescription: one\ndescription: PRIVATE_TOKEN\n---\n'),
    ).toEqual({ status: 'invalid', diagnostic: { code: 'invalid-yaml', line: 3, column: 1 } });
  });
});

describe('bounded UTF-8 metadata readers', () => {
  it('accepts a whole SKILL.md at the inclusive 65536-byte boundary', async () => {
    const text = skillBytes(65536);
    expect(Buffer.byteLength(text, 'utf8')).toBe(65536);
    expect(text.length).toBeLessThan(65536);
    expect(await readMarkdownFrontmatter(await put(text))).toEqual({
      status: 'valid',
      data: { description: 'Valid description' },
    });
  });

  it('rejects 65537 bytes even with a short valid header', async () => {
    expect(await readMarkdownFrontmatter(await put(skillBytes(65537)))).toEqual({
      status: 'invalid',
      diagnostic: { code: 'file-too-large' },
    });
  });

  it('rejects malformed UTF-8 even when the invalid byte is in the body', async () => {
    const file = await put(
      Buffer.concat([Buffer.from('---\ndescription: Header\n---\n'), Buffer.from([0xc3, 0x28])]),
    );
    expect(await readMarkdownFrontmatter(file)).toEqual({
      status: 'invalid',
      diagnostic: { code: 'invalid-utf8' },
    });
  });

  it('decodes valid BOM/Unicode through the file reader', async () => {
    expect(
      await readMarkdownFrontmatter(await put('\ufeff---\r\ndescription: Описание Ж\r\n---\r\n')),
    ).toEqual({ status: 'valid', data: { description: 'Описание Ж' } });
  });

  it('returns missing for a readable command without frontmatter', async () => {
    expect(await readMarkdownFrontmatter(await put('# Command body\ndescription: body'))).toEqual({
      status: 'missing',
    });
  });

  it('reports an unreadable document without leaking its path', async () => {
    const result = await readMarkdownFrontmatter(path.join(root, 'PRIVATE_TOKEN.md'));
    expect(result).toEqual({ status: 'invalid', diagnostic: { code: 'unreadable' } });
    expect(JSON.stringify(result)).not.toContain(root);
    const directory = path.join(root, 'directory');
    await mkdir(directory);
    expect(await readMarkdownFrontmatter(directory)).toEqual({
      status: 'invalid',
      diagnostic: { code: 'unreadable' },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects real FIFOs in all readers without waiting for a writer',
    async () => {
      const fifo = path.join(root, 'PRIVATE_TOKEN.md');
      const execute = promisify(execFile);
      await execute('mkfifo', [fifo]);
      const moduleUrl = new URL('./frontmatter.ts', import.meta.url).href;
      const code = `
      import { readMarkdownFrontmatter, readYamlDocument, readTomlDocument } from ${JSON.stringify(moduleUrl)};
      const results = await Promise.all([
        readMarkdownFrontmatter(process.argv[1]),
        readYamlDocument(process.argv[1], 65536),
        readTomlDocument(process.argv[1], 65536),
      ]);
      console.log(JSON.stringify(results));
    `;
      // Isolate blocking open() from Vitest's worker; execFile kills/reaps the child on timeout.
      let output: string;
      try {
        const child = await execute(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', code, fifo],
          {
            timeout: 2000,
            killSignal: 'SIGKILL',
          },
        );
        output = child.stdout;
      } catch {
        throw new Error('Metadata reader subprocess failed or timed out while opening a FIFO');
      }
      expect(JSON.parse(output)).toEqual(
        Array.from({ length: 3 }, () => ({
          status: 'invalid',
          diagnostic: { code: 'unreadable' },
        })),
      );
      expect(output).not.toMatch(/PRIVATE_TOKEN|TOP_SECRET/);
    },
  );

  it('allows callers to choose a separate ceiling for YAML policy or role TOML', async () => {
    const yaml = '#'.repeat(70000) + '\npolicy:\n  allow_implicit_invocation: false\n';
    const yamlFile = await put(yaml, 'policy.yaml');
    expect(await readYamlDocument(yamlFile, 80000)).toEqual({
      status: 'valid',
      data: { policy: { allow_implicit_invocation: false } },
    });
    expect(await readYamlDocument(yamlFile, 65536)).toEqual({
      status: 'invalid',
      diagnostic: { code: 'file-too-large' },
    });
    const tomlFile = await put(
      'developer_instructions="""' + 'Ж'.repeat(35000) + '"""\nmodel="native"',
      'role.toml',
    );
    const result = await readTomlDocument(tomlFile, 80000);
    expect(result).toEqual({
      status: 'valid',
      data: { developer_instructions: 'Ж'.repeat(35000), model: 'native' },
    });
    expect(await readTomlDocument(tomlFile, 65536)).toEqual({
      status: 'invalid',
      diagnostic: { code: 'file-too-large' },
    });
  });
});
