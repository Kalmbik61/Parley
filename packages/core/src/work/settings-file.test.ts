/**
 * Чек-лист приёмки TUI v2, пункты 12 и 13: файл настроек содержит все хуки
 * таблицы 4.2 с одной и той же командой, а на диске это валидный JSON нужной
 * формы — мерж с настройками пользователя делает сам Claude Code.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEED_HOOK_EVENTS,
  HOOK_COMMAND,
  HOOK_EVENTS,
  workSettings,
  workSettingsJson,
  writeWorkSettings,
  type HookHttp,
} from './settings-file.js';
import { STATUSLINE_BIN, STATUSLINE_ENTRY, statusLineCommand } from './statusline.js';
import { createWork, workPaths } from './store.js';

describe('workSettings', () => {
  it('содержит ровно хуки таблицы 4.2', () => {
    expect(Object.keys(workSettings().hooks)).toEqual([
      'UserPromptSubmit',
      'Notification',
      'PermissionRequest',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'SessionStart',
      'SessionEnd',
    ]);
    expect(HOOK_EVENTS).toHaveLength(8);
  });

  it('команда у всех хуков одна: дописать stdin в журнал сессии', () => {
    const { hooks } = workSettings();

    for (const event of HOOK_EVENTS) {
      const commands = hooks[event]?.[0]?.hooks;
      expect(commands).toHaveLength(1);
      expect(commands?.[0]?.type).toBe('command');
      expect(commands?.[0]?.command).toBe(HOOK_COMMAND);
    }
    // Новое имя главнее, а нет его — прежнее (R3): у старой сессии в окружении только `HARNAS_*`.
    expect(HOOK_COMMAND).toBe(
      'cat >> "${PARLEY_WORK_DIR:-$HARNAS_WORK_DIR}/events/${PARLEY_SESSION_ID:-$HARNAS_SESSION_ID}.jsonl" || true',
    );
  });

  it('предел ожидания есть только у SessionEnd и равен пяти секундам', () => {
    const { hooks } = workSettings();

    expect(hooks['SessionEnd']?.[0]?.hooks[0]?.timeout).toBe(5);
    for (const event of HOOK_EVENTS.filter((name) => name !== 'SessionEnd')) {
      expect(hooks[event]?.[0]?.hooks[0]?.timeout).toBeUndefined();
    }
  });
});

describe('HTTP-хуки ленты вида «Chat» (план 2026-10-01, решение 1)', () => {
  const URL = 'http://127.0.0.1:53123/hooks';

  /** Файл до ленты, собранный руками: восемь хуков `cat >>`, предел у `SessionEnd`, строка статуса. */
  const legacyJson = (): string => {
    const hooks: Record<string, unknown> = {};
    for (const event of HOOK_EVENTS) {
      const command: Record<string, unknown> = { type: 'command', command: HOOK_COMMAND };
      if (event === 'SessionEnd') command['timeout'] = 5;
      hooks[event] = [{ hooks: [command] }];
    }
    return `${JSON.stringify({ hooks, statusLine: { type: 'command', command: statusLineCommand() } }, null, 2)}\n`;
  };

  const httpOf = (event: string): HookHttp[] =>
    (workSettings({ hookUrl: URL }).hooks[event] ?? []).flatMap((group) =>
      group.hooks.filter((hook): hook is HookHttp => hook.type === 'http'),
    );

  it('без hookUrl файл побайтно прежний', () => {
    expect(workSettingsJson()).toBe(legacyJson());
    expect(workSettingsJson({})).toBe(legacyJson());
    expect(workSettingsJson({ hookEvents: ['Stop'] })).toBe(legacyJson());
  });

  it('с hookUrl: HTTP-хук на каждое событие решения 1, с токеном и сессией из окружения', () => {
    const settings = workSettings({ hookUrl: URL });

    expect(Object.keys(settings.hooks)).toEqual([
      ...new Set([...HOOK_EVENTS, ...FEED_HOOK_EVENTS]),
    ]);
    for (const event of FEED_HOOK_EVENTS) {
      const http = httpOf(event);
      expect(http, event).toHaveLength(1);
      expect(http[0]).toMatchObject({
        type: 'http',
        url: URL,
        headers: {
          Authorization: 'Bearer $PARLEY_HOOK_TOKEN',
          'X-Parley-Session': '$PARLEY_SESSION_ID',
        },
        allowedEnvVars: ['PARLEY_HOOK_TOKEN', 'PARLEY_SESSION_ID'],
      });
    }
    expect(FEED_HOOK_EVENTS).toEqual([
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'MessageDisplay',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'PostToolUseFailure',
      'PostToolBatch',
      'Stop',
      'StopFailure',
      'Notification',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'PostModelSwitch',
    ]);
  });

  it('таймауты: час у PermissionRequest и PreToolUse, у остальных — умолчание Claude Code', () => {
    expect(httpOf('PermissionRequest')[0]?.timeout).toBe(3600);
    expect(httpOf('PreToolUse')[0]?.timeout).toBe(3600);
    for (const event of FEED_HOOK_EVENTS.filter(
      (name) => name !== 'PermissionRequest' && name !== 'PreToolUse',
    )) {
      expect(httpOf(event)[0]?.timeout, event).toBeUndefined();
    }
  });

  it('матчеров нет: PreToolUse идёт для всех инструментов', () => {
    const { hooks } = workSettings({ hookUrl: URL });

    expect(hooks['PreToolUse']).toEqual([{ hooks: httpOf('PreToolUse') }]);
    for (const [event, groups] of Object.entries(hooks)) {
      expect(
        groups.every((group) => group.matcher === undefined),
        event,
      ).toBe(true);
    }
  });

  it('прежние хуки cat >> на месте и идут первыми в своей группе', () => {
    const { hooks } = workSettings({ hookUrl: URL });

    for (const event of HOOK_EVENTS) {
      const group = hooks[event];
      expect(group, event).toHaveLength(1);
      expect(group?.[0]?.hooks[0]).toMatchObject({ type: 'command', command: HOOK_COMMAND });
      expect(group?.[0]?.hooks[1]?.type, event).toBe('http');
    }
    expect(hooks['SessionEnd']?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: HOOK_COMMAND,
      timeout: 5,
    });
    expect(workSettings({ hookUrl: URL }).statusLine).toEqual({
      type: 'command',
      command: statusLineCommand(),
    });
  });

  it('hookEvents сужает список HTTP-событий', () => {
    const { hooks } = workSettings({ hookUrl: URL, hookEvents: ['Stop', 'MessageDisplay'] });

    expect(Object.keys(hooks)).toEqual([...HOOK_EVENTS, 'MessageDisplay']);
    expect(hooks['Stop']?.[0]?.hooks.map((hook) => hook.type)).toEqual(['command', 'http']);
    expect(hooks['UserPromptSubmit']?.[0]?.hooks.map((hook) => hook.type)).toEqual(['command']);
  });

  it('в файле только хуки и строка статуса — рамка (Review Focus 5)', () => {
    expect(Object.keys(workSettings({ hookUrl: URL }))).toEqual(['hooks', 'statusLine']);
  });
});

