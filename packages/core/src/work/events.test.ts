/**
 * Чек-лист приёмки TUI v2, пункты 7, 8 и 11: битые строки пропускаются, порядок
 * событий — порядок файла, а второе чтение не перечитывает старые байты. Плюс разбор полей
 * агента и снимка фоновых задач (Parley 0.2.0, активность агентов).
 */

import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bareEvent, eventRecordOf, openEvents, watchEvents } from './events.js';
import { NEED_DETAIL_MAX } from './stuck.js';

const SESSION = 's-01';

const line = (name: string, notificationType?: string): string =>
  `${JSON.stringify(
    notificationType === undefined
      ? { hook_event_name: name }
      : { hook_event_name: name, notification_type: notificationType },
  )}\n`;

/** Строка журнала с произвольными полями — как хук дописывает stdin Claude Code. */
const raw = (fields: Record<string, unknown>): string => `${JSON.stringify(fields)}\n`;

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

describe('openEvents: поля агента и фоновых задач', () => {
  const read = async (text: string) => {
    await writeFile(journal(), text, 'utf8');
    const events = await openEvents(dir).read(SESSION);
    if (events === null) throw new Error('журнал не прочитан');
    return events;
  };

  it('SubagentStart: agent_id, agent_type и transcript_path родителя', async () => {
    const [event] = await read(
      raw({
        hook_event_name: 'SubagentStart',
        agent_id: 'a4a0fb93b5a2dbaf7',
        agent_type: 'general-purpose',
        transcript_path: '/home/u/.claude/projects/p/sess.jsonl',
        session_id: 'sess',
      }),
    );

    expect(event).toMatchObject({
      name: 'SubagentStart',
      agentId: 'a4a0fb93b5a2dbaf7',
      agentType: 'general-purpose',
      transcriptPath: '/home/u/.claude/projects/p/sess.jsonl',
      backgroundTasks: null,
      waitTarget: null,
    });
  });

  it('пустой agent_type — null (SubagentStop часто шлёт пустую строку); нет полей — null', async () => {
    const [stop, bare] = await read(
      raw({ hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: '' }) +
        raw({ hook_event_name: 'Stop' }),
    );

    expect(stop).toMatchObject({ agentId: 'a1', agentType: null });
    expect(bare).toMatchObject({
      agentId: null,
      agentType: null,
      transcriptPath: null,
      backgroundTasks: null,
      waitTarget: null,
    });
  });

  it('значения не строк в agent_id, agent_type и transcript_path — null, строка не теряется', async () => {
    const events = await read(
      raw({
        hook_event_name: 'SubagentStart',
        agent_id: 42,
        agent_type: { x: 1 },
        transcript_path: ['a'],
      }) + raw({ hook_event_name: 'Stop' }),
    );

    expect(events.map((item) => item.name)).toEqual(['SubagentStart', 'Stop']);
    expect(events[0]).toMatchObject({ agentId: null, agentType: null, transcriptPath: null });
  });

  it('background_tasks: задачи разобраны; пустое описание и тип агента — null', async () => {
    const [event] = await read(
      raw({
        hook_event_name: 'Stop',
        background_tasks: [
          {
            id: 'a4a0fb93b5a2dbaf7',
            type: 'subagent',
            status: 'running',
            agent_type: 'general-purpose',
            description: 'Orca mobile app research',
          },
          { id: 'b2', type: 'subagent', status: 'completed', agent_type: '', description: '' },
        ],
      }),
    );

    expect(event?.backgroundTasks).toEqual([
      {
        id: 'a4a0fb93b5a2dbaf7',
        type: 'subagent',
        status: 'running',
        agentType: 'general-purpose',
        description: 'Orca mobile app research',
      },
      { id: 'b2', type: 'subagent', status: 'completed', agentType: null, description: null },
    ]);
  });

  it('background_tasks: [] — поле есть, задач нет; без поля — null', async () => {
    const [empty, absent] = await read(
      raw({ hook_event_name: 'Stop', background_tasks: [] }) + raw({ hook_event_name: 'Stop' }),
    );

    expect(empty?.backgroundTasks).toEqual([]);
    expect(absent?.backgroundTasks).toBeNull();
  });

  it('кривые элементы background_tasks пропускаются, остальные и сама строка живут', async () => {
    const [event] = await read(
      raw({
        hook_event_name: 'SubagentStop',
        agent_id: 'a1',
        background_tasks: [
          null,
          7,
          'строка',
          [],
          {},
          { id: 'без-статуса', type: 'subagent' },
          { id: '', type: 'subagent', status: 'running' },
          { id: 12, type: 'subagent', status: 'running' },
          { id: 'без-типа', status: 'running' },
          { id: 'ok', type: 'subagent', status: 'running', description: 5 },
        ],
      }),
    );

    expect(event?.name).toBe('SubagentStop');
    expect(event?.agentId).toBe('a1');
    expect(event?.backgroundTasks).toEqual([
      { id: 'ok', type: 'subagent', status: 'running', agentType: null, description: null },
    ]);
  });

  it('background_tasks не массив — как отсутствующее поле: прежний снимок не затирается', async () => {
    const events = await read(
      raw({ hook_event_name: 'Stop', background_tasks: 'нет' }) +
        raw({ hook_event_name: 'Stop', background_tasks: { id: 'a' } }) +
        raw({ hook_event_name: 'Stop', background_tasks: null }),
    );

    expect(events.map((item) => item.backgroundTasks)).toEqual([null, null, null]);
  });

  it('ParleyWaitStart несёт parley_wait_target, ParleyWaitEnd — нет', async () => {
    const [start, end, bad] = await read(
      raw({ hook_event_name: 'ParleyWaitStart', parley_wait_target: 's-03' }) +
        raw({ hook_event_name: 'ParleyWaitEnd' }) +
        raw({ hook_event_name: 'ParleyWaitStart', parley_wait_target: 5 }),
    );

    expect(start).toMatchObject({ name: 'ParleyWaitStart', waitTarget: 's-03' });
    expect(end).toMatchObject({ name: 'ParleyWaitEnd', waitTarget: null });
    expect(bad).toMatchObject({ name: 'ParleyWaitStart', waitTarget: null });
  });

  it('parley_wait_id у обеих строк ожидания; без него и не строка — null', async () => {
    const [start, end, oldStart, oldEnd, bad] = await read(
      raw({
        hook_event_name: 'ParleyWaitStart',
        parley_wait_target: 's-03',
        parley_wait_id: 'w-1',
      }) +
        raw({ hook_event_name: 'ParleyWaitEnd', parley_wait_id: 'w-1' }) +
        raw({ hook_event_name: 'ParleyWaitStart', parley_wait_target: 's-03' }) +
        raw({ hook_event_name: 'ParleyWaitEnd' }) +
        raw({ hook_event_name: 'ParleyWaitEnd', parley_wait_id: 7 }),
    );

    expect(start).toMatchObject({ waitTarget: 's-03', waitId: 'w-1' });
    expect(end).toMatchObject({ waitTarget: null, waitId: 'w-1' });
    expect(oldStart?.waitId).toBeNull();
    expect(oldEnd?.waitId).toBeNull();
    expect(bad?.waitId).toBeNull();
  });

  it('source у SessionStart доходит до события; пустой и не строка — null', async () => {
    const [startup, resume, empty, none, bad] = await read(
      raw({ hook_event_name: 'SessionStart', source: 'startup' }) +
        raw({ hook_event_name: 'SessionStart', source: 'resume' }) +
        raw({ hook_event_name: 'SessionStart', source: '' }) +
        raw({ hook_event_name: 'SessionStart' }) +
        raw({ hook_event_name: 'SessionStart', source: 3 }),
    );

    expect(startup?.source).toBe('startup');
    expect(resume?.source).toBe('resume');
    expect(empty?.source).toBeNull();
    expect(none?.source).toBeNull();
    expect(bad?.source).toBeNull();
  });
});

