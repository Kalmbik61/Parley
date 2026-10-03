import { mkdtemp, rm, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig } from '@parley/core';
import type { SkillInstallOptions, SkillInstallResult } from '@parley/core';
import type { EventData, EventName, SessionRef } from '@parley/protocol';
import type { HostContext } from '../context.js';
import { createSkillInstaller } from './agent-skills.js';

let home = '';
let broadcasts: Array<{ event: EventName; data: unknown }> = [];
let logs: Array<{ level: string; msg: string; data?: object | undefined }> = [];
let savedHome: string | undefined;
let savedFlag: string | undefined;

const PROJECT = '/проекты/магазин';
const REF: SessionRef = { projectPath: PROJECT, workId: 'w-0001', sessionId: 's-01' };

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'parley-agent-skills-'));
  savedHome = process.env['PARLEY_HOME'];
  savedFlag = process.env['PARLEY_AGENT_SKILLS'];
  process.env['PARLEY_HOME'] = home;
  delete process.env['PARLEY_AGENT_SKILLS'];
  broadcasts = [];
  logs = [];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = savedHome;
  if (savedFlag === undefined) delete process.env['PARLEY_AGENT_SKILLS'];
  else process.env['PARLEY_AGENT_SKILLS'] = savedFlag;
  await rm(home, { recursive: true, force: true });
});

/** Минимальный `HostContext`: установщику нужны только `log` и `broadcast`. */
function fakeHost(): HostContext {
  const log = (level: string) => (msg: string, data?: object) => {
    logs.push({ level, msg, data });
  };
  return {
    version: '0.0.0',
    startedAt: new Date().toISOString(),
    paths: { dir: '', socket: '', token: '', pid: '', log: '' },
    log: { info: log('info'), warn: log('warn'), error: log('error') },
    clients: () => [],
    liveSessions: () => 0,
    broadcast: (event, data) => broadcasts.push({ event, data: data as EventData<EventName> }),
    onShutdown: () => {},
    shutdown: async () => {},
    busy: () => {},
  };
}

/** Подставной core: что вернуть и с чем его позвали. */
function fakeInstall(result: Partial<SkillInstallResult> = {}) {
  const calls: SkillInstallOptions[] = [];
  const install = async (options: SkillInstallOptions): Promise<SkillInstallResult> => {
    calls.push(options);
    return { skipped: [], written: [], removed: [], ...result };
  };
  return { calls, install };
}

const notices = (): unknown[] =>
  broadcasts.filter((item) => item.event === 'host.notice').map((item) => item.data);

