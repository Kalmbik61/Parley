/**
 * Проверка новой версии (V6 плана релиза 0.1.0): сравнение версий, разбор ответа GitHub, сетевые отказы,
 * планировщик «при старте и раз в сутки» и выключатели. Настоящей сети здесь нет — запрос подставной.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  CHECK_INTERVAL_MS,
  CHECK_TIMEOUT_MS,
  compareVersions,
  createUpdateChecker,
  fetchLatestRelease,
  isNewerVersion,
  MAX_RESPONSE_BYTES,
  parseLatestRelease,
  RELEASES_LATEST_URL,
  updateCheckOff,
  type UpdateFetch,
} from './update-check.js';

const RELEASE_URL = 'https://github.com/Kalmbik61/Parley/releases/tag/v0.2.0';

/** Ответ `releases/latest` в той части, которую читает окно; прочие поля настоящего ответа ему безразличны. */
const release = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v0.2.0',
  html_url: RELEASE_URL,
  draft: false,
  prerelease: false,
  name: 'Parley 0.2.0',
  body: 'notes',
  assets: [],
  ...patch,
});

const respond = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init });

/** Запрос, отвечающий релизом; тест при необходимости подменяет ответ через `mockResolvedValueOnce`. */
const fetchOf = (body: unknown = release()): Mock<UpdateFetch> =>
  vi.fn<UpdateFetch>(async () => respond(body));

describe('compareVersions и isNewerVersion', () => {
  const order: Array<[string, string, -1 | 0 | 1]> = [
    ['0.1.0', '0.1.1', -1],
    ['0.1.1', '0.1.0', 1],
    ['0.1.0', '0.1.0', 0],
    // Части — числа, а не строки: 10 старше 9.
    ['0.9.0', '0.10.0', -1],
    ['0.2.0', '0.1.99', 1],
    ['1.0.0', '0.99.99', 1],
    ['v0.1.0', '0.1.0', 0],
    // semver 2.0.0, п. 11: prerelease младше релиза, части — по правилам.
    ['0.2.0-rc.1', '0.2.0', -1],
    ['0.2.0', '0.2.0-rc.1', 1],
    ['0.2.0-rc.1', '0.2.0-rc.2', -1],
    ['0.2.0-rc.2', '0.2.0-rc.10', -1],
    ['0.2.0-alpha', '0.2.0-beta', -1],
    ['0.2.0-1', '0.2.0-alpha', -1],
    ['0.2.0-rc', '0.2.0-rc.1', -1],
    ['0.2.0-rc.1', '0.2.0-rc.1', 0],
    ['0.2.0-1', '0.2.0-01', 0],
    ['0.2.0-99999999999999999999999', '0.2.0-99999999999999999999998', 1],
    // Метаданные сборки порядка не меняют.
    ['0.2.0+build5', '0.2.0+build9', 0],
    ['0.2.0+build5', '0.2.0', 0],
  ];

  it.each(order)('%s против %s → %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it.each([
    '',
    'latest',
    '1.2',
    '1.2.3.4',
    'v1.2.x',
    '1.2.3-',
    '1.2.3-rc..1',
    'x1.2.3',
    '9007199254740993.0.0',
  ])('не версия «%s» — null, и новее она не бывает', (garbage) => {
    expect(compareVersions(garbage, '0.1.0')).toBeNull();
    expect(compareVersions('0.1.0', garbage)).toBeNull();
    expect(isNewerVersion(garbage, '0.1.0')).toBe(false);
    expect(isNewerVersion('9.9.9', garbage)).toBe(false);
  });

  it('isNewerVersion — только строго новее', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    // Запущена сборка-кандидат, вышел её релиз — это обновление.
    expect(isNewerVersion('0.2.0', '0.2.0-rc.1')).toBe(true);
    expect(isNewerVersion('0.2.0-rc.1', '0.2.0')).toBe(false);
  });
});

