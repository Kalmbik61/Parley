import { watch } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForMap, type MapChanges } from './watch-map.js';

/**
 * `fs.watch` проходит через шпиона (спека хранилища 6.9): после переезда карты в базу файла, за которым следить, нет,
 * и ожидание не должно заводить файловый наблюдатель вовсе — ни с внешним сигналом, ни без него.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

/**
 * Личность работы, как её отдаёт `workVersionKey`: номер версии строкой или `null`, если работы нет. Тест двигает её
 * сам — `bump` изображает запись, `current = null` — исчезнувшую работу.
 */
let current: string | null = '1';
let version = 1;
const identity = (): string | null => current;
const bump = (): void => {
  current = String(++version);
};
/** Отмена ожиданий теста: он гасит ими свои ожидания, а `afterEach` — те, что упавший тест не довёл до конца. */
let cancel = new AbortController();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tick = (): Promise<void> => delay(30);

/** Внешний источник сигнала, как `onWorksChange` у хоста: один слушатель; `fire` — «карта изменилась». */
function source(): { changes: MapChanges; fire: () => void; listening: () => boolean } {
  let listener: (() => void) | null = null;
  return {
    changes: (onChange) => {
      listener = onChange;
      return () => {
        listener = null;
      };
    },
    fire: () => listener!(),
    listening: () => listener !== null,
  };
}

beforeEach(() => {
  current = '1';
  version = 1;
  cancel = new AbortController();
  vi.mocked(watch).mockClear();
});

afterEach(() => {
  cancel.abort();
});

