/**
 * Рамочный тест (спека 14.4): корневого прогона vitest нет (`pnpm test` — это
 * тесты пакетов), а рамка — общая забота, поэтому живёт в core и сканирует
 * исходники всех пакетов разом. Зелёный тест здесь — предохранитель для всех
 * следующих кусков плана окна, а не только для core.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installAgentSkill } from '../src/work/skill-install.js';
import { runStatusline } from '../src/work/statusline.js';
import {
  collectSourceFiles,
  FRAME_EXCEPTIONS,
  FRAME_RULES,
  isFrameException,
  PINNED_USES,
  pinDrift,
  scanSource,
  type FrameHit,
  type PinnedUses,
} from './frame-scan.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, '../../..');

/** Сами сканер и тест не сканируются: их регэкспы правил иначе были бы находкой сами на себя. */
const OWN_FILES = new Set(['frame-check.test.ts', 'frame-scan.ts']);

async function scanRoots(roots: string[]): Promise<FrameHit[]> {
  const hits: FrameHit[] = [];
  for (const root of roots) {
    for (const file of await collectSourceFiles(root)) {
      if (OWN_FILES.has(path.basename(file))) continue;
      const source = await readFile(file, 'utf8');
      hits.push(...scanSource(path.relative(repoRoot, file), source));
    }
  }
  return hits;
}

describe('FRAME_RULES', () => {
  it('покрывает четыре правила спеки 14.4 и границы ключа GLM', () => {
    expect(FRAME_RULES.map((item) => item.rule)).toEqual([
      'учётные данные агентов',
      'запись в каталоги агентов',
      'API провайдеров',
      'YOLO-флаги',
      'секрет GLM вне хранилища',
      'ключ GLM вне окружения процесса',
    ]);
  });
});

describe('scanSource', () => {
  it('находит учётные данные агентов (тест 5)', () => {
    const hits = scanSource('x.ts', "readFile(home + '/.claude/.credentials.json')");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rule).toBe('учётные данные агентов');
  });

  it('пропускает ту же строку после `//` (тест 5)', () => {
    expect(scanSource('x.ts', "// readFile(home + '/.claude/.credentials.json')")).toEqual([]);
  });

  it('пропускает ту же строку внутри настоящего блока /* … */ (тест 5)', () => {
    const source = ['/*', " * readFile(home + '/.claude/.credentials.json')", ' */'].join('\n');
    expect(scanSource('x.ts', source)).toEqual([]);
  });

  it('находит YOLO-флаг (тест 5)', () => {
    const hits = scanSource('x.ts', "const args = ['--dangerously-skip-permissions'];");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rule).toBe('YOLO-флаги');
  });

  it('находит запись в каталоги агентов (тест 5)', () => {
    const hits = scanSource('x.ts', "writeFile(path.join(home, '.claude.json'), text)");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rule).toBe('запись в каталоги агентов');
  });

  it('правило «запись в каталоги агентов» срабатывает и при чтении того же пути (тест 5)', () => {
    const hits = scanSource('x.ts', "readFile(home + '/.codex/config.toml')");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rule).toBe('запись в каталоги агентов');
  });

  // Тест 15 раунда исправлений (находка I5): построчная эвристика без состояния
  // блока даёт и ложные пропуски (генератор `*gen() {}` похож на продолжение
  // комментария), и ложные срабатывания (строка внутри блока без ведущей `*`).
  it('однострочный генератор-метод не считается продолжением блок-комментария (тест 15)', () => {
    const source = "class Foo {\n  *gen() { return '.credentials.json'; }\n}";
    const hits = scanSource('x.ts', source);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 2, rule: 'учётные данные агентов' });
  });

  it('строка внутри блока без ведущей `*` всё равно распознаётся как комментарий (тест 15)', () => {
    const source = [
      'const a = 1;',
      '/*',
      "readFile(home + '/.claude/.credentials.json')",
      '*/',
    ].join('\n');
    expect(scanSource('x.ts', source)).toEqual([]);
  });
});

