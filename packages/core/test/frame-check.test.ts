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
import { runStatusline } from '../src/work/statusline.js';
import { collectSourceFiles, FRAME_RULES, scanSource, type FrameHit } from './frame-scan.js';

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
  it('покрывает все четыре правила таблицы спеки 14.4', () => {
    expect(FRAME_RULES.map((item) => item.rule)).toEqual([
      'учётные данные агентов',
      'запись в каталоги агентов',
      'API провайдеров',
      'YOLO-флаги',
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

  // Нынешних «близких» совпадений в исходниках пять, все в комментариях — сверено
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
            if (pattern.test(line))
              rawHits.push({ file: relative, line: index + 1, rule, text: line.trim() });
          }
        });
      }
    }

    const locations = rawHits.map((hit) => `${hit.file}:${hit.line}`).sort();
    expect(locations).toEqual(
      [
        'packages/core/src/codex/discover.ts:8',
        'packages/core/src/codex/discover.ts:9',
        'packages/core/src/providers.ts:13',
        'packages/core/src/providers.ts:167',
        'packages/core/src/work/mcp-config.ts:89',
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
        HARNAS_WORK_DIR: workDir,
        HARNAS_SESSION_ID: 's-01',
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
