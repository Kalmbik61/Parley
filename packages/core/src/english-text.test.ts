/**
 * Страж «тексты продукта по-английски» для core и protocol: ни одной кириллической буквы в строковых и
 * шаблонных литералах `packages/core/src` и `packages/protocol/src`. Это то, что во время работы доходит до
 * агента (гид, бриф, скилл, инструменты MCP, письма, указатели) и до человека (вывод и ошибки CLI,
 * предупреждения и ошибки, которые хост пересылает окну). Комментарии не проверяются: парсер не отдаёт их
 * узлами, поэтому кириллица в `//` и `/* … *\/` находкой не считается.
 *
 * Русские переводы в `core/src/i18n` разрешены во втором аргументе общего `defineCatalog`.
 * Остальное исключение — `// cyrillic-ok: <почему>` на той же исходной строке: метка-страж, лежащая в картах на
 * диске, или метка в файле, которую надо узнавать по прежнему тексту. Тесты не сканируются: их данные и
 * названия по-русски. Устройство — как у `packages/desktop/src/english-ui.test.ts`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const coreSrc = path.dirname(fileURLToPath(import.meta.url));
const protocolSrc = path.join(coreSrc, '..', '..', 'protocol', 'src');

const CYRILLIC = /[Ѐ-ӿ]/;
const CYRILLIC_OK = /\/\/\s*cyrillic-ok:/;

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
 * `Tail`). `getStart()` пропускает ведущую тривию, а срез не выходит за `getEnd()`, — комментарии вокруг
 * узла в срез не попадают.
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
  const localeIndex = relPath === path.join('i18n', 'index.ts');
  const catalogImport = localeIndex ? './catalog.js' : './index.js';
  const importsCatalog = path.dirname(relPath) === 'i18n' &&
    sourceFile.statements.some(
      (statement) => ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === catalogImport &&
        statement.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some(
          (item) => item.propertyName === undefined && item.name.text === 'defineCatalog',
        ),
    );
  const lines = sourceText.split('\n');
  const exempt = new Set<number>();
  lines.forEach((lineText, index) => {
    if (CYRILLIC_OK.test(lineText)) exempt.add(index + 1);
  });

  const violations: Violation[] = [];
  const reported = new Set<number>();
  const isText = (node: ts.Node): boolean =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail;

  const isRussianCatalogTranslation = (node: ts.Node): boolean => {
    if (!importsCatalog) return false;
    const property = node.parent;
    const object = property.parent;
    const call = object.parent;
    if (!ts.isPropertyAssignment(property) || property.initializer !== node ||
      !ts.isObjectLiteralExpression(object) || !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) || call.expression.text !== 'defineCatalog') return false;
    if (call.arguments[1] === object) return true;
    // Language names in the picker are written in their own language in both locales.
    return localeIndex && call.arguments[0] === object &&
      ts.isStringLiteral(property.name) && property.name.text === 'settings.language.ru' &&
      ts.isStringLiteral(node) && node.text === 'Русский';
  };

  const visit = (node: ts.Node): void => {
    if (isText(node) && !isRussianCatalogTranslation(node)) {
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

describe('english-text: страж кириллицы в текстах core и protocol', () => {
  it('packages/core/src не содержит кириллицы в строковых литералах (кроме каталогов и cyrillic-ok)', () => {
    const violations = scanDir(coreSrc);
    expect(violations, report(violations)).toEqual([]);
  });

  it('packages/protocol/src не содержит кириллицы в строковых литералах (кроме cyrillic-ok)', () => {
    const violations = scanDir(protocolSrc);
    expect(violations, report(violations)).toEqual([]);
  });

  it('сканер видит нужные файлы: иначе зелёный страж ничего бы не доказывал', () => {
    const core = collectFiles(coreSrc).map((file) => path.relative(coreSrc, file));
    expect(core).toEqual(
      expect.arrayContaining(['cli.ts', 'config.ts', 'work/guide.ts', 'work/worktree.ts']),
    );
    expect(core.some((file) => file.endsWith('.test.ts'))).toBe(false);
    const protocol = collectFiles(protocolSrc).map((file) => path.relative(protocolSrc, file));
    expect(protocol).toEqual(expect.arrayContaining(['framing.ts']));
  });
});

describe('scanDir: сам сканер (временный каталог)', () => {
  it('кириллица в строке и шаблоне — находка; cyrillic-ok и комментарии — нет', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'english-text-scan-'));
    try {
      await writeFile(
        path.join(dir, 'bad.ts'),
        ["export const plain = 'Привет';", 'export const named = `имя ${plain} дальше`;', ''].join(
          '\n',
        ),
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

      const catalogs = path.join(dir, 'i18n');
      await mkdir(catalogs);
      await writeFile(
        path.join(catalogs, 'catalog.ts'),
        [
          "import { defineCatalog } from './index.js';",
          "defineCatalog({ title: 'English' }, { title: 'Русский' });",
          "defineCatalog({ title: 'Русский' }, { title: 'Русский' });",
        ].join('\n'),
      );

      const violations = scanDir(dir);

      expect(violations.map((violation) => `${violation.file}:${violation.line}`)).toEqual([
        'bad.ts:1',
        'bad.ts:2',
        path.join('i18n', 'catalog.ts:3'),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