describe('узкие исключения добровольно введённого ключа GLM (спека провайдеров, 4.2–5)', () => {
  // Правила, которые снимают только исключения GLM; остальные исключения закреплены поимённо в тесте выше.
  const GLM_RULES = ['API провайдеров', 'секрет GLM вне хранилища', 'ключ GLM вне окружения процесса'];
  const approved = [
    {
      file: 'packages/host/src/limits/zai-quota.ts',
      rule: 'API провайдеров',
      line: "export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';",
    },
    {
      file: 'packages/host/src/limits/zai-check.ts',
      rule: 'API провайдеров',
      line: "const ZAI_MESSAGES_URL = 'https://api.z.ai/api/anthropic/v1/messages';",
    },
    {
      file: 'packages/core/src/providers.ts',
      rule: 'API провайдеров',
      line: "ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',",
    },
    {
      file: 'packages/core/src/secrets.ts',
      rule: 'секрет GLM вне хранилища',
      line: "const secretsPath = (): string => path.join(parleyHome(), 'secrets.json');",
    },
    {
      file: 'packages/host/src/sessions/provider-env.ts',
      rule: 'ключ GLM вне окружения процесса',
      line: 'if (key !== null) env.ANTHROPIC_AUTH_TOKEN = key;',
    },
  ];

  it('новые исключения — только согласованные строки GLM', () => {
    expect(
      FRAME_EXCEPTIONS.filter((item) => GLM_RULES.includes(item.rule)).map(
        ({ file, rule, line }) => ({ file, rule, line }),
      ),
    ).toEqual(approved);
  });

  it.each(approved)('разрешает только согласованную строку в $file', ({ file, rule, line }) => {
    expect(scanSource(file, `  ${line}`)).toEqual([]);
    expect(isFrameException(file, rule, line)).toBe(true);
    const exception = FRAME_EXCEPTIONS.find((item) => item.file === file && item.rule === rule);
    expect(exception?.line).toBe(line);
    expect(exception?.reason).toMatch(/спека провайдеров/);
    expect(exception?.reason).not.toContain('\n');
  });

  it.each(approved)('ловит ту же строку вне $file', ({ rule, line }) => {
    for (const file of ['packages/core/src/other.ts', 'packages/host/src/other.ts']) {
      const hits = scanSource(file, line);
      expect(hits, file).toHaveLength(1);
      expect(hits[0]?.rule).toBe(rule);
    }
  });

  it.each(approved)('ловит дополненный код в разрешённом $file', ({ file, rule, line }) => {
    const hits = scanSource(file, `${line} leak();`);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rule).toBe(rule);
    for (const other of FRAME_RULES.filter((item) => item.rule !== rule)) {
      expect(isFrameException(file, other.rule, line)).toBe(false);
    }
  });

  it('разрешение endpoint не разрешает HTTP-запрос даже из реестра', () => {
    expect(
      scanSource('packages/core/src/providers.ts', "fetch('https://api.z.ai/api/anthropic');"),
    ).toMatchObject([{ rule: 'API провайдеров' }]);
  });

  it('разрешение пути не разрешает чтение хранилища из другого модуля', () => {
    expect(
      scanSource('packages/host/src/sessions/provider-env.ts', "readFile('secrets.json');"),
    ).toMatchObject([{ rule: 'секрет GLM вне хранилища' }]);
  });

  it('разрешение токена не разрешает его запись в файл или план', () => {
    for (const line of [
      'writeFile(file, JSON.stringify({ ANTHROPIC_AUTH_TOKEN: key }));',
      'plan.env.ANTHROPIC_AUTH_TOKEN = key;',
    ]) {
      expect(scanSource('packages/host/src/sessions/provider-env.ts', line)).toMatchObject([
        { rule: 'ключ GLM вне окружения процесса' },
      ]);
    }
  });
});

/**
 * Явное исключение из правила «запись в каталоги агентов» (спека комнат Organic, 3.5): скрипт
 * строки статуса читает `settings.json` человека и проекта, чтобы строка в терминале осталась
 * прежней. Исключение узкое: один файл, одно правило, одна строка целиком.
 */
