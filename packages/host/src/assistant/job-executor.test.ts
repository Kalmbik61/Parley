import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HumanOverviewV1 } from '@parley/protocol';
import { JOB_TOKEN_PREFIX, type ProviderEntry } from '@parley/core';
import { openMemoryDb } from '@parley/core';
import { claimsDoneAction, createJobExecutor, JOB_PROMPT, JOB_PROMPT_AUTO, SUMMARY_PROMPT, SUMMARY_TURN_MS, type JobExecutorDeps } from './job-executor.js';
import { createJobPrompt } from './job-context.js';
import { createJobs } from './jobs.js';
import { createRequests } from './requests.js';
import { createServiceMessages } from './service-messages.js';
import type { ReplySnapshot } from './reply-snapshot.js';
import { createJobTokens, type JobTokens } from './job-tokens.js';
import type { Job } from './jobs.js';
import type { TurnEnd, TurnHandle, TurnSpec } from './turn.js';

const job = { jobId: 'job-1', provider: 'claude', requestText: 'close the tab', correlation: { mode: 'text' } } as unknown as Job;
const entry = { id: 'claude', label: 'Claude', runner: { command: 'claude', mcpConfig: 'json-file', assistantArgs: ['-p', '{prompt}', '--mcp-config', '{mcpConfig}', '--system-prompt', '{systemPrompt}'] } } as unknown as ProviderEntry;
const codexEntry = { id: 'codex', label: 'Codex', runner: { command: 'codex', mcpConfig: 'codex-override', assistantArgs: ['exec', '-c', '{mcpConfig}', '-c', '{developerInstructions}', '{prompt}'] } } as unknown as ProviderEntry;

let cwd = '';
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'parley-job-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

function setup(end: TurnEnd, extra: Partial<JobExecutorDeps> & { text?: string; during?: (tokens: JobTokens, token: string) => void; provider?: ProviderEntry } = {}) {
  const { text = 'Closed it.', during, provider = entry, ...rest } = extra;
  const tokens = createJobTokens(() => 1);
  const specs: TurnSpec[] = [];
  const cancel = vi.fn();
  const run = vi.fn((spec: TurnSpec, onEvent: (event: never) => void): TurnHandle => {
    specs.push(spec);
    // Здесь же идёт «работа» job: токен действует, инструменты вызываются через хост.
    const at = spec.args.indexOf('--mcp-config');
    const file = at < 0 ? undefined : spec.args[at + 1];
    const config = file === undefined ? spec.args.join(' ') : readFileSync(file, 'utf8');
    const token = config.match(/job_[0-9a-f]+/)?.[0] ?? '';
    during?.(tokens, token);
    (onEvent as (event: { type: 'text'; delta: string }) => void)({ type: 'text', delta: text });
    return { cancel, done: Promise.resolve(end) };
  });
  const execute = createJobExecutor({
    providers: async () => ({ claude: provider, codex: codexEntry }),
    ready: async () => null,
    launchEnv: async () => ({}),
    binary: async (command) => `/bin/${command}`,
    cwd,
    endpointUrl: () => 'http://127.0.0.1:9/assistant',
    tokens,
    now: () => 500,
    run: run as unknown as JobExecutorDeps['run'],
    ...rest,
  });
  return { execute, specs, run, cancel, tokens };
}

