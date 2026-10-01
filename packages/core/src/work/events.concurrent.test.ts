/**
 * Два чтения одного журнала разом (fix-tests2, attention:63 — «1 needs you» не появлялся).
 * Отдельный файл: здесь `open` из `node:fs/promises` подменён, чтобы задержать первое чтение
 * между `stat` и разбором — на настоящей файловой системе этот порядок не выставить.
 */

import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Пока задан — `stat()` следующего открытого файла ждёт его, уже сняв размер. */
const gate: { hold: Promise<void> | null } = { hold: null };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const hold = gate.hold;
      gate.hold = null;
      if (hold === null) return handle;
      const stat = handle.stat.bind(handle);
      return Object.assign(handle, {
        stat: async () => {
          const info = await stat();
          await hold;
          return info;
        },
      });
    },
  };
});

const { openEvents } = await import('./events.js');

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-events-race-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openEvents: чтения одной сессии разом', () => {
  it('чтение, начатое раньше, кончается раньше и не затирает события более позднего', async () => {
    const file = path.join(dir, 's-01.jsonl');
    await writeFile(file, '');
    const log = openEvents(dir);

    let release!: () => void;
    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done: Array<[string, number]> = [];
    // Первое чтение сняло размер пустого журнала и задержалось…
    const first = log.read('s-01').then((events) => done.push(['first', events?.length ?? -1]));
    await vi.waitFor(() => expect(gate.hold).toBeNull());
    // …хук дописал строку, и второе чтение (событие наблюдателя) пошло следом.
    await appendFile(
      file,
      `${JSON.stringify({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })}\n`,
    );
    const second = log.read('s-01').then((events) => done.push(['second', events?.length ?? -1]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([first, second]);

    // Потребитель (activity хоста) применяет ответы по мере прихода: последний обязан нести
    // событие, иначе состояние сессии откатывается к пустому журналу до следующего хука.
    expect(done).toEqual([
      ['first', 0],
      ['second', 1],
    ]);
  });
});
