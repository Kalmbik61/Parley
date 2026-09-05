/**
 * Чек-лист приёмки TUI v2, пункты 12 и 13: файл настроек содержит все хуки
 * таблицы 4.2 с одной и той же командой, а на диске это валидный JSON нужной
 * формы — мерж с настройками пользователя делает сам Claude Code.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_COMMAND, HOOK_EVENTS, workSettings, writeWorkSettings } from './settings-file.js';
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
    expect(HOOK_COMMAND).toBe('cat >> "$HARNAS_WORK_DIR/events/$HARNAS_SESSION_ID.jsonl" || true');
  });

  it('предел ожидания есть только у SessionEnd и равен пяти секундам', () => {
    const { hooks } = workSettings();

    expect(hooks['SessionEnd']?.[0]?.hooks[0]?.timeout).toBe(5);
    for (const event of HOOK_EVENTS.filter((name) => name !== 'SessionEnd')) {
      expect(hooks[event]?.[0]?.hooks[0]?.timeout).toBeUndefined();
    }
  });
});

describe('writeWorkSettings', () => {
  let home = '';
  let project = '';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'harnas-home-'));
    project = await mkdtemp(path.join(tmpdir(), 'harnas-project-'));
    process.env.HARNAS_HOME = home;
  });

  afterEach(async () => {
    delete process.env.HARNAS_HOME;
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

    // Повторный запуск сессии переписывает тот же файл: он один на работу.
    expect(await writeWorkSettings(project, work.id)).toBe(file);
  });
});