describe('job executor', () => {
  it('отдельный прогон с текстом job; VA-09: чтение завершается completed с toolRefs от хоста', async () => {
    const { execute, specs } = setup(
      { ok: true },
      {
        text: 'Anna is working in the Auth room.',
        during: (tokens, token) => {
          const jobId = tokens.jobOf(token)!;
          tokens.recordTool(jobId, 'parley_overview', true);
          tokens.recordTool(jobId, 'parley_detail', true);
        },
      },
    );
    await expect(execute(job).done).resolves.toEqual({
      ok: true,
      summary: 'Anna is working in the Auth room.',
      outcome: 'completed',
      result: {
        answer: 'Anna is working in the Auth room.',
        capturedAt: 500,
        cards: [],
        toolRefs: [
          { tool: 'parley_overview', ok: true, at: 1 },
          { tool: 'parley_detail', ok: true, at: 1 },
        ],
      },
    });
    expect(specs[0]).toMatchObject({ command: '/bin/claude', cwd });
    expect(specs[0]!.args).toContain('close the tab');
  });

  it('VA-10: подготовленная карточка попадает в result.cards, job completed, а действия нет', async () => {
    const { execute } = setup(
      { ok: true },
      {
        text: 'I prepared a message to Anna; it waits for your confirmation.',
        during: (tokens, token) => {
          const jobId = tokens.jobOf(token)!;
          tokens.recordTool(jobId, 'propose_message', true);
          tokens.recordCard(jobId, { cardId: 'p3', kind: 'message' });
        },
      },
    );
    const end = await execute(job).done;
    expect(end).toMatchObject({ ok: true, outcome: 'completed', result: { cards: [{ cardId: 'p3', kind: 'message' }] } });
  });

  it('действие заявлено без карточки — needs_confirmation, успех не объявляется', async () => {
    const { execute } = setup({ ok: true }, { text: 'I sent the message to Anna.' });
    await expect(execute(job).done).resolves.toMatchObject({ ok: true, outcome: 'needs_confirmation', result: { cards: [] } });
    const russian = setup({ ok: true }, { text: 'Я отправила сообщение Анне.' });
    await expect(russian.execute(job).done).resolves.toMatchObject({ outcome: 'needs_confirmation' });
  });

  it('распознавание заявленного действия: осторожно, но чтение не страдает', () => {
    for (const text of ['I sent it.', "I've created the room", 'Готово. Отправил.', 'Я закрыла сессию', 'Создал комнату Auth.']) expect(claimsDoneAction(text)).toBe(true);
    for (const text of ['Anna is working.', 'The session was closed yesterday.', 'Я не отправил, нужна карточка.', 'Сессия закрыта вчера.', 'Prepared a message; waits for confirmation.', 'не знаю']) {
      expect(claimsDoneAction(text)).toBe(false);
    }
  });

  const propose = (tokens: JobTokens, token: string): void => {
    const jobId = tokens.jobOf(token)!;
    tokens.recordTool(jobId, 'propose_message', true);
    tokens.recordCard(jobId, { cardId: 'p7', kind: 'message' });
  };

  it('лимит после карточки: повтора нет, needs_confirmation, карточка в result', async () => {
    const { execute } = setup({ ok: false, kind: 'limit', message: 'You hit your limit' }, { text: '', during: propose });
    const end = await execute(job).done;
    expect(end).toMatchObject({ ok: true, outcome: 'needs_confirmation', result: { answer: '', cards: [{ cardId: 'p7', kind: 'message' }] } });
    if (end.ok) expect(end.summary).toContain('limit');
  });

  it('timeout и сбой после карточки — тоже needs_confirmation с карточкой', async () => {
    for (const failure of [{ ok: false, kind: 'timeout', message: 'too slow' }, { ok: false, kind: 'other', message: 'crash' }] as const) {
      const { execute } = setup(failure, { text: '', during: propose });
      await expect(execute(job).done).resolves.toMatchObject({ ok: true, outcome: 'needs_confirmation', result: { cards: [{ cardId: 'p7' }] } });
    }
  });

  it('сбой без карточек остаётся сбоем: лимит возвращается в очередь, прочее failed', async () => {
    const { execute } = setup({ ok: false, kind: 'limit', message: 'You hit your limit' }, { text: '' });
    await expect(execute(job).done).resolves.toMatchObject({ ok: false, kind: 'limit' });
  });

  it('пустой ответ с карточкой — completed с answer пустым', async () => {
    const { execute } = setup({ ok: true }, { text: '', during: propose });
    await expect(execute(job).done).resolves.toMatchObject({ ok: true, outcome: 'completed', summary: '', result: { answer: '', cards: [{ cardId: 'p7' }] } });
  });

  it('cancel после карточки: partial() отдаёт карточки, прогон кончается cancelled', async () => {
    const noop = () => {};
    let release: (end: TurnEnd) => void = noop;
    const tokens = createJobTokens(() => 1);
    const execute = createJobExecutor({
      providers: async () => ({ claude: entry }),
      ready: async () => null,
      launchEnv: async () => ({}),
      binary: async (command) => command,
      cwd,
      endpointUrl: () => 'http://127.0.0.1:9/assistant',
      tokens,
      now: () => 9,
      run: ((spec: TurnSpec) => {
        const config = readFileSync(spec.args[spec.args.indexOf('--mcp-config') + 1]!, 'utf8');
        propose(tokens, config.match(/job_[0-9a-f]+/)![0]);
        return { cancel: () => release({ ok: false, kind: 'cancelled', message: 'cancelled' }), done: new Promise<TurnEnd>((resolve) => (release = resolve)) };
      }) as unknown as JobExecutorDeps['run'],
    });
    const run = execute(job);
    await vi.waitFor(() => expect(release).not.toBe(noop));
    const partial = run.partial!();
    run.cancel();
    expect(partial).toEqual({ answer: '', capturedAt: 9, cards: [{ cardId: 'p7', kind: 'message' }], toolRefs: [{ tool: 'propose_message', ok: true, at: 1 }] });
    await expect(run.done).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
  });

  it('пустой ответ без карточек — не готовый ответ: job failed (other), а не completed', async () => {
    const { execute } = setup({ ok: true }, { text: '   ' });
    await expect(execute(job).done).resolves.toEqual({ ok: false, kind: 'other', message: 'The run finished without a reply' });
  });

  it('у job свой токен в MCP: не токен разговора, действует только пока идёт прогон', async () => {
    let seen = '';
    let whileRunning: string | null = null;
    const { execute, specs, tokens } = setup(
      { ok: true },
      {
        during: (t, token) => {
          seen = token;
          whileRunning = t.jobOf(token);
        },
      },
    );
    await execute(job).done;
    expect(seen.startsWith(JOB_TOKEN_PREFIX)).toBe(true);
    expect(whileRunning).toBe('job-1');
    expect(tokens.jobOf(seen)).toBeNull(); // после прогона токен отозван
    expect(specs[0]!.args).toContain('--mcp-config');
    // Файл конфига с токеном прогона удалён.
    expect((await readdir(cwd)).filter((name) => name.startsWith('job-'))).toEqual([]);
  });

  it('конфиг MCP — в приватном файле, с адресом хоста и токеном job; промпт job — в --system-prompt', async () => {
    let configPath = '';
    let contents = '';
    const run = vi.fn((spec: TurnSpec): TurnHandle => {
      configPath = spec.args[spec.args.indexOf('--mcp-config') + 1]!;
      contents = '';
      return { cancel: vi.fn(), done: readFile(configPath, 'utf8').then((text) => { contents = text; return { ok: true } as TurnEnd; }) };
    });
    const { execute, specs } = setup({ ok: true }, { run: run as unknown as JobExecutorDeps['run'], text: '' });
    void specs;
    await execute(job).done;
    const parsed = JSON.parse(contents) as { mcpServers: Record<string, { env: Record<string, string> }> };
    const server = Object.values(parsed.mcpServers)[0]!;
    expect(server.env['PARLEY_ASSISTANT_URL']).toBe('http://127.0.0.1:9/assistant');
    expect(server.env['PARLEY_ASSISTANT_TOKEN']!.startsWith(JOB_TOKEN_PREFIX)).toBe(true);
    const args = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(JOB_PROMPT);
  });

  it('Codex получает токен job в -c и промпт job файлом', async () => {
    const { execute, specs } = setup({ ok: true }, { provider: codexEntry });
    await execute({ ...job, provider: 'codex' } as Job).done;
    const args = specs[0]!.args;
    expect(args.some((arg) => arg.includes('PARLEY_ASSISTANT_TOKEN="job_'))).toBe(true);
    expect(args.some((arg) => arg.startsWith('model_instructions_file='))).toBe(true);
  });

  it('JOB_PROMPT: 1–3 предложения, имена вместо id, «не знаю», link_request первым шагом, запись только карточкой', () => {
    expect(JOB_PROMPT).toContain('one to three short plain sentences');
    expect(JOB_PROMPT).toContain('never by ids');
    expect(JOB_PROMPT).toContain('не знаю');
    expect(JOB_PROMPT).toMatch(/first step is to call link_request/);
    expect(JOB_PROMPT).toContain('propose_*');
  });

  it('JOB_PROMPT: на вопрос о статусе — request_status, который только читает', () => {
    expect(JOB_PROMPT).toContain('call request_status');
    expect(JOB_PROMPT).toContain('never repeats the work');
  });

  it('сервер хуков не поднят — start, токен не выдаётся', async () => {
    const { execute, run, tokens } = setup({ ok: true }, { endpointUrl: () => null });
    await expect(execute(job).done).resolves.toMatchObject({ ok: false, kind: 'start' });
    expect(run).not.toHaveBeenCalled();
    expect(tokens.jobOf('job_anything')).toBeNull();
  });

  it("текст лимита в kind 'other' классифицируется как limit", async () => {
    const { execute } = setup({ ok: false, kind: 'other', message: 'You hit your limit, resets at 5pm' });
    await expect(execute(job).done).resolves.toEqual({ ok: false, kind: 'limit', message: 'You hit your limit, resets at 5pm' });
  });

  it('провайдер не готов или неизвестен — start, прогон не запускается', async () => {
    const notReady = setup({ ok: true }, { ready: async () => 'sign in first' });
    await expect(notReady.execute(job).done).resolves.toEqual({ ok: false, kind: 'start', message: 'sign in first' });
    expect(notReady.run).not.toHaveBeenCalled();
    const unknown = setup({ ok: true }, { providers: async () => ({}) });
    await expect(unknown.execute(job).done).resolves.toMatchObject({ ok: false, kind: 'start' });
  });

  it('cancel гасит идущий прогон и отзывает токен', async () => {
    const noop = () => {};
    let release: (end: TurnEnd) => void = noop;
    const cancel = vi.fn(() => release({ ok: false, kind: 'cancelled', message: 'cancelled' }));
    const tokens = createJobTokens();
    const execute = createJobExecutor({
      providers: async () => ({ claude: entry }),
      ready: async () => null,
      launchEnv: async () => ({}),
      binary: async (command) => command,
      cwd,
      endpointUrl: () => 'http://127.0.0.1:9/assistant',
      tokens,
      run: (() => ({ cancel, done: new Promise<TurnEnd>((resolve) => (release = resolve)) })) as unknown as JobExecutorDeps['run'],
    });
    const run = execute(job);
    // Ждём, пока прогон дойдёт до run(): cancel до этого отменил бы старт, а не процесс.
    await vi.waitFor(() => expect(release).not.toBe(noop));
    run.cancel();
    await expect(run.done).resolves.toMatchObject({ ok: false, kind: 'cancelled' });
    expect(cancel).toHaveBeenCalled();
  });

  it('рабочая папка создаётся до запуска процесса', async () => {
    const order: string[] = [];
    const { execute, run } = setup({ ok: true }, { ensureDir: async (dir) => void order.push(`mkdir ${dir}`) });
    run.mockImplementationOnce(() => {
      order.push('run');
      return { cancel: vi.fn(), done: Promise.resolve({ ok: true }) } as TurnHandle;
    });
    await execute(job).done;
    expect(order).toEqual([`mkdir ${cwd}`, 'run']);
  });

  it('promptOf: модель получает вход job (контекст Request), а не только текст; без него — текст поручения', async () => {
    const withContext = setup({ ok: true }, { promptOf: (item) => `${item.requestText}\n[context]` });
    await withContext.execute(job).done;
    expect(withContext.specs[0]!.args).toContain('close the tab\n[context]');
    const plain = setup({ ok: true });
    await plain.execute(job).done;
    expect(plain.specs[0]!.args).toContain('close the tab');
  });

  it('JOB_PROMPT велит начать с link_request и не произносить id Request', () => {
    expect(JOB_PROMPT).toContain('call link_request');
    expect(JOB_PROMPT).toContain('Request ids are only for link_request');
  });
});


