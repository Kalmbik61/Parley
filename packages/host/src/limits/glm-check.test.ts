/** Исход явной проверки ключа Z.ai: файл (атомарно, без секретов), отпечаток ключа, событие окнам. */
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGlmCheckService,
  glmCheckOptionsFromEnv,
  readGlmCheck,
  writeGlmCheck,
  type GlmCheckOptions,
  type GlmCheckRecord,
} from './glm-check.js';

const KEY = 'synthetic-key';
const T0 = Date.parse('2026-10-05T09:30:00.000Z');

let dir = '';
let file = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-glm-check-'));
  file = path.join(dir, 'glm-check.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fingerprint = (key: string): string => createHash('sha256').update(key).digest('hex');

const message = (): Response =>
  new Response(JSON.stringify({ type: 'message', content: [] }), { status: 200 });
const rejected = (): Response =>
  new Response(JSON.stringify({ error: { code: '1000', message: KEY } }), { status: 401 });

describe('файл исхода', () => {
  it('запись читается обратно той же; успех — без причины', async () => {
    const failed: GlmCheckRecord = {
      state: 'failed', reason: 'limit_reached', httpStatus: 429, code: '1308',
      at: '2026-10-05T09:30:00.000Z', keyFingerprint: fingerprint(KEY),
    };
    await writeGlmCheck(failed, file);
    expect(await readGlmCheck(file)).toEqual(failed);
    const ok: GlmCheckRecord = { state: 'ok', at: '2026-10-05T09:31:00.000Z', keyFingerprint: fingerprint(KEY) };
    await writeGlmCheck(ok, file);
    expect(await readGlmCheck(file)).toEqual(ok);
  });

  it('отсутствующий, битый и чужой файл — null, без ошибки', async () => {
    expect(await readGlmCheck(file)).toBeNull();
    const fp = fingerprint(KEY);
    for (const text of [
      '',
      'not json',
      '{}',
      '[]',
      JSON.stringify({ state: 'nope', at: 'x', keyFingerprint: fp }),
      JSON.stringify({ state: 'ok', at: '', keyFingerprint: fp }),
      JSON.stringify({ state: 'ok', reason: 'timeout', at: 'x', keyFingerprint: fp }),
      JSON.stringify({ state: 'failed', at: 'x', keyFingerprint: fp }),
      JSON.stringify({ state: 'failed', reason: 'strange', at: 'x', keyFingerprint: fp }),
      JSON.stringify({ state: 'failed', reason: 'timeout', at: 'x' }),
      JSON.stringify({ state: 'failed', reason: 'rate_limited', httpStatus: 42, at: 'x', keyFingerprint: fp }),
      JSON.stringify({ state: 'failed', reason: 'rate_limited', httpStatus: 429.5, at: 'x', keyFingerprint: fp }),
      JSON.stringify({ state: 'failed', reason: 'rate_limited', code: 'text', at: 'x', keyFingerprint: fp }),
    ]) {
      await writeFile(file, text, 'utf8');
      expect(await readGlmCheck(file), text).toBeNull();
    }
  });
});

describe('служба проверки', () => {
  const service = (options: GlmCheckOptions = {}) => {
    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let now = T0;
    const glm = createGlmCheckService(
      { log, broadcast: (event, data) => broadcasts.push({ event, data }) },
      { file, now: () => now, ...options },
    );
    return { glm, broadcasts, log, tick: (ms: number) => { now += ms; } };
  };

  it('без проверки исхода нет; успех — в памяти и в файле, вместо ключа отпечаток', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => message());
    const { glm } = service({ fetch });
    expect(await glm.current(KEY)).toBeNull();
    expect(await glm.run(KEY)).toEqual({ state: 'ok', at: new Date(T0).toISOString() });
    expect(await glm.current(KEY)).toEqual({ state: 'ok', at: new Date(T0).toISOString() });
    const stored = await readFile(file, 'utf8');
    expect(JSON.parse(stored)).toMatchObject({ state: 'ok', keyFingerprint: fingerprint(KEY) });
    expect(stored).not.toContain(KEY);
  });

  it('отказ переживает перезапуск хоста: новая служба читает файл без сети', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => rejected());
    const first = service({ fetch });
    expect(await first.glm.run(KEY)).toMatchObject({ state: 'failed', reason: 'authentication', httpStatus: 401, code: '1000' });
    const second = service({ fetch });
    expect(await second.glm.current(KEY)).toMatchObject({ state: 'failed', reason: 'authentication' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('другой ключ — исход прежнего про него ничего не говорит; ключа нет — тоже null', async () => {
    const { glm } = service({ fetch: vi.fn<typeof globalThis.fetch>(async () => message()) });
    await glm.run(KEY);
    expect(await glm.current('rotated-key')).toBeNull();
    expect(await glm.current(null)).toBeNull();
  });

  it('providers.changed — на новый исход, а не на время того же', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => message());
    const { glm, broadcasts, tick } = service({ fetch });
    await glm.run(KEY);
    expect(broadcasts).toEqual([{ event: 'providers.changed', data: { provider: 'glm' } }]);
    broadcasts.length = 0;
    tick(60_000);
    expect(await glm.run(KEY)).toEqual({ state: 'ok', at: new Date(T0 + 60_000).toISOString() });
    expect(broadcasts).toEqual([]);
    fetch.mockImplementation(async () => rejected());
    await glm.run(KEY);
    expect(broadcasts).toEqual([{ event: 'providers.changed', data: { provider: 'glm' } }]);
  });

  it('параллельные проверки одного ключа делят один запрос', async () => {
    let answer: (response: Response) => void = () => {};
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const { glm } = service({ fetch });
    const first = glm.run(KEY);
    const second = glm.run(KEY);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    answer(message());
    expect(await first).toEqual(await second);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('файл не записался — исход всё равно отдаётся, сбой уходит в журнал', async () => {
    const { glm, log } = service({ fetch: vi.fn<typeof globalThis.fetch>(async () => message()), file: path.join(dir, 'missing', '\0bad') });
    expect(await glm.run(KEY)).toMatchObject({ state: 'ok' });
    expect(log.warn).toHaveBeenCalled();
  });

  it('журнал получает исход без ключа', async () => {
    const { glm, log } = service({ fetch: vi.fn<typeof globalThis.fetch>(async () => rejected()) });
    await glm.run(KEY);
    expect(JSON.stringify(log.info.mock.calls)).toContain('authentication');
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toContain(KEY);
  });

  it('рычаг E2E: исход без сети, на диск не пишется, журнал помечает подмену', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { glm, log } = service({ fetch, stub: { state: 'failed', reason: 'limit_reached' } });
    expect(await glm.run(KEY)).toEqual({ state: 'failed', reason: 'limit_reached', at: new Date(T0).toISOString() });
    expect(fetch).not.toHaveBeenCalled();
    await expect(access(file)).rejects.toThrow();
    expect(JSON.stringify(log.info.mock.calls)).toContain('"stub":true');
    // Служба без рычага (переменную убрали) подменённого исхода не видит.
    expect(await service({ fetch }).glm.current(KEY)).toBeNull();
  });

  it('поздний ответ проверки прежнего ключа не затирает исход нового', async () => {
    let answerOld: (response: Response) => void = () => {};
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { answerOld = resolve; }))
      .mockImplementationOnce(async () => message());
    const { glm } = service({ fetch });
    const old = glm.run('old-key');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(await glm.run(KEY)).toMatchObject({ state: 'ok' });
    answerOld(rejected());
    // Звавшему исход отдаётся, но записывается только самая новая проверка.
    expect(await old).toMatchObject({ state: 'failed', reason: 'authentication' });
    expect(await glm.current(KEY)).toMatchObject({ state: 'ok' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ state: 'ok', keyFingerprint: fingerprint(KEY) });
  });

  it('forget: исход и файл забыты, идущая проверка своего исхода уже не запишет', async () => {
    let answer: (response: Response) => void = () => {};
    const fetch = vi.fn<typeof globalThis.fetch>(async () => message());
    const { glm } = service({ fetch });
    await glm.run(KEY);
    await glm.forget();
    expect(await glm.current(KEY)).toBeNull();
    await expect(access(file)).rejects.toThrow();
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const pending = glm.run(KEY);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await glm.forget();
    answer(message());
    await pending;
    expect(await glm.current(KEY)).toBeNull();
    await expect(access(file)).rejects.toThrow();
    // После forget новая проверка того же ключа идёт своим запросом, а не ждёт отменённую.
    expect(await glm.run(KEY)).toMatchObject({ state: 'ok' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('forget во время записи файла: удаление идёт после записи, файла не остаётся', async () => {
    const { glm } = service({ fetch: vi.fn<typeof globalThis.fetch>(async () => message()) });
    const pending = glm.run(KEY);
    // Запись исхода и forget поставлены в очередь диска почти одновременно.
    await vi.waitFor(async () => expect(await glm.current(KEY)).not.toBeNull());
    const forgotten = glm.forget();
    await Promise.all([pending, forgotten]);
    await expect(access(file)).rejects.toThrow();
    expect(await glm.current(KEY)).toBeNull();
  });

  it('forget во время чтения файла не воскрешает прежний исход', async () => {
    await writeGlmCheck({ state: 'ok', at: '2026-10-05T09:00:00.000Z', keyFingerprint: fingerprint(KEY) }, file);
    const { glm } = service({ fetch: vi.fn<typeof globalThis.fetch>() });
    const reading = glm.current(KEY);
    await glm.forget();
    await reading;
    expect(await glm.current(KEY)).toBeNull();
  });
});

describe('glmCheckOptionsFromEnv', () => {
  it('ok и причины из закрытого списка дают исход без сети; прочее — настоящая проверка', () => {
    expect(glmCheckOptionsFromEnv({ PARLEY_GLM_CHECK_STUB: 'ok' })).toEqual({ stub: { state: 'ok' } });
    expect(glmCheckOptionsFromEnv({ PARLEY_GLM_CHECK_STUB: 'authentication' })).toEqual({
      stub: { state: 'failed', reason: 'authentication' },
    });
    expect(glmCheckOptionsFromEnv({ HARNAS_GLM_CHECK_STUB: ' network ' })).toEqual({
      stub: { state: 'failed', reason: 'network' },
    });
    for (const value of [undefined, '', 'yes', 'OK', 'constructor']) {
      expect(glmCheckOptionsFromEnv({ PARLEY_GLM_CHECK_STUB: value })).toBeUndefined();
    }
  });
});
