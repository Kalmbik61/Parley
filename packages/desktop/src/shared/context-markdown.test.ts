import { describe, expect, it } from 'vitest';
import {
  assemble,
  CONTEXT_LIMITS,
  contextLabel,
  fence,
  fillScreenshot,
  headerUrl,
  isContextKind,
  SCREENSHOT_SLOT,
  viewportNote,
} from './context-markdown.js';
import { S } from './strings.js';

describe('fence (спека 3.6, К3 сравнения с Orca)', () => {
  it('без обратных кавычек — три, info по умолчанию text', () => {
    expect(fence('a\nb')).toBe('```text\na\nb\n```');
  });

  it('Фокус ревью 3: ограда на одну длиннее самой длинной серии внутри — пять кавычек дают шесть', () => {
    const text = 'x ````` y\n```\nz';
    expect(fence(text)).toBe(`\`\`\`\`\`\`text\n${text}\n\`\`\`\`\`\``);
  });

  it('перевод строки в конце не удваивается; info — любой', () => {
    expect(fence('a\n', 'json')).toBe('```json\na\n```');
  });
});

describe('contextLabel', () => {
  it('[a-z0-9._-] в нижнем регистре, серии прочего — один дефис, края без - и .', () => {
    expect(contextLabel('Button.Save')).toBe('button.save');
    expect(contextLabel('POST /api/settings 500')).toBe('post-api-settings-500');
    expect(contextLabel('../../etc/passwd')).toBe('etc-passwd');
    expect(contextLabel('  Привет, мир!  ')).toBe('page');
  });

  it('не длиннее 40 и без дефиса на конце после обрезки; пусто — page', () => {
    expect(contextLabel(`${'a'.repeat(39)}-tail`)).toBe('a'.repeat(39));
    expect(contextLabel('x'.repeat(100))).toHaveLength(CONTEXT_LIMITS.label);
    expect(contextLabel('')).toBe('page');
  });
});

describe('headerUrl', () => {
  it('origin + pathname: без query, hash и user:pass@; битый адрес — пусто', () => {
    expect(headerUrl('http://u:p@localhost:5173/settings?token=1#x')).toBe('http://localhost:5173/settings');
    expect(headerUrl('about:blank')).toBe('about:blank');
    expect(headerUrl('nope')).toBe('');
  });
});

describe('viewportNote', () => {
  it('Fit — null; пресет — его имя; поворот и Custom', () => {
    expect(viewportNote(null)).toBeNull();
    expect(viewportNote(undefined)).toBeNull();
    expect(viewportNote({ preset: 'mobile-m', rotated: false, dpr: 2 })).toBe('Mobile M, emulated');
    expect(viewportNote({ preset: 'laptop', rotated: true, dpr: 1 })).toBe('Laptop, rotated, emulated');
    expect(viewportNote({ width: 500, height: 700, mobile: false, dpr: 1 })).toBe('Custom, emulated');
  });
});

describe('fillScreenshot', () => {
  const md = `# Page element — a\nURL: http://x/\n${S.contextFile.screenshot(SCREENSHOT_SLOT)}\n\nbody ${SCREENSHOT_SLOT}\n`;

  it('путь встаёт только в шапку: слот в данных ниже не тронут', () => {
    expect(fillScreenshot(md, '/h/c/a.png')).toBe(`# Page element — a\nURL: http://x/\nScreenshot: /h/c/a.png\n\nbody ${SCREENSHOT_SLOT}\n`);
  });

  it('без снимка строка уходит; без слота — текст как был', () => {
    expect(fillScreenshot(md, null)).toBe(`# Page element — a\nURL: http://x/\n\nbody ${SCREENSHOT_SLOT}\n`);
    expect(fillScreenshot('# T\n\nx', '/a.png')).toBe('# T\n\nx');
  });
});

describe('assemble', () => {
  it('части через пустую строку, данные — в ограде, в конце перевод строки', () => {
    expect(assemble([{ text: '# T' }, { data: 'a`b' }])).toBe('# T\n\n```text\na`b\n```\n');
  });

  it('больше 256 КБ — режутся данные, текст человека цел, итог в пределе', () => {
    const out = assemble([{ text: '# T' }, { text: 'keep me' }, { data: 'я'.repeat(200_000) }]);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(CONTEXT_LIMITS.markdown);
    expect(out).toContain('keep me');
    expect(out).toContain(S.contextFile.truncated);
  });
});

describe('isContextKind', () => {
  it('пять видов — да, прочее — нет', () => {
    for (const kind of ['element', 'console', 'request', 'errors', 'annotations']) expect(isContextKind(kind), kind).toBe(true);
    for (const value of ['cookie', '', null, 1]) expect(isContextKind(value), String(value)).toBe(false);
  });
});