describe('eventRecordOf: поля ошибки и инструмента', () => {
  const AT = '2026-10-12T10:00:00.000Z';
  /** Шесть полей этой задачи, когда в stdin хука их нет. */
  const NO_EXTRA = {
    error: null,
    errorDetails: null,
    lastAssistantMessage: null,
    message: null,
    toolName: null,
    toolDetail: null,
  };

  it('StopFailure из документации: error, error_details и last_assistant_message', () => {
    const event = eventRecordOf(
      {
        hook_event_name: 'StopFailure',
        session_id: 'abc123',
        transcript_path: '/home/u/.claude/projects/p/abc123.jsonl',
        cwd: '/home/u/p',
        error: 'rate_limit',
        error_details: '429 Too Many Requests',
        last_assistant_message: 'API Error: Rate limit reached',
      },
      AT,
    );

    expect(event).toMatchObject({
      at: AT,
      name: 'StopFailure',
      error: 'rate_limit',
      errorDetails: '429 Too Many Requests',
      lastAssistantMessage: 'API Error: Rate limit reached',
      message: null,
      toolName: null,
      toolDetail: null,
    });
  });

  it('Notification: message доходит до события вместе с notification_type', () => {
    const event = eventRecordOf(
      {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      },
      AT,
    );

    expect(event).toMatchObject({
      notificationType: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
      error: null,
      toolName: null,
    });
  });

  it('PermissionRequest Bash: tool_name и команда из tool_input', () => {
    const event = eventRecordOf(
      {
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf node_modules', description: 'Remove dependencies' },
        permission_suggestions: [],
      },
      AT,
    );

    expect(event).toMatchObject({
      name: 'PermissionRequest',
      toolName: 'Bash',
      toolDetail: 'rm -rf node_modules',
      error: null,
      errorDetails: null,
      lastAssistantMessage: null,
      message: null,
    });
  });

  it.each([
    ['Bash', { command: 'git status' }, 'git status'],
    ['Edit', { file_path: '/p/src/a.ts', old_string: 'a', new_string: 'b' }, '/p/src/a.ts'],
    ['Write', { file_path: '/p/src/b.ts', content: 'x' }, '/p/src/b.ts'],
    ['MultiEdit', { file_path: '/p/src/c.ts', edits: [] }, '/p/src/c.ts'],
    ['NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'x' }, '/p/n.ipynb'],
  ])('toolDetail у %s — команда или путь файла', (toolName, toolInput, expected) => {
    const event = eventRecordOf(
      { hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput },
      AT,
    );

    expect(event).toMatchObject({ toolName, toolDetail: expected });
  });

  it.each([
    ['Read', { file_path: '/p/src/a.ts' }],
    ['Grep', { pattern: 'x', path: '/p' }],
    ['mcp__parley__wait_for', { target: 's-02' }],
    // Чужое поле своего инструмента: путь у Bash и команда у Edit детали не дают.
    ['Bash', { file_path: '/p/a.ts' }],
    ['Edit', { command: 'ls' }],
    ['NotebookEdit', { file_path: '/p/a.ts' }],
    ['Bash', { command: '' }],
    ['Bash', { command: 42 }],
    ['Bash', 'ls'],
    ['Bash', ['ls']],
    ['Bash', null],
  ])('toolDetail у %s при tool_input %j — null', (toolName, toolInput) => {
    const event = eventRecordOf(
      { hook_event_name: 'PermissionRequest', tool_name: toolName, tool_input: toolInput },
      AT,
    );

    expect(event?.toolName).toBe(toolName);
    expect(event?.toolDetail).toBeNull();
  });

  it('toolDetail: длинная многострочная команда — одна строка не длиннее NEED_DETAIL_MAX, оборванная на …', () => {
    const command = `echo start\n${'x'.repeat(500)}\necho end`;
    const event = eventRecordOf(
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command } },
      AT,
    );

    expect(event?.toolDetail).not.toContain('\n');
    expect(event?.toolDetail).toHaveLength(NEED_DETAIL_MAX);
    expect(event?.toolDetail?.startsWith('echo start xxx')).toBe(true);
    expect(event?.toolDetail?.endsWith('…')).toBe(true);
  });

  it('Stop без этих полей и bareEvent: все шесть полей — null', () => {
    const stop = eventRecordOf(
      { hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [] },
      AT,
    );

    expect(stop).toMatchObject(NO_EXTRA);
    expect(bareEvent(AT, 'Stop')).toMatchObject(NO_EXTRA);
  });

  // У настоящих `Stop` и `SubagentStop` в last_assistant_message лежит весь последний ответ, а события живут
  // в памяти хоста всю сессию: поле нужно только `StopFailure` (там текст ошибки со временем сброса).
  it.each(['Stop', 'SubagentStop'])(
    '%s: длинный last_assistant_message и error_details не читаются — null',
    (name) => {
      const big = 'x'.repeat(50_000);
      const event = eventRecordOf(
        { hook_event_name: name, last_assistant_message: big, error_details: big },
        AT,
      );

      expect(event).toMatchObject({ name, lastAssistantMessage: null, errorDetails: null });
    },
  );

  it('StopFailure: last_assistant_message и error_details читаются', () => {
    const event = eventRecordOf(
      {
        hook_event_name: 'StopFailure',
        last_assistant_message: 'API Error: Rate limit reached',
        error_details: '429 Too Many Requests',
      },
      AT,
    );

    expect(event).toMatchObject({
      lastAssistantMessage: 'API Error: Rate limit reached',
      errorDetails: '429 Too Many Requests',
    });
  });

  it('пустые строки и значения не строк — null, событие не теряется', () => {
    const event = eventRecordOf(
      {
        hook_event_name: 'StopFailure',
        error: 7,
        error_details: { code: 429 },
        last_assistant_message: '',
        message: ['x'],
        tool_name: false,
        // Без имени инструмента команда деталью не становится.
        tool_input: { command: 'ls' },
      },
      AT,
    );

    expect(event).toMatchObject({ name: 'StopFailure', ...NO_EXTRA });
  });

  it('строка StopFailure из журнала events/ несёт те же поля', async () => {
    await writeFile(
      journal(),
      raw({
        hook_event_name: 'StopFailure',
        error: 'rate_limit',
        error_details: '429 Too Many Requests',
        last_assistant_message: "You've hit your session limit · resets 2:50pm (Europe/Moscow)",
      }),
      'utf8',
    );

    const [event] = (await openEvents(dir).read(SESSION)) ?? [];

    expect(event).toMatchObject({
      name: 'StopFailure',
      error: 'rate_limit',
      errorDetails: '429 Too Many Requests',
      lastAssistantMessage: "You've hit your session limit · resets 2:50pm (Europe/Moscow)",
    });
  });

  it('в журнале events/ ответ держит только StopFailure: у Stop с длинным ответом поле — null', async () => {
    await writeFile(
      journal(),
      raw({ hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(50_000) }) +
        raw({
          hook_event_name: 'StopFailure',
          error: 'rate_limit',
          last_assistant_message: 'API Error: Rate limit reached',
        }),
      'utf8',
    );

    const events = (await openEvents(dir).read(SESSION)) ?? [];

    expect(events.map((event) => event.lastAssistantMessage)).toEqual([
      null,
      'API Error: Rate limit reached',
    ]);
  });
});

describe('watchEvents', () => {
  it('на изменение журнала отдаёт id сессии', async () => {
    await mkdir(dir, { recursive: true });
    const seen: string[] = [];
    const watcher = watchEvents(dir, (sessionId) => seen.push(sessionId), { debounceMs: 10 });

    try {
      // fs.watch включается не сразу: запись в окно между вызовом и включением (macOS, под нагрузкой — до сотен
      // миллисекунд) не приходит событием вовсе. Проверяется, что дописывание отдаёт id сессии, а не гонка с
      // включением, поэтому дописываем, пока событие не придёт.
      const deadline = Date.now() + 10_000;
      while (seen.length === 0 && Date.now() < deadline) {
        await appendFile(journal(), line('UserPromptSubmit'), 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      watcher.close();
    }

    expect(seen).toContain(SESSION);
  }, 20_000);
});
