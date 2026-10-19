import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustomProviderRecord } from './custom-providers.js';
import {
  LINKED_CLAUDE_ITEMS,
  mirrorProjectTrust,
  prepareCustomProviderDir,
  removeCustomProviderDir,
  syncApiKeyApproval,
  userClaudeConfigDir,
  userClaudeJsonPath,
} from './custom-provider-dir.js';

const record: CustomProviderRecord = {
  id: 'custom-kimi',
  label: 'Kimi',
  preset: 'kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  auth: 'bearer',
  models: { opus: 'k3', sonnet: 'k3', haiku: 'k2', subagent: 'k3' },
  contextWindow: null,
  linkClaude: true,
};

let root: string;
let home: string;
let claudeDir: string;
let dir: string;
const json = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, 'utf8'));
const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );

/** Снимок дерева: путь + тип + sha256 содержимого (ссылки не раскрываются). */
async function snapshot(base: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const name of (await readdir(current)).sort()) {
      const full = path.join(current, name);
      const stat = await lstat(full);
      const rel = path.relative(base, full);
      if (stat.isSymbolicLink()) out.push(`${rel} -> ${await readlink(full)}`);
      else if (stat.isDirectory()) {
        out.push(`${rel}/`);
        await walk(full);
      } else out.push(`${rel} ${createHash('sha256').update(await readFile(full)).digest('hex')}`);
    }
  }
  await walk(base);
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'parley-cpdir-'));
  home = path.join(root, 'parley');
  claudeDir = path.join(root, 'claude');
  dir = path.join(home, 'providers', record.id);
  await mkdir(path.join(claudeDir, 'skills', 'x'), { recursive: true });
  await mkdir(path.join(claudeDir, 'skills', '.trash'), { recursive: true });
  await mkdir(path.join(claudeDir, 'agents'), { recursive: true });
  await writeFile(path.join(claudeDir, 'skills', 'x', 'SKILL.md'), 'skill x');
  await writeFile(path.join(claudeDir, 'skills', '.DS_Store'), 'junk');
  await writeFile(path.join(claudeDir, 'agents', 'a.md'), 'agent a');
  await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'rules');
  await writeFile(path.join(claudeDir, 'settings.json'), '{"secret":true}');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const prepare = (rec: CustomProviderRecord = record): Promise<void> =>
  prepareCustomProviderDir(rec, { claudeConfigDir: claudeDir, home });

