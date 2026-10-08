import { describe, expect, it } from 'vitest';
import {
  createUsageLedger,
  freezeUsage,
  legacyUsage,
  selectUsage,
  sumUsage,
  usageKey,
  withDescendants,
  type DescendantUsage,
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

  it('перекрытие, которое нечем разрешить: запись не учтена, итог неполный', () => {
    const ledger = createUsageLedger();
    ledger.observe(delta('msg:parent'));
    ledger.markAmbiguous();
    expect(ledger.summary()).toMatchObject({ input: 10, completeness: 'partial' });
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

describe('usageKey', () => {
  it('провайдер, нативный id и эпоха различают потомков; Claude и его надстройки — одно семейство логов', () => {
    const base = usageKey('codex', 'thread-1', '2026-10-04T12:00:00.000Z');
    expect(usageKey('codex', 'thread-1', '2026-10-04T12:00:00.000Z')).toBe(base);
    expect(usageKey('claude', 'thread-1', '2026-10-04T12:00:00.000Z')).not.toBe(base);
    expect(usageKey('codex', 'thread-2', '2026-10-04T12:00:00.000Z')).not.toBe(base);
    expect(usageKey('codex', 'thread-1', '2026-10-04T13:00:00.000Z')).not.toBe(base);
    expect(usageKey('codex', 'thread-1', null)).not.toBe(base);
  });
});

describe('withDescendants', () => {
  const child = (id: string, over: Partial<UsageSummary> = {}, extra: Partial<DescendantUsage> = {}): DescendantUsage => ({
    key: usageKey('claude', id, '2026-10-04T12:00:00.000Z'),
    usage: summary({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalInput: 8, ...over }),
    ...extra,
  });
  const parent = summary({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalInput: 80 });

  it('без потомков итог разговора как есть', () => {
    expect(withDescendants(parent, [])).toBe(parent);
  });

  it('родитель плюс потомок: счётчики складываются, охват — с потомками, полнота сохраняется', () => {
    const total = withDescendants(parent, [child('a1', { observedAt: '2026-10-04T12:00:09.000Z' })]);
    expect(total).toMatchObject({
      input: 11,
      output: 22,
      cacheRead: 33,
      cacheWrite: 44,
      totalInput: 88,
      coverage: 'conversation-and-descendants',
      completeness: 'complete',
      observedAt: '2026-10-04T12:00:09.000Z',
      source: 'native-index',
    });
  });

  it('один потомок в двух видах входит один раз, побеждает более свежее наблюдение', () => {
    const total = withDescendants(parent, [
      child('a1', { input: 1, observedAt: '2026-10-04T12:00:01.000Z' }),
      child('a1', { input: 5, observedAt: '2026-10-04T12:00:05.000Z' }),
    ]);
    expect(total).toMatchObject({ input: 15, completeness: 'complete' });
  });

  it('потомок с другой эпохой — другой потомок', () => {
    const other: DescendantUsage = { ...child('a1'), key: usageKey('claude', 'a1', '2026-10-04T15:00:00.000Z') };
    expect(withDescendants(parent, [child('a1'), other])).toMatchObject({ input: 12 });
  });

  it('перекрытие без доказательства: потомок не прибавляется, итог неполный и охват прежний', () => {
    const total = withDescendants(parent, [child('a1', {}, { overlapUnresolved: true })]);
    expect(total).toMatchObject({ input: 10, output: 20, completeness: 'partial', coverage: 'conversation' });
  });

  it('доказанный потомок прибавляется, неразрешённый — нет: итог неполный', () => {
    const total = withDescendants(parent, [child('a1'), child('a2', { input: 100 }, { overlapUnresolved: true })]);
    expect(total).toMatchObject({ input: 11, completeness: 'partial', coverage: 'conversation-and-descendants' });
  });

  it('потомок без наблюдений не обнуляет и не выдумывает: итог неполный', () => {
    const none = child('a1', { input: null, output: null, cacheRead: null, cacheWrite: null, totalInput: null, completeness: 'unknown' });
    expect(withDescendants(parent, [none])).toMatchObject({ input: 10, completeness: 'partial', coverage: 'conversation' });
  });

  it('поле известно не у всех слагаемых — сумма неизвестна и итог неполный; Codex: кэш записи неизвестен у всех', () => {
    const mixed = withDescendants(parent, [child('a1', { cacheWrite: null, totalInput: null })]);
    expect(mixed).toMatchObject({ input: 11, cacheWrite: null, totalInput: null, completeness: 'partial' });

    const codex = (id: string, input: number) => ({
      key: usageKey('codex', id, null),
      usage: summary({ input, cacheWrite: null }),
    });
    const together = withDescendants(summary({ cacheWrite: null }), [codex('t1', 5)]);
    expect(together).toMatchObject({ input: 15, cacheWrite: null, completeness: 'complete' });
  });

  it('у самого разговора нет цифр: потомки в неизвестное не складываются', () => {
    const unknown = summary({ input: null, output: null, cacheRead: null, cacheWrite: null, totalInput: null, completeness: 'unknown' });
    expect(withDescendants(unknown, [child('a1')])).toBe(unknown);
  });

  it('неполное слагаемое и устаревшее наблюдение делают весь итог неполным и устаревшим', () => {
    const total = withDescendants(parent, [child('a1', { completeness: 'partial', stale: true })]);
    expect(total).toMatchObject({ completeness: 'partial', stale: true });
  });

  it('в итог не попадают ключи потомков', () => {
    expect(JSON.stringify(withDescendants(parent, [child('native-agent-id')]))).not.toContain('native-agent-id');
  });
});

describe('sumUsage с потомками', () => {
  const key = (id: string) => usageKey('codex', id, '2026-10-04T12:00:00.000Z');
  const kid = (id: string, input: number, extra: Partial<DescendantUsage> = {}): DescendantUsage => ({
    key: key(id),
    usage: summary({ input, cacheWrite: null }),
    ...extra,
  });
  const own = (input: number) => summary({ input, cacheWrite: null });

  it('потомок, увиденный из родителя и как отдельный разговор, входит один раз', () => {
    const total = sumUsage([
      { key: 'codex\u0000parent', usage: own(10), descendants: [kid('child', 5)] },
      { key: key('child'), usage: own(5) },
    ]);
    expect(total).toMatchObject({ input: 15, coverage: 'conversation-and-descendants', completeness: 'complete', conversations: 2 });
  });

  it('один потомок у родителя в двух видах — один раз', () => {
    const total = sumUsage([
      { key: 'codex\u0000parent', usage: own(10), descendants: [kid('child', 5)] },
      { key: 'codex\u0000parent', usage: own(10), descendants: [kid('child', 5)] },
    ]);
    expect(total).toMatchObject({ input: 15, conversations: 1 });
  });

  it('неразрешённое перекрытие и потомок без наблюдений: итог неполный, чужие цифры не прибавлены', () => {
    const none = kid('empty', 0, { usage: summary({ input: null, output: null, cacheRead: null, cacheWrite: null, totalInput: null, completeness: 'unknown' }) });
    const total = sumUsage([
      { key: 'codex\u0000parent', usage: own(10), descendants: [kid('fork', 50, { overlapUnresolved: true }), none] },
    ]);
    expect(total).toMatchObject({ input: 10, completeness: 'partial', coverage: 'conversation' });
  });
});
