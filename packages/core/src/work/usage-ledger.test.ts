import { describe, expect, it } from 'vitest';
import {
  createUsageLedger,
  freezeUsage,
  legacyUsage,
  selectUsage,
  sumUsage,
  type UsageCounters,
  type UsageSummary,
} from './usage-ledger.js';

const counters = (over: Partial<UsageCounters> = {}): UsageCounters => ({
  input: 10,
  output: 5,
  cacheRead: 100,
  cacheWrite: 20,
  totalInput: 130,
  ...over,
});

const delta = (id: string, over: Partial<UsageCounters> = {}, at: string | null = '2026-10-04T12:00:00.000Z') =>
  ({ kind: 'delta' as const, id, counters: counters(over), at });

const cumulative = (
  value: Partial<UsageCounters>,
  extra: { stream?: string; reset?: boolean; at?: string } = {},
) => ({
  kind: 'cumulative' as const,
  stream: extra.stream ?? 'rollout',
  ...(extra.reset === undefined ? {} : { reset: extra.reset }),
  counters: counters(value),
  at: extra.at ?? '2026-10-04T12:00:00.000Z',
});

/** Итог индекса с заданными счётчиками и временем последней записи. */
function summary(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    ...counters(),
    source: 'native-index',
    observedAt: '2026-10-04T12:00:01.000Z',
    stale: false,
    completeness: 'complete',
    coverage: 'conversation',
    ...over,
  };
}

describe('createUsageLedger', () => {
  it('без наблюдений всё неизвестно, а не ноль', () => {
    expect(createUsageLedger().summary()).toMatchObject({
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      totalInput: null,
      completeness: 'unknown',
    });
  });

  it('частичные дубли одного запроса считаются один раз, неполные поля дополняются из более полной записи', () => {
    const ledger = createUsageLedger();
    // Claude пишет ответ несколькими записями; в первой выход ещё не дорос и записи кэша нет.
    ledger.observe(delta('msg:1', { output: 2, cacheWrite: null, totalInput: null }));
    ledger.observe(delta('msg:1', { output: 5 }));
    ledger.observe(delta('msg:1'));
    ledger.observe(delta('msg:2', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalInput: 1 }));

    expect(ledger.summary()).toMatchObject({
      input: 11,
      output: 6,
      cacheRead: 100,
      cacheWrite: 20,
      totalInput: 131,
      completeness: 'complete',
    });
  });

  it('кэш у Codex не наблюдается: запись остаётся null, полнота не страдает, итог входа не удваивается', () => {
    const ledger = createUsageLedger();
    // `input_tokens` Codex уже включает кэш: 1000 всего, из них 30 из кэша.
    ledger.observe(cumulative({ input: 970, output: 200, cacheRead: 30, cacheWrite: null, totalInput: 1000 }));

    expect(ledger.summary()).toMatchObject({
      input: 970,
      cacheRead: 30,
      cacheWrite: null,
      totalInput: 1000,
      completeness: 'complete',
    });
  });

  it('поле есть не у всех записей — сумма неизвестна, итог неполный; а не заниженное число', () => {
    const ledger = createUsageLedger();
    ledger.observe(delta('msg:1'));
    ledger.observe(delta('msg:2', { cacheWrite: null, totalInput: null }));

    expect(ledger.summary()).toMatchObject({ input: 20, cacheWrite: null, totalInput: null, completeness: 'partial' });
  });

  it('накопительное значение растёт — берётся последнее, повтор той же записи его не меняет', () => {
    const ledger = createUsageLedger();
    ledger.observe(cumulative({ input: 100, output: 20 }));
    ledger.observe(cumulative({ input: 1000, output: 200 }));
    ledger.observe(cumulative({ input: 1000, output: 200 }));

    expect(ledger.summary()).toMatchObject({ input: 1000, output: 200, completeness: 'complete' });
  });

  it('спад накопителя без доказанного сброса не суммируется: остаётся наибольшее, итог неполный', () => {
    const ledger = createUsageLedger();
    ledger.observe(cumulative({ input: 1000, output: 200 }));
    ledger.observe(cumulative({ input: 50, output: 10 }));

    expect(ledger.summary()).toMatchObject({ input: 1000, output: 200, completeness: 'partial' });
  });

  it('доказанный сброс закрывает период и прибавляет его: ничего не теряется и не удваивается', () => {
    const ledger = createUsageLedger();
    ledger.observe(cumulative({ input: 1000, output: 200 }));
    ledger.observe(cumulative({ input: 50, output: 10 }, { reset: true }));
    ledger.observe(cumulative({ input: 80, output: 30 }));

    expect(ledger.summary()).toMatchObject({ input: 1080, output: 230, completeness: 'complete' });
  });

  it('ротация: нити разных файлов складываются, одна и та же нить из двух видов — один раз', () => {
    const ledger = createUsageLedger();
    ledger.observe(cumulative({ input: 100, output: 20 }, { stream: 'file-a' }));
    ledger.observe(cumulative({ input: 40, output: 8 }, { stream: 'file-b' }));
    // Тот же файл прочитан вторым видом — прежние значения.
    ledger.observe(cumulative({ input: 100, output: 20 }, { stream: 'file-a' }));

    expect(ledger.summary()).toMatchObject({ input: 140, output: 28, completeness: 'complete' });
  });

  it('потомок с тем же id запроса, что и у родителя, учитывается один раз и помечает охват', () => {
    const ledger = createUsageLedger();
    ledger.observe(delta('msg:parent'));
    ledger.observe({ ...delta('msg:child'), child: true });
    ledger.observe({ ...delta('msg:child'), child: true });

    expect(ledger.summary()).toMatchObject({ input: 20, coverage: 'conversation-and-descendants' });
  });

  it('значение не из неотрицательных целых становится неизвестным, а не нулём', () => {
    const ledger = createUsageLedger();
    ledger.observe(delta('msg:1', { output: -3, cacheRead: 1.5 }));

    expect(ledger.summary()).toMatchObject({ output: null, cacheRead: null, input: 10 });
  });

  it('время наблюдения — время последней записи', () => {
    const ledger = createUsageLedger();
    ledger.observe(delta('msg:1', {}, '2026-10-04T12:00:05.000Z'));
    ledger.observe(delta('msg:2', {}, '2026-10-04T12:00:02.000Z'));

    expect(ledger.summary().observedAt).toBe('2026-10-04T12:00:05.000Z');
  });
});