describe('установщик скилла: настройка agentSkills', () => {
  it('по умолчанию включена: core зовут с проектом сессии, без worktree ключа нет', async () => {
    const { calls, install } = fakeInstall();

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(calls).toEqual([{ projectPath: PROJECT }]);
  });

  it('worktree сессии уходит в core вторым корнем', async () => {
    const { calls, install } = fakeInstall();
    const worktree = '/worktrees/магазин-a1b2c3/w-0001-s-01';

    await createSkillInstaller(fakeHost(), install)(REF, worktree);

    expect(calls).toEqual([{ projectPath: PROJECT, worktreePath: worktree }]);
  });

  it('выключена в config.json — не делается ничего: core не зовут, в лог и окно ничего не идёт', async () => {
    await saveConfig({ agentSkills: false });
    const { calls, install } = fakeInstall({ written: ['/x'] });

    await createSkillInstaller(fakeHost(), install)(REF, '/worktrees/w');

    expect(calls).toEqual([]);
    expect(logs).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('выключена переменной PARLEY_AGENT_SKILLS=0 — она перекрывает файл', async () => {
    await saveConfig({ agentSkills: true });
    process.env['PARLEY_AGENT_SKILLS'] = '0';
    const { calls, install } = fakeInstall();

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(calls).toEqual([]);
  });

  it('настройку читают при каждом запуске: включили обратно — следующий запуск ставит', async () => {
    const { calls, install } = fakeInstall();
    const installer = createSkillInstaller(fakeHost(), install);

    await saveConfig({ agentSkills: false });
    await installer(REF, null);
    await saveConfig({ agentSkills: true });
    await installer(REF, null);

    expect(calls).toHaveLength(1);
  });
});

describe('установщик скилла: что не тронуто', () => {
  it('чужой путь в проекте: строка в host.log и одно host.notice без сессии', async () => {
    const skipped = [{ path: `${PROJECT}/.agents/skills/parley`, reason: 'foreign' as const }];
    const { install } = fakeInstall({ skipped });

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(logs.filter((item) => item.level === 'warn')).toHaveLength(1);
    expect(logs[0]?.data).toMatchObject({ path: skipped[0]?.path, reason: 'foreign' });
    expect(notices()).toEqual([
      {
        kind: 'skill-foreign',
        ref: null,
        text: `Agent skill was not installed: the path already exists and was not created by Parley — left as is: ${skipped[0]?.path}`,
        at: expect.any(String),
      },
    ]);
  });

  it('тот же путь при следующих запусках больше не шумит: ни в логе, ни в окне', async () => {
    const skipped = [{ path: `${PROJECT}/.agents/skills/parley`, reason: 'foreign' as const }];
    const { install } = fakeInstall({ skipped });
    const installer = createSkillInstaller(fakeHost(), install);

    await installer(REF, null);
    await installer(REF, null);
    await installer({ ...REF, sessionId: 's-02' }, null);

    expect(logs.filter((item) => item.level === 'warn')).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it('небезопасный путь (симлинк по дороге) — тоже в окно: скилла в проекте не будет', async () => {
    const { install } = fakeInstall({
      skipped: [{ path: `${PROJECT}/.claude/skills/parley`, reason: 'unsafe' }],
    });

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(notices()).toMatchObject([
      {
        text: `Agent skill was not installed: a symlink or a file stands in place of a directory on the way to the path: ${PROJECT}/.claude/skills/parley`,
      },
    ]);
  });

  it('правка человека — только в лог: он сделал её сам, окну сообщать нечего', async () => {
    const { install } = fakeInstall({
      skipped: [{ path: `${PROJECT}/.agents/skills/parley`, reason: 'edited' }],
    });

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(logs.filter((item) => item.level === 'warn')).toHaveLength(1);
    expect(logs[0]?.msg).toBe('Agent skill was not updated: the file was edited by hand — left as is');
    expect(notices()).toEqual([]);
  });

  it('чужое только в worktree (копия из репозитория) — в лог, но окну не про проект', async () => {
    const worktree = '/worktrees/магазин-a1b2c3/w-0001-s-01';
    const { install } = fakeInstall({
      skipped: [{ path: `${worktree}/.agents/skills/parley`, reason: 'foreign' }],
    });

    await createSkillInstaller(fakeHost(), install)(REF, worktree);

    expect(logs.filter((item) => item.level === 'warn')).toHaveLength(1);
    expect(notices()).toEqual([]);
  });

  it('поставленное — строкой info с путями, без уведомления окну', async () => {
    const { install } = fakeInstall({ written: [`${PROJECT}/.agents/skills/parley`] });

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(logs).toEqual([
      {
        level: 'info',
        msg: 'Agent skills installed or updated',
        data: { ref: REF, paths: [`${PROJECT}/.agents/skills/parley`] },
      },
    ]);
    expect(notices()).toEqual([]);
  });
});

describe('установщик скилла: прежняя установка под именем harnas', () => {
  it('убранное — строкой info с путями, без уведомления окну', async () => {
    const removed = [`${PROJECT}/.claude/skills/harnas`, `${PROJECT}/.agents/skills/harnas`];
    const { install } = fakeInstall({ removed });

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(logs).toEqual([
      { level: 'info', msg: 'прежний скилл harnas убран', data: { ref: REF, paths: removed } },
    ]);
    expect(notices()).toEqual([]);
  });

  it('ничего не убрано — строки про прежнее нет', async () => {
    const { install } = fakeInstall({ written: [`${PROJECT}/.agents/skills/parley`] });

    await createSkillInstaller(fakeHost(), install)(REF, null);

    expect(logs.map((item) => item.msg)).toEqual(['Agent skills installed or updated']);
  });
});

describe('установщик скилла: сбой не останавливает запуск', () => {
  it('исключение core уходит в host.log как error, вызов не бросает, окну ничего не шлётся', async () => {
    const failing = async (): Promise<SkillInstallResult> => {
      throw new Error('диск полон');
    };

    await expect(createSkillInstaller(fakeHost(), failing)(REF, null)).resolves.toBeUndefined();

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'error', data: { error: 'Error: диск полон' } });
    expect(notices()).toEqual([]);
  });
});

import { installAgentSkill as installNativeAssets } from '../../../core/src/work/skill-install.js';

it('the existing start/resume installer delivers both builtins to project/worktree and is idempotent', async () => {
  const project = path.join(home, 'project'); const worktree = path.join(home, 'worktree');
  await Promise.all([mkdir(project), mkdir(worktree)]);
  const installer = createSkillInstaller(fakeHost(), installNativeAssets);
  const ref = { ...REF, projectPath: project };
  await installer(ref, worktree);
  for (const root of [project, worktree]) {
    expect(await readdir(path.join(root, '.agents/skills'))).toEqual(['minimal-development', 'parley']);
    expect(await readFile(path.join(root, '.claude/skills/minimal-development/LICENSE'), 'utf8')).toContain('Copyright (c) 2026 DietrichGebert');
  }
  const body = path.join(worktree, '.agents/skills/minimal-development/SKILL.md');
  const modified = (await stat(body)).mtimeMs;
  await installer({ ...ref, sessionId: 's-02' }, worktree);
  expect((await stat(body)).mtimeMs).toBe(modified);
  expect(logs.filter(item => item.level === 'info')).toHaveLength(1);
});

it.each(['config', 'environment'])('disabled native delivery (%s) writes neither builtin nor receipts in either root', async source => {
  const project = path.join(home, 'off-project'); const worktree = path.join(home, 'off-worktree');
  await Promise.all([mkdir(project), mkdir(worktree)]);
  if (source === 'config') await saveConfig({ agentSkills: false });
  else process.env['PARLEY_AGENT_SKILLS'] = '0';
  await createSkillInstaller(fakeHost(), installNativeAssets)({ ...REF, projectPath: project }, worktree);
  expect(await readdir(project)).toEqual([]); expect(await readdir(worktree)).toEqual([]);
  expect(logs).toEqual([]); expect(broadcasts).toEqual([]);
});
