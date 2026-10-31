import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRESSURE_INTERVAL_MS,
  createPressureSensor,
  parseDarwinLevel,
  parseDarwinSwap,
  parseLinuxPressure,
  type PressureReading,
} from './memory-pressure.js';

/** Настоящий вывод `sysctl -n vm.swapusage` на macOS, с переводом строки в конце. */
const SWAP_LINE = 'total = 3072.00M  used = 2365.44M  free = 706.56M  (encrypted)\n';

const LEVEL_KEY = 'kern.memorystatus_vm_pressure_level';
const SWAP_KEY = 'vm.swapusage';
const LEVER = 'PARLEY_MEMORY_PRESSURE_FILE';

/** Подставной `sysctl`: на уровень и на своп отвечает по ключу, последнему в аргументах. */
function sysctlRun(level: string, swap: string = SWAP_LINE) {
  return vi.fn(async (_command: string, args: readonly string[]) =>
    args.at(-1) === SWAP_KEY ? swap : level,
  );
}

/** Подставной `sysctl`, которого нет на машине. */
function missingRun() {
  return vi.fn(async (): Promise<string> => {
    throw new Error('spawn sysctl ENOENT');
  });
}

/** Подставное чтение файлов: что не названо, того «нет на диске». */
function fakeFiles(files: Record<string, string>) {
  return vi.fn(async (file: string) => {
    const text = files[file];
    if (text === undefined) throw new Error(`ENOENT: ${file}`);
    return text;
  });
}

/** `/proc/pressure/memory`: доля времени за 10 с, когда задачи стоят в ожидании памяти. */
const psi = (some: number, full: number): string =>
  `some avg10=${some.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n` +
  `full avg10=${full.toFixed(2)} avg60=0.00 avg300=0.00 total=0\n`;

/**
 * `/proc/meminfo`. Всего памяти ровно 1 000 000 кБ, чтобы доля `MemAvailable` читалась с первого взгляда:
 * 10 000 кБ — один процент. Своп — 2 ГБ, из них занято `swapUsedKb`.
 */
const meminfo = (availablePct: number, swapUsedKb = 0): string =>
  [
    'MemTotal:        1000000 kB',
    'MemFree:          100000 kB',
    `MemAvailable:  ${Math.round(availablePct * 10_000)} kB`,
    'Buffers:           10000 kB',
    'SwapTotal:       2097152 kB',
    `SwapFree:        ${2_097_152 - swapUsedKb} kB`,
    '',
  ].join('\n');

describe('parseDarwinLevel', () => {
  it.each([
    ['1\n', 'normal'],
    ['2', 'warn'],
    ['4', 'critical'],
    ['', 'unknown'],
    ['x', 'unknown'],
    ['3', 'unknown'],
  ])('вывод %j — %s', (text, level) => {
    expect(parseDarwinLevel(text)).toBe(level);
  });
});

describe('parseDarwinSwap', () => {
  it('настоящая строка: занято 2365.44M, это около 2.31 ГБ', () => {
    expect(parseDarwinSwap(SWAP_LINE)).toBeCloseTo(2.31, 2);
  });

  it('гигабайты берутся как есть', () => {
    expect(parseDarwinSwap('used = 2.50G')).toBe(2.5);
  });

  it('пустой своп — ноль, а не «нет данных»', () => {
    expect(parseDarwinSwap('total = 0.00M  used = 0.00M  free = 0.00M\n')).toBe(0);
  });

  it.each(['', 'мусор', 'used = M', 'used = 12K', 'total = 3072.00M  free = 706.56M'])(
    'нечитаемый вывод %j — null',
    (text) => {
      expect(parseDarwinSwap(text)).toBeNull();
    },
  );
});