describe('selectUsage', () => {
  const epoch = '2026-10-04T12:00:00.000Z';
  const frozen = (over: Partial<UsageSummary> = {}, closed = true) =>
    freezeUsage(
      summary({ input: 100, output: 20, cacheRead: null, cacheWrite: null, totalInput: null, observedAt: '2026-10-04T11:00:00.000Z', ...over }),
      { binding: 'native-thread', epoch, closed },
    );

  it('идущая сессия: свежий живой индекс 1000/200 побеждает снимок 100/20', () => {
    const result = selectUsage({
      active: true,
      epoch,
      live: summary({ input: 1000, output: 200 }),
      frozen: frozen(),
    });
    expect(result).toMatchObject({ input: 1000, output: 200, source: 'native-index', stale: false });
  });

  it('индекс с последней записью до запуска процесса не побеждает: снимок остаётся, помеченный устаревшим', () => {
    const result = selectUsage({
      active: true,
      epoch,
      live: summary({ input: 1000, output: 200, observedAt: '2026-10-04T11:00:00.000Z' }),
      frozen: frozen(),
    });
    expect(result).toMatchObject({ input: 100, output: 20, source: 'frozen-snapshot', stale: true });
  });

  it('допуск часов: запись на пару секунд раньше запуска ещё свежая', () => {
    const result = selectUsage({
      active: true,
      epoch,
      live: summary({ input: 1000, output: 200, observedAt: '2026-10-04T11:59:57.000Z' }),
      frozen: frozen(),
    });
    expect(result.source).toBe('native-index');
  });

  it('индекс без времени записи при известной эпохе не считается свежим', () => {
    const result = selectUsage({
      active: true,
      epoch,
      live: summary({ input: 1000, output: 200, observedAt: null }),
      frozen: frozen(),
    });
    expect(result).toMatchObject({ input: 100, source: 'frozen-snapshot', stale: true });
  });

  it('эпоха неизвестна (процесс поднимал не Parley) — проверка эпохи пропускается', () => {
    const result = selectUsage({ active: true, epoch: null, live: summary({ input: 1000, output: 200 }), frozen: frozen() });
    expect(result).toMatchObject({ input: 1000, source: 'native-index' });
  });

  it('индекс похудел против снимка (ротация, усечение): наибольшие поля и нижняя граница, а не откат', () => {
    const result = selectUsage({
      active: true,
      epoch,
      live: summary({ input: 40, output: 30, cacheRead: 5, cacheWrite: 1, totalInput: 46 }),
      frozen: frozen({ input: 100, output: 20, cacheRead: 7, cacheWrite: 2, totalInput: 109 }),
    });
    expect(result).toMatchObject({
      input: 100,
      output: 30,
      cacheRead: 7,
      cacheWrite: 2,
      totalInput: 109,
      source: 'native-index',
      completeness: 'partial',
    });
  });

  it('остановленная сессия: снимок сна — закрытый период, как есть, без пометки устаревшего', () => {
    const result = selectUsage({
      active: false,
      epoch,
      live: summary({ input: 1000, output: 200 }),
      frozen: frozen(),
    });
    expect(result).toMatchObject({ input: 100, output: 20, source: 'frozen-snapshot', stale: false, observedAt: '2026-10-04T11:00:00.000Z' });
  });

  it('остановленная сессия со снимком report (снят посреди работы): индекс 1000/200 не теряется', () => {
    const result = selectUsage({
      active: false,
      epoch,
      live: summary({ input: 1000, output: 200 }),
      frozen: frozen({}, false),
    });
    expect(result).toMatchObject({ input: 1000, output: 200, source: 'native-index', stale: false });
  });

  it('остановленная сессия со снимком report и усечённым логом: наибольшие поля, нижняя граница', () => {
    const result = selectUsage({
      active: false,
      epoch,
      live: summary({ input: 50, output: 30 }),
      frozen: frozen({}, false),
    });
    expect(result).toMatchObject({ input: 100, output: 30, completeness: 'partial', source: 'native-index' });
  });

  it('снимок сна другой эпохи — не закрытый период этого запуска', () => {
    const result = selectUsage({
      active: false,
      epoch: '2026-10-04T13:00:00.000Z',
      live: summary({ input: 1000, output: 200 }),
      frozen: frozen(),
    });
    expect(result).toMatchObject({ input: 1000, output: 200, source: 'native-index' });
  });

  it('остановленная сессия со снимком report и без лога: снимок помечен устаревшим', () => {
    const result = selectUsage({ active: false, epoch, live: null, frozen: frozen({}, false) });
    expect(result).toMatchObject({ input: 100, source: 'frozen-snapshot', stale: true });
  });

  it('снимка нет — берётся индекс; нет и его — всё неизвестно, а не ноль', () => {
    expect(selectUsage({ active: false, epoch, live: summary(), frozen: null })).toMatchObject({ source: 'native-index', input: 10 });
    expect(selectUsage({ active: true, epoch, live: null, frozen: null })).toMatchObject({
      source: 'unavailable',
      input: null,
      output: null,
      completeness: 'unknown',
      stale: true,
    });
  });

  it('снимок до P36 даёт вход и выход, а кэш и полный вход неизвестны', () => {
    const result = selectUsage({ active: false, epoch, live: null, frozen: legacyUsage({ input: 100, output: 20 }) });
    expect(result).toMatchObject({
      source: 'legacy-snapshot',
      input: 100,
      output: 20,
      cacheRead: null,
      cacheWrite: null,
      totalInput: null,
      completeness: 'unknown',
      observedAt: null,
    });
  });

  it('наружу не попадают связывание, эпоха и посторонние поля карты', () => {
    const result = selectUsage({
      active: false,
      epoch,
      live: null,
      frozen: { ...frozen(), transcript: '/home/me/.claude/projects/x/y.jsonl' } as UsageSummary,
    });
    expect(Object.keys(result).sort()).toEqual(
      ['cacheRead', 'cacheWrite', 'completeness', 'coverage', 'input', 'observedAt', 'output', 'source', 'stale', 'totalInput'].sort(),
    );
    expect(JSON.stringify(result)).not.toMatch(/native-thread|transcript|\.jsonl/);
  });
});

describe('sumUsage', () => {
  it('один разговор в двух видах входит один раз, побеждает более свежее наблюдение', () => {
    const total = sumUsage([
      { key: 'claude\u0000thread-1', usage: summary({ input: 100, observedAt: '2026-10-04T12:00:00.000Z' }) },
      { key: 'claude\u0000thread-1', usage: summary({ input: 150, observedAt: '2026-10-04T12:05:00.000Z' }) },
      { key: 'codex\u0000thread-2', usage: summary({ input: 7 }) },
    ]);
    expect(total).toMatchObject({ input: 157, conversations: 2, completeness: 'complete' });
  });

  it('неизвестное поле одного слагаемого делает неизвестной сумму, неполное слагаемое — весь итог', () => {
    const total = sumUsage([
      { key: 'a', usage: summary() },
      { key: 'b', usage: summary({ cacheWrite: null, totalInput: null, completeness: 'partial', stale: true }) },
    ]);
    expect(total).toMatchObject({ input: 20, cacheWrite: null, totalInput: null, completeness: 'partial', stale: true });
  });

  it('без слагаемых итог неизвестен', () => {
    expect(sumUsage([])).toMatchObject({ input: null, completeness: 'unknown', conversations: 0 });
  });
});