describe('исключение для чтения settings.json в скрипте строки статуса (спека комнат, 3.5)', () => {
  const STATUSLINE = 'packages/core/src/work/statusline.ts';
  const DECLARATION = "const SETTINGS_FILE = '.claude/settings.json';";

  it('исключение statusline.ts: правило записи в каталоги агентов, причина — ссылка на 3.5', () => {
    expect(FRAME_EXCEPTIONS[0]).toMatchObject({
      file: STATUSLINE,
      rule: 'запись в каталоги агентов',
      line: DECLARATION,
    });
    expect(FRAME_EXCEPTIONS[0]?.reason).toContain('3.5');
  });

  // Список исключений закреплён поимённо: новое — решение контролёра (frame-scan.ts), поэтому
  // оно краснит этот тест, пока человек не прочитал строку и не добавил её сюда осознанно.
  // Все, кроме statusline.ts, — чтение: спека возможностей (2026-10-02) запрещает писать в
  // ~/.claude.json и settings.json, читать их можно; и проверка конфликтных флагов Codex в
  // agents.ts, которая такие флаги отвергает, а не подставляет. Исключения провайдеров
  // (спека провайдеров, 4.2–5) — только фиксированные адреса Z.ai, хранилище ключа и финальное
  // окружение процесса GLM.
  it('исключений ровно перечисленные: файл и правило, причина — одна строка', () => {
    expect(FRAME_EXCEPTIONS.map((item) => `${item.file} | ${item.rule}`)).toEqual([
      `${STATUSLINE} | запись в каталоги агентов`,
      'packages/core/src/skills/claude.ts | запись в каталоги агентов',
      'packages/core/src/work/agents.ts | YOLO-флаги',
      'packages/host/src/capabilities/claude.ts | запись в каталоги агентов',
      'packages/host/src/capabilities/native-plugin-inventory.ts | запись в каталоги агентов',
      'packages/host/src/capabilities/native-plugin-inventory.ts | запись в каталоги агентов',
      'packages/host/src/capabilities/native-targets.ts | запись в каталоги агентов',
      'packages/host/src/capabilities/snapshot.ts | запись в каталоги агентов',
      'packages/host/src/limits/zai-quota.ts | API провайдеров',
      'packages/host/src/limits/zai-check.ts | API провайдеров',
      'packages/core/src/providers.ts | API провайдеров',
      'packages/core/src/secrets.ts | секрет GLM вне хранилища',
      'packages/host/src/sessions/provider-env.ts | ключ GLM вне окружения процесса',
    ]);
    for (const exception of FRAME_EXCEPTIONS) {
      expect(exception.reason, exception.file).not.toBe('');
      expect(exception.reason, exception.file).not.toContain('\n');
    }
  });

  it('объявление пути настроек в statusline.ts не находка', () => {
    expect(scanSource(STATUSLINE, `  ${DECLARATION}`)).toEqual([]);
    expect(isFrameException(STATUSLINE, 'запись в каталоги агентов', DECLARATION)).toBe(true);
  });

  it('запись в каталоги агента из того же файла по-прежнему ловится', () => {
    for (const write of [
      "await writeFile(path.join(home, '.claude/settings.json'), text);",
      "await writeFile(path.join(home, '.claude.json'), text);",
      "await writeFile(path.join(home, '.codex/config.toml'), text);",
      // Та же строка объявления, но с дописанным кодом, — уже не исключение.
      `${DECLARATION} await writeFile(SETTINGS_FILE, text);`,
      "const OTHER_FILE = '.claude/settings.json';",
    ]) {
      const hits = scanSource(STATUSLINE, write);
      expect(hits, write).toHaveLength(1);
      expect(hits[0]?.rule, write).toBe('запись в каталоги агентов');
    }
  });

  it('то же объявление в любом другом файле — находка', () => {
    expect(scanSource('packages/core/src/work/other.ts', DECLARATION)).toHaveLength(1);
    expect(scanSource('packages/host/src/statusline.ts', DECLARATION)).toHaveLength(1);
  });

  it('исключение снимает только своё правило: для других правил та же строка не исключена', () => {
    for (const { rule } of FRAME_RULES.filter(
      (item) => item.rule !== 'запись в каталоги агентов',
    )) {
      expect(isFrameException(STATUSLINE, rule, DECLARATION), rule).toBe(false);
    }
  });

  it('другие правила в этом файле действуют: учётные данные, API, YOLO-флаги', () => {
    for (const [line, rule] of [
      ["readFile(home + '/.claude/.credentials.json')", 'учётные данные агентов'],
      ["fetch('https://api.anthropic.com/v1/messages')", 'API провайдеров'],
      ["const args = ['--dangerously-skip-permissions'];", 'YOLO-флаги'],
    ] as const) {
      const hits = scanSource(STATUSLINE, line);
      expect(hits, line).toHaveLength(1);
      expect(hits[0]?.rule, line).toBe(rule);
    }
  });

  it('исключение не устарело: его строка есть в файле ровно один раз', async () => {
    for (const exception of FRAME_EXCEPTIONS) {
      const source = await readFile(path.join(repoRoot, exception.file), 'utf8');
      const same = source.split('\n').filter((line) => line.trim() === exception.line);
      expect(same, `${exception.file}: ${exception.line}`).toHaveLength(1);
    }
  });
});