describe('parseLinuxPressure', () => {
  it('спокойная машина — normal', () => {
    expect(parseLinuxPressure(psi(0.5, 0), meminfo(50)).level).toBe('normal');
  });

  it('some avg10 от 10 — warn, ниже — normal', () => {
    expect(parseLinuxPressure(psi(10, 0), meminfo(50)).level).toBe('warn');
    expect(parseLinuxPressure(psi(9.99, 0), meminfo(50)).level).toBe('normal');
  });

  it('full avg10 от 10 — critical, ниже — normal', () => {
    expect(parseLinuxPressure(psi(0, 10), meminfo(50)).level).toBe('critical');
    expect(parseLinuxPressure(psi(0, 9.99), meminfo(50)).level).toBe('normal');
  });

  it('MemAvailable ниже 10 % — warn, от 10 % — normal', () => {
    expect(parseLinuxPressure(psi(0, 0), meminfo(9.9)).level).toBe('warn');
    expect(parseLinuxPressure(psi(0, 0), meminfo(10)).level).toBe('normal');
  });

  it('MemAvailable ниже 5 % — critical, от 5 % — warn', () => {
    expect(parseLinuxPressure(psi(0, 0), meminfo(4.9)).level).toBe('critical');
    expect(parseLinuxPressure(psi(0, 0), meminfo(5)).level).toBe('warn');
  });

  it('два признака разной тяжести — берётся тяжелее', () => {
    expect(parseLinuxPressure(psi(20, 0), meminfo(3)).level).toBe('critical');
    expect(parseLinuxPressure(psi(0, 15), meminfo(8)).level).toBe('critical');
  });

  it('нет файла PSI (ядро старше) — уровень по MemAvailable', () => {
    expect(parseLinuxPressure('', meminfo(3)).level).toBe('critical');
    expect(parseLinuxPressure('', meminfo(50)).level).toBe('normal');
  });

  it('нет /proc/meminfo — уровень по PSI', () => {
    expect(parseLinuxPressure(psi(12, 0), '').level).toBe('warn');
    expect(parseLinuxPressure(psi(0, 0), '').level).toBe('normal');
  });

  it('пусто или мусор в обоих — unknown, своп null', () => {
    expect(parseLinuxPressure('', '')).toEqual({ level: 'unknown', swapGb: null });
    expect(parseLinuxPressure('мусор', 'тоже мусор\n')).toEqual({ level: 'unknown', swapGb: null });
  });

  it('своп — занятое (SwapTotal − SwapFree) в гигабайтах', () => {
    expect(parseLinuxPressure(psi(0, 0), meminfo(50, 1_048_576)).swapGb).toBe(1);
    expect(parseLinuxPressure(psi(0, 0), meminfo(50)).swapGb).toBe(0);
  });

  it('нет строк свопа — swapGb null, на уровень это не влияет', () => {
    const withoutSwap = meminfo(3)
      .split('\n')
      .filter((line) => !line.startsWith('Swap'))
      .join('\n');

    expect(parseLinuxPressure('', withoutSwap)).toEqual({ level: 'critical', swapGb: null });
  });
});

describe('createPressureSensor: macOS', () => {
  it('до первого чтения — unknown без времени', () => {
    const sensor = createPressureSensor({ platform: 'darwin', run: sysctlRun('1'), env: {} });

    expect(sensor.current()).toEqual({ level: 'unknown', swapGb: null, at: 0 });
  });

  it('уровень 4 и строка свопа — critical, слушатель вызван один раз', async () => {
    const run = sysctlRun('4\n');
    const sensor = createPressureSensor({ platform: 'darwin', run, env: {}, now: () => 1234 });
    const listener = vi.fn();
    sensor.onReading(listener);

    const reading = await sensor.read();

    expect(reading.level).toBe('critical');
    expect(reading.swapGb).toBeCloseTo(2.31, 2);
    expect(reading.at).toBe(1234);
    expect(sensor.current()).toEqual(reading);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(reading);
    expect(run).toHaveBeenCalledWith('sysctl', ['-n', LEVEL_KEY]);
    expect(run).toHaveBeenCalledWith('sysctl', ['-n', SWAP_KEY]);
  });

  it('каждое чтение обновляет current(): сперва normal, потом warn', async () => {
    let level = '1';
    const sensor = createPressureSensor({
      platform: 'darwin',
      run: vi.fn(async (_command: string, args: readonly string[]) =>
        args.at(-1) === SWAP_KEY ? SWAP_LINE : level,
      ),
      env: {},
    });

    await sensor.read();
    expect(sensor.current().level).toBe('normal');
    level = '2';
    await sensor.read();
    expect(sensor.current().level).toBe('warn');
  });

  it('sysctl нет на машине — unknown, своп null, read не бросает', async () => {
    const sensor = createPressureSensor({ platform: 'darwin', run: missingRun(), env: {} });
    const listener = vi.fn();
    sensor.onReading(listener);

    const reading = await sensor.read();

    expect(reading).toMatchObject({ level: 'unknown', swapGb: null });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('вывод мусорный — unknown и null', async () => {
    const sensor = createPressureSensor({
      platform: 'darwin',
      run: sysctlRun('sysctl: unknown oid', 'ошибка'),
      env: {},
    });

    expect(await sensor.read()).toMatchObject({ level: 'unknown', swapGb: null });
  });

  it('не ответил своп — уровень остаётся; не ответил уровень — остаётся своп', async () => {
    const swapDown = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.at(-1) === SWAP_KEY) throw new Error('таймаут');
      return '2';
    });
    const levelDown = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.at(-1) === LEVEL_KEY) throw new Error('таймаут');
      return SWAP_LINE;
    });

    const first = await createPressureSensor({ platform: 'darwin', run: swapDown, env: {} }).read();
    const second = await createPressureSensor({ platform: 'darwin', run: levelDown, env: {} }).read();

    expect(first).toMatchObject({ level: 'warn', swapGb: null });
    expect(second.level).toBe('unknown');
    expect(second.swapGb).toBeCloseTo(2.31, 2);
  });
});