describe('parseLatestRelease', () => {
  it('стабильный релиз → версия без v и страница релиза', () => {
    expect(parseLatestRelease(release())).toEqual({ version: '0.2.0', url: RELEASE_URL });
  });

  it('тег без v годится; метаданные сборки в версию не попадают', () => {
    expect(parseLatestRelease(release({ tag_name: '0.2.0' }))?.version).toBe('0.2.0');
    expect(parseLatestRelease(release({ tag_name: 'v1.10.3+exp.sha.5114f85' }))?.version).toBe(
      '1.10.3',
    );
  });

  it('черновик и prerelease не берутся', () => {
    expect(parseLatestRelease(release({ draft: true }))).toBeNull();
    expect(parseLatestRelease(release({ prerelease: true }))).toBeNull();
  });

  it('тег с суффиксом prerelease не берётся, даже если GitHub не пометил релиз', () => {
    expect(parseLatestRelease(release({ tag_name: 'v0.2.0-rc.1' }))).toBeNull();
  });

  it('нет или не строка tag_name и html_url, тег не версия — null', () => {
    expect(parseLatestRelease(release({ tag_name: undefined }))).toBeNull();
    expect(parseLatestRelease(release({ tag_name: 2 }))).toBeNull();
    expect(parseLatestRelease(release({ tag_name: 'nightly' }))).toBeNull();
    expect(parseLatestRelease(release({ html_url: undefined }))).toBeNull();
    expect(parseLatestRelease(release({ html_url: 7 }))).toBeNull();
  });

  // Обёрнуты в массивы: у `it.each` голый массив — это список аргументов, а не одно значение.
  it.each([[null], [undefined], ['text'], [42], [true], [[]], [[release()]]])(
    'не объект (%j) — null',
    (body) => {
      expect(parseLatestRelease(body)).toBeNull();
    },
  );

  // Адрес открывается в браузере человека: чужой, не https, с логином, портом или не http(s) — отказ.
  it.each([
    'http://github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
    'https://evil.example/Kalmbik61/Parley/releases/tag/v0.2.0',
    'https://github.com.evil.example/Kalmbik61/Parley/releases/tag/v0.2.0',
    'https://evil.example/github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
    'https://user:secret@github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
    'https://github.com:8443/Kalmbik61/Parley/releases/tag/v0.2.0',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>1</script>',
    '//github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
    'github.com/Kalmbik61/Parley/releases/tag/v0.2.0',
    '',
  ])('html_url «%s» — null', (htmlUrl) => {
    expect(parseLatestRelease(release({ html_url: htmlUrl }))).toBeNull();
  });
});

