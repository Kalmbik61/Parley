/**
 * Скилл `parley-browser` (спека браузера, 5.3; этап D): frontmatter по спецификации Agent Skills, английский текст до
 * 220 строк, все 15 инструментов `browser_*` на месте, выдуманных нет, разделы и фразы, которые нельзя потерять.
 * Коды ошибок канала сверяет контрактный тест протокола (core протокол не импортирует).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BROWSER_TOOLS } from '../mcp/browser-tools.js';
import { MIGRATION_REGISTRY } from '../mcp/code-mode/migration-registry.js';
import { originalToolNames } from '../mcp/tools.js';
import { CLASSIC_ROUTING, fixtureRouting, replacementRouting, routeOf } from './code-mode-instructions.js';
import { ROUTING_MANIFEST } from './code-mode-routing-manifest.js';
import { MINIMAL_DEVELOPMENT_SKILL_MD } from './minimal-development.js';
import { RESEARCH_SWARM_SKILL_MD } from './research-swarm-skill.js';
import { SKILL_MD } from './skill.js';
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
    expect(names).toHaveLength(15);
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
      'browser_evaluate, browser_cookies and browser_storage run without a question in Claude Code and Codex alike',
      'confirm() returns false',
      'never repeat',
      'shared with the human',
      'httpOnly',
      'can sign the human out',
      'only with action select',
      'macOS may ask',
      'moves the mouse',
      'Parley allows them in advance',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });

  it('старых запретов этапов B2/C в тексте нет', () => {
    expect(body).not.toContain('Only localhost');
    expect(body).not.toContain('no JavaScript');
  });

  it('browser_evaluate, browser_cookies, browser_storage: разрешены заранее у Claude Code и Codex, правила ask нет (решение владельца 2026-10-21, 5.4)', () => {
    expect(body).toContain('Every browser tool is allowed in advance, `browser_evaluate`, `browser_cookies` and `browser_storage` included: Parley does not ask the human before a call, in Claude Code or in Codex.');
    expect(body.match(/Allowed in advance; use it only when the task needs it\./g)).toHaveLength(3);
    expect(body).not.toMatch(/asks the human (to approve|before each call)/);
    expect(body).not.toMatch(/first call of `browser_evaluate`/i);
  });

  it('таблица ошибок: not_loopback — окно старой сборки', () => {
    expect(body).toContain('an older Parley window: ask the human to update Parley');
    expect(body).toContain('| `human_busy` |');
    expect(body).toContain('| `stale_ref` |');
  });
});

describe('скилл parley-browser и маршруты Code Mode (план T8d1)', () => {
  it('браузер весь прямой, и текст не менялся: пока так, таблица инструментов верна', () => {
    const names = [...new Set([...PARLEY_BROWSER_SKILL_MD.matchAll(/\bbrowser_[a-z_]+\b/g)].map((m) => m[0]))];
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const entry = MIGRATION_REGISTRY.entries.find((e) => e.name === name);
      expect(entry, name).toMatchObject({ cohort: false, removal: `T11-${name}` });
      // Доказан перенос метода браузера: его задача T11 меняет этот текст, сохраняя правила о данных страницы и владении, и снимает этот запрет.
      expect(MIGRATION_REGISTRY.proven, `T11-${name} must route this skill's text`).not.toContain(name);
    }
    expect(createHash('sha256').update(PARLEY_BROWSER_SKILL_MD).digest('hex')).toBe('570ed2ae4628f4f566e136cfcd2cc10b0f21de29dbf9841196fc1e1f0d7414f0');
  });
  it('скилл роя и минимальная разработка байт в байт как были: о роях там уже нейтрально', () => {
    expect(createHash('sha256').update(RESEARCH_SWARM_SKILL_MD).digest('hex')).toBe('9f231160503f0a2929729cd4d2c9b2b3403176762d17b9a2593e7458ace72ad3');
    expect(createHash('sha256').update(MINIMAL_DEVELOPMENT_SKILL_MD).digest('hex')).toBe('2622ed4b2e454801622c232ad465676cc0be737f7356c0a421a8e75eff17cc50');
    expect(RESEARCH_SWARM_SKILL_MD).not.toMatch(/`[a-z_]+` tools?\b|\btools? `[a-z_]+`/);
  });
  it('каждое имя четырёх скиллов определено в каждом наборе запуска, а недоступное накрыто правилом заглушки', () => {
    const agent = { url: 'http://127.0.0.1:1/agent/browser', token: 't' };
    const rows = ROUTING_MANIFEST.filter((row) => ['skill.ts', 'parley-browser-skill.ts', 'research-swarm-skill.ts', 'minimal-development.ts'].includes(row.file.split('/').pop()!));
    expect(rows).toHaveLength(4);
    const universes: [string, Parameters<typeof originalToolNames>[0], number][] = [
      ['full', { sessionId: 's-1', agent }, 49],
      ['short', { sessionId: 's-1', agent, toolProfile: 'short' }, 46],
      ['no channel', { sessionId: 's-1' }, 30],
    ];
    const five = fixtureRouting(['backlog_list', 'get_map', 'list_roles', 'read_guide', 'read_room']);
    const unavailable: Record<string, string[]> = {};
    for (const [label, context, size] of universes) {
      const universe = originalToolNames(context);
      expect(universe, label).toHaveLength(size);
      for (const routing of [CLASSIC_ROUTING, replacementRouting(MIGRATION_REGISTRY), five]) {
        for (const row of rows) for (const name of row.names) {
          const route = routeOf(name, universe, routing);
          expect(['direct', 'migrated', 'unavailable'], name).toContain(route);
          if (route === 'migrated') expect(five.mode === 'replacement' && five.migrated, name).toContain(name);
          if (route === 'unavailable' && !unavailable[label]?.includes(name)) (unavailable[label] ??= []).push(name);
        }
      }
    }
    // Что недоступно, то недоступно по правилу заглушки: без канала нет браузера и создания сессий; у short нет только памяти, которой в скиллах нет.
    expect(unavailable['full']).toBeUndefined();
    expect(unavailable['short']).toBeUndefined();
    expect(unavailable['no channel']!.sort()).toEqual(expect.arrayContaining(['browser_tabs', 'create_session', 'create_swarm']));
    expect(SKILL_MD).toContain('is unavailable here: say so and do not guess');
  });
});