/**
 * Закрепление использований константы пути (спека комнат Organic, 3.5). Исключение выше снимает
 * правило только со СТРОКИ ОБЪЯВЛЕНИЯ `SETTINGS_FILE`, а запись через константу сканер не видит: в
 * `writeFile(path.join(home, SETTINGS_FILE), …)` самого пути уже нет. Поэтому строки, где названа
 * константа, закреплены поимённо: новая ссылка краснит тест, пока человек осознанно не обновит
 * `PINNED_USES` в `frame-scan.ts`.
 */
describe('закрепление использований констант путей настроек (спека комнат, 3.5)', () => {
  const STATUSLINE = 'packages/core/src/work/statusline.ts';
  const NO_DRIFT = { added: [], removed: [] };
  const pinned = (): PinnedUses => {
    const [pin] = PINNED_USES;
    if (pin === undefined) throw new Error('в PINNED_USES нет закрепления');
    return pin;
  };
  const readStatusline = (): Promise<string> => readFile(path.join(repoRoot, STATUSLINE), 'utf8');
  // Мутации правят копию, а не настоящий файл: чистая копия — ровно закреплённые строки, поэтому
  // тесты с мутациями не зависят от того, что сейчас лежит в statusline.ts (его сверяет отдельный
  // тест).
  const cleanCopy = (): string => [...pinned().declarations, ...pinned().reads].join('\n');

  it('закрепление одно: statusline.ts, SETTINGS_FILE, два объявления и две строки чтения', () => {
    expect(PINNED_USES).toHaveLength(1);
    expect(pinned()).toMatchObject({ file: STATUSLINE, name: 'SETTINGS_FILE' });
    expect(pinned().declarations).toEqual([
      "const SETTINGS_FILE = '.claude/settings.json';",
      "const LOCAL_SETTINGS_FILE = '.claude/settings.local.json';",
    ]);
    // Объявление, снятое с правила исключением, закреплено вместе с остальными.
    expect(pinned().declarations).toContain(FRAME_EXCEPTIONS[0]?.line);
    expect(pinned().reads).toHaveLength(2);
  });

  it('в statusline.ts имя константы встречается только в закреплённых строках', async () => {
    expect(
      pinDrift(await readStatusline(), pinned()),
      'новая ссылка на константу пути настроек Claude Code: если она только читает, допишите ' +
        'строку в PINNED_USES (test/frame-scan.ts); запись в каталог агента — нарушение рамки 15.1',
    ).toEqual(NO_DRIFT);
  });

  // В чистую копию дописана строка записи через константу. Правило рамки такую строку не видит —
  // пути в ней нет, — а закрепление видит каждую; без мутации копия зелёная.
  it('запись через константу в копии файла краснит закрепление', () => {
    expect(pinDrift(cleanCopy(), pinned())).toEqual(NO_DRIFT);
    for (const write of [
      'await writeFile(path.join(home, SETTINGS_FILE), text);',
      'await rename(temp, SETTINGS_FILE);',
      "const backup = SETTINGS_FILE + '.bak';",
      'await writeFile(path.join(dir, LOCAL_SETTINGS_FILE), text);',
      // Комментарии не пропускаются: упоминание имени — такая же ссылка.
      '// SETTINGS_FILE',
    ]) {
      const drift = pinDrift(`${cleanCopy()}\n  ${write}\n`, pinned());
      expect(drift, write).toEqual({ added: [write], removed: [] });
    }
  });

  it('пропавшая закреплённая строка и лишняя копия закреплённой — тоже расхождение', () => {
    const read = 'return [...project, path.join(home, SETTINGS_FILE)];';
    expect(pinned().reads).toContain(read);
    // Строка чтения пропала — закрепление устарело.
    expect(pinDrift(cleanCopy().replace(read, '// убрано'), pinned())).toEqual({
      added: [],
      removed: [read],
    });
    // Строка продублирована: считаются строки, а не принадлежность к множеству.
    expect(pinDrift(`${cleanCopy()}\n  ${read}\n`, pinned())).toEqual({
      added: [read],
      removed: [],
    });
  });
});