describe('fetchLatestRelease', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('удача: версия и страница релиза; запрос — GET releases/latest без токена и куки', async () => {
    const fetch = fetchOf();

    await expect(fetchLatestRelease(fetch)).resolves.toEqual({
      version: '0.2.0',
      url: RELEASE_URL,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as Parameters<UpdateFetch>;
    expect(url).toBe('https://api.github.com/repos/Kalmbik61/Parley/releases/latest');
    expect(url).toBe(RELEASES_LATEST_URL);
    expect(init.headers).toEqual({
      Accept: 'application/vnd.github+json',
      // Язык системы человека запрос не выдаёт: стек Chromium иначе подставил бы его сам.
      'Accept-Language': 'en',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Parley',
    });
    // Ни токена, ни куки: человеческий профиль GitHub тут ни при чём.
    const names = Object.keys(init.headers).map((name) => name.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(names).not.toContain('cookie');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([404, 403, 429, 500, 503])('HTTP %i — null, не ошибка', async (status) => {
    const fetch = vi.fn<UpdateFetch>(async () => respond({ message: 'no' }, { status }));
    await expect(fetchLatestRelease(fetch)).resolves.toBeNull();
  });

  it('статус не 2xx — null, даже если тело похоже на релиз (прокси, страница ошибки)', async () => {
    const fetch = vi.fn<UpdateFetch>(async () => respond(release(), { status: 500 }));
    await expect(fetchLatestRelease(fetch)).resolves.toBeNull();
  });

  it('ошибка сети — null, а не исключение', async () => {
    const fetch = vi.fn<UpdateFetch>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(fetchLatestRelease(fetch)).resolves.toBeNull();
  });

  it('запрос, брошенный синхронно, — тоже null', async () => {
    const fetch = vi.fn<UpdateFetch>(() => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    await expect(fetchLatestRelease(fetch)).resolves.toBeNull();
  });

  it('тело не JSON или не та форма — null', async () => {
    await expect(
      fetchLatestRelease(vi.fn<UpdateFetch>(async () => new Response('<html>rate limited</html>'))),
    ).resolves.toBeNull();
    await expect(fetchLatestRelease(fetchOf({ message: 'Not Found' }))).resolves.toBeNull();
    await expect(fetchLatestRelease(fetchOf([]))).resolves.toBeNull();
  });

  it('черновик и prerelease в ответе — null', async () => {
    await expect(fetchLatestRelease(fetchOf(release({ draft: true })))).resolves.toBeNull();
    await expect(fetchLatestRelease(fetchOf(release({ prerelease: true })))).resolves.toBeNull();
  });

  it('ответ больше предела — null: тело не читается целиком', async () => {
    const huge = release({ body: 'x'.repeat(MAX_RESPONSE_BYTES) });
    await expect(fetchLatestRelease(fetchOf(huge))).resolves.toBeNull();
    // А ответ с длинными заметками в пределах — в порядке: GitHub отдаёт до 125 000 знаков.
    await expect(
      fetchLatestRelease(fetchOf(release({ body: 'я'.repeat(125_000) }))),
    ).resolves.toEqual({ version: '0.2.0', url: RELEASE_URL });
  });

  it('таймаут 10 с: запрос, не слушающий сигнал, не держит проверку; сигнал отменён', async () => {
    vi.useFakeTimers();
    expect(CHECK_TIMEOUT_MS).toBe(10_000);
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<UpdateFetch>((_url, init) => {
      signal = init.signal;
      return new Promise<Response>(() => {});
    });

    const result = fetchLatestRelease(fetch);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
  });

  it('запрос, отказавший по сигналу, после таймаута необработанным отказом не остаётся', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<UpdateFetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    );

    const result = fetchLatestRelease(fetch);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);

    await expect(result).resolves.toBeNull();
  });

  it('таймер снимается и после удачи, и после отказа: ничего не висит', async () => {
    vi.useFakeTimers();
    await fetchLatestRelease(fetchOf());
    expect(vi.getTimerCount()).toBe(0);
    await fetchLatestRelease(vi.fn<UpdateFetch>(async () => respond({}, { status: 500 })));
    expect(vi.getTimerCount()).toBe(0);
    await fetchLatestRelease(
      vi.fn<UpdateFetch>(async () => {
        throw new Error('offline');
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createUpdateChecker', () => {
  const NEWER = { version: '0.2.0', url: RELEASE_URL };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  interface Setup {
    fetch: Mock<UpdateFetch>;
    onUpdate: Mock<(info: { version: string; url: string }) => void>;
    isEnabled: Mock<() => boolean | Promise<boolean>>;
    checker: ReturnType<typeof createUpdateChecker>;
  }

  function setup(options: { current?: string; body?: unknown; enabled?: boolean } = {}): Setup {
    const fetch = fetchOf(options.body ?? release());
    const onUpdate = vi.fn<(info: { version: string; url: string }) => void>();
    const isEnabled = vi.fn<() => boolean | Promise<boolean>>(() => options.enabled ?? true);
    const checker = createUpdateChecker({
      currentVersion: options.current ?? '0.1.0',
      fetch,
      isEnabled,
      onUpdate,
    });
    return { fetch, onUpdate, isEnabled, checker };
  }

  it('интервал — сутки', () => {
    expect(CHECK_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('start проверяет сразу; релиз новее — onUpdate и latest', async () => {
    const { fetch, onUpdate, checker } = setup();

    checker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith(NEWER);
    await expect(checker.latest()).resolves.toEqual(NEWER);
    checker.stop();
  });

  it('до первого ответа latest — null', async () => {
    const { checker } = setup();
    await expect(checker.latest()).resolves.toBeNull();
  });

  it.each(['0.2.0', '0.3.0', '1.0.0'])(
    'запущена %s, а последний релиз 0.2.0 — не новее: тишина',
    async (current) => {
      const { onUpdate, checker } = setup({ current });

      checker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(onUpdate).not.toHaveBeenCalled();
      await expect(checker.latest()).resolves.toBeNull();
      checker.stop();
    },
  );

  it('дальше — раз в сутки, ни чаще, ни реже', async () => {
    const { fetch, onUpdate, checker } = setup();
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Повторное сообщение о той же версии нормально: окно закрытую версию отсеивает само.
    expect(onUpdate).toHaveBeenCalledTimes(3);
    checker.stop();
  });

  it('повторный start ничего не удваивает', async () => {
    const { fetch, checker } = setup();
    checker.start();
    checker.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(fetch).toHaveBeenCalledTimes(2);
    checker.stop();
  });

  it('stop снимает таймер: проверок больше нет, start после него заводит заново', async () => {
    const { fetch, checker } = setup();
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    checker.stop();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    checker.stop();
  });

  it('выключено: в сеть не ходит ни при старте, ни по таймеру, latest — null', async () => {
    const { fetch, onUpdate, isEnabled, checker } = setup({ enabled: false });

    checker.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);

    expect(isEnabled).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    await expect(checker.latest()).resolves.toBeNull();
    checker.stop();
  });

  it('переключатель читается перед каждой проверкой: выключили — замолчала, включили — заговорила', async () => {
    const { fetch, isEnabled, checker } = setup();
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(checker.latest()).resolves.toEqual(NEWER);

    isEnabled.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Найденное до выключения окну уже не отдаётся: человек эту проверку выключил.
    await expect(checker.latest()).resolves.toBeNull();

    isEnabled.mockReturnValue(true);
    await expect(checker.latest()).resolves.toEqual(NEWER);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    checker.stop();
  });

  it('isEnabled может быть асинхронным; отказ чтения настройки — выключено, а не исключение', async () => {
    const { fetch, isEnabled, checker } = setup();
    isEnabled.mockResolvedValue(true);
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    isEnabled.mockRejectedValue(new Error('ui.json unreadable'));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(checker.latest()).resolves.toBeNull();
    checker.stop();
  });

  it('ошибка сети прежний ответ не отменяет и ничего не бросает', async () => {
    const { fetch, onUpdate, checker } = setup();
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await expect(checker.latest()).resolves.toEqual(NEWER);
    checker.stop();
  });

  it('удачная проверка без нового релиза (отозван) находку снимает', async () => {
    const { fetch, onUpdate, checker } = setup();
    checker.start();
    await vi.advanceTimersByTimeAsync(0);
    await expect(checker.latest()).resolves.toEqual(NEWER);

    fetch.mockResolvedValueOnce(
      respond(
        release({
          tag_name: 'v0.1.0',
          html_url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.1.0',
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    await expect(checker.latest()).resolves.toBeNull();
    checker.stop();
  });

  it('новый релиз после прежнего: latest — свежий, onUpdate — о нём', async () => {
    const { fetch, onUpdate, checker } = setup();
    checker.start();
    await vi.advanceTimersByTimeAsync(0);

    const next = {
      version: '0.3.0',
      url: 'https://github.com/Kalmbik61/Parley/releases/tag/v0.3.0',
    };
    fetch.mockResolvedValueOnce(respond(release({ tag_name: 'v0.3.0', html_url: next.url })));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    expect(onUpdate).toHaveBeenLastCalledWith(next);
    await expect(checker.latest()).resolves.toEqual(next);
    checker.stop();
  });

  it('onUpdate, бросивший исключение, проверку не роняет: отказавшего промиса без обработчика нет', async () => {
    const { onUpdate, checker } = setup();
    onUpdate.mockImplementation(() => {
      throw new Error('window destroyed');
    });

    checker.start();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);

    await expect(checker.latest()).resolves.toEqual(NEWER);
    checker.stop();
  });
});

describe('updateCheckOff — PARLEY_UPDATE_CHECK=off', () => {
  it.each(['off', 'OFF', 'Off', ' off '])('«%s» — проверки нет', (value) => {
    expect(updateCheckOff({ PARLEY_UPDATE_CHECK: value })).toBe(true);
  });

  it.each([undefined, '', 'on', '1', '0', 'false', 'no', 'offline'])(
    '«%s» — проверка идёт',
    (value) => {
      expect(updateCheckOff({ PARLEY_UPDATE_CHECK: value })).toBe(false);
    },
  );

  it('переменной нет вовсе — проверка идёт', () => {
    expect(updateCheckOff({})).toBe(false);
  });
});
