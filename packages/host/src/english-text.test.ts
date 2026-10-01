/**
 * Страж «тексты продукта по-английски» для хоста: ни одной кириллической буквы в строковых и шаблонных
 * литералах `packages/host/src`, кроме строк журнала. Это то, что хост отдаёт наружу во время работы:
 * `message` ошибок протокола (их читает окно и вызывающий клиент), `text` уведомлений `host.notice`,
 * системные письма сессиям, текст слияния и строки для агента. Комментарии не проверяются: парсер не
 * отдаёт их узлами, поэтому кириллица в `//` и `/* … *\/` находкой не считается.
 *
 * Строки журнала хоста (`log.info|warn|error|debug('…')` — первый аргумент) остаются по-русски: их читает
 * разработчик в `host.log`, а не человек в окне. Исключение для остального — `// cyrillic-ok: <почему>` на
 * той же исходной строке. Тесты не сканируются: их данные и названия по-русски. Устройство — как у
 * `packages/core/src/english-text.test.ts` и `packages/desktop/src/english-ui.test.ts`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const hostSrc = path.dirname(fileURLToPath(import.meta.url));

const CYRILLIC = /[Ѐ-ӿ]/;
const CYRILLIC_OK = /\/\/\s*cyrillic-ok:/;
/** Вызов журнала: `host.log.error`, `log.info`, `options.context.log.warn`, `log[expected ? 'info' : 'warn']`. */
const LOG_CALLEE = /(^|\.)log(\.(debug|info|warn|error)|\[[^\]]*\])$/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

/** `.ts` каталога рекурсивно, кроме тестов и деклараций. */
function collectFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

/**
 * Кириллица в `StringLiteral`, `NoSubstitutionTemplateLiteral` и частях шаблона (`TemplateHead`/`Middle`/
 * `Tail`), которые не лежат в первом аргументе вызова журнала. `getStart()` пропускает ведущую тривию, а срез
 * не выходит за `getEnd()`, — комментарии вокруг узла в срез не попадают.
 */
function scanFile(absPath: string, relPath: string): Violation[] {
  const sourceText = readFileSync(absPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    absPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const lines = sourceText.split('\n');
  const exempt = new Set<number>();
  lines.forEach((lineText, index) => {
    if (CYRILLIC_OK.test(lineText)) exempt.add(index + 1);
  });

  const isText = (node: ts.Node): boolean =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail;

  /** Узел лежит внутри первого аргумента вызова журнала — это строка для `host.log`, а не для человека. */
  const isLogMessage = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (!ts.isCallExpression(parent) || !LOG_CALLEE.test(parent.expression.getText(sourceFile))) continue;
      const message = parent.arguments[0];
      if (message !== undefined && node.pos >= message.pos && node.end <= message.end) return true;
    }
    return false;
  };

  const violations: Violation[] = [];
  const reported = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (isText(node) && !isLogMessage(node)) {
      const start = node.getStart(sourceFile);
      const raw = sourceText.slice(start, node.getEnd());
      for (let i = 0; i < raw.length; i += 1) {
        if (!CYRILLIC.test(raw[i] ?? '')) continue;
        const lineNumber = sourceFile.getLineAndCharacterOfPosition(start + i).line + 1;
        if (exempt.has(lineNumber) || reported.has(lineNumber)) continue;
        reported.add(lineNumber);
        violations.push({
          file: relPath,
          line: lineNumber,
          text: (lines[lineNumber - 1] ?? '').trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

const scanDir = (root: string): Violation[] =>
  collectFiles(root).flatMap((file) => scanFile(file, path.relative(root, file)));

const report = (violations: Violation[]): string =>
  violations
    .map((violation) => `${violation.file}:${violation.line} — ${violation.text}`)
    .join('\n');

describe('english-text: страж кириллицы в текстах хоста', () => {
  it('packages/host/src не содержит кириллицы в строковых литералах (кроме строк журнала и cyrillic-ok)', () => {
    const violations = scanDir(hostSrc);
    expect(violations, report(violations)).toEqual([]);
  });

  it('сканер видит нужные файлы: иначе зелёный страж ничего бы не доказывал', () => {
    const files = collectFiles(hostSrc).map((file) => path.relative(hostSrc, file));
    expect(files).toEqual(
      expect.arrayContaining([
        'host.ts',
        'server.ts',
        'rooms/rooms-service.ts',
        'sessions/sessions-service.ts',
        'wake/wake-service.ts',
        'worktrees/worktrees-service.ts',
      ]),
    );
    expect(files.some((file) => file.endsWith('.test.ts'))).toBe(false);
  });
});

describe('scanDir: сам сканер (временный каталог)', () => {
  it('кириллица в ошибке, шаблоне и втором аргументе журнала — находка; журнал, cyrillic-ok и комментарии — нет', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'english-text-scan-'));
    try {
      await writeFile(
        path.join(dir, 'bad.ts'),
        [
          "export const plain = new Error('Привет');",
          'export const named = `имя ${plain} дальше`;',
          "host.log.error('нормально', { text: 'не нормально' });",
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'log.ts'),
        [
          "host.log.error('сбой записи', { error: String(error) });",
          'options.context.log.warn(`карта: ${kind}`, { text });',
          "log[expected ? 'info' : 'warn']('перенесён', { projectPath });",
          '',
        ].join('\n'),
      );
      await writeFile(
        path.join(dir, 'ok.ts'),
        "export const mark = 'Привет'; // cyrillic-ok: метка на диске\n",
      );
      await writeFile(
        path.join(dir, 'comment.ts'),
        "// Комментарий по-русски\n/** И JSDoc */\nexport const text = 'Hello';\n",
      );
      await writeFile(path.join(dir, 'bad.test.ts'), "export const skipped = 'Привет';\n");

      const violations = scanDir(dir);

      expect(violations.map((violation) => `${violation.file}:${violation.line}`)).toEqual([
        'bad.ts:1',
        'bad.ts:2',
        'bad.ts:3',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