describe('collectSourceFiles', () => {
  it('берёт .ts, пропускает .test.ts/.json/каталоги с точкой/node_modules (тест 10)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frame-scan-collect-'));
    try {
      await writeFile(path.join(dir, 'a.ts'), '');
      await writeFile(path.join(dir, 'a.test.ts'), '');
      await writeFile(path.join(dir, 'a.json'), '');
      await mkdir(path.join(dir, '.omc', 'state'), { recursive: true });
      await writeFile(path.join(dir, '.omc', 'state', 'x.ts'), '');
      await mkdir(path.join(dir, 'node_modules'), { recursive: true });
      await writeFile(path.join(dir, 'node_modules', 'x.ts'), '');

      const files = (await collectSourceFiles(dir)).map((file) => path.relative(dir, file));

      expect(files).toEqual(['a.ts']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('рамочный тест репозитория (тест 6)', () => {
  it('packages/*/src и tools/ чисты', async () => {
    const packagesDir = path.join(repoRoot, 'packages');
    const packageEntries = await readdir(packagesDir, { withFileTypes: true });
    const srcRoots = packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesDir, entry.name, 'src'));

    const hits = await scanRoots([...srcRoots, path.join(repoRoot, 'tools')]);

    const report = hits.map((hit) => `${hit.file}:${hit.line} — ${hit.rule}`).join('\n');
    expect(hits, report).toEqual([]);
  });

  // Нынешних «близких» совпадений в исходниках пять (без явных исключений FRAME_EXCEPTIONS), все в комментариях — сверено
  // по факту (raw-скан без фильтра комментариев) при написании этого раунда
  // исправлений. Если список изменится, этот тест укажет ровно на новую строку,
  // не пропустив её молча в общем «all clean».
  it('все нынешние совпадения регэкспов правил — в комментариях (перечислены)', async () => {
    const rawHits: FrameHit[] = [];
    const packagesDir = path.join(repoRoot, 'packages');
    const packageEntries = await readdir(packagesDir, { withFileTypes: true });
    const srcRoots = packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesDir, entry.name, 'src'));

    for (const root of [...srcRoots, path.join(repoRoot, 'tools')]) {
      for (const file of await collectSourceFiles(root)) {
        if (OWN_FILES.has(path.basename(file))) continue;
        const source = await readFile(file, 'utf8');
        const relative = path.relative(repoRoot, file);
        source.split('\n').forEach((line, index) => {
          for (const { rule, pattern } of FRAME_RULES) {
            // Явные исключения (`FRAME_EXCEPTIONS`) — код, а не комментарии: проверены отдельно.
            if (pattern.test(line) && !isFrameException(relative, rule, line))
              rawHits.push({ file: relative, line: index + 1, rule, text: line.trim() });
          }
        });
      }
    }

    const locations = rawHits.map((hit) => `${hit.file}:${hit.line}`).sort();
    expect(locations).toEqual(
      [
        'packages/core/src/codex/discover.ts:10',
        'packages/core/src/codex/discover.ts:9',
        'packages/core/src/providers.ts:17',
        'packages/core/src/providers.ts:263',
        'packages/core/src/work/mcp-config.ts:160',
      ].sort(),
    );
  });
});

/**
 * Всё, что лежит под `dir`: путь, вид, размер, время изменения и содержимое файлов. Два снимка
 * равны, только если под каталогом ничего не появилось, не пропало и не изменилось.
 */
async function snapshot(dir: string, base: string = dir): Promise<string[]> {
  const lines: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const info = await stat(full);
    const content = entry.isDirectory() ? '' : await readFile(full, 'utf8');
    const kind = entry.isDirectory() ? 'dir' : 'file';
    lines.push(`${path.relative(base, full)}|${kind}|${info.size}|${info.mtimeMs}|${content}`);
    if (entry.isDirectory()) lines.push(...(await snapshot(full, base)));
  }
  return lines;
}

