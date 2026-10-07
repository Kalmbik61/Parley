import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('берёт name и description из шапки', () => {
    expect(parseFrontmatter('---\nname: review\ndescription: Check a diff\n---\nтело')).toEqual({
      name: 'review',
      description: 'Check a diff',
    });
  });

  it('снимает кавычки со значений', () => {
    expect(parseFrontmatter('---\nname: "a"\ndescription: \'b: c\'\n---\n')).toEqual({ name: 'a', description: 'b: c' });
  });

  it('многострочное значение (> и |) — полный YAML текст', () => {
    expect(parseFrontmatter('---\ndescription: >\n  первая\n  вторая\nname: x\n---\n')).toEqual({
      name: 'x',
      description: 'первая вторая\n',
    });
    expect(parseFrontmatter('---\ndescription: |\n  one\n  two\n---\n').description).toBe('one\ntwo\n');
  });

  it('без шапки или без закрытия — оба null; ключи после --- не читаются', () => {
    expect(parseFrontmatter('# просто текст\nname: x')).toEqual({ name: null, description: null });
    expect(parseFrontmatter('---\nname: a\n---\nname: b\ndescription: c').description).toBeNull();
  });

  it('rejects duplicate keys, unterminated headers and nonstring metadata without coercion', () => {
    expect(parseFrontmatter('---\nname: a\nname: b\n---\n')).toEqual({ name: null, description: null });
    expect(parseFrontmatter('---\nname: a\n')).toEqual({ name: null, description: null });
    expect(parseFrontmatter('---\nname: 123\ndescription: false\n---\n')).toEqual({ name: null, description: null });
    expect(parseFrontmatter('\uFEFF---\r\nname: x\r\ndescription: "escaped \\"text\\""\r\n---\r\n')).toEqual({ name: 'x', description: 'escaped "text"' });
  });

  it('does not discard a closed header when the body is cut inside a UTF-8 scalar', () => {
    const header = '---\nname: helper\ndescription: Helps\n---\n';
    expect(parseFrontmatter(header + 'a'.repeat(4096 - Buffer.byteLength(header) - 1) + 'Ж')).toEqual({ name: 'helper', description: 'Helps' });
  });

  it('читает не больше первых 4 КБ', () => {
    const text = `---\n${'x: 1\n'.repeat(1000)}description: поздно\n---\n`;
    expect(parseFrontmatter(text).description).toBeNull();
  });
});
