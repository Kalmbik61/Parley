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

  it('многострочное значение (> и |) — первая строка', () => {
    expect(parseFrontmatter('---\ndescription: >\n  первая\n  вторая\nname: x\n---\n')).toEqual({
      name: 'x',
      description: 'первая',
    });
    expect(parseFrontmatter('---\ndescription: |\n  one\n  two\n---\n').description).toBe('one');
  });

  it('без шапки или без закрытия — оба null; ключи после --- не читаются', () => {
    expect(parseFrontmatter('# просто текст\nname: x')).toEqual({ name: null, description: null });
    expect(parseFrontmatter('---\nname: a\n---\nname: b\ndescription: c').description).toBeNull();
  });

  it('читает не больше первых 4 КБ', () => {
    const text = `---\n${'x: 1\n'.repeat(1000)}description: поздно\n---\n`;
    expect(parseFrontmatter(text).description).toBeNull();
  });
});
