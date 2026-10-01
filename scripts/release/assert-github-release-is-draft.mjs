#!/usr/bin/env node
// Гейт релиза: релиз тега должен быть черновиком (план релиза 0.1.0, V5).
//
// Адаптация `config/scripts/assert-github-release-is-draft.mjs` из Orca
// (https://github.com/stablyai/orca, ветка main на 2026-09-30).
// Copyright (c) 2026 Lovecast Inc. Лицензия MIT — полный текст в NOTICE в корне репозитория.
//
// Против Orca упрощено и поправлено:
// - по умолчанию скрипт только проверяет. Вернуть вышедший релиз в черновик он может лишь с
//   `--restore` — так гейт в `publish-release` не «снимет с публикации» уже опубликованный релиз
//   при повторном запуске задачи. С `--restore` его зовёт `build-mac` сразу после загрузки файлов:
//   если electron-builder опубликовал релиз сам, `/releases/latest` не должен отдавать недогруженный;
// - релиз ищется только по `tag_name` и должен быть ровно один (Orca ещё сверяет имя и версию без `v`);
// - репозиторий по умолчанию свой, а тег берётся из `TAG`: в оболочку workflow имя тега не подставляется.
//
// Использование: `TAG=v0.1.0 GH_TOKEN=… node scripts/release/assert-github-release-is-draft.mjs [--restore]`.
// Черновик — код 0, иначе 1 (после `--restore` релиз снова черновик, но код всё равно 1: загрузка
// не прошла как надо).

/* global fetch */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  API_URL,
  errorAnnotation,
  githubRequest,
  listReleases,
  releaseEnvironment,
  releaseForTag,
} from './github-api.mjs';

/**
 * Состояние релиза тега. Черновик — `{ draft: true }`. Иначе без `restore` ничего не меняется, а с ним
 * релиз возвращается в черновик (PATCH): `{ draft: false, restored: true }`. Нет релиза тега или их
 * несколько — ошибка.
 */
export async function checkReleaseDraftState({
  repo,
  tag,
  token,
  restore = false,
  fetchImpl = fetch,
  log = console.error,
}) {
  const release = releaseForTag(await listReleases({ repo, token, fetchImpl }), tag, repo);
  if (release.draft === true) return { draft: true, restored: false, release };
  if (!restore) return { draft: false, restored: false, release };

  if (!Number.isInteger(release.id)) {
    throw new Error(`Release ${tag} is missing a GitHub release id`);
  }
  // `make_latest: 'false'`: возвращённый в черновик релиз не должен остаться «последним».
  const res = await githubRequest(
    fetchImpl,
    `${API_URL}/repos/${repo}/releases/${release.id}`,
    token,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft: true, make_latest: 'false' }),
    },
  );
  log(`Restored GitHub release ${release.id} (${tag}) to draft.`);
  return { draft: false, restored: true, release: await res.json() };
}

async function main() {
  const args = process.argv.slice(2);
  const restore = args.includes('--restore');
  const { tag, token, repo } = releaseEnvironment(
    process.env,
    args.find((arg) => !arg.startsWith('--')),
  );
  const state = await checkReleaseDraftState({ repo, tag, token, restore });
  if (state.draft) {
    console.log(`Release ${tag} is a draft.`);
    return;
  }
  console.error(
    errorAnnotation(
      state.restored
        ? `Release ${tag} was published during the artifact upload. Restored it to draft so /releases/latest does not serve partial assets.`
        : `Release ${tag} is already published; refusing to continue.`,
    ),
  );
  process.exitCode = 1;
}

// Запуск из командной строки; при импорте (тест) ничего не делается. `realpath`: `import.meta.url` —
// настоящий путь файла, а `argv[1]` мог прийти через символическую ссылку.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(errorAnnotation(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