describe('пути к настройкам Claude Code человека', () => {
  it('userClaudeConfigDir / userClaudeJsonPath: CLAUDE_CONFIG_DIR или дом', () => {
    expect(LINKED_CLAUDE_ITEMS).toEqual(['CLAUDE.md', 'skills', 'agents']);
    expect(userClaudeConfigDir({}, '/h')).toBe(path.join('/h', '.claude'));
    expect(userClaudeConfigDir({ CLAUDE_CONFIG_DIR: '  /c  ' }, '/h')).toBe('/c');
    expect(userClaudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' }, '/h')).toBe(path.join('/h', '.claude'));
    expect(userClaudeJsonPath({}, '/h')).toBe(path.join('/h', '.claude.json'));
    expect(userClaudeJsonPath({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toBe(path.join('/c', '.claude.json'));
    expect(userClaudeJsonPath({ CLAUDE_CONFIG_DIR: ' ' }, '/h')).toBe(path.join('/h', '.claude.json'));
  });
});

describe('prepareCustomProviderDir', () => {
  it('создаёт папку 0700 и projects/, сеет .claude.json и не перезаписывает существующий', async () => {
    await prepare();
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(dir, 'projects'))).isDirectory()).toBe(true);
    expect(await json(path.join(dir, '.claude.json'))).toEqual({ hasCompletedOnboarding: true });
    await writeFile(
      path.join(dir, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'x', projects: { '/p': { hasTrustDialogAccepted: true } } }),
    );
    await prepare();
    expect(await json(path.join(dir, '.claude.json'))).toEqual({
      hasCompletedOnboarding: true,
      theme: 'x',
      projects: { '/p': { hasTrustDialogAccepted: true } },
    });
  });

  it('посев сливается: чужие поля сохранены, незаданный hasCompletedOnboarding дописан', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'u', mcpServers: { a: {} } }));
    await prepare();
    expect(await json(path.join(dir, '.claude.json'))).toEqual({
      userID: 'u',
      mcpServers: { a: {} },
      hasCompletedOnboarding: true,
    });
  });

  it('битый .claude.json не затирается', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.claude.json'), '{broken');
    await prepare();
    expect(await readFile(path.join(dir, '.claude.json'), 'utf8')).toBe('{broken');
  });

  it('linkClaude: CLAUDE.md — ссылка; skills/ и agents/ — настоящие папки со ссылкой на каждую запись оригинала (спека 5.4, К14)', async () => {
    await prepare();
    expect((await lstat(path.join(dir, 'skills'))).isDirectory()).toBe(true);
    expect((await lstat(path.join(dir, 'skills'))).isSymbolicLink()).toBe(false);
    expect(await readlink(path.join(dir, 'skills', 'x'))).toBe(path.join(claudeDir, 'skills', 'x'));
    expect(await readlink(path.join(dir, 'agents', 'a.md'))).toBe(path.join(claudeDir, 'agents', 'a.md'));
    expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(claudeDir, 'CLAUDE.md'));
    // settings.json не подтягивается.
    expect(await exists(path.join(dir, 'settings.json'))).toBe(false);
  });

  it('записи с точкой (.trash, .DS_Store) не связываются; отсутствующий источник — без ссылки', async () => {
    await rm(path.join(claudeDir, 'CLAUDE.md'));
    await rm(path.join(claudeDir, 'agents'), { recursive: true });
    await prepare();
    expect(await readdir(path.join(dir, 'skills'))).toEqual(['x']);
    expect(await exists(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(await exists(path.join(dir, 'agents'))).toBe(false);
  });

  it('повторный prepare: новый навык оригинала получает ссылку; копия, навык провайдера и ссылка поверх копии', async () => {
    await prepare();
    // копия: ссылку x заменили настоящей папкой
    await rm(path.join(dir, 'skills', 'x'));
    await mkdir(path.join(dir, 'skills', 'x'));
    await writeFile(path.join(dir, 'skills', 'x', 'SKILL.md'), 'my copy');
    // навык, созданный в сессии провайдера
    await mkdir(path.join(dir, 'skills', 'own'));
    await writeFile(path.join(dir, 'skills', 'own', 'SKILL.md'), 'own');
    // новый навык оригинала
    await mkdir(path.join(claudeDir, 'skills', 'y'));
    await prepare();
    expect((await lstat(path.join(dir, 'skills', 'x'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dir, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('my copy');
    expect(await readFile(path.join(dir, 'skills', 'own', 'SKILL.md'), 'utf8')).toBe('own');
    expect(await readlink(path.join(dir, 'skills', 'y'))).toBe(path.join(claudeDir, 'skills', 'y'));
  });

  it('настоящий CLAUDE.md провайдера не заменяется ссылкой', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'CLAUDE.md'), 'mine');
    await prepare();
    expect((await lstat(path.join(dir, 'CLAUDE.md'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('mine');
  });

  it('skills — ссылка или файл: не трогается и не связывается, в журнал идёт предупреждение', async () => {
    await mkdir(dir, { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(dir, 'skills'));
    await writeFile(path.join(dir, 'agents'), 'a file');
    const warnings: string[] = [];
    await prepareCustomProviderDir(record, { claudeConfigDir: claudeDir, home, warn: (m) => warnings.push(m) });
    expect(await readlink(path.join(dir, 'skills'))).toBe(elsewhere);
    expect(await readdir(elsewhere)).toEqual([]);
    expect(await readFile(path.join(dir, 'agents'), 'utf8')).toBe('a file');
    expect(warnings).toHaveLength(2);
  });

  it('linkClaude выключен — ссылки убраны, копии и настоящий CLAUDE.md в папке провайдера не тронуты', async () => {
    await prepare();
    await rm(path.join(dir, 'skills', 'x'));
    await mkdir(path.join(dir, 'skills', 'x'));
    await writeFile(path.join(dir, 'skills', 'x', 'SKILL.md'), 'copy');
    await mkdir(path.join(claudeDir, 'skills', 'y'));
    await prepare(); // y получает ссылку
    await prepare({ ...record, linkClaude: false });
    expect(await exists(path.join(dir, 'skills', 'y'))).toBe(false);
    expect(await exists(path.join(dir, 'agents', 'a.md'))).toBe(false);
    expect(await exists(path.join(dir, 'CLAUDE.md'))).toBe(false);
    expect(await readFile(path.join(dir, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('copy');
    // настоящий CLAUDE.md провайдера
    await writeFile(path.join(dir, 'CLAUDE.md'), 'mine');
    await prepare({ ...record, linkClaude: false });
    expect(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('mine');
  });

  it('Review Focus 5: навык оригинала удалён — висячая ссылка убрана; источник сменился — ссылки переставлены', async () => {
    await prepare();
    await rm(path.join(claudeDir, 'skills', 'x'), { recursive: true });
    await rm(path.join(claudeDir, 'agents', 'a.md'));
    await rm(path.join(claudeDir, 'CLAUDE.md'));
    await prepare();
    expect(await exists(path.join(dir, 'skills', 'x'))).toBe(false);
    expect(await exists(path.join(dir, 'agents', 'a.md'))).toBe(false);
    expect(await exists(path.join(dir, 'CLAUDE.md'))).toBe(false);

    // источник сменился (старый ещё существует)
    await mkdir(path.join(claudeDir, 'skills', 'x'));
    await writeFile(path.join(claudeDir, 'CLAUDE.md'), 'rules');
    await prepare();
    const other = path.join(root, 'claude2');
    await mkdir(path.join(other, 'skills', 'x'), { recursive: true });
    await mkdir(path.join(other, 'skills', 'z'), { recursive: true });
    await writeFile(path.join(other, 'CLAUDE.md'), 'rules2');
    await prepareCustomProviderDir(record, { claudeConfigDir: other, home });
    expect(await readlink(path.join(dir, 'skills', 'x'))).toBe(path.join(other, 'skills', 'x'));
    expect(await readlink(path.join(dir, 'skills', 'z'))).toBe(path.join(other, 'skills', 'z'));
    expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(other, 'CLAUDE.md'));
    // старая ссылка вида «навык оригинала», которого в новом источнике нет, но старый жив, — убрана
    await mkdir(path.join(claudeDir, 'skills', 'old'));
    await prepare();
    expect(await readlink(path.join(dir, 'skills', 'old'))).toBe(path.join(claudeDir, 'skills', 'old'));
    await prepareCustomProviderDir(record, { claudeConfigDir: other, home });
    expect(await exists(path.join(dir, 'skills', 'old'))).toBe(false);
  });

  it('чужая ссылка (не вида «оригинал») в skills/ провайдера не трогается, пока не висячая', async () => {
    await prepare();
    const mine = path.join(root, 'myskill');
    await mkdir(mine);
    await symlink(mine, path.join(dir, 'skills', 'custom-link'));
    await prepare();
    expect(await readlink(path.join(dir, 'skills', 'custom-link'))).toBe(mine);
  });

  it('содержимое claudeDir (пути + sha256) до и после prepare и remove — одинаковое', async () => {
    const before = await snapshot(claudeDir);
    await prepare();
    await prepare();
    await prepare({ ...record, linkClaude: false });
    await prepare();
    expect(await snapshot(claudeDir)).toEqual(before);
    await removeCustomProviderDir(record.id, home);
    expect(await snapshot(claudeDir)).toEqual(before);
  });

  it('неверный id — отказ, ничего не создано', async () => {
    await expect(prepare({ ...record, id: 'custom-../x' })).rejects.toThrow();
    expect(await exists(path.join(home, 'providers'))).toBe(false);
  });
});

describe('prepareCustomProviderDir: параллельные запуски одного провайдера', () => {
  it('3-5 одновременных вызовов не падают, ссылки верные', async () => {
    for (const n of [3, 5]) {
      await rm(dir, { recursive: true, force: true });
      await Promise.all(Array.from({ length: n }, () => prepare()));
      expect(await readlink(path.join(dir, 'CLAUDE.md'))).toBe(path.join(claudeDir, 'CLAUDE.md'));
      expect(await readlink(path.join(dir, 'skills', 'x'))).toBe(path.join(claudeDir, 'skills', 'x'));
      expect(await readlink(path.join(dir, 'agents', 'a.md'))).toBe(path.join(claudeDir, 'agents', 'a.md'));
    }
  });
});

describe('removeCustomProviderDir', () => {
  it('удаляет папку, ссылки удаляются как ссылки (источники целы)', async () => {
    await prepare();
    await writeFile(path.join(dir, 'history.jsonl'), '{}');
    await removeCustomProviderDir(record.id, home);
    expect(await exists(dir)).toBe(false);
    expect(await readFile(path.join(claudeDir, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('skill x');
    expect(await readFile(path.join(claudeDir, 'agents', 'a.md'), 'utf8')).toBe('agent a');
    expect(await readFile(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('rules');
  });

  it('даже ссылка на всю папку внутри провайдера не уводит удаление в источник', async () => {
    await prepare();
    await symlink(claudeDir, path.join(dir, 'whole'));
    await removeCustomProviderDir(record.id, home);
    expect(await exists(dir)).toBe(false);
    expect(await readdir(claudeDir)).toContain('settings.json');
    expect(await readFile(path.join(claudeDir, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('skill x');
  });

  it('несуществующая папка — не ошибка', async () => {
    await expect(removeCustomProviderDir('custom-none', home)).resolves.toBeUndefined();
  });

  it('id без префикса или с ../ — отказ, ничего не удалено', async () => {
    await mkdir(path.join(home, 'providers', 'plain'), { recursive: true });
    await mkdir(path.join(home, 'custom-x'), { recursive: true });
    for (const bad of ['plain', '../custom-x', 'custom-/../..', '', 'custom-a/b', 'custom-../..', '..']) {
      await expect(removeCustomProviderDir(bad, home), bad).rejects.toThrow();
    }
    expect(await exists(path.join(home, 'providers', 'plain'))).toBe(true);
    expect(await exists(path.join(home, 'custom-x'))).toBe(true);
  });
});

describe('mirrorProjectTrust (спека 6.2, К18)', () => {
  const userFile = (): string => path.join(root, 'user.claude.json');

  it('симлинк на файл человека читается по ссылке', async () => {
    const real = path.join(root, 'dotfiles.claude.json');
    await writeFile(real, JSON.stringify({ projects: { '/work/app': { hasTrustDialogAccepted: true } } }));
    await symlink(real, userFile());
    await prepare();
    expect(await mirrorProjectTrust(record.id, '/work/app', { userClaudeJson: userFile(), home })).toBe(true);
    expect(((await json(path.join(dir, '.claude.json')))['projects'] as Record<string, unknown>)['/work/app']).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it('доверие для cwd переносится; прочие поля провайдера сохранены; файл пользователя побайтно прежний', async () => {
    const text = JSON.stringify({ projects: { '/work/app': { hasTrustDialogAccepted: true, allowedTools: [] } } });
    await writeFile(userFile(), text);
    await prepare();
    await writeFile(
      path.join(dir, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, userID: 'u', projects: { '/other': { x: 1 } } }),
    );
    expect(await mirrorProjectTrust(record.id, '/work/app', { userClaudeJson: userFile(), home })).toBe(true);
    expect(await json(path.join(dir, '.claude.json'))).toEqual({
      hasCompletedOnboarding: true,
      userID: 'u',
      projects: { '/other': { x: 1 }, '/work/app': { hasTrustDialogAccepted: true } },
    });
    expect(await readFile(userFile(), 'utf8')).toBe(text);
  });

  it('доверие к родителю действует на вложенную папку; ключ — путь сессии', async () => {
    await writeFile(userFile(), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }));
    await prepare();
    expect(await mirrorProjectTrust(record.id, '/work/app/sub', { userClaudeJson: userFile(), home })).toBe(true);
    expect(((await json(path.join(dir, '.claude.json')))['projects'] as Record<string, unknown>)['/work/app/sub']).toEqual({
      hasTrustDialogAccepted: true,
    });
  });

  it('недоверенная папка, false и соседняя папка — ничего не пишется', async () => {
    await writeFile(
      userFile(),
      JSON.stringify({ projects: { '/work/app': { hasTrustDialogAccepted: false }, '/work/app2': { hasTrustDialogAccepted: true } } }),
    );
    await prepare();
    const before = await readFile(path.join(dir, '.claude.json'), 'utf8');
    expect(await mirrorProjectTrust(record.id, '/work/app', { userClaudeJson: userFile(), home })).toBe(false);
    expect(await mirrorProjectTrust(record.id, '/work/app/x', { userClaudeJson: userFile(), home })).toBe(false);
    expect(await readFile(path.join(dir, '.claude.json'), 'utf8')).toBe(before);
  });

  it('нет или битый файл пользователя — false, ничего не пишется', async () => {
    await prepare();
    const before = await readFile(path.join(dir, '.claude.json'), 'utf8');
    expect(await mirrorProjectTrust(record.id, '/work', { userClaudeJson: path.join(root, 'nope.json'), home })).toBe(false);
    await writeFile(userFile(), '{bad');
    expect(await mirrorProjectTrust(record.id, '/work', { userClaudeJson: userFile(), home })).toBe(false);
    expect(await readFile(path.join(dir, '.claude.json'), 'utf8')).toBe(before);
  });

  it('у провайдера ещё нет .claude.json — создаётся с одним доверием; нет папки — false', async () => {
    await writeFile(userFile(), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }));
    expect(await mirrorProjectTrust(record.id, '/work', { userClaudeJson: userFile(), home })).toBe(false);
    expect(await exists(dir)).toBe(false);
    await mkdir(dir, { recursive: true });
    expect(await mirrorProjectTrust(record.id, '/work', { userClaudeJson: userFile(), home })).toBe(true);
    expect(await json(path.join(dir, '.claude.json'))).toEqual({ projects: { '/work': { hasTrustDialogAccepted: true } } });
  });

  it('уже доверено у провайдера — файл не переписывается', async () => {
    await writeFile(userFile(), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true, k: 1 } } }));
    expect(await mirrorProjectTrust(record.id, '/work', { userClaudeJson: userFile(), home })).toBe(false);
    expect(await json(path.join(dir, '.claude.json'))).toEqual({ projects: { '/work': { hasTrustDialogAccepted: true, k: 1 } } });
  });

  it('после записи не остаётся временных файлов', async () => {
    await writeFile(userFile(), JSON.stringify({ projects: { '/work': { hasTrustDialogAccepted: true } } }));
    await prepare();
    await mirrorProjectTrust(record.id, '/work', { userClaudeJson: userFile(), home });
    expect((await readdir(dir)).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('syncApiKeyApproval (спека 6.2, К17)', () => {
  const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';

  it('ключ -> approved = последние 20 символов, rejected пуст; прочие поля целы', async () => {
    await prepare();
    await syncApiKeyApproval(record.id, KEY, home);
    expect(await json(path.join(dir, '.claude.json'))).toEqual({
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    });
    expect(KEY.slice(-20)).toHaveLength(20);
  });

  it('смена ключа заменяет хвост; короткий ключ — целиком', async () => {
    await prepare();
    await syncApiKeyApproval(record.id, KEY, home);
    await syncApiKeyApproval(record.id, 'short-key', home);
    expect(((await json(path.join(dir, '.claude.json')))['customApiKeyResponses'] as { approved: string[] }).approved).toEqual(['short-key']);
  });

  it('null убирает поле, остальное целое', async () => {
    await prepare();
    await syncApiKeyApproval(record.id, KEY, home);
    await syncApiKeyApproval(record.id, null, home);
    expect(await json(path.join(dir, '.claude.json'))).toEqual({ hasCompletedOnboarding: true });
  });

  it('нет файла и null — ничего не создаётся; ключ без папки — тоже', async () => {
    await syncApiKeyApproval(record.id, null, home);
    expect(await exists(dir)).toBe(false);
    await syncApiKeyApproval(record.id, KEY, home);
    expect(await exists(dir)).toBe(false);
    await mkdir(dir, { recursive: true });
    await syncApiKeyApproval(record.id, null, home);
    expect(await exists(path.join(dir, '.claude.json'))).toBe(false);
  });

  it('хвост ключа не попадает никуда, кроме .claude.json провайдера', async () => {
    await prepare();
    await syncApiKeyApproval(record.id, KEY, home);
    // Рекурсивно, ссылки не раскрываются: ищем в настоящих файлах папки Claude Code человека.
    const walk = async (current: string): Promise<void> => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) expect((await readFile(full)).toString()).not.toContain(KEY.slice(-20));
      }
    };
    await walk(claudeDir);
  });
});
