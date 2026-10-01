// Общие запросы к API GitHub для гейтов релиза (план релиза 0.1.0, V5):
// `assert-github-release-is-draft.mjs` и `verify-release-required-assets.mjs`.
//
// Адаптация вспомогательных функций тех же скриптов Orca
// (https://github.com/stablyai/orca, config/scripts/, ветка main на 2026-09-30): у Orca каждый скрипт
// держит свою копию, здесь она одна. Copyright (c) 2026 Lovecast Inc. Лицензия MIT — полный текст
// в NOTICE в корне репозитория.
//
// Сеть подменяема: каждая функция принимает `fetchImpl`, юнит-тесты (packages/desktop/src/
// release-scripts.test.ts) кормят её выдуманными ответами и настоящего GitHub не трогают.

/* global fetch, AbortSignal */

export const DEFAULT_REPO = 'Kalmbik61/Parley';
export const API_URL = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Один запрос не должен держать задачу workflow: зависший канал — ошибка, а не часы ожидания. */
const REQUEST_TIMEOUT_MS = 30_000;

export function githubHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

/** Запрос с таймаутом; не 2xx — ошибка с началом тела ответа. Возвращает `Response`. */
export async function githubRequest(fetchImpl, url, token, { accept, ...options } = {}) {
  const res = await fetchImpl(url, {
    ...options,
    headers: { ...githubHeaders(token, accept), ...options.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub request failed ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res;
}

/**
 * Релизы репозитория вместе с черновиками (их видит только токен с правом записи — для публичного
 * `releases/tags/<тег>` черновика нет). Первая страница в 100 штук: свежий черновик всегда на ней.
 */
export async function listReleases({ repo, token, fetchImpl = fetch }) {
  const res = await githubRequest(
    fetchImpl,
    `${API_URL}/repos/${repo}/releases?per_page=100`,
    token,
  );
  const releases = await res.json();
  if (!Array.isArray(releases)) {
    throw new Error(`GitHub releases response for ${repo} was not an array`);
  }
  return releases;
}

/**
 * Ровно один релиз с тегом `tag`: нет релиза или их несколько — ошибка. Несколько черновиков на один
 * тег бывают, если electron-builder не нашёл созданный `create-release` и завёл свой, — тогда
 * `gh release edit <тег>` тронул бы случайный, и лучше остановиться.
 */
export function releaseForTag(releases, tag, repo) {
  const matches = releases.filter((release) => release?.tag_name === tag);
  if (matches.length === 0) {
    throw new Error(`No GitHub release with tag ${tag} was found in ${repo}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} GitHub releases in ${repo} have tag ${tag}; refusing to pick one`,
    );
  }
  return matches[0];
}

/**
 * Строка-аннотация ошибки для GitHub Actions. Переводы строк и `%` кодируются: иначе в аннотацию
 * попадает только первая строка сообщения, а список недостающих файлов остаётся за кадром.
 */
export function errorAnnotation(message) {
  const encoded = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `::error::${encoded}`;
}

/** Токен и репозиторий окружения; тег — из аргумента или `TAG` (в оболочку workflow он не подставляется). */
export function releaseEnvironment(env, argTag) {
  const tag = argTag ?? env.TAG;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!tag) throw new Error('Release tag is required: pass it as the first argument or in TAG');
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN must be set');
  return { tag, token, repo: env.GITHUB_REPOSITORY || DEFAULT_REPO };
}
