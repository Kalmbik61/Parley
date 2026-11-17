import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNewSession, createPendingSession } from './launch.js';
import { addSession, removeSession } from './map.js';
import {
  appendTrialLedger,
  parseTrialLedger,
  readTrialLedger,
  trialLedgerFile,
  unresolvedIntents,
  withTrialAssignment,
  type TrialLedgerLine,
} from './trial-ledger.js';
import {
  createWork,
  deleteWorkFiles,
  listWorkVersions,
  pruneWorksIndex,
  readMap,
  updateMap,
  workIdentity,
  workPaths,
} from './store.js';
import type { SessionTrial } from './types.js';

let root: string;
let home: string;
let project: string;
let previous: string | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp('/private/tmp/parley-trial-ledger-'));
  home = path.join(root, 'home');
  project = path.join(root, 'project');
  await mkdir(home);
  await mkdir(project);
  previous = process.env['PARLEY_HOME'];
  process.env['PARLEY_HOME'] = home;
});

afterEach(async () => {
  if (previous === undefined) delete process.env['PARLEY_HOME'];
  else process.env['PARLEY_HOME'] = previous;
  await rm(root, { recursive: true, force: true });
});

const TAG = '0123456789abcdef0123456789abcdef';
const trial = (tag = TAG): SessionTrial => ({ name: 'exp-a', arm: 'packet', at: '2026-11-17T10:00:00.000Z', tag });
const ledger = (name = 'exp-a') => readTrialLedger(name, home);
const lines = (name = 'exp-a') => ledger(name)?.lines ?? [];
const kinds = () => lines().map((line) => line.kind);
const warnings: string[] = [];
const options = () => ({ home, warn: (message: string) => void warnings.push(message) });
beforeEach(() => { warnings.length = 0; });

/** Все метки назначений во всех картах дома: по ним проверяется, что прежние назначения не пережили работу. */
async function tagsInMaps(): Promise<string[]> {
  const tags: string[] = [];
  for (const work of listWorkVersions()) {
    for (const session of (await readMap(work.projectPath, work.id)).sessions) {
      if (session.trial !== undefined && 'tag' in session.trial) tags.push(session.trial.tag);
    }
  }
  return tags;
}

