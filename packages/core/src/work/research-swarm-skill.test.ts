/**
 * Скилл `research-swarm` (спека роя v1, этап 3): frontmatter по спецификации Agent Skills, английский текст до 220 строк,
 * инструменты роя и Parley — только существующие, свойства инструментов — из их схем, коды отказов — из спеки роя.
 */
import { describe, expect, it } from 'vitest';
import { CREATE_SWARM_TOOL, SWARM_ADD_TOOL } from '../mcp/swarm-tools.js';
import { TOOLS } from '../mcp/tools.js';
import { parseMarkdownFrontmatter } from '../skills/frontmatter.js';
import { RESEARCH_SWARM_SKILL_MD, RESEARCH_SWARM_SKILL_NAME } from './research-swarm-skill.js';

const lines = RESEARCH_SWARM_SKILL_MD.split('\n');
const body = lines.slice(lines.indexOf('---', 1) + 1).join('\n');

function description(): string {
  const metadata = parseMarkdownFrontmatter(RESEARCH_SWARM_SKILL_MD);
  if (metadata.status !== 'valid') throw new Error('frontmatter не разобрался');
  return String(metadata.data['description']);
}

const properties = (tool: typeof CREATE_SWARM_TOOL): string[] => Object.keys(tool.inputSchema.properties ?? {});

describe('скилл research-swarm: frontmatter', () => {
  it('только name и description; имя — как каталог навыка', () => {
    const metadata = parseMarkdownFrontmatter(RESEARCH_SWARM_SKILL_MD);
    expect(metadata.status).toBe('valid');
    if (metadata.status !== 'valid') return;
    expect(metadata.data).toEqual({ name: RESEARCH_SWARM_SKILL_NAME, description: expect.any(String) });
    expect(RESEARCH_SWARM_SKILL_NAME).toBe('research-swarm');
  });

  it('описание отвечает «когда»: create_swarm, королева, срезы, большие задачи; узкий вопрос и код — не нужен', () => {
    expect(description().length).toBeLessThan(1024);
    for (const word of ['create_swarm', 'queen', 'slices', 'whole-repository audit', 'document corpus', 'web research', 'do not need it']) {
      expect(description(), word).toContain(word);
    }
  });
});

describe('скилл research-swarm: тело', () => {
  it('английский текст до 220 строк', () => {
    expect(RESEARCH_SWARM_SKILL_MD).not.toMatch(/[А-Яа-яЁё]/);
    expect(lines.length).toBeLessThanOrEqual(220);
  });

  it('разделы: когда нужен, запуск, план королевы, задача трутня, сбор, проверка, сводка, закрытие, ошибки, правила', () => {
    for (const heading of [
      '## When a swarm pays off',
      '## Starting a swarm',
      "## The queen's plan",
      '## Drone task',
      '## Collecting hand-ins',
      '## Verification wave',
      '## Summary',
      '## Closing',
      '## Errors',
      '## Rules',
    ]) {
      expect(body, heading).toContain(heading);
    }
  });

  it('называет только существующие инструменты Parley', () => {
    const known = new Set([...TOOLS, CREATE_SWARM_TOOL, SWARM_ADD_TOOL].map((tool) => tool.name));
    for (const name of ['create_swarm', 'swarm_add', 'report', 'wait_for', 'get_map', 'list_roles']) {
      expect(known, name).toContain(name);
      expect(body, name).toContain(`\`${name}\``);
    }
  });

  it('свойства create_swarm и swarm_add — из их схем', () => {
    for (const property of properties(CREATE_SWARM_TOOL)) expect(body, `create_swarm.${property}`).toContain(`\`${property}\``);
    for (const property of properties(SWARM_ADD_TOOL)) expect(body, `swarm_add.${property}`).toContain(`\`${property}\``);
  });

  it('коды отказов роя и общего бюджета', () => {
    for (const code of ['not-queen', 'swarm-closed', 'swarm-member', 'swarm-sessions', 'swarm-concurrent', 'swarms', 'swarm-total', 'resource-budget']) {
      expect(body, code).toContain(`\`${code}\``);
    }
  });

  it('фразы, на которых держится метод', () => {
    for (const phrase of [
      'Facts only with a source',
      'path:line',
      'COVERAGE: covered | partial | failed',
      'PASS, FAIL',
      'NOT VERIFIED',
      'not its author',
      'Read the hand-in, not the transcript',
      '"Nothing found" proves nothing',
      'Only the human cancels a swarm',
      'All members of swarm sw-NN have handed in',
      'pilot 1',
      'When in doubt, answer with one agent',
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });
});