describe('команда хука в оболочке: адрес сессии под обоими именами (R3)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'parley-hook-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Запускает хук как Claude Code: оболочка, stdin-JSON и только переданное окружение. */
  const fire = (env: Record<string, string>, json: string): number | null =>
    spawnSync('/bin/sh', ['-c', HOOK_COMMAND], { input: json, env: { PATH: process.env['PATH'] ?? '', ...env } })
      .status;

  it('только PARLEY_*: строка ложится в журнал сессии', async () => {
    await mkdir(path.join(dir, 'new', 'events'), { recursive: true });
    expect(fire({ PARLEY_WORK_DIR: path.join(dir, 'new'), PARLEY_SESSION_ID: 's-01' }, '{"a":1}\n')).toBe(0);
    expect(await readFile(path.join(dir, 'new', 'events', 's-01.jsonl'), 'utf8')).toBe('{"a":1}\n');
  });

  it('только HARNAS_* (сессия, поднятая прежней сборкой): строка ложится в тот же журнал', async () => {
    await mkdir(path.join(dir, 'old', 'events'), { recursive: true });
    expect(fire({ HARNAS_WORK_DIR: path.join(dir, 'old'), HARNAS_SESSION_ID: 's-02' }, '{"b":2}\n')).toBe(0);
    expect(await readFile(path.join(dir, 'old', 'events', 's-02.jsonl'), 'utf8')).toBe('{"b":2}\n');
  });

  it('оба набора: главнее PARLEY_*', async () => {
    await mkdir(path.join(dir, 'new', 'events'), { recursive: true });
    await mkdir(path.join(dir, 'old', 'events'), { recursive: true });
    const env = {
      PARLEY_WORK_DIR: path.join(dir, 'new'),
      PARLEY_SESSION_ID: 's-03',
      HARNAS_WORK_DIR: path.join(dir, 'old'),
      HARNAS_SESSION_ID: 's-04',
    };
    expect(fire(env, '{"c":3}\n')).toBe(0);
    expect(await readFile(path.join(dir, 'new', 'events', 's-03.jsonl'), 'utf8')).toBe('{"c":3}\n');
    await expect(stat(path.join(dir, 'old', 'events', 's-04.jsonl'))).rejects.toThrow();
  });

  it('пробелы и кириллица в пути каталога работы: адрес в кавычках, строка всё равно ложится в журнал', async () => {
    const work = path.join(dir, 'Мой проект with space', 'works', 'w 1');
    await mkdir(path.join(work, 'events'), { recursive: true });
    expect(fire({ PARLEY_WORK_DIR: work, PARLEY_SESSION_ID: 's-06' }, '{"d":4}\n')).toBe(0);
    expect(await readFile(path.join(work, 'events', 's-06.jsonl'), 'utf8')).toBe('{"d":4}\n');
  });

  it('недоступный каталог журнала код выхода не ломает (`|| true`)', () => {
    expect(fire({ PARLEY_WORK_DIR: path.join(dir, 'нет', 'такого'), PARLEY_SESSION_ID: 's-05' }, '{}\n')).toBe(0);
  });
});