describe('waitForMap', () => {
  it('внешний сигнал будит ожидание без fs.watch и отписывается', async () => {
    let listener: (() => void) | null = null;
    const changes: MapChanges = (onChange) => {
      listener = onChange;
      return () => {
        listener = null;
      };
    };
    let ready = false;
    const waiting = waitForMap(identity, async () => (ready ? 'ok' : null), 5_000, 60_000, undefined, changes);
    // Подписка заводится после первой пробы: ждём её, а не спим, и только тогда даём пробе увидеть «готово».
    await vi.waitFor(() => expect(listener).not.toBeNull());
    ready = true;
    bump();
    listener!();
    await expect(waiting).resolves.toBe('ok');
    expect(listener).toBeNull();
    expect(watch).not.toHaveBeenCalled();
  });

  it('пока личность не менялась, проба не зовётся', async () => {
    let calls = 0;
    let listener: (() => void) | null = null;
    const changes: MapChanges = (onChange) => {
      listener = onChange;
      return () => {};
    };
    const abort = new AbortController();
    const waiting = waitForMap(
      identity,
      async () => {
        calls++;
        return null;
      },
      5_000,
      60_000,
      abort.signal,
      changes,
    );
    await vi.waitFor(() => expect(listener).not.toBeNull());
    listener!();
    listener!();
    // Отсутствие пробы ждать нечем: пауза даёт лишнему вызову, если бы он был, успеть.
    await tick();
    expect(calls).toBe(1);
    bump();
    listener!();
    await vi.waitFor(() => expect(calls).toBe(2));
    abort.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('два сигнала подряд на изменившейся работе зовут пробу один раз', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      identity,
      async () => {
        calls++;
        return null;
      },
      5_000,
      60_000,
      cancel.signal,
      changes,
    );
    await vi.waitFor(() => expect(listening()).toBe(true));
    bump();
    fire();
    fire();
    fire();
    await vi.waitFor(() => expect(calls).toBe(2));
    // Лишних проб не было бы и позже: пауза даёт им, если бы они были, успеть.
    await tick();
    expect(calls).toBe(2);
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('запись во время пробы не теряется: личность берётся до пробы', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      identity,
      async () => {
        calls++;
        // Работу переписали, пока первая проба её читала: следующий повод обязан это заметить.
        if (calls === 1) bump();
        return null;
      },
      5_000,
      60_000,
      cancel.signal,
      changes,
    );
    await vi.waitFor(() => expect(listening()).toBe(true));
    fire();
    await vi.waitFor(() => expect(calls).toBe(2));
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('работы нет (личность null) — проба зовётся на каждый повод', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      identity,
      async () => {
        calls++;
        return null;
      },
      5_000,
      60_000,
      cancel.signal,
      changes,
    );
    await vi.waitFor(() => expect(listening()).toBe(true));
    current = null;
    fire();
    fire();
    await vi.waitFor(() => expect(calls).toBe(3));
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('функция личности бросила — это «личности нет»: проба зовётся, а отказ не уходит необработанным', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    let broken = false;
    const waiting = waitForMap(
      () => {
        if (broken) throw new Error('база не открылась');
        return current;
      },
      async () => {
        calls++;
        return calls === 2 ? 'ok' : null;
      },
      5_000,
      60_000,
      cancel.signal,
      changes,
    );
    await vi.waitFor(() => expect(listening()).toBe(true));
    broken = true;
    fire();
    await expect(waiting).resolves.toBe('ok');
    expect(calls).toBe(2);
  });

  it('без внешнего сигнала fs.watch не заводится, а будит ожидание тик опроса', async () => {
    let ready = false;
    let calls = 0;
    const waiting = waitForMap(
      identity,
      async () => {
        calls++;
        return ready ? 'ok' : null;
      },
      5_000,
      20,
      cancel.signal,
    );
    await delay(100);
    expect(calls).toBe(1);
    ready = true;
    bump();
    await expect(waiting).resolves.toBe('ok');
    expect(calls).toBe(2);
    expect(watch).not.toHaveBeenCalled();
  });

  it('тик опроса пробу не зовёт, пока личность не менялась, и зовёт после записи', async () => {
    let calls = 0;
    const waiting = waitForMap(
      identity,
      async () => {
        calls++;
        return null;
      },
      5_000,
      20,
      cancel.signal,
    );
    await delay(150);
    expect(calls).toBe(1);
    bump();
    await vi.waitFor(() => expect(calls).toBe(2));
    await delay(100);
    expect(calls).toBe(2);
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('с внешним сигналом опрос остаётся запасным', async () => {
    const { changes, listening } = source();
    let ready = false;
    const waiting = waitForMap(identity, async () => (ready ? 'ok' : null), 5_000, 20, cancel.signal, changes);
    await vi.waitFor(() => expect(listening()).toBe(true));
    ready = true;
    // Сигнал не придёт: ожидание заметит запись по тику опроса.
    bump();
    await expect(waiting).resolves.toBe('ok');
    expect(listening()).toBe(false);
    expect(watch).not.toHaveBeenCalled();
  });

  it('подписка на внешний сигнал снимается по таймауту', async () => {
    const { changes, listening } = source();
    const waiting = waitForMap(identity, async () => null, 300, 60_000, undefined, changes);
    await vi.waitFor(() => expect(listening()).toBe(true));
    await expect(waiting).resolves.toBeNull();
    expect(listening()).toBe(false);
  });

  it('подписка на внешний сигнал снимается по отмене', async () => {
    const { changes, listening } = source();
    const abort = new AbortController();
    const waiting = waitForMap(identity, async () => null, 5_000, 60_000, abort.signal, changes);
    await vi.waitFor(() => expect(listening()).toBe(true));
    abort.abort();
    await expect(waiting).resolves.toBeNull();
    expect(listening()).toBe(false);
  });

  it('подписка на внешний сигнал снимается, когда проба бросила', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      identity,
      async () => {
        if (++calls === 2) throw new Error('карта не читается');
        return null;
      },
      5_000,
      60_000,
      cancel.signal,
      changes,
    );
    await vi.waitFor(() => expect(listening()).toBe(true));
    bump();
    fire();
    await expect(waiting).rejects.toThrow('карта не читается');
    expect(listening()).toBe(false);
  });
});
