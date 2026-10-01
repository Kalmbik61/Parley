#!/usr/bin/env node
// Гейт релиза: перед публикацией в черновике лежат все файлы (план релиза 0.1.0, V5).
//
// Адаптация `config/scripts/verify-release-required-assets.mjs` из Orca
// (https://github.com/stablyai/orca, ветка main на 2026-09-30).
// Copyright (c) 2026 Lovecast Inc. Лицензия MIT — полный текст в NOTICE в корне репозитория.
//
// Против Orca упрощено и поправлено:
// - список файлов — под одну macOS-сборку Parley: 2 dmg, 2 zip, `latest-mac.yml`, `SHA256SUMS.txt`.
//   Имена без версии (`artifactName` в electron-builder.yml), поэтому от тега список не зависит;
//   Linux, Windows, deb, rpm и blockmap не требуются;
// - релиз тега должен быть ровно один и черновиком: публикует только `publish-release`, а вышедший
//   раньше релиз — повод остановиться, а не тихо пройти;
// - манифест `latest-mac.yml` читается, только если сам он загружен и не пуст.
//
// Использование: `TAG=v0.1.0 GH_TOKEN=… node scripts/release/verify-release-required-assets.mjs`.

/* global fetch */

import { realpathSync } from 'node:fs';
import { URL, pathToFileURL } from 'node:url';
import {
  API_URL,
  errorAnnotation,
  githubRequest,
  listReleases,
  releaseEnvironment,
  releaseForTag,
} from './github-api.mjs';

/** Что обязано лежать в релизе: имена фиксированы шаблоном `artifactName` и шагом `SHA256SUMS.txt`. */
export const REQUIRED_RELEASE_ASSETS = [
  'latest-mac.yml',
  'parley-macos-arm64.dmg',
  'parley-macos-arm64.zip',
  'parley-macos-x64.dmg',
  'parley-macos-x64.zip',
  'SHA256SUMS.txt',
];

/** Манифесты обновлений: файлы, на которые они ссылаются, тоже обязательны. */
export const UPDATE_MANIFESTS = ['latest-mac.yml'];

/** Имена файлов из строк `url:` и `path:` манифеста обновлений electron-builder. */
export function extractManifestAssetNames(manifestText) {
  const names = new Set();
  for (const line of manifestText.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?(?:url|path):\s*['"]?([^'"]+)['"]?\s*$/);
    if (!match) continue;
    const value = match[1].trim();
    try {
      names.add(new URL(value).pathname.split('/').findLast(Boolean) ?? value);
    } catch {
      names.add(value.split('/').findLast(Boolean) ?? value);
    }
  }
  return [...names];
}

const isUploaded = (asset) => !asset.state || asset.state === 'uploaded';

/**
 * Проверяет черновик тега: он один, это именно черновик, и каждый обязательный файл (и каждый,
 * названный в манифестах) загружен и не пуст. Нарушение — ошибка со списком; иначе
 * `{ tag, checked, draft, prerelease }`.
 */
export async function verifyRequiredReleaseAssets({ repo, tag, token, fetchImpl = fetch }) {
  const release = releaseForTag(await listReleases({ repo, token, fetchImpl }), tag, repo);
  if (release.draft !== true) {
    throw new Error(
      `Release ${tag} is already published; only a draft can be verified for publishing.`,
    );
  }
  const assetsByName = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  const required = new Set(REQUIRED_RELEASE_ASSETS);

  for (const manifestName of UPDATE_MANIFESTS) {
    const manifest = assetsByName.get(manifestName);
    if (manifest === undefined || !isUploaded(manifest) || manifest.size === 0) continue;
    const res = await githubRequest(
      fetchImpl,
      `${API_URL}/repos/${repo}/releases/assets/${manifest.id}`,
      token,
      { accept: 'application/octet-stream' },
    );
    for (const referenced of extractManifestAssetNames(await res.text())) required.add(referenced);
  }

  const names = [...required].sort();
  const present = names.filter((name) => assetsByName.has(name));
  const missing = names.filter((name) => !assetsByName.has(name));
  const notUploaded = present.filter((name) => !isUploaded(assetsByName.get(name)));
  const empty = present.filter((name) => assetsByName.get(name).size === 0);

  if (missing.length > 0 || notUploaded.length > 0 || empty.length > 0) {
    throw new Error(
      [
        `Release ${tag} is missing required assets.`,
        missing.length > 0 ? `Missing: ${missing.join(', ')}` : null,
        notUploaded.length > 0
          ? `Not uploaded: ${notUploaded.map((name) => `${name}:${assetsByName.get(name).state}`).join(', ')}`
          : null,
        empty.length > 0 ? `Empty: ${empty.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return { tag, checked: names, draft: release.draft, prerelease: release.prerelease };
}

async function main() {
  const { tag, token, repo } = releaseEnvironment(process.env, process.argv[2]);
  const result = await verifyRequiredReleaseAssets({ repo, tag, token });
  console.log(`Verified ${result.checked.length} required release assets for ${repo}@${tag}`);
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
