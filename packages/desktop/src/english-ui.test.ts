/**
 * Страж «английский интерфейс окна» (кусок E.1, решение пользователя
 * 2026-09-27): ни одной кириллической буквы в видимых строках
 * `packages/desktop/src` — строковых литералах, шаблонных литералах и тексте
 * JSX. Комментарии не проверяются — парсер их не отдаёт как узлы с этим
 * видом (`ts.forEachChild` в них не заходит), поэтому кириллица в `//` и
 * `/* … *\/` не считается находкой сама по себе. Отдельная строка-исключение —
 * `// cyrillic-ok: <почему>` на той же исходной строке, где найдена кириллица
 * (например, нормализация `ё`/`е` в палитре, кусок 6.2).
 *
 * Тесты и `test-utils/` не сканируются: их селекторы и фикстуры — не
 * интерфейс. Сам этот файл тоже себя не сканирует (имя видно по basename).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const dirname = path.dirname(fileURLToPath(import.meta.url));
/** `packages/desktop/src` — этот файл лежит прямо в нём. */
const srcRoot = dirname;

const OWN_FILE = path.basename(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(['test-utils']);
const CYRILLIC = /[Ѐ-ӿ]/;
const CYRILLIC_OK = /\/\/\s*cyrillic-ok:/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Обходит каталог рекурсивно и отдаёт `.ts`/`.tsx`/`.js`, кроме тестов, `test-utils/` и самого стража.
 * `.js` — с 9.3a: подпись оверлея Design Mode живёт в `main/browser/guest-pick.js`.
 */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx|js)$/.test(entry.name)) continue;
      if (entry.name.includes('.test.')) continue;
      if (entry.name === OWN_FILE) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Разбирает файл TS-парсером и ищет кириллицу в `StringLiteral`,
 * `NoSubstitutionTemplateLiteral`, частях шаблонных литералов (`TemplateHead`
 * /`Middle`/`Tail`) и `JsxText`. `node.getStart()` пропускает ведущую
 * тривию (пробелы и комментарии), а срез не выходит за `node.getEnd()` —
 * поэтому комментарии вокруг узла в срез не попадают.
 */
function scanFile(absPath: string, relPath: string): Violation[] {
  const sourceText = readFileSync(absPath, 'utf8');
  const scriptKind = absPath.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : absPath.endsWith('.js')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(absPath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = sourceText.split('\n');
  const exemptLines = new Set<number>();
  lines.forEach((lineText, index) => {
    if (CYRILLIC_OK.test(lineText)) exemptLines.add(index + 1);
  });

  const violations: Violation[] = [];
  const reportedLines = new Set<number>();

  const isTextNode = (node: ts.Node): boolean =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail ||
    ts.isJsxText(node);

  const visit = (node: ts.Node): void => {
    if (isTextNode(node)) {
      const start = node.getStart(sourceFile);
      const raw = sourceText.slice(start, node.getEnd());
      for (let i = 0; i < raw.length; i += 1) {
        if (!CYRILLIC.test(raw[i] ?? '')) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(start + i);
        const lineNumber = line + 1;
        if (exemptLines.has(lineNumber) || reportedLines.has(lineNumber)) continue;
        reportedLines.add(lineNumber);
        violations.push({ file: relPath, line: lineNumber, text: (lines[line] ?? '').trim() });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function scanDir(root: string): Violation[] {
  return collectFiles(root).flatMap((file) => scanFile(file, path.relative(root, file)));
}

describe('english-ui: страж кириллицы в интерфейсе окна', () => {
  it('packages/desktop/src не содержит кириллицы в видимых строках (кроме cyrillic-ok)', () => {
    const violations = scanDir(srcRoot);
    const report = violations.map((v) => `${v.file}:${v.line} — ${v.text}`).join('\n');
    expect(violations, report).toEqual([]);
  });

  // Язык документа читают экранный диктор и проверка орфографии полей (ревью M9): окно по-английски.
  it('renderer/index.html объявляет lang="en"', () => {
    const html = readFileSync(path.join(srcRoot, 'renderer', 'index.html'), 'utf8');
    expect(html).toMatch(/<html\s+lang="en"\s*>/);
  });
});

describe('scanDir: сам сканер (временный каталог)', () => {
  it('валит файл с кириллицей и пропускает строку с пометкой cyrillic-ok', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'english-ui-scan-'));
    try {
      await writeFile(path.join(dir, 'bad.ts'), "export const bad = 'Привет';\n");
      await writeFile(path.join(dir, 'ok.ts'), "export const ok = 'Привет'; // cyrillic-ok: тест\n");

      const violations = scanDir(dir);

      expect(violations.map((v) => v.file)).toEqual(['bad.ts']);
      expect(violations[0]).toMatchObject({ file: 'bad.ts', line: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('смотрит и .js (кусок 9.3a): кириллица в строке скрипта — находка; guest-pick.js проходит', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'english-ui-scan-js-'));
    try {
      await writeFile(path.join(dir, 'bad.js'), "const label = 'Кнопка';\n");
      await writeFile(path.join(dir, 'ok.js'), "// Комментарий по-русски\nconst label = 'Button';\n");

      expect(scanDir(dir).map((v) => v.file)).toEqual(['bad.js']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const guestPick = path.join(srcRoot, 'main', 'browser', 'guest-pick.js');
    expect(scanFile(guestPick, 'guest-pick.js')).toEqual([]);
    expect(collectFiles(srcRoot)).toContain(guestPick);
  });
});
