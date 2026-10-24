import { watch } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForMap, type MapChanges } from './watch-map.js';

/**
 * `fs.watch` проходит через шпиона (спека хранилища 6.9): тесты проверяют, заводит ли ожидание его вообще, и сами
 * зовут его обработчик — так на неизменённой карте появляется событие, которого настоящая запись не даёт.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

let dir = '';
let mapFile = '';
let version = 0;
/** Отмена ожиданий теста: он гасит ими свои ожидания, а `afterEach` — те, что упавший тест не довёл до конца. */
let cancel = new AbortController();

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const tick = (): Promise<void> => delay(30);

/** Переписывает карту так, как это делает запись: через `.tmp` и `rename` — новый inode, размер и время. */
async function touch(file: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `{"v":${++version}${' '.repeat(version)}}`, 'utf8');
  await rename(tmp, file);
}

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

/** Обработчик, с которым ожидание завело `fs.watch`. */
function watchHandler(): (event: string, name: string | null) => void {
  const call = vi.mocked(watch).mock.calls.at(-1) as unknown as
    [string, (event: string, name: string | null) => void] | undefined;
  if (call === undefined) throw new Error('fs.watch не заводился');
  return call[1];
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'parley-watch-map-'));
  mapFile = path.join(dir, 'map.json');
  await writeFile(mapFile, '{}', 'utf8');
  cancel = new AbortController();
  vi.mocked(watch).mockClear();
});

afterEach(async () => {
  cancel.abort();
  await rm(dir, { recursive: true, force: true });
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
    const waiting = waitForMap(
      mapFile,
      async () => (ready ? 'ok' : null),
      5_000,
      60_000,
      undefined,
      changes,
    );
    // Подписка заводится после первой пробы: ждём её, а не спим, и только тогда даём пробе увидеть «готово».
    await vi.waitFor(() => expect(listener).not.toBeNull());
    ready = true;
    await touch(mapFile);
    listener!();
    await expect(waiting).resolves.toBe('ok');
    expect(listener).toBeNull();
    expect(watch).not.toHaveBeenCalled();
  });

  it('пока файл карты не менялся, проба не зовётся', async () => {
    let calls = 0;
    let listener: (() => void) | null = null;
    const changes: MapChanges = (onChange) => {
      listener = onChange;
      return () => {};
    };
    const abort = new AbortController();
    const waiting = waitForMap(
      mapFile,
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
    await touch(mapFile);
    listener!();
    await vi.waitFor(() => expect(calls).toBe(2));
    abort.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('два сигнала подряд на изменившейся карте зовут пробу один раз', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      mapFile,
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
    await touch(mapFile);
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

  it('запись во время пробы не теряется: личность файла берётся до пробы', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      mapFile,
      async () => {
        calls++;
        // Карту переписали, пока первая проба её читала: следующий повод обязан это заметить.
        if (calls === 1) await touch(mapFile);
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

  it('карты нет — проба зовётся на каждый повод', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      mapFile,
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
    await rm(mapFile);
    fire();
    fire();
    await vi.waitFor(() => expect(calls).toBe(3));
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('без внешнего сигнала fs.watch стоит на каталоге карты, а событие на неизменённой карте пробу не зовёт', async () => {
    let calls = 0;
    const waiting = waitForMap(
      mapFile,
      async () => {
        calls++;
        return null;
      },
      5_000,
      60_000,
      cancel.signal,
    );
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(watch).mock.calls[0]?.[0]).toBe(dir);
    const onEvent = watchHandler();
    onEvent('change', 'map.json');
    onEvent('rename', 'map.json');
    onEvent('change', null);
    await tick();
    expect(calls).toBe(1);
    await touch(mapFile);
    await vi.waitFor(() => expect(calls).toBe(2));
    // Одна запись — несколько событий файловой системы, а проба одна.
    await tick();
    expect(calls).toBe(2);
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('тик опроса пробу не зовёт, пока карта не менялась, и зовёт после записи', async () => {
    let calls = 0;
    const waiting = waitForMap(
      mapFile,
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
    await touch(mapFile);
    await vi.waitFor(() => expect(calls).toBe(2));
    await delay(100);
    expect(calls).toBe(2);
    cancel.abort();
    await expect(waiting).resolves.toBeNull();
  });

  it('с внешним сигналом опрос остаётся запасным', async () => {
    const { changes, listening } = source();
    let ready = false;
    const waiting = waitForMap(
      mapFile,
      async () => (ready ? 'ok' : null),
      5_000,
      20,
      cancel.signal,
      changes,
    );
    await vi.waitFor(() => expect(listening()).toBe(true));
    ready = true;
    // Сигнал не придёт: ожидание заметит запись по тику опроса.
    await touch(mapFile);
    await expect(waiting).resolves.toBe('ok');
    expect(listening()).toBe(false);
    expect(watch).not.toHaveBeenCalled();
  });

  it('подписка на внешний сигнал снимается по таймауту', async () => {
    const { changes, listening } = source();
    const waiting = waitForMap(mapFile, async () => null, 300, 60_000, undefined, changes);
    await vi.waitFor(() => expect(listening()).toBe(true));
    await expect(waiting).resolves.toBeNull();
    expect(listening()).toBe(false);
  });

  it('подписка на внешний сигнал снимается по отмене', async () => {
    const { changes, listening } = source();
    const abort = new AbortController();
    const waiting = waitForMap(mapFile, async () => null, 5_000, 60_000, abort.signal, changes);
    await vi.waitFor(() => expect(listening()).toBe(true));
    abort.abort();
    await expect(waiting).resolves.toBeNull();
    expect(listening()).toBe(false);
  });

  it('подписка на внешний сигнал снимается, когда проба бросила', async () => {
    const { changes, fire, listening } = source();
    let calls = 0;
    const waiting = waitForMap(
      mapFile,
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
    await touch(mapFile);
    fire();
    await expect(waiting).rejects.toThrow('карта не читается');
    expect(listening()).toBe(false);
  });
});
