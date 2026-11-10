/**
 * Сжатие журналов хуков на старте: что остаётся от журнала и что видят его читатели.
 * Временные каталоги только свои; домашний каталог не трогается.
 */

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activityOf, hookedSince, type ActivityLog } from './activity.js';
import { openEvents, type EventRecord } from './events.js';
import { JOURNAL_ROTATE_BYTES, rotateJournal, rotateWorkJournals } from './journal-rotate.js';
import { silentTurnEnd } from './silent-endings.js';
import { workPaths } from './store.js';
import type { WorkEntry } from './works.js';

const SESSION = 's-01';
const STAMP = new Date('2026-11-01T10:00:00.000Z');

const line = (name: string, fields: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ hook_event_name: name, ...fields })}\n`;
const start = (source?: string): string => line('SessionStart', source === undefined ? {} : { source });
/** Ход с запросом разрешения и концом: так журнал выглядит после обычной работы. */
const turn = (): string =>
  line('UserPromptSubmit') +
  line('Notification', { notification_type: 'permission_prompt', message: 'needs Bash' }) +
  line('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }) +
  line('Stop');
/** Процесс агента, проработавший два хода. */
const processOf = (source: string): string => start(source) + turn() + turn();
/** Два прошлых процесса с ходами — «длинная история» перед сценарием. */
const HISTORY = processOf('startup') + processOf('resume');

/** Сценарии конца журнала: что делал последний процесс. */
const SCENARIOS: Record<string, string> = {
  'последний процесс закончил ход': HISTORY + start('resume') + turn(),
  'запущен и ничего не сделал': HISTORY + start('resume'),
  'прошлый умер посреди хода': HISTORY + start('resume') + line('UserPromptSubmit') + line('SessionEnd') + start('resume'),
  'прошлый стоял на PermissionRequest':
    HISTORY +
    start('resume') +
    line('UserPromptSubmit') +
    line('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }) +
    start('resume'),
  'работает фоновый субагент':
    HISTORY +
    start('resume') +
    line('UserPromptSubmit') +
    line('SubagentStart', { agent_id: 'a1', agent_type: 'worker' }) +
    line('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] }),
  'открыт wait_for':
    HISTORY +
    start('resume') +
    line('UserPromptSubmit') +
    line('ParleyWaitStart', { parley_wait_target: 'inbox', parley_wait_id: 'w1' }),
  'последний — StopFailure с rate_limit':
    HISTORY +
    start('resume') +
    line('UserPromptSubmit') +
    line('StopFailure', { error: 'rate_limit', error_details: '429', last_assistant_message: 'limit resets 2:50pm' }),
  'SessionStart compact внутри процесса':
    HISTORY + start('resume') + line('UserPromptSubmit') + start('compact') + line('Stop'),
  'строки 0.32.0 без source и parley_wait_id':
    line('SessionStart') +
    line('UserPromptSubmit') +
    line('ParleyWaitStart', { parley_wait_target: 'inbox' }) +
    line('Stop') +
    line('SessionStart') +
    line('UserPromptSubmit') +
    line('Stop'),
  '60 SubagentStop между Stop и SessionStart':
    HISTORY +
    turn() +
    Array.from({ length: 60 }, () => line('SubagentStop', { agent_id: 'z' })).join('') +
    start('resume'),
};

let dir = '';
const file = (): string => path.join(dir, `${SESSION}.jsonl`);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-rotate-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Пишет журнал и ставит ему mtime: читатель присваивает его всем событиям (`at`). */
async function put(body: string): Promise<void> {
  await writeFile(file(), body, 'utf8');
  await utimes(file(), STAMP, STAMP);
}

const read = async (): Promise<readonly EventRecord[]> => (await openEvents(dir).read(SESSION)) ?? [];

/** Последнее событие хода, как его видит `findInterrupted`: без простоя, ожиданий и субагентов. */
const lastTurnEvent = (events: readonly EventRecord[]): EventRecord | undefined =>
  events
    .filter(
      (event) =>
        !(event.name === 'Notification' && event.notificationType === 'idle_prompt') &&
        !['ParleyWaitStart', 'ParleyWaitEnd', 'ParleyPermissionAnswered', 'SubagentStart', 'SubagentStop'].includes(
          event.name,
        ),
    )
    .at(-1);

describe('rotateJournal: что читатели получают после сжатия', () => {
  for (const [name, body] of Object.entries(SCENARIOS)) {
    it(`${name}: хвост — суффикс файла, производные значения прежние`, async () => {
      await put(body);
      const before = await read();
      const result = await rotateJournal(file());

      expect(result).not.toBeNull();
      const kept = await readFile(file(), 'utf8');
      expect(kept.length).toBeLessThan(body.length);
      expect(body.endsWith(kept)).toBe(true);
      expect(result).toEqual({ before: Buffer.byteLength(body), after: Buffer.byteLength(kept) });
      // Время файла прежнее: событиям читатель присваивает его, и оно не сдвигается.
      expect((await stat(file())).mtime.toISOString()).toBe(STAMP.toISOString());
      expect(await readdir(dir)).toEqual([`${SESSION}.jsonl`]);

      const after = await read();
      expect(after.length).toBeLessThan(before.length);
      const now = STAMP.getTime();
      const newer = new Date(now + 60_000).toISOString();
      const logs: Array<ActivityLog | null> = [
        null,
        { lastRecordAt: newer, lastUserRecordAt: newer },
        { lastRecordAt: newer, lastUserRecordAt: null, lastApiError: { at: newer, error: 'rate_limit', text: 'limit' } },
      ];
      for (const log of logs) {
        for (const seen of [false, true]) {
          const full = activityOf({ events: before, log, seen, now });
          const cut = activityOf({ events: after, log, seen, now });
          // Весь выход свёртки: `turnEndedAt`, `need`, `lastEventAt`, задачи, ожидания — без исключений.
          expect(cut).toEqual(full);
          // Будильник («новый процесс дал хук») и сторож молчаливого конца хода.
          const since = now - 1000;
          expect(hookedSince(cut, since)).toBe(hookedSince(full, since));
          expect(silentTurnEnd(cut, since)).toBe(silentTurnEnd(full, since));
        }
      }
      // Список прерванных: последнее событие хода и работающие фоновые задачи.
      expect(lastTurnEvent(after)?.name).toBe(lastTurnEvent(before)?.name);
      expect(activityOf({ events: after, now }).tasks.some((task) => task.background)).toBe(
        activityOf({ events: before, now }).tasks.some((task) => task.background),
      );
    });
  }

  it('второй проход ничего не меняет', async () => {
    await put(SCENARIOS['последний процесс закончил ход'] ?? '');
    expect(await rotateJournal(file())).not.toBeNull();
    const once = await readFile(file(), 'utf8');

    expect(await rotateJournal(file())).toBeNull();
    expect(await readFile(file(), 'utf8')).toBe(once);
  });

  it('журнал без SessionStart запуска не меняется', async () => {
    const body = turn() + turn() + start('compact') + turn();
    await put(body);

    expect(await rotateJournal(file())).toBeNull();
    expect(await readFile(file(), 'utf8')).toBe(body);
  });

  it('оборванная последняя строка сохраняется', async () => {
    const body = `${HISTORY}${start('resume')}${turn()}{"hook_event_name":"Sto`;
    await put(body);

    expect(await rotateJournal(file())).not.toBeNull();
    const kept = await readFile(file(), 'utf8');
    expect(kept.endsWith('{"hook_event_name":"Sto')).toBe(true);
    expect(body.endsWith(kept)).toBe(true);
  });

  it('после сжатия дописанная строка читается как новое событие', async () => {
    await put(HISTORY + start('resume') + turn());
    expect(await rotateJournal(file())).not.toBeNull();
    const log = openEvents(dir);
    const first = await log.read(SESSION);

    await appendFile(file(), line('UserPromptSubmit'), 'utf8');
    const second = await log.read(SESSION);

    expect(second?.length).toBe((first?.length ?? 0) + 1);
    expect(second?.at(-1)?.name).toBe('UserPromptSubmit');
  });

  it('нет файла — null, без следов', async () => {
    expect(await rotateJournal(file())).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('rotateWorkJournals', () => {
  let project = '';

  beforeEach(async () => {
    project = await mkdtemp(path.join(tmpdir(), 'parley-rotate-project-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  /** Большая история: выше порога сжатия. */
  const big = (): string => {
    const padding = 'x'.repeat(400);
    let body = '';
    while (body.length <= JOURNAL_ROTATE_BYTES) body += line('UserPromptSubmit', { padding }) + line('Stop', { padding });
    return processOf('startup') + body + start('resume') + turn();
  };

  const entryOf = (sessions: Array<{ id: string; lifecycle: string }>): WorkEntry =>
    ({ projectPath: project, map: { work: { id: 'w-01' }, sessions } }) as unknown as WorkEntry;

  const journalOf = (id: string): string => path.join(workPaths(project, 'w-01').events, `${id}.jsonl`);

  it('сжимает sleeping и closed больше порога, active и малые не трогает, .tmp не остаётся', async () => {
    const events = workPaths(project, 'w-01').events;
    await mkdir(events, { recursive: true });
    const body = big();
    for (const id of ['s-sleep', 's-closed', 's-active']) await writeFile(journalOf(id), body, 'utf8');
    const small = HISTORY + start('resume') + turn();
    await writeFile(journalOf('s-small'), small, 'utf8');

    const result = await rotateWorkJournals([
      entryOf([
        { id: 's-sleep', lifecycle: 'sleeping' },
        { id: 's-closed', lifecycle: 'closed' },
        { id: 's-active', lifecycle: 'active' },
        { id: 's-small', lifecycle: 'sleeping' },
      ]),
    ]);

    expect(result.rotated).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(Buffer.byteLength(body) / 2);
    expect((await readFile(journalOf('s-sleep'), 'utf8')).length).toBeLessThan(body.length);
    expect((await readFile(journalOf('s-closed'), 'utf8')).length).toBeLessThan(body.length);
    expect(await readFile(journalOf('s-active'), 'utf8')).toBe(body);
    expect(await readFile(journalOf('s-small'), 'utf8')).toBe(small);
    expect((await readdir(events)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('отсутствующий журнал не мешает остальным', async () => {
    const events = workPaths(project, 'w-01').events;
    await mkdir(events, { recursive: true });
    await writeFile(journalOf('s-b'), big(), 'utf8');

    const result = await rotateWorkJournals([
      entryOf([
        { id: 's-a', lifecycle: 'sleeping' },
        { id: 's-b', lifecycle: 'sleeping' },
      ]),
    ]);

    expect(result.rotated).toBe(1);
  });

  it('нулевой срок: ничего не трогает', async () => {
    const events = workPaths(project, 'w-01').events;
    await mkdir(events, { recursive: true });
    const body = big();
    await writeFile(journalOf('s-a'), body, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await rotateWorkJournals([entryOf([{ id: 's-a', lifecycle: 'sleeping' }])], -1);

    expect(result).toEqual({ rotated: 0, freedBytes: 0 });
    expect(await readFile(journalOf('s-a'), 'utf8')).toBe(body);
  });
});