describe('список назначений: протокол записи (Э-1б, критерий 4)', () => {
  it('намерение сброшено на диск до записи карты, подтверждение — после; в подтверждении метка, проект, работа, номер создания и сессия', async () => {
    const map = await createWork(project, { title: 'W' });
    let seenAtCommit: TrialLedgerLine[] = [];
    const created = await createNewSession(project, map.work.id, trial(), {
      ...options(),
      append: (name, line, dir) => {
        if (line.kind === 'confirm') seenAtCommit = lines();
        appendTrialLedger(name, line, dir);
      },
    });
    // К моменту подтверждения намерение уже на диске и стоит первым; карта уже записана.
    expect(seenAtCommit.map((line) => line.kind)).toEqual(['intent']);
    expect(kinds()).toEqual(['intent', 'confirm']);
    expect(lines()[0]).toEqual({ kind: 'intent', tag: TAG, name: 'exp-a', arm: 'packet', at: '2026-11-17T10:00:00.000Z' });
    expect(lines()[1]).toMatchObject({
      kind: 'confirm', tag: TAG, projectPath: project, workId: map.work.id, sessionId: created.session.id,
      incarnation: workIdentity(project, map.work.id)!.incarnation,
    });
    expect((await readMap(project, map.work.id)).sessions[0]?.trial).toEqual(trial());
    expect(warnings).toEqual([]);
    expect(statSync(trialLedgerFile('exp-a', home)).mode & 0o777).toBe(0o600);
  });

  it('намерение пишется прямо перед записью карты: на момент записи карты оно уже есть, а до неё карты с сессией нет', async () => {
    const map = await createWork(project, { title: 'W' });
    const at: { intents: number; sessions: number }[] = [];
    await createPendingSession(project, map.work.id, { provider: 'claude', label: 'x', task: 't', trial: trial() }, (current) => {
      // Мутатор карты идёт внутри записи: намерение к этому моменту уже на диске.
      at.push({ intents: lines().filter((line) => line.kind === 'intent').length, sessions: current.sessions.length });
    }, options());
    expect(at).toEqual([{ intents: 1, sessions: 1 }]);
    expect(kinds()).toEqual(['intent', 'confirm']);
  });

  it('сбой записи намерения: сессия создаётся без плеча, предупреждение есть, ни отмены, ни подтверждения нет', async () => {
    const map = await createWork(project, { title: 'W' });
    // Вместо каталога `trials` — файл: дозапись невозможна.
    writeFileSync(path.join(home, 'trials'), 'not a directory');
    const created = await createNewSession(project, map.work.id, trial(), options());
    expect(created.session).not.toHaveProperty('trial');
    expect((await readMap(project, map.work.id)).sessions[0]).not.toHaveProperty('trial');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('intent');
    expect(existsSync(path.join(home, 'trials', 'exp-a.jsonl'))).toBe(false);
  });

  it('сбой записи карты (отказ внутри записи): строка отмены с той же меткой, сессии в карте нет, ошибка не проглочена', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(createPendingSession(project, map.work.id, { provider: 'claude', label: 'x', task: 't', trial: trial() }, () => {
      throw new Error('admission refused');
    }, options())).rejects.toThrow('admission refused');
    expect(lines()).toMatchObject([{ kind: 'intent', tag: TAG }, { kind: 'cancel', tag: TAG }]);
    expect((await readMap(project, map.work.id)).sessions).toEqual([]);
    expect(unresolvedIntents(lines())).toEqual([]);
  });

  it('обрыв между намерением и записью карты: намерение остаётся без пары и читается как потерянная сессия', async () => {
    const map = await createWork(project, { title: 'W' });
    // Процесс умер сразу после намерения: дозапись отмены и записи карты не случилось.
    appendTrialLedger('exp-a', { kind: 'intent', tag: TAG, name: 'exp-a', arm: 'packet', at: '2026-11-17T10:00:00.000Z' }, home);
    const open = unresolvedIntents(lines());
    expect(open).toHaveLength(1);
    expect(open[0]?.intent.tag).toBe(TAG);
    expect(open[0]).not.toHaveProperty('confirm');
    // Метки нет ни в одной карте и ни в одном следе: подсчёт назовёт её потерянной.
    expect(await tagsInMaps()).not.toContain(TAG);
    expect((await readMap(project, map.work.id)).work.trialTrace).toBeUndefined();
  });

  it('сбой записи карты и сбой самой отмены: намерение остаётся открытым, предупреждение есть, исходная ошибка пробрасывается', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(createPendingSession(project, map.work.id, { provider: 'claude', label: 'x', task: 't', trial: trial() }, () => {
      throw new Error('admission refused');
    }, {
      ...options(),
      append: (name, line, dir) => {
        if (line.kind === 'cancel') throw new Error('disk gone');
        appendTrialLedger(name, line, dir);
      },
    })).rejects.toThrow('admission refused');
    expect(kinds()).toEqual(['intent']);
    expect(warnings.join('\n')).toContain('cancel');
  });

  it('сбой подтверждения не отменяет плечо: сессия остаётся в опыте с назначением, есть предупреждение', async () => {
    const map = await createWork(project, { title: 'W' });
    const created = await createNewSession(project, map.work.id, trial(), {
      ...options(),
      append: (name, line, dir) => {
        if (line.kind === 'confirm') throw new Error('disk gone');
        appendTrialLedger(name, line, dir);
      },
    });
    expect(created.session.trial).toEqual(trial());
    expect((await readMap(project, map.work.id)).sessions[0]?.trial).toEqual(trial());
    expect(kinds()).toEqual(['intent']);
    expect(warnings.join('\n')).toContain('confirm');
    // Метка найдена в карте: намерение без подтверждения не делает сессию потерянной.
    expect(await tagsInMaps()).toContain(TAG);
  });

  it('без назначения каталога trials нет и протокол ничего не пишет — на обоих путях создания', async () => {
    const map = await createWork(project, { title: 'W' });
    await createNewSession(project, map.work.id, undefined, options());
    await createPendingSession(project, map.work.id, { provider: 'claude', label: 'x', task: 't' }, undefined, options());
    expect(existsSync(path.join(home, 'trials'))).toBe(false);
    expect((await readMap(project, map.work.id)).sessions.every((session) => !('trial' in session))).toBe(true);
  });

  it('сбой шага после записи карты (бриф и прочее) отменой не считается: подтверждение стоит, отмены нет', async () => {
    const map = await createWork(project, { title: 'W' });
    // Запись карты проходит, а бриф упасть может: каталог брифов подменён файлом. Протокол видит только запись карты.
    rmSync(workPaths(project, map.work.id).briefs, { recursive: true, force: true });
    writeFileSync(workPaths(project, map.work.id).briefs, 'not a directory');
    await expect(createPendingSession(project, map.work.id, { provider: 'claude', label: 'x', task: 't', trial: trial() }, undefined, options()))
      .rejects.toThrow();
    expect(kinds()).toEqual(['intent', 'confirm']);
    expect(await tagsInMaps()).toEqual([TAG]);
  });

  /** Запись карты фиксируется (сессия с меткой в карте), а исключение летит уже после — как у хранилища после COMMIT. */
  const commitThenThrow = (map: { work: { id: string } }) => async (assigned: SessionTrial | undefined): Promise<never> => {
    await updateMap(project, map.work.id, (current) => {
      addSession(current, { provider: 'claude', label: 'x', task: 't', ...(assigned === undefined ? {} : { trial: assigned }) });
    });
    throw new Error('thrown after the commit');
  };

  it('исключение после состоявшейся фиксации: карта перечитана, метка найдена — подтверждение, а не отмена; ошибка пробрасывается', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(withTrialAssignment(trial(), { projectPath: project, workId: map.work.id }, commitThenThrow(map), () => 's-01', options()))
      .rejects.toThrow('thrown after the commit');
    expect(lines()).toMatchObject([{ kind: 'intent' }, { kind: 'confirm', tag: TAG, workId: map.work.id, sessionId: 's-01' }]);
    expect(kinds()).not.toContain('cancel');
    expect(await tagsInMaps()).toEqual([TAG]);
  });

  it('сбой записи и невозможность перечитать карту: намерение остаётся без пары (ни отмены, ни подтверждения), предупреждение есть', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(withTrialAssignment(trial(), { projectPath: project, workId: map.work.id }, commitThenThrow(map), () => 's-01', {
      ...options(),
      readMap: async () => { throw new Error('database is locked'); },
    })).rejects.toThrow('thrown after the commit');
    expect(kinds()).toEqual(['intent']);
    expect(warnings.join('\n')).toContain('could not be read');
    // Сессия с меткой в карте при этом есть, но протокол этого доказать не смог: итог решает подсчёт по меткам.
    expect(unresolvedIntents(lines())).toHaveLength(1);
  });

  const fails = (commit: (assigned: SessionTrial | undefined) => Promise<never>, workId: string, extra = {}) =>
    withTrialAssignment(trial(), { projectPath: project, workId }, commit, () => 's-01', { ...options(), ...extra });

  it('сессия удалена между ошибкой и перечитыванием: метка есть в следе — подтверждение с номером сессии из следа, отмены нет', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(fails(async (assigned) => {
      await updateMap(project, map.work.id, (current, letters) => {
        addSession(current, { provider: 'claude', label: 'x', task: 't', ...(assigned === undefined ? {} : { trial: assigned }) });
        removeSession(current, letters, 's-01');
      });
      throw new Error('thrown after the commit');
    }, map.work.id)).rejects.toThrow('thrown after the commit');
    expect(lines()).toMatchObject([{ kind: 'intent' }, { kind: 'confirm', tag: TAG, sessionId: 's-01' }]);
  });

  it('работа пересоздана между ошибкой и перечитыванием: отмены нет и подтверждения нет, намерение остаётся без пары', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(fails(async () => {
      await deleteWorkFiles(project, map.work.id);
      await createWork(project, { title: 'W again' });
      throw new Error('boom');
    }, map.work.id)).rejects.toThrow('boom');
    expect(kinds()).toEqual(['intent']);
    expect(warnings.join('\n')).toContain('could not be proven');
  });

  it('работа создаётся этой же операцией, её номера до записи нет: при ошибке ничего не пишется, намерение остаётся без пары', async () => {
    await createWork(project, { title: 'other' });
    // Номер работы, которой ещё нет; операция создаёт её и падает.
    await expect(fails(async () => {
      await createWork(project, { title: 'created by the same operation' });
      throw new Error('boom');
    }, 'w-0002')).rejects.toThrow('boom');
    expect(kinds()).toEqual(['intent']);
  });

  it('следы повреждены: метки нет в записях, но отсутствие не доказано — отмены нет', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(fails(async () => {
      await updateMap(project, map.work.id, (current) => { Object.assign(current.work, { trialTrace: 'garbage' }); });
      throw new Error('boom');
    }, map.work.id)).rejects.toThrow('boom');
    expect(kinds()).toEqual(['intent']);
  });

  it('карта прочитана, метки нет ни в записях, ни в следах, работа прежняя — отмена', async () => {
    const map = await createWork(project, { title: 'W' });
    await expect(fails(async () => { throw new Error('boom'); }, map.work.id)).rejects.toThrow('boom');
    expect(lines()).toMatchObject([{ kind: 'intent' }, { kind: 'cancel', tag: TAG }]);
  });

  it('каталог trials и файл создаются со сбросом на диск: первая строка читается сразу, права файла 0600', () => {
    appendTrialLedger('exp-a', { kind: 'intent', tag: TAG, name: 'exp-a', arm: 'packet', at: '2026-11-17T10:00:00.000Z' }, home);
    expect(readTrialLedger('exp-a', home)?.lines).toHaveLength(1);
    expect(statSync(path.join(home, 'trials')).isDirectory()).toBe(true);
    expect(statSync(trialLedgerFile('exp-a', home)).mode & 0o777).toBe(0o600);
  });
});