describe('statusLine: скрипт строки статуса лимитов (спека комнат, 3.5)', () => {
  it('ключ statusLine — команда, а хуки остались прежними', () => {
    const settings = workSettings();

    expect(settings.statusLine).toEqual({ type: 'command', command: statusLineCommand() });
    expect(Object.keys(settings.hooks)).toEqual([...HOOK_EVENTS]);
    expect(settings.hooks['Stop']?.[0]?.hooks[0]?.command).toBe(HOOK_COMMAND);
  });

  it('команда — node процесса и скрипт по абсолютному пути, без надежды на PATH', () => {
    const [node, entry] = statusLineCommand().match(/'[^']*'/g) ?? [];

    expect(node).toBe(`'${process.execPath}'`);
    expect(entry).toBe(`'${STATUSLINE_ENTRY}'`);
    expect(path.isAbsolute(process.execPath)).toBe(true);
    expect(path.isAbsolute(STATUSLINE_ENTRY)).toBe(true);
    expect(path.basename(STATUSLINE_ENTRY)).toBe(`${STATUSLINE_BIN}.js`);
    // Скрипт лежит рядом с этим модулем: так же, как сервер MCP рядом со своим.
    expect(path.basename(path.dirname(STATUSLINE_ENTRY))).toBe('work');
  });

  it('пути с пробелом и кавычкой оболочка читает обратно теми же двумя словами', () => {
    const original = process.execPath;
    process.execPath = "/tmp/it's a dir/node";
    try {
      const script = `set -- ${statusLineCommand()}\nprintf '%s\\n' "$1" "$2"`;
      const words = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' }).split('\n');
      expect(words.slice(0, 2)).toEqual(["/tmp/it's a dir/node", STATUSLINE_ENTRY]);
    } finally {
      process.execPath = original;
    }
  });

  // Собранное окно запускает хост своим node из `Parley.app/Contents/Resources/node/bin/node`, и этот
  // путь — `process.execPath` хоста, то есть первое слово команды. Приложение лежит там, куда его положил
  // человек, — в том числе в каталоге с пробелом: оболочка Claude Code должна запустить команду целиком.
  it('node приложения в каталоге с пробелом: оболочка запускает команду, скрипт приходит одним аргументом', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'parley-sl-'));
    const node = path.join(dir, 'My Apps', 'Parley.app', 'Contents', 'Resources', 'node', 'bin', 'node');
    await mkdir(path.dirname(node), { recursive: true });
    await writeFile(node, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', 'utf8');
    await chmod(node, 0o755);
    const original = process.execPath;
    process.execPath = node;
    try {
      const out = execFileSync('/bin/sh', ['-c', statusLineCommand()], { encoding: 'utf8' });
      expect(out).toBe(`${STATUSLINE_ENTRY}\n`);
    } finally {
      process.execPath = original;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeWorkSettings', () => {
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'parley-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'parley-project-'));
    process.env.PARLEY_HOME = home;
  });

  afterEach(async () => {
    delete process.env.PARLEY_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  });

  it('кладёт один файл на работу и заводит каталог событий', async () => {
    const { work } = await createWork(project, { title: 'Авторизация' });
    const paths = workPaths(project, work.id);

    const file = await writeWorkSettings(project, work.id);
    expect(file).toBe(paths.settings);
    expect((await stat(paths.events)).isDirectory()).toBe(true);

    // Пункт 13: на диске валидный JSON нужной формы.
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
    };
    expect(Object.keys(parsed.hooks)).toEqual([...HOOK_EVENTS]);
    expect(parsed.hooks['Stop']?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: HOOK_COMMAND,
    });
    // Строка статуса лежит в том же файле, что и хуки, — `--settings` у сессии один.
    expect((parsed as unknown as { statusLine: unknown }).statusLine).toEqual({
      type: 'command',
      command: statusLineCommand(),
    });

    // Повторный запуск сессии переписывает тот же файл: он один на работу.
    expect(await writeWorkSettings(project, work.id)).toBe(file);
  });

  it('с hookUrl пишет HTTP-хуки, без него — снова прежний файл', async () => {
    const { work } = await createWork(project, { title: 'Лента' });
    const url = 'http://127.0.0.1:40001/hooks';

    const file = await writeWorkSettings(project, work.id, { hookUrl: url });
    expect(await readFile(file, 'utf8')).toBe(workSettingsJson({ hookUrl: url }));
    expect(await readFile(file, 'utf8')).toContain(url);

    await writeWorkSettings(project, work.id);
    expect(await readFile(file, 'utf8')).toBe(workSettingsJson());
  });
});