describe('createPressureSensor: Linux', () => {
  it('читает /proc/pressure/memory и /proc/meminfo', async () => {
    const readFile = fakeFiles({
      '/proc/pressure/memory': psi(0, 12),
      '/proc/meminfo': meminfo(50, 1_048_576),
    });
    const run = missingRun();
    const sensor = createPressureSensor({ platform: 'linux', run, readFile, env: {} });

    expect(await sensor.read()).toMatchObject({ level: 'critical', swapGb: 1 });
    expect(run).not.toHaveBeenCalled();
  });

  it('файлы не читаются — unknown, read не бросает', async () => {
    const sensor = createPressureSensor({ platform: 'linux', readFile: fakeFiles({}), env: {} });

    expect(await sensor.read()).toMatchObject({ level: 'unknown', swapGb: null });
  });

  it('нет /proc/pressure/memory — уровень по /proc/meminfo', async () => {
    const readFile = fakeFiles({ '/proc/meminfo': meminfo(8) });
    const sensor = createPressureSensor({ platform: 'linux', readFile, env: {} });

    expect(await sensor.read()).toMatchObject({ level: 'warn', swapGb: 0 });
  });
});

describe('createPressureSensor: другие системы', () => {
  it('win32 — unknown, ОС не спрашивается', async () => {
    const run = sysctlRun('4');
    const readFile = fakeFiles({});
    const sensor = createPressureSensor({ platform: 'win32', run, readFile, env: {} });

    expect(await sensor.read()).toMatchObject({ level: 'unknown', swapGb: null });
    expect(run).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe(`createPressureSensor: рычаг ${LEVER}`, () => {
  it('файл со словом warn — warn, своп null, ОС не спрашивается', async () => {
    const run = sysctlRun('4');
    const readFile = fakeFiles({ '/tmp/pressure': 'warn\n' });
    const sensor = createPressureSensor({
      platform: 'darwin',
      run,
      readFile,
      env: { [LEVER]: '/tmp/pressure' },
    });

    expect(await sensor.read()).toMatchObject({ level: 'warn', swapGb: null });
    expect(run).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith('/tmp/pressure');
  });

  it.each(['normal', 'warn', 'critical'] as const)('слово %s из файла', async (word) => {
    const sensor = createPressureSensor({
      platform: 'darwin',
      run: sysctlRun('1'),
      readFile: fakeFiles({ '/tmp/pressure': `  ${word}\r\n` }),
      env: { [LEVER]: '/tmp/pressure' },
    });

    expect((await sensor.read()).level).toBe(word);
  });

  it('файл читается заново при каждом чтении', async () => {
    const files = { '/tmp/pressure': 'normal' };
    const sensor = createPressureSensor({
      platform: 'darwin',
      run: sysctlRun('1'),
      readFile: async (file) => files[file as keyof typeof files],
      env: { [LEVER]: '/tmp/pressure' },
    });

    expect((await sensor.read()).level).toBe('normal');
    files['/tmp/pressure'] = 'critical';
    expect((await sensor.read()).level).toBe('critical');
  });

  it.each([
    ['файла нет', {}],
    ['в файле другое слово', { '/tmp/pressure': 'hot' }],
    ['файл пуст', { '/tmp/pressure': '' }],
    ['в файле unknown', { '/tmp/pressure': 'unknown' }],
  ])('%s — unknown, ОС не спрашивается', async (_name, files) => {
    const run = sysctlRun('4');
    const sensor = createPressureSensor({
      platform: 'darwin',
      run,
      readFile: fakeFiles(files),
      env: { [LEVER]: '/tmp/pressure' },
    });

    expect(await sensor.read()).toMatchObject({ level: 'unknown', swapGb: null });
    expect(run).not.toHaveBeenCalled();
  });

  it('рычаг главнее платформы: на win32 и на Linux уровень тоже из файла', async () => {
    const readFile = fakeFiles({ '/tmp/pressure': 'critical' });
    const env = { [LEVER]: '/tmp/pressure' };

    for (const platform of ['win32', 'linux'] as const) {
      const sensor = createPressureSensor({ platform, readFile, env });
      expect((await sensor.read()).level).toBe('critical');
    }
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile).not.toHaveBeenCalledWith('/proc/meminfo');
  });

  it('пустое значение переменной — рычага нет, спрашивается ОС', async () => {
    const run = sysctlRun('2');
    const sensor = createPressureSensor({ platform: 'darwin', run, env: { [LEVER]: '' } });

    expect((await sensor.read()).level).toBe('warn');
    expect(run).toHaveBeenCalled();
  });
});

describe('createPressureSensor: слушатели', () => {
  it('отписка снимает слушателя', async () => {
    const sensor = createPressureSensor({ platform: 'darwin', run: sysctlRun('1'), env: {} });
    const listener = vi.fn();
    const off = sensor.onReading(listener);

    await sensor.read();
    off();
    await sensor.read();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('сбойный слушатель не мешает ни чтению, ни остальным слушателям', async () => {
    const sensor = createPressureSensor({ platform: 'darwin', run: sysctlRun('2'), env: {} });
    const after = vi.fn();
    sensor.onReading(() => {
      throw new Error('слушатель сломан');
    });
    sensor.onReading(after);

    await expect(sensor.read()).resolves.toMatchObject({ level: 'warn' });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('параллельные read() делят одно чтение', async () => {
    const run = sysctlRun('2');
    const sensor = createPressureSensor({ platform: 'darwin', run, env: {} });
    const listener = vi.fn();
    sensor.onReading(listener);

    const [first, second] = await Promise.all([sensor.read(), sensor.read()]);

    expect(second).toBe(first);
    expect(run).toHaveBeenCalledTimes(2); // уровень и своп — по одному разу
    expect(listener).toHaveBeenCalledTimes(1);

    await sensor.read();

    expect(run).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('createPressureSensor: таймер', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start читает сразу, потом раз в 10 с; stop прекращает', async () => {
    const run = sysctlRun('1');
    const sensor = createPressureSensor({ platform: 'darwin', run, env: {} });
    const readings: PressureReading[] = [];
    sensor.onReading((reading) => readings.push(reading));

    expect(PRESSURE_INTERVAL_MS).toBe(10_000);
    sensor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(readings).toHaveLength(1);
    expect(sensor.current().level).toBe('normal');

    await vi.advanceTimersByTimeAsync(PRESSURE_INTERVAL_MS - 1);
    expect(readings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(readings).toHaveLength(2);

    sensor.stop();
    await vi.advanceTimersByTimeAsync(PRESSURE_INTERVAL_MS * 3);
    expect(readings).toHaveLength(2);
  });

  it('свой интервал; повторный start второй таймер не заводит', async () => {
    const sensor = createPressureSensor({
      platform: 'darwin',
      run: sysctlRun('1'),
      env: {},
      intervalMs: 1_000,
    });
    const listener = vi.fn();
    sensor.onReading(listener);

    sensor.start();
    sensor.start();
    await vi.advanceTimersByTimeAsync(2_500);

    expect(listener).toHaveBeenCalledTimes(3); // сразу, на 1 с и на 2 с
    sensor.stop();
  });

  it('после stop start запускает таймер снова', async () => {
    const sensor = createPressureSensor({
      platform: 'darwin',
      run: sysctlRun('1'),
      env: {},
      intervalMs: 1_000,
    });
    const listener = vi.fn();
    sensor.onReading(listener);

    sensor.start();
    await vi.advanceTimersByTimeAsync(0);
    sensor.stop();
    sensor.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(listener).toHaveBeenCalledTimes(3); // сразу, снова сразу и через 1 с
    sensor.stop();
  });

  it('таймер не держит процесс (unref)', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const sensor = createPressureSensor({ platform: 'darwin', run: sysctlRun('1'), env: {} });

    sensor.start();

    const timer = spy.mock.results[0]?.value as { hasRef(): boolean } | undefined;
    expect(timer?.hasRef()).toBe(false);
    sensor.stop();
    spy.mockRestore();
  });

  it('сбой чтения на тике не роняет процесс: следующий тик читает снова', async () => {
    let broken = true;
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (broken) throw new Error('sysctl завис');
      return args.at(-1) === SWAP_KEY ? SWAP_LINE : '4';
    });
    const sensor = createPressureSensor({ platform: 'darwin', run, env: {} });

    sensor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sensor.current().level).toBe('unknown');

    broken = false;
    await vi.advanceTimersByTimeAsync(PRESSURE_INTERVAL_MS);
    expect(sensor.current().level).toBe('critical');
    sensor.stop();
  });
});