describe('разбор списка назначений (Э-1б, критерий 4 и 6 для скрипта подсчёта)', () => {
  const intent = JSON.stringify({ kind: 'intent', tag: TAG, name: 'exp-a', arm: 'control', at: '2026-11-17T10:00:00.000Z' });

  it('читает три вида строк; пустые строки пропускает, неразбираемые называет по номеру, а не теряет', () => {
    const confirm = JSON.stringify({ kind: 'confirm', tag: TAG, projectPath: '/p', workId: 'w-0001', incarnation: 3, sessionId: 's-01', at: '2026-11-17T10:00:01.000Z' });
    const cancel = JSON.stringify({ kind: 'cancel', tag: 'f'.repeat(32), at: '2026-11-17T10:00:02.000Z' });
    const parsed = parseTrialLedger([intent, '', confirm, '{broken', cancel, JSON.stringify({ kind: 'intent', tag: 'short' }), ''].join('\n'));
    expect(parsed.lines.map((line) => line.kind)).toEqual(['intent', 'confirm', 'cancel']);
    expect(parsed.unreadable).toEqual([4, 5 + 1]);
  });

  it('намерения без отмены: подтверждённое называет работу и сессию, отменённое выпадает', () => {
    const other = 'e'.repeat(32);
    const parsed = parseTrialLedger([
      intent,
      JSON.stringify({ kind: 'confirm', tag: TAG, projectPath: '/p', workId: 'w-0001', incarnation: 1, sessionId: 's-02', at: '2026-11-17T10:00:01.000Z' }),
      JSON.stringify({ kind: 'intent', tag: other, name: 'exp-a', arm: 'packet', at: '2026-11-17T10:00:03.000Z' }),
      JSON.stringify({ kind: 'cancel', tag: other, at: '2026-11-17T10:00:04.000Z' }),
    ].join('\n'));
    const open = unresolvedIntents(parsed.lines);
    expect(open.map((entry) => entry.intent.tag)).toEqual([TAG]);
    expect(open[0]?.confirm).toMatchObject({ workId: 'w-0001', sessionId: 's-02' });
  });

  it('файла нет — readTrialLedger отвечает undefined, а не пустым списком; чужое имя опыта пути не строит', () => {
    expect(readTrialLedger('exp-a', home)).toBeUndefined();
    expect(() => trialLedgerFile('../evil', home)).toThrow();
  });
});