describe('строка статуса не пишет в каталоги агента (спека комнат, 3.5)', () => {
  // Скрипт строки статуса читает настройки Claude Code — своя строка статуса человека лежит
  // там — и только читает: рамка «в `~/.claude` не пишем ничего» остаётся в силе. Данные лимитов
  // ложатся в каталог работы, а не в каталог агента.
  it('домашняя папка и проект человека после прогона скрипта не изменились ни на байт', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'frame-statusline-'));
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      const workDir = path.join(root, 'work');
      const human = (command: string): string =>
        JSON.stringify({ statusLine: { type: 'command', command } });
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
      await mkdir(path.join(project, '.claude'), { recursive: true });
      await mkdir(workDir);
      await writeFile(path.join(home, '.claude', 'settings.json'), human("printf 'user'"));
      await writeFile(path.join(home, '.claude', 'history.jsonl'), '{}\n');
      await writeFile(path.join(project, '.claude', 'settings.json'), human("printf 'shared'"));
      await writeFile(
        path.join(project, '.claude', 'settings.local.json'),
        human("printf 'local'"),
      );
      const before = { home: await snapshot(home), project: await snapshot(project) };

      const input = JSON.stringify({
        model: { display_name: 'Opus' },
        workspace: { current_dir: project, project_dir: project },
        rate_limits: { five_hour: { used_percentage: 58, resets_at: 4_102_444_800 } },
      });
      const env = {
        PATH: process.env['PATH'],
        PARLEY_WORK_DIR: workDir,
        PARLEY_SESSION_ID: 's-01',
      };
      const printed = await runStatusline(input, { env, home });

      // Настройки прочитаны (вывод — от команды человека), а не переписаны.
      expect(printed.toString()).toBe('local');
      expect({ home: await snapshot(home), project: await snapshot(project) }).toEqual(before);
      // Данные лимитов — в каталоге работы, и только там.
      expect(await readdir(path.join(workDir, 'limits'))).toEqual(['s-01.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('скилл агентов не пишет в каталоги агента (юридическая рамка, кусок 10)', () => {
  // Скиллы `parley` и `minimal-development` кладутся в проект и в worktree сессий, а `~/.claude`, `~/.codex`, `~/.agents` и
  // `~/.claude.json` не трогаются ни при каких условиях: ни установкой, ни учётом, ни строками exclude.
  it('домашняя папка после установки в проект и в worktree не изменилась ни на байт', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'frame-skill-'));
    const savedHome = process.env['HOME'];
    try {
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      const worktree = path.join(root, 'worktrees', 'w-0001-s-02');
      await mkdir(path.join(home, '.claude', 'skills', 'чужой'), { recursive: true });
      await mkdir(path.join(home, '.codex', 'sessions'), { recursive: true });
      await mkdir(path.join(home, '.agents', 'skills'), { recursive: true });
      await writeFile(path.join(home, '.claude.json'), '{"trust":true}\n');
      await writeFile(path.join(home, '.claude', 'settings.json'), '{}\n');
      await writeFile(path.join(home, '.claude', 'skills', 'чужой', 'SKILL.md'), 'чужой\n');
      await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "x"\n');
      await mkdir(project);
      await mkdir(worktree, { recursive: true });
      process.env['HOME'] = home;
      const before = await snapshot(home);

      await installAgentSkill({ projectPath: project, worktreePath: worktree });
      // Проект — сама домашняя папка и каталог агента внутри неё: писать туда нельзя, и не пишется.
      await installAgentSkill({ projectPath: home });
      await installAgentSkill({ projectPath: path.join(home, '.claude') });

      expect(await snapshot(home)).toEqual(before);
      // А в проекте и в worktree скиллы легли (parley и внутренний minimal-development, P39):
      // проверка не прошла бы на пустом месте.
      expect(await readdir(path.join(project, '.agents', 'skills'))).toEqual([
        'minimal-development',
        'parley',
      ]);
      expect(await readdir(path.join(worktree, '.claude', 'skills'))).toEqual([
        'minimal-development',
        'parley',
      ]);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
