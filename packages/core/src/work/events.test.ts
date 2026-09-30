/**
 * Чек-лист приёмки TUI v2, пункты 7, 8 и 11: битые строки пропускаются, порядок
 * событий — порядок файла, а второе чтение не перечитывает старые байты.
 */

import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openEvents, watchEvents } from './events.js';

const SESSION = 's-01';

const line = (name: string, notificationType?: string): string =>
  `${JSON.stringify(
    notificationType === undefined
      ? { hook_event_name: name }
      : { hook_event_name: name, notification_type: notificationType },
  )}\n`;

let dir = '';
const journal = (): string => path.join(dir, `${SESSION}.jsonl`);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-events-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openEvents', () => {
  it('читает журнал в порядке файла', async () => {
    await writeFile(
      journal(),
      line('UserPromptSubmit') + line('Notification', 'permission_prompt') + line('Stop'),
      'utf8',
    );

    const events = await openEvents(dir).read(SESSION);

    expect(events?.map((item) => item.name)).toEqual(['UserPromptSubmit', 'Notification', 'Stop']);
    expect(events?.[1]?.notificationType).toBe('permission_prompt');
  });

  // Пункт 7.
  it('пропускает битые строки и строки без имени события', async () => {
    await writeFile(
      journal(),
      `${line('UserPromptSubmit')}не json\n[]\n{"foo":1}\n\n${line('Stop')}`,
      'utf8',
    );

    const events = await openEvents(dir).read(SESSION);

    expect(events?.map((item) => item.name)).toEqual(['UserPromptSubmit', 'Stop']);
  });

  it('незаконченная последняя строка ждёт своего конца', async () => {
    await writeFile(journal(), `${line('UserPromptSubmit')}{"hook_event_name":"St`, 'utf8');
    const log = openEvents(dir);

    expect(await log.read(SESSION)).toHaveLength(1);

    await appendFile(journal(), 'op"}\n', 'utf8');
    expect((await log.read(SESSION))?.map((item) => item.name)).toEqual([
      'UserPromptSubmit',
      'Stop',
    ]);
  });

  // Пункт 11.
  it('второе чтение берёт только новые байты', async () => {
    const first = line('UserPromptSubmit');
    await writeFile(journal(), first + line('Stop'), 'utf8');
    const log = openEvents(dir);

    expect(await log.read(SESSION)).toHaveLength(2);

    // Затираем уже прочитанный кусок мусором той же длины: если читатель
    // перечитает файл целиком, первое событие превратится в битую строку.
    const handle = await open(journal(), 'r+');
    await handle.write(Buffer.alloc(first.length - 1, 0x58), 0, first.length - 1, 0);
    await handle.close();
    await appendFile(journal(), line('SessionEnd'), 'utf8');

    expect((await log.read(SESSION))?.map((item) => item.name)).toEqual([
      'UserPromptSubmit',
      'Stop',
      'SessionEnd',
    ]);
  });

  it('каждое чтение отдаёт свой массив: подписчик сравнивает его по ссылке', async () => {
    await writeFile(journal(), line('UserPromptSubmit'), 'utf8');
    const log = openEvents(dir);

    const first = await log.read(SESSION);
    await appendFile(journal(), line('Stop'), 'utf8');
    const second = await log.read(SESSION);

    // Отдай мы внутренний массив, `first` дорос бы до двух элементов вместе с
    // `second`, и мемоизация раздела 8.2 новых событий не заметила бы.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  it('переписанный с нуля журнал читается заново', async () => {
    await writeFile(journal(), line('UserPromptSubmit') + line('Stop'), 'utf8');
    const log = openEvents(dir);
    expect(await log.read(SESSION)).toHaveLength(2);

    await writeFile(journal(), line('SessionStart'), 'utf8');

    expect((await log.read(SESSION))?.map((item) => item.name)).toEqual(['SessionStart']);
  });

  // Пункт 10: каталог и файл различаются — без каталога хуков нет совсем.
  it('журнала ещё нет, но каталог есть → пустой список; каталога нет → null', async () => {
    expect(await openEvents(dir).read(SESSION)).toEqual([]);
    expect(await openEvents(path.join(dir, 'нет')).read(SESSION)).toBeNull();
  });
});

describe('watchEvents', () => {
  it('на изменение журнала отдаёт id сессии', async () => {
    await mkdir(dir, { recursive: true });
    const seen: string[] = [];
    const watcher = watchEvents(dir, (sessionId) => seen.push(sessionId), { debounceMs: 10 });

    try {
      await appendFile(journal(), line('UserPromptSubmit'), 'utf8');
      const deadline = Date.now() + 3000;
      while (seen.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      watcher.close();
    }

    expect(seen).toContain(SESSION);
  });
});