describe('удаление рабочей области (Э-1б, критерий 7)', () => {
  /** Работа с сессией, у которой назначение с меткой TAG; идёт обычным путём создания. */
  async function workWithTrial() {
    const map = await createWork(project, { title: 'W' });
    await createNewSession(project, map.work.id, trial(), options());
    expect(await tagsInMaps()).toEqual([TAG]);
    return map.work.id;
  }

  it('deleteWorkFiles и пересоздание с тем же номером: метка прежнего назначения в картах не находится, номер создания новый, список помнит', async () => {
    const id = await workWithTrial();
    const before = workIdentity(project, id)!.incarnation;
    await deleteWorkFiles(project, id);
    expect(await tagsInMaps()).toEqual([]);
    const again = await createWork(project, { title: 'W again' });
    expect(again.work.id).toBe(id);
    expect(workIdentity(project, id)!.incarnation).not.toBe(before);
    expect(await tagsInMaps()).toEqual([]);
    // Список назначений остаётся: намерение с этой меткой есть, а в картах её нет.
    expect(unresolvedIntents(lines()).map((entry) => entry.intent.tag)).toEqual([TAG]);
  });

  it('pruneWorksIndex (каталог работы стёрт руками) и пересоздание: метки в картах нет', async () => {
    const id = await workWithTrial();
    await rm(workPaths(project, id).dir, { recursive: true, force: true });
    const removed = await pruneWorksIndex();
    expect(removed.map((entry) => entry.id)).toEqual([id]);
    expect(await tagsInMaps()).toEqual([]);
    await createWork(project, { title: 'W again' });
    expect(await tagsInMaps()).toEqual([]);
    expect(unresolvedIntents(lines())).toHaveLength(1);
  });

  it('пересозданная работа с тем же номером и новая сессия с тем же номером не закрывают прежнее назначение: сверка идёт по метке', async () => {
    const id = await workWithTrial();
    const confirm = lines().find((line) => line.kind === 'confirm');
    await deleteWorkFiles(project, id);
    await createWork(project, { title: 'W again' });
    const fresh = await createNewSession(project, id, trial('d'.repeat(32)), options());
    // Те же номера работы и сессии, что у прежнего подтверждения…
    expect(confirm).toMatchObject({ workId: id, sessionId: fresh.session.id });
    // …но метка прежнего назначения в картах по-прежнему не находится, а новая находится.
    expect(await tagsInMaps()).toEqual(['d'.repeat(32)]);
    expect(unresolvedIntents(lines()).map((entry) => entry.intent.tag)).toEqual([TAG, 'd'.repeat(32)]);
    // Содержимое файла списка не изменилось от удаления: только дозапись.
    expect(readFileSync(trialLedgerFile('exp-a', home), 'utf8').split('\n').filter(Boolean)).toHaveLength(4);
  });
});
