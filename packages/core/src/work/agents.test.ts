import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentDirs, assertAgent, listAgents } from './agents.js';

let project = '';
let claudeHome = '';

/** Кладёт определение агента: харнесс смотрит только на имя файла. */
async function defineAgent(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${name}.md`), '# роль\n', 'utf8');
}

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
  // Настоящий `~/.claude` в тестах не трогаем ни на чтение, ни на запись:
  // каталог приходит параметром (спецификация 2026-09-08, 5.1).
  claudeHome = await mkdtemp(path.join(tmpdir(), 'harnas-claude-'));
});

afterEach(async () => {
  await Promise.all([project, claudeHome].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agentDirs', () => {
  it('каталог проекта идёт первым, пользовательский — вторым', () => {
    expect(agentDirs(project, claudeHome)).toEqual([
      path.join(project, '.claude', 'agents'),
      path.join(claudeHome, 'agents'),
    ]);
  });
});

describe('listAgents', () => {
  it('собирает имена из обоих каталогов, без расширения и по алфавиту', async () => {
    const [projectDir, homeDir] = agentDirs(project, claudeHome) as [string, string];
    await defineAgent(projectDir, 'reviewer');
    await defineAgent(homeDir, 'planner');
    // Не `.md` — не определение агента.
    await writeFile(path.join(projectDir, 'README.txt'), 'x', 'utf8');

    expect(await listAgents(agentDirs(project, claudeHome))).toEqual(['planner', 'reviewer']);
  });

  it('одно имя в обоих каталогах — одна запись; каталогов нет — пусто', async () => {
    const [projectDir, homeDir] = agentDirs(project, claudeHome) as [string, string];
    await defineAgent(projectDir, 'reviewer');
    await defineAgent(homeDir, 'reviewer');

    expect(await listAgents(agentDirs(project, claudeHome))).toEqual(['reviewer']);
    expect(await listAgents(agentDirs(path.join(project, 'нет'), claudeHome))).toEqual(['reviewer']);
  });
});

describe('assertAgent', () => {
  it('определение в проекте и в пользовательском каталоге принимается', async () => {
    const [projectDir, homeDir] = agentDirs(project, claudeHome) as [string, string];
    await defineAgent(projectDir, 'reviewer');
    await defineAgent(homeDir, 'planner');

    await expect(assertAgent('reviewer', agentDirs(project, claudeHome))).resolves.toBeUndefined();
    await expect(assertAgent('planner', agentDirs(project, claudeHome))).resolves.toBeUndefined();
  });

  it('определения нет — ошибка с перечнем имён из обоих каталогов', async () => {
    const [projectDir, homeDir] = agentDirs(project, claudeHome) as [string, string];
    await defineAgent(projectDir, 'reviewer');
    await defineAgent(homeDir, 'planner');

    await expect(assertAgent('backend', agentDirs(project, claudeHome))).rejects.toThrow(
      /агента backend нет; найдены: planner, reviewer/,
    );
  });

  it('ни одного определения — ошибка называет оба каталога', async () => {
    await expect(assertAgent('backend', agentDirs(project, claudeHome))).rejects.toThrow(
      /\.claude\/agents\/ проекта/,
    );
  });

  it('имя с путём или пробелом — ошибка до похода на диск', async () => {
    await expect(assertAgent('../ключи', agentDirs(project, claudeHome))).rejects.toThrow(/имя/);
    await expect(assertAgent('два слова', agentDirs(project, claudeHome))).rejects.toThrow(/имя/);
  });
});
