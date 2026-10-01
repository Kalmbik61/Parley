#!/usr/bin/env node
// Подготовка релиза для задачи `create-release` (.github/workflows/release.yml, план релиза 0.1.0, V5):
// проверяет тег, берёт заметки из CHANGELOG.md и отдаёт задаче версию и признак prerelease.
//
// Тег — единственная строка снаружи, и приходит она через переменную `TAG`: в оболочку workflow имя
// тега не подставляется. Скрипт принимает только строгий вид `vX.Y.Z` или `vX.Y.Z-пререлиз` и
// требует, чтобы версия в теге совпала с версией окна (`packages/desktop/package.json`): её же
// показывает приложение и по ней electron-builder ищет релиз-черновик.
//
// Окружение:
//   TAG          имя тега (`github.ref_name`);
//   REF_TYPE     `github.ref_type`: релиз собирается только с тега, не с ветки;
//   NOTES_FILE   куда записать заметки релиза (раздел версии из CHANGELOG.md, без заголовка);
//   GITHUB_OUTPUT  файл выходов шага Actions: `tag`, `version`, `prerelease`. Не задан (локальный
//                запуск) — выходы идут в stdout.

import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { errorAnnotation } from './github-api.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `vX.Y.Z` или `vX.Y.Z-rc.1` (идентификаторы пререлиза по semver); метаданные сборки (`+…`) не принимаются. */
export const TAG_PATTERN = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

/** Версия и признак prerelease из тега; не тот вид — ошибка. Тег с «-» — prerelease. */
export function parseReleaseTag(tag) {
  const match = TAG_PATTERN.exec(tag);
  if (match === null) {
    throw new Error(
      `Tag ${JSON.stringify(tag)} is not a release tag: expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-prerelease`,
    );
  }
  return { version: match[1], prerelease: match[1].includes('-') };
}

/** Релиз режется с тега, версия тега равна версии окна. Возвращает `{ version, prerelease }`. */
export function checkReleaseTag({ tag, refType, desktopVersion }) {
  if (refType !== 'tag') {
    throw new Error(
      `A release is cut from a tag, but this run is on a ${refType || 'unknown'} ref: push a vX.Y.Z tag, or start the workflow on that tag`,
    );
  }
  const parsed = parseReleaseTag(tag);
  if (parsed.version !== desktopVersion) {
    throw new Error(
      `Tag ${tag} does not match version ${desktopVersion} in packages/desktop/package.json`,
    );
  }
  return parsed;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Заголовок раздела версии: `## 0.1.0`, `## [0.1.0] - 2026-10-01`, `## v0.1.0 (2026-10-01)`. */
const headingFor = (version) =>
  new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?:[\\s(].*)?$`);

/** Строки в хвосте раздела, не относящиеся к заметкам: пустые и ссылки версий (`[0.1.0]: https://…`). */
const TRAILING_NOISE = /^(?:\s*|\[(?:Unreleased|v?\d[^\]]*)\]:\s+\S.*)$/i;

/**
 * Заметки версии из CHANGELOG.md: всё между её заголовком второго уровня и следующим, без самого
 * заголовка (название релиза и так «Parley X.Y.Z»). Нет раздела или он пуст — ошибка: релиз без
 * заметок не выпускаем.
 */
export function extractChangelogNotes(markdown, version) {
  const lines = markdown.split(/\r?\n/);
  const heading = headingFor(version);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) {
    throw new Error(
      `CHANGELOG.md has no section for version ${version}: expected a heading like "## ${version}"`,
    );
  }
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const body = lines.slice(start + 1, next === -1 ? lines.length : next);
  while (body.length > 0 && TRAILING_NOISE.test(body[body.length - 1])) body.pop();
  const notes = body.join('\n').trim();
  if (notes === '') throw new Error(`The CHANGELOG.md section for version ${version} is empty`);
  return notes;
}

function main() {
  const {
    TAG: tag = '',
    REF_TYPE: refType = '',
    NOTES_FILE: notesFile,
    GITHUB_OUTPUT: outputFile,
  } = process.env;
  if (!notesFile) throw new Error('NOTES_FILE is required: where to write the release notes');

  const desktop = JSON.parse(
    readFileSync(path.join(repoRoot, 'packages', 'desktop', 'package.json'), 'utf8'),
  );
  const { version, prerelease } = checkReleaseTag({
    tag,
    refType,
    desktopVersion: desktop.version,
  });
  const notes = extractChangelogNotes(
    readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8'),
    version,
  );

  writeFileSync(notesFile, `${notes}\n`);
  const outputs = `tag=${tag}\nversion=${version}\nprerelease=${prerelease}\n`;
  if (outputFile) appendFileSync(outputFile, outputs);
  else process.stdout.write(outputs);
  console.log(
    `Release ${tag}: version ${version}, ${prerelease ? 'prerelease' : 'stable'}, notes from CHANGELOG.md`,
  );
}

// Запуск из командной строки; при импорте (тест) ничего не делается. `realpath`: `import.meta.url` —
// настоящий путь файла, а `argv[1]` мог прийти через символическую ссылку.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(errorAnnotation(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
