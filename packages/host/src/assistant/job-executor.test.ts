import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_TOKEN_PREFIX, type ProviderEntry } from '@parley/core';
import { claimsDoneAction, createJobExecutor, JOB_PROMPT, type JobExecutorDeps } from './job-executor.js';
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
    const file = spec.args[spec.args.indexOf('--mcp-config') + 1];
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