it('H11: normalizes the final human job answer before summary and result storage', async () => {
  const { execute } = setup({ ok: true }, {
    text: '[[calm]] s-257 @s123 room:abc:w-123:r-123 r-123 work:abc:w-123 w-123 session:abc:w-123:s-257 works-123 S256abc.',
    during: (tokens, token) => {
      tokens.recordTool(tokens.jobOf(token)!, 'parley_overview', true);
      tokens.recordCard(tokens.jobOf(token)!, { cardId: 'p3', kind: 'message' });
    },
  });
  const end = await execute(job).done;
  expect(end).toMatchObject({ ok: true, result: { cards: [{ cardId: 'p3', kind: 'message' }], toolRefs: [{ tool: 'parley_overview', ok: true, at: 1 }] } });
  if (!end.ok) throw new Error('Expected completed job');
  expect(end.summary).toBe(end.result.answer);
  expect(end.summary).not.toMatch(/\[\[|s-257|@s123|room:|r-123|work:|w-123|session:/);
  expect(end.summary).toContain('works-123 S256abc.');
});


it('uses the permitted overview names for S01, mentions and full refs, preserving arbitrary S24', async () => {
  const ref = 'session:abc:w-1:s-01';
  const overview = { rooms: [{ ref: 'room:abc:w-1:r-1', title: 'Auth', workLabel: 'Parley', members: [{ ref, displayName: 'Anna' }] }], unassignedSessions: [] } as unknown as HumanOverviewV1;
  const { execute } = setup({ ok: true }, {
    text: `[[calm]] S01 @s01 ${ref} s-01 uses S24.`,
    during: (tokens, token) => {
      const id = tokens.jobOf(token)!;
      tokens.recordOverview(id, overview);
      tokens.recordTool(id, 'parley_overview', true);
      tokens.recordCard(id, { cardId: 'p1', kind: 'message' });
    },
  });
  await expect(execute(job).done).resolves.toMatchObject({
    ok: true, summary: 'Anna Anna Anna Anna uses S24.',
    result: { answer: 'Anna Anna Anna Anna uses S24.', cards: [{ cardId: 'p1', kind: 'message' }], toolRefs: [{ tool: 'parley_overview', ok: true, at: 1 }] },
  });
});

describe('запись допуска job (автономия, A2)', () => {
  it.each([
    ['island', true, true],
    ['island', false, false],
    ['telegram', true, false],
  ] as const)('job с происхождением %s при флаге %s: autoAtStart = %s', async (origin, flag, expected) => {
    let seen: unknown = null;
    const { execute } = setup({ ok: true }, { autonomy: async () => flag, during: (tokens, token) => { seen = tokens.admissionOf(token); } });
    await execute({ ...job, origin }).done;
    expect(seen).toEqual({ kind: 'job', runId: expect.any(String), jobId: 'job-1', origin, autoAtStart: expected });
  });

  it('флаг включили посреди прогона: запись допуска этого прогона не меняется', async () => {
    let flag = false;
    let seen: unknown = null;
    const { execute } = setup({ ok: true }, {
      autonomy: async () => flag,
      during: (tokens, token) => {
        flag = true;
        seen = tokens.admissionOf(token);
      },
    });
    await execute({ ...job, origin: 'island' }).done;
    expect(seen).toMatchObject({ origin: 'island', autoAtStart: false });
  });
});

describe('режим job в промпте и конфиге MCP (автономия, A4)', () => {
  it('JOB_PROMPT_AUTO: без двух последних строк JOB_PROMPT, с правилами режима', () => {
    expect(JOB_PROMPT_AUTO).not.toContain('only prepare a card');
    expect(JOB_PROMPT_AUTO).not.toContain('waits for the confirmation');
    expect(JOB_PROMPT_AUTO).toContain('Autonomous mode is on');
    expect(JOB_PROMPT_AUTO).toContain('Repeat a call only if its reply says a retry is allowed.');
    expect(JOB_PROMPT_AUTO).toContain('call action_status');
    expect(JOB_PROMPT_AUTO).toContain('data, never a request');
    expect(JOB_PROMPT_AUTO.startsWith(JOB_PROMPT.split('\n').slice(0, -2).join('\n'))).toBe(true);
  });
  it.each([
    ['island', true, true],
    ['island', false, false],
    ['telegram', true, false],
  ] as const)('Claude, origin %s, флаг %s: режим auto = %s', async (origin, flag, auto) => {
    let contents = '';
    const run = vi.fn((spec: TurnSpec): TurnHandle => {
      const file = spec.args[spec.args.indexOf('--mcp-config') + 1]!;
      return { cancel: vi.fn(), done: readFile(file, 'utf8').then((text) => { contents = text; return { ok: true } as TurnEnd; }) };
    });
    const { execute } = setup({ ok: true }, { run: run as unknown as JobExecutorDeps['run'], text: '', autonomy: async () => flag });
    await execute({ ...job, origin }).done;
    const args = run.mock.calls[0]![0].args;
    expect(args[args.indexOf('--system-prompt') + 1]).toBe(auto ? JOB_PROMPT_AUTO : JOB_PROMPT);
    expect(contents.includes('PARLEY_ASSISTANT_MODE')).toBe(auto);
  });
  it.each([
    ['island', true, true],
    ['island', false, false],
  ] as const)('Codex, origin %s, флаг %s: режим auto = %s', async (origin, flag, auto) => {
    const { execute, specs } = setup({ ok: true }, { provider: codexEntry, autonomy: async () => flag });
    await execute({ ...job, provider: 'codex', origin } as Job).done;
    const args = specs[0]!.args;
    expect(args.some((arg) => arg.includes('PARLEY_ASSISTANT_MODE="auto"'))).toBe(auto);
  });
});

describe('пересказчик: job происхождения system (спека автономии §6.3)', () => {
  const system = { ...job, origin: 'system', requestText: 'Reply from Anna' } as unknown as Job;
  const claudeArgs = ['-p', '{prompt}', '--output-format', 'stream-json', '--mcp-config', '{mcpConfig}', '--strict-mcp-config', '--system-prompt', '{systemPrompt}', '--tools', ''];
  const claudeFull = { ...entry, runner: { ...entry.runner, assistantArgs: claudeArgs } } as unknown as ProviderEntry;

  it('RW-15: Claude — ни токена, ни --mcp-config, ни файла MCP; срок 90 секунд; промпт SUMMARY_PROMPT', async () => {
    const { execute, specs, tokens } = setup({ ok: true }, { provider: claudeFull, text: 'Anna says it is ready.' });
    const issue = vi.spyOn(tokens, 'issue');
    await expect(execute(system).done).resolves.toMatchObject({ ok: true, outcome: 'completed', summary: 'Anna says it is ready.', result: { cards: [], toolRefs: [] } });
    const spec = specs[0]!;
    expect(issue).not.toHaveBeenCalled();
    expect(spec.args).not.toContain('--mcp-config');
    expect(spec.args).toContain('--strict-mcp-config');
    expect(spec.args.join(' ')).not.toMatch(/job_[0-9a-f]+|parley-assistant|link_request/);
    expect(spec.args[spec.args.indexOf('--system-prompt') + 1]).toBe(SUMMARY_PROMPT);
    expect(spec.timeoutMs).toBe(90_000);
    expect(SUMMARY_TURN_MS).toBe(90_000);
    expect(JSON.stringify(spec.env)).not.toMatch(/job_[0-9a-f]+/);
  });

  it('RW-15: Codex — нет -c mcp_servers и токена; инструкции — SUMMARY_PROMPT', async () => {
    let instructions = '';
    const run = vi.fn((spec: TurnSpec): TurnHandle => {
      const arg = spec.args.find((item) => item.startsWith('model_instructions_file='))!;
      instructions = readFileSync(JSON.parse(arg.slice('model_instructions_file='.length)) as string, 'utf8');
      return { cancel: vi.fn(), done: Promise.resolve({ ok: true } as TurnEnd) };
    });
    const { execute, specs } = setup({ ok: true }, { provider: codexEntry, text: 'Done.', run: run as unknown as JobExecutorDeps['run'] });
    await execute({ ...system, provider: 'codex' } as Job).done;
    const args = run.mock.calls[0]![0].args;
    void specs;
    expect(args.some((arg) => arg.includes('mcp_servers') || /job_[0-9a-f]+/.test(arg))).toBe(false);
    expect(args.filter((arg) => arg === '-c')).toHaveLength(1);
    expect(instructions).toBe(SUMMARY_PROMPT);
    expect(instructions).toContain('You tell the person what one of their agents has just answered');
    expect(instructions).not.toContain('link_request');
    expect(run.mock.calls[0]![0].timeoutMs).toBe(90_000);
  });

  it('SUMMARY_PROMPT: без строк JOB_PROMPT и link_request; есть строка про итог действия', () => {
    expect(SUMMARY_PROMPT).not.toContain('link_request');
    for (const line of JOB_PROMPT.split('\n')) expect(SUMMARY_PROMPT.split('\n')).not.toContain(line);
    expect(SUMMARY_PROMPT).toContain('whether it is safe to try again');
  });

  it('«I sent the report» у пересказчика — completed, а не needs_confirmation', async () => {
    const { execute } = setup({ ok: true }, { text: 'Anna says I sent the report.' });
    await expect(execute(system).done).resolves.toMatchObject({ ok: true, outcome: 'completed' });
  });

  it('пустой ответ — failed', async () => {
    const { execute } = setup({ ok: true }, { text: '' });
    await expect(execute(system).done).resolves.toMatchObject({ ok: false });
  });

  it('обычный job по-прежнему с токеном и MCP', async () => {
    const { execute, specs } = setup({ ok: true });
    await execute(job).done;
    expect(specs[0]!.args).toContain('--mcp-config');
  });

  const snapshot = (extra: Partial<ReplySnapshot>): ReplySnapshot => ({ event: 'turn-end', key: 'k1', session: 'S02 Anna', reply: null, replyNote: null, waiting: null, lastLetter: null, ...extra });

  /** Настоящие jobs и Request; выполнение подставное: вход прогона записывается. */
  function chain() {
    const db = openMemoryDb();
    const inputs: string[] = [];
    const ref = { projectPath: '/p', workId: 'w-1', sessionId: 's-2' };
    const holder: { prompt?: (j: Job) => string } = {};
    const tokens = createJobTokens(() => 1);
    const run = vi.fn((spec: TurnSpec, onEvent: (event: never) => void): TurnHandle => {
      inputs.push(spec.args[spec.args.indexOf('-p') + 1]!);
      (onEvent as (event: { type: 'text'; delta: string }) => void)({ type: 'text', delta: 'Anna finished the report.' });
      return { cancel: vi.fn(), done: Promise.resolve({ ok: true } as TurnEnd) };
    });
    const jobs = createJobs({
      db,
      defaultProvider: () => 'claude',
      capPerProvider: 50,
      execute: createJobExecutor({
        providers: async () => ({ claude: claudeFull }),
        ready: async () => null,
        launchEnv: async () => ({}),
        binary: async (command) => `/bin/${command}`,
        cwd,
        endpointUrl: () => 'http://127.0.0.1:9/assistant',
        tokens,
        promptOf: (j) => holder.prompt?.(j) ?? j.requestText,
        run: run as unknown as JobExecutorDeps['run'],
      }),
    });
    const requests = createRequests({ db, jobs });
    holder.prompt = createJobPrompt({ requests, jobs });
    const messages = createServiceMessages({ requests, jobs, takeResult: () => true, autonomous: () => true, note: () => undefined });
    return { messages, requests, inputs, ref, jobs };
  }
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('RW-19 + RW-08/09: событие слежения → Request → job → вход со снимком → completed; закреплённый текст, пропуск и отметка в конце', async () => {
    const h = chain();
    const reply = `${'a'.repeat(1500)}\n[… 14000 characters omitted …]\nConclusion: the report is ready.`;
    const view = h.messages.watchEvent({ event: 'turn-end', key: 'k1', ref: h.ref, name: 'S02 Anna', snapshot: snapshot({ reply, lastLetter: 'Please prepare the report' }) } as never);
    expect(view).not.toBeNull();
    await settled();
    expect(h.inputs).toHaveLength(1);
    const input = h.inputs[0]!;
    expect(input).toContain('Agent: S02 Anna. Its turn ended.');
    expect(input.endsWith('Please prepare the report')).toBe(true);
    expect(input).toContain('[… 14000 characters omitted …]\nConclusion: the report is ready.');
    expect(input).not.toMatch(/link_request|s-2|w-1|requestId/);
    expect(h.jobs.getJob(view!.job.jobId)).toMatchObject({ state: 'completed', resultSummary: 'Anna finished the report.' });
  });

  it('RW-09: «прочитать не удалось» и ожидание человека доходят до входа', () => {
    const prompt = createJobPrompt({ requests: { byJob: () => ({ origin: 'system', context: { service: 'watch', event: 'turn-end', name: 'S02 Anna', snapshot: snapshot({ replyNote: 'the reply could not be read' }) } }), openBefore: () => [] } as never, jobs: {} as never });
    expect(prompt(system)).toContain('Note: the reply could not be read.');
    const waiting = createJobPrompt({
      requests: { byJob: () => ({ origin: 'system', context: { service: 'watch', event: 'needs-human', name: 'S02 Anna', earlierReplies: 1, snapshot: snapshot({ event: 'needs-human', waiting: { kind: 'permission', detail: null, card: { type: 'permission', text: 'Bash npm test' } } }) } }), openBefore: () => [] } as never,
      jobs: {} as never,
    })(system);
    expect(waiting).toContain('waiting for the person: permission');
    expect(waiting).toContain('Bash npm test');
    expect(waiting).toContain('replaces 1 earlier reply');
  });

  it('итог действия: статус, сделанное, причина, можно ли повторять; без id карточки', () => {
    const outcome = { status: 'partial', effects: ['message to Auth'], retry: 'unsafe', reason: 'stopped at step 2 of 2' };
    const text = createJobPrompt({ requests: { byJob: () => ({ origin: 'system', context: { service: 'outcome', cardId: 'p1', kind: 'actions', outcome } }), openBefore: () => [] } as never, jobs: {} as never })(system);
    expect(text).toContain('Outcome of an action: partial.');
    expect(text).toContain('Done: message to Auth.');
    expect(text).toContain('Reason: stopped at step 2 of 2');
    expect(text).toContain('not safe');
    expect(text).not.toMatch(/\bp1\b/);
  });
});
