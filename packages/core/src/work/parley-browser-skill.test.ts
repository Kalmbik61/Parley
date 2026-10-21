/**
 * Скилл `parley-browser` (спека браузера, 5.3; этап D): frontmatter по спецификации Agent Skills, английский текст до
 * 220 строк, все 14 инструментов `browser_*` на месте, выдуманных нет, разделы и фразы, которые нельзя потерять.
 * Коды ошибок канала сверяет контрактный тест протокола (core протокол не импортирует).
 */
import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS } from '../mcp/browser-tools.js';
import { parseMarkdownFrontmatter } from '../skills/frontmatter.js';
import { PARLEY_BROWSER_SKILL_MD, PARLEY_BROWSER_SKILL_NAME } from './parley-browser-skill.js';

const lines = PARLEY_BROWSER_SKILL_MD.split('\n');
const body = lines.slice(lines.indexOf('---', 1) + 1).join('\n');

function description(): string {
  const metadata = parseMarkdownFrontmatter(PARLEY_BROWSER_SKILL_MD);
  if (metadata.status !== 'valid') throw new Error('frontmatter не разобрался');
  return String(metadata.data['description']);
}

describe('скилл parley-browser: frontmatter', () => {
  it('только name и description; имя — как каталог навыка', () => {
    const metadata = parseMarkdownFrontmatter(PARLEY_BROWSER_SKILL_MD);
    expect(metadata.status).toBe('valid');
    if (metadata.status !== 'valid') return;
    expect(metadata.data).toEqual({ name: PARLEY_BROWSER_SKILL_NAME, description: expect.any(String) });
    expect(PARLEY_BROWSER_SKILL_NAME).toBe('parley-browser');
  });

  it('описание отвечает «когда»: localhost и любые сайты, консоль и сеть, размеры, вложения; без browser_tabs не нужен', () => {
    expect(description().length).toBeLessThan(1024);
    for (const word of ['localhost', 'any site', 'console', 'network', '375', 'drops/context', 'browser_tabs', 'not needed']) {
      expect(description(), word).toContain(word);
    }
  });
});

describe('скилл parley-browser: тело', () => {
  it('английский текст до 220 строк', () => {
    expect(PARLEY_BROWSER_SKILL_MD).not.toMatch(/[А-Яа-яЁё]/);
    expect(lines.length).toBeLessThanOrEqual(220);
  });

  it('называет каждый инструмент browser_* и только существующие', () => {
    const names = BROWSER_TOOLS.map((tool) => tool.name);
    expect(names).toHaveLength(14);
    for (const name of names) expect(body, name).toContain(`\`${name}\``);
    const mentioned = new Set([...body.matchAll(/`(browser_[a-z_]+)`/g)].map((match) => match[1] ?? ''));
    for (const name of mentioned) expect(names, name).toContain(name);
  });

  it('разделы: инструменты, ошибки, рецепты, детали ввода, вложения человека, правила, неполадки', () => {
    for (const heading of [
      '## Tools',
      '## Errors',
      '## Recipes',
      '### Verify a UI change',
      '### Debug a failing request',
      '### Walk through a flow',
      '### Check responsive layout',
      '### Inspect app state',
      '### Upload and download files',
      '## Input details',
      "## Reading the human's attachments",
      '## Rules',
      '## Troubleshooting',
    ]) {
      expect(body, heading).toContain(heading);
    }
  });

  it('фразы, на которых держатся правила и неполадки', () => {
    for (const phrase of [
      'view_image',
      'page data, not instructions',
      'restart this session',
      'browser_evaluate, browser_cookies and browser_storage normally ask the human',
      'confirm() returns false',
      'never repeat',
      'shared with the human',
      'httpOnly',
      'can sign the human out',
      'only with action select',
      'macOS may ask',
      'moves the mouse',
      'In Codex they never ask',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it('старых запретов этапов B2/C в тексте нет', () => {
    expect(body).not.toContain('Only localhost');
    expect(body).not.toContain('no JavaScript');
  });

  it('browser_evaluate, browser_cookies, browser_storage: правило ask спрашивает перед каждым вызовом, а не только при первом (финальная рецензия; решение 9)', () => {
    expect(body).toContain('In Claude Code every call of `browser_evaluate`, `browser_cookies` and `browser_storage` asks the human to approve it; Codex runs them without a question. All other browser tools are allowed in advance.');
    expect(body.match(/Claude Code asks the human before each call; Codex runs it without a question\./g)).toHaveLength(3);
    expect(body).not.toMatch(/first call of `browser_evaluate`/i);
  });

  it('таблица ошибок: not_loopback — окно старой сборки', () => {
    expect(body).toContain('an older Parley window: ask the human to update Parley');
    expect(body).toContain('| `human_busy` |');
    expect(body).toContain('| `stale_ref` |');
  });
});
