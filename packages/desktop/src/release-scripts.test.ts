/**
 * Скрипты выпуска релиза (`scripts/release/`, план релиза 0.1.0, V5): проверка тега и заметок из CHANGELOG.md,
 * гейт «релиз — черновик» и гейт «в черновике все файлы». Сеть подменена: настоящий GitHub тесты не трогают,
 * ответы API выдуманы по форме настоящих (`GET /repos/{repo}/releases`).
 */
import { describe, expect, it } from 'vitest';
import { checkReleaseDraftState } from '../../../scripts/release/assert-github-release-is-draft.mjs';
import {
  errorAnnotation,
  releaseEnvironment,
  releaseForTag,
} from '../../../scripts/release/github-api.mjs';
import {
  checkReleaseTag,
  extractChangelogNotes,
  parseReleaseTag,
} from '../../../scripts/release/prepare-release.mjs';
import {
  REQUIRED_RELEASE_ASSETS,
  extractManifestAssetNames,
  verifyRequiredReleaseAssets,
} from '../../../scripts/release/verify-release-required-assets.mjs';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FakeAsset {
  id: number;
  name: string;
  size: number;
  state: string;
}

/** `fetch`, который отвечает по таблице «подстрока адреса → ответ» и записывает все вызовы. */
function fakeGithub(routes: Array<[string, () => Response]>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    for (const [needle, respond] of routes) if (url.includes(needle)) return respond();
    throw new Error(`fake GitHub: no route for ${url}`);
  };
  return { fetchImpl, calls };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const asset = (name: string, extra: Partial<FakeAsset> = {}): FakeAsset => ({
  id: Math.abs([...name].reduce((sum, ch) => sum * 31 + ch.charCodeAt(0), 7)) % 1_000_000,
  name,
  size: 1024,
  state: 'uploaded',
  ...extra,
});

/** `latest-mac.yml`, как его пишет electron-builder для наших dmg и zip. */
const MANIFEST = `version: 0.1.0
files:
  - url: parley-macos-x64.zip
    sha512: NmExQ4o2U8E9eeWx9J1B/okVykgRyuS6WADc5TfMkE3dkjYYg0mUbFNF2PvVqW32PnXKxVE2gFyQYimfoKCpNQ==
    size: 200758401
  - url: parley-macos-arm64.zip
    sha512: ipRutzOvqREK4KqgqbhSA+eOgIVvEdJh2T1BujdnN8gxgbXnfiOCyWlj70oKg7Hy5/1StEFeJPtxqfdkYpjQPA==
    size: 194092340
  - url: parley-macos-x64.dmg
    sha512: p05RL2Nfjv95e93g/wDOQV1qi0kKwLdwM73yjGt/bukTiV6Xtp3wt6X2keKN8eD1YGpsOvbAKdXCbZB2vF92wA==
    size: 205045635
  - url: parley-macos-arm64.dmg
    sha512: oXYO6HXjUZYmm/H87cYmRvCti3ZOuEn29GJKhCD8YjwKjMAQxbnLp7heJGCMl16svhVnaWq4tQYtuq+SbY47Ig==
    size: 198380738
path: parley-macos-x64.zip
sha512: NmExQ4o2U8E9eeWx9J1B/okVykgRyuS6WADc5TfMkE3dkjYYg0mUbFNF2PvVqW32PnXKxVE2gFyQYimfoKCpNQ==
releaseDate: '2026-10-01T07:05:43.799Z'
`;

const fullAssets = (): FakeAsset[] => [
  ...REQUIRED_RELEASE_ASSETS.map((name) => asset(name)),
  // electron-builder кладёт и blockmap — обязательными они не считаются.
  asset('parley-macos-arm64.dmg.blockmap'),
];

const REPO = 'Kalmbik61/Parley';
const TAG = 'v0.1.0';
const LIST_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;

describe('prepare-release: тег', () => {
  it('принимает vX.Y.Z и пререлиз vX.Y.Z-идентификаторы; «-» в теге — prerelease', () => {
    expect(parseReleaseTag('v0.1.0')).toEqual({ version: '0.1.0', prerelease: false });
    expect(parseReleaseTag('v12.30.4')).toEqual({ version: '12.30.4', prerelease: false });
    expect(parseReleaseTag('v0.2.0-rc.1')).toEqual({ version: '0.2.0-rc.1', prerelease: true });
    expect(parseReleaseTag('v1.0.0-beta')).toEqual({ version: '1.0.0-beta', prerelease: true });
  });

  it.each([
    '',
    '0.1.0',
    'V0.1.0',
    'v0.1',
    'v0.1.0.1',
    'v0.1.0-',
    'v0.1.0+build.5',
    'v0.1.0 ',
    ' v0.1.0',
    'v0.1.0\nv0.1.0',
    'v0.1.0; touch /tmp/pwned',
    'v0.1.0"; echo "',
    'v0.1.0$(id)',
    'v0.1.0`id`',
    'v0.1.0|cat',
    'v${{ secrets.GITHUB_TOKEN }}',
    'v../../0.1.0',
  ])('отвергает %j: в оболочку и в API идут только строгие теги', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow(/not a release tag/);
  });

  it('релиз режется с тега, а версия тега равна версии окна', () => {
    expect(checkReleaseTag({ tag: 'v0.1.0', refType: 'tag', desktopVersion: '0.1.0' })).toEqual({
      version: '0.1.0',
      prerelease: false,
    });
    expect(() =>
      checkReleaseTag({ tag: 'v0.1.1', refType: 'tag', desktopVersion: '0.1.0' }),
    ).toThrow(/Tag v0\.1\.1 does not match version 0\.1\.0 in packages\/desktop\/package\.json/);
    expect(() =>
      checkReleaseTag({ tag: 'v0.1.0-rc.1', refType: 'tag', desktopVersion: '0.1.0' }),
    ).toThrow(/does not match/);
    // Ветка с именем «v0.1.0» — не тег: ручной запуск не на теге релизом не станет.
    expect(() =>
      checkReleaseTag({ tag: 'v0.1.0', refType: 'branch', desktopVersion: '0.1.0' }),
    ).toThrow(/cut from a tag, but this run is on a branch ref/);
    expect(() => checkReleaseTag({ tag: 'main', refType: 'tag', desktopVersion: '0.1.0' })).toThrow(
      /not a release tag/,
    );
  });
});

describe('prepare-release: заметки из CHANGELOG.md', () => {
  const changelog = `# Changelog

All notable changes to Parley.

## [Unreleased]

- Nothing yet.

## [0.2.0] - 2026-11-01

- Second release.

## [0.1.0] - 2026-10-01

First public release.

### Added

- The window: sessions, rooms and decisions.
- Claude Code and Codex.

### Known issues

- macOS only.

## [0.0.9] - 2026-09-01

- Old.

[Unreleased]: https://github.com/Kalmbik61/Parley/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Kalmbik61/Parley/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kalmbik61/Parley/releases/tag/v0.1.0
`;

  it('берёт раздел версии целиком — от заголовка до следующего «## », с подразделами, без заголовка', () => {
    const notes = extractChangelogNotes(changelog, '0.1.0');

    expect(notes.startsWith('First public release.')).toBe(true);
    expect(notes).toContain('### Added');
    expect(notes).toContain('- Claude Code and Codex.');
    expect(notes).toContain('### Known issues\n\n- macOS only.');
    expect(notes).not.toContain('0.1.0');
    expect(notes).not.toContain('Old.');
    expect(notes).not.toContain('Second release.');
  });

  it('последний раздел файла теряет хвост ссылок версий, но не свои ссылки', () => {
    const notes = extractChangelogNotes(
      `## 0.1.0\n\nSee [docs] for more.\n\n[docs]: https://example.test/docs\n[0.1.0]: https://example.test/0.1.0\n`,
      '0.1.0',
    );

    expect(notes).toBe('See [docs] for more.\n\n[docs]: https://example.test/docs');
  });

  it.each([
    '## 0.1.0',
    '## [0.1.0]',
    '## v0.1.0',
    '## [0.1.0] - 2026-10-01',
    '## 0.1.0 (2026-10-01)',
    '## [0.1.0](https://example.test/compare/a...b) (2026-10-01)',
    '##   0.1.0',
  ])('узнаёт заголовок «%s»', (heading) => {
    expect(extractChangelogNotes(`# Changelog\n\n${heading}\n\nNotes.\n`, '0.1.0')).toBe('Notes.');
  });

  it('версию с пререлизом ищет точно и не путает соседние', () => {
    const text =
      '## 0.1.0-rc.1\n\nRC.\n\n## 0.1.0\n\nStable.\n\n## 10.1.0\n\nTen.\n\n## 0.1.01\n\nOdd.\n';

    expect(extractChangelogNotes(text, '0.1.0-rc.1')).toBe('RC.');
    expect(extractChangelogNotes(text, '0.1.0')).toBe('Stable.');
    expect(extractChangelogNotes(text, '10.1.0')).toBe('Ten.');
  });

  it('CRLF не мешает', () => {
    expect(
      extractChangelogNotes(
        '## 0.1.0\r\n\r\nLine one.\r\nLine two.\r\n\r\n## 0.0.9\r\n\r\nOld.\r\n',
        '0.1.0',
      ),
    ).toBe('Line one.\nLine two.');
  });

  it('нет раздела версии или он пуст — ошибка: релиз без заметок не выпускаем', () => {
    expect(() => extractChangelogNotes(changelog, '0.3.0')).toThrow(
      /no section for version 0\.3\.0/,
    );
    expect(() => extractChangelogNotes('', '0.1.0')).toThrow(/no section/);
    expect(() => extractChangelogNotes('## 0.1.0\n\n\n## 0.0.9\n\nOld.\n', '0.1.0')).toThrow(
      /section for version 0\.1\.0 is empty/,
    );
    expect(() =>
      extractChangelogNotes('## 0.1.0\n\n[0.1.0]: https://example.test\n', '0.1.0'),
    ).toThrow(/is empty/);
  });
});

describe('github-api', () => {
  it('releaseForTag: ровно один релиз с тегом, иначе ошибка', () => {
    const one = { tag_name: TAG, draft: true };

    expect(releaseForTag([{ tag_name: 'v0.0.9' }, one], TAG, REPO)).toBe(one);
    expect(() => releaseForTag([{ tag_name: 'v0.0.9' }], TAG, REPO)).toThrow(
      /No GitHub release with tag v0\.1\.0/,
    );
    expect(() => releaseForTag([], TAG, REPO)).toThrow(/No GitHub release/);
    expect(() => releaseForTag([one, { ...one }], TAG, REPO)).toThrow(
      /2 GitHub releases .* refusing to pick one/,
    );
  });

  it('releaseEnvironment: тег — аргумент или TAG, токен — GH_TOKEN или GITHUB_TOKEN, репозиторий — свой по умолчанию', () => {
    expect(releaseEnvironment({ TAG: 'v1.0.0', GH_TOKEN: 'a' }, undefined)).toEqual({
      tag: 'v1.0.0',
      token: 'a',
      repo: REPO,
    });
    expect(
      releaseEnvironment({ TAG: 'v1.0.0', GITHUB_TOKEN: 'b', GITHUB_REPOSITORY: 'x/y' }, 'v2.0.0'),
    ).toEqual({
      tag: 'v2.0.0',
      token: 'b',
      repo: 'x/y',
    });
    expect(() => releaseEnvironment({ GH_TOKEN: 'a' }, undefined)).toThrow(/tag is required/);
    expect(() => releaseEnvironment({ TAG: 'v1.0.0' }, undefined)).toThrow(
      /GH_TOKEN or GITHUB_TOKEN/,
    );
  });

  it('errorAnnotation кодирует переводы строк и «%»: в аннотацию попадает всё сообщение', () => {
    expect(errorAnnotation('Release v0.1.0 is missing required assets.\nMissing: a, b')).toBe(
      '::error::Release v0.1.0 is missing required assets.%0AMissing: a, b',
    );
    expect(errorAnnotation('100% done\r\n')).toBe('::error::100%25 done%0D%0A');
  });
});

describe('assert-github-release-is-draft', () => {
  const release = (draft: boolean) => ({ id: 42, tag_name: TAG, draft });

  it('черновик — проходит, и ничего, кроме чтения списка, не делает', async () => {
    const github = fakeGithub([
      ['/releases?', () => json([release(true), { id: 1, tag_name: 'v0.0.9', draft: false }])],
    ]);

    const state = await checkReleaseDraftState({
      repo: REPO,
      tag: TAG,
      token: 'secret',
      restore: true,
      fetchImpl: github.fetchImpl,
    });

    expect(state).toMatchObject({ draft: true, restored: false });
    expect(github.calls).toHaveLength(1);
    expect(github.calls[0]).toMatchObject({ url: LIST_URL, method: 'GET' });
    expect(github.calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer secret',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('вышедший релиз без --restore только сообщается: релиз не трогают', async () => {
    const github = fakeGithub([['/releases?', () => json([release(false)])]]);

    const state = await checkReleaseDraftState({
      repo: REPO,
      tag: TAG,
      token: 't',
      fetchImpl: github.fetchImpl,
    });

    expect(state).toMatchObject({ draft: false, restored: false });
    expect(github.calls.map((call) => call.method)).toEqual(['GET']);
  });

  it('с --restore вышедший релиз возвращается в черновик и перестаёт быть «последним»', async () => {
    const logged: string[] = [];
    const github = fakeGithub([
      ['/releases?', () => json([release(false)])],
      ['/releases/42', () => json({ ...release(true) })],
    ]);

    const state = await checkReleaseDraftState({
      repo: REPO,
      tag: TAG,
      token: 't',
      restore: true,
      fetchImpl: github.fetchImpl,
      log: (message: string) => logged.push(message),
    });

    expect(state).toMatchObject({ draft: false, restored: true });
    expect(state.release).toMatchObject({ draft: true });
    const patch = github.calls[1];
    expect(patch).toMatchObject({
      url: `https://api.github.com/repos/${REPO}/releases/42`,
      method: 'PATCH',
    });
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ draft: true, make_latest: 'false' });
    expect(patch?.headers['Content-Type']).toBe('application/json');
    expect(logged.join('\n')).toMatch(/Restored GitHub release 42 \(v0\.1\.0\) to draft/);
  });

  it('нет релиза тега, два релиза или ответ не списком — ошибка', async () => {
    const none = fakeGithub([
      ['/releases?', () => json([{ id: 1, tag_name: 'v0.0.9', draft: true }])],
    ]);
    await expect(
      checkReleaseDraftState({ repo: REPO, tag: TAG, token: 't', fetchImpl: none.fetchImpl }),
    ).rejects.toThrow(/No GitHub release/);

    const twice = fakeGithub([
      ['/releases?', () => json([release(true), { ...release(true), id: 43 }])],
    ]);
    await expect(
      checkReleaseDraftState({ repo: REPO, tag: TAG, token: 't', fetchImpl: twice.fetchImpl }),
    ).rejects.toThrow(/refusing to pick one/);

    const notArray = fakeGithub([['/releases?', () => json({ message: 'nope' })]]);
    await expect(
      checkReleaseDraftState({ repo: REPO, tag: TAG, token: 't', fetchImpl: notArray.fetchImpl }),
    ).rejects.toThrow(/was not an array/);
  });

  it('ошибка GitHub — ошибка гейта с кодом и началом ответа; релиз без id вернуть в черновик нельзя', async () => {
    const down = fakeGithub([
      [
        '/releases?',
        () => new Response('x'.repeat(1000), { status: 502, statusText: 'Bad Gateway' }),
      ],
    ]);
    const failure = checkReleaseDraftState({
      repo: REPO,
      tag: TAG,
      token: 't',
      fetchImpl: down.fetchImpl,
    });
    await expect(failure).rejects.toThrow(/GitHub request failed 502 Bad Gateway: x+$/);
    await expect(failure).rejects.not.toThrow(/x{301}/);

    const noId = fakeGithub([['/releases?', () => json([{ tag_name: TAG, draft: false }])]]);
    await expect(
      checkReleaseDraftState({
        repo: REPO,
        tag: TAG,
        token: 't',
        restore: true,
        fetchImpl: noId.fetchImpl,
      }),
    ).rejects.toThrow(/missing a GitHub release id/);
    expect(noId.calls).toHaveLength(1);
  });
});

describe('verify-release-required-assets', () => {
  /** Черновик с файлами `assets`; манифест `latest-mac.yml` отдаётся по `/releases/assets/<id>`. */
  function releaseWith(
    assets: FakeAsset[],
    { draft = true, manifest = MANIFEST }: { draft?: boolean; manifest?: string } = {},
  ) {
    const manifestAsset = assets.find((item) => item.name === 'latest-mac.yml');
    return fakeGithub([
      [`/releases/assets/${manifestAsset?.id}`, () => new Response(manifest)],
      ['/releases?', () => json([{ id: 7, tag_name: TAG, draft, prerelease: false, assets }])],
    ]);
  }

  it('обязательные файлы — 2 dmg, 2 zip, latest-mac.yml и SHA256SUMS.txt; имена без версии', () => {
    expect([...REQUIRED_RELEASE_ASSETS].sort()).toEqual([
      'SHA256SUMS.txt',
      'latest-mac.yml',
      'parley-macos-arm64.dmg',
      'parley-macos-arm64.zip',
      'parley-macos-x64.dmg',
      'parley-macos-x64.zip',
    ]);
  });

  it('extractManifestAssetNames берёт имена из url: и path: настоящего latest-mac.yml', () => {
    expect(extractManifestAssetNames(MANIFEST).sort()).toEqual([
      'parley-macos-arm64.dmg',
      'parley-macos-arm64.zip',
      'parley-macos-x64.dmg',
      'parley-macos-x64.zip',
    ]);
    expect(
      extractManifestAssetNames(
        [
          'files:',
          '  - url: "https://github.com/Kalmbik61/Parley/releases/download/v0.1.0/parley-macos-x64.zip"',
          "  - url: 'sub/dir/parley-macos-arm64.zip'",
          'path: parley-macos-arm64.zip',
          'sha512: not-a-url',
          '',
        ].join('\r\n'),
      ).sort(),
    ).toEqual(['parley-macos-arm64.zip', 'parley-macos-x64.zip']);
  });

  it('полный черновик — проходит; манифест читается один раз как octet-stream', async () => {
    const assets = fullAssets();
    const github = releaseWith(assets);

    const result = await verifyRequiredReleaseAssets({
      repo: REPO,
      tag: TAG,
      token: 't',
      fetchImpl: github.fetchImpl,
    });

    expect(result).toEqual({
      tag: TAG,
      checked: [...REQUIRED_RELEASE_ASSETS].sort(),
      draft: true,
      prerelease: false,
    });
    const manifestCalls = github.calls.filter((call) => call.url.includes('/releases/assets/'));
    expect(manifestCalls).toHaveLength(1);
    expect(manifestCalls[0]?.headers.Accept).toBe('application/octet-stream');
  });

  it.each(REQUIRED_RELEASE_ASSETS.map((name) => [name]))(
    'нет файла %s — ошибка называет его',
    async (missing) => {
      const github = releaseWith(fullAssets().filter((item) => item.name !== missing));

      await expect(
        verifyRequiredReleaseAssets({
          repo: REPO,
          tag: TAG,
          token: 't',
          fetchImpl: github.fetchImpl,
        }),
      ).rejects.toThrow(
        new RegExp(
          `Release v0\\.1\\.0 is missing required assets\\.\\nMissing: .*${missing.replace('.', '\\.')}`,
        ),
      );
    },
  );

  it('файл не загружен до конца или пуст — ошибка с состоянием', async () => {
    const assets = fullAssets().map((item) =>
      item.name === 'parley-macos-x64.dmg'
        ? { ...item, state: 'open' }
        : item.name === 'parley-macos-arm64.zip'
          ? { ...item, size: 0 }
          : item,
    );
    const github = releaseWith(assets);

    const failure = verifyRequiredReleaseAssets({
      repo: REPO,
      tag: TAG,
      token: 't',
      fetchImpl: github.fetchImpl,
    });

    await expect(failure).rejects.toThrow(/Not uploaded: parley-macos-x64\.dmg:open/);
    await expect(failure).rejects.toThrow(/Empty: parley-macos-arm64\.zip/);
  });

  it('файл, названный в latest-mac.yml, но не лежащий в релизе, — тоже ошибка', async () => {
    const manifest = `${MANIFEST}  - url: parley-macos-universal.zip\n`;
    const github = releaseWith(fullAssets(), { manifest });

    await expect(
      verifyRequiredReleaseAssets({
        repo: REPO,
        tag: TAG,
        token: 't',
        fetchImpl: github.fetchImpl,
      }),
    ).rejects.toThrow(/Missing: parley-macos-universal\.zip/);
  });

  it('пустой или недогруженный latest-mac.yml не скачивается и не разбирается — только отмечается', async () => {
    const empty = releaseWith(
      fullAssets().map((item) => (item.name === 'latest-mac.yml' ? { ...item, size: 0 } : item)),
    );
    await expect(
      verifyRequiredReleaseAssets({ repo: REPO, tag: TAG, token: 't', fetchImpl: empty.fetchImpl }),
    ).rejects.toThrow(/Empty: latest-mac\.yml/);
    expect(empty.calls.some((call) => call.url.includes('/releases/assets/'))).toBe(false);

    const open = releaseWith(
      fullAssets().map((item) =>
        item.name === 'latest-mac.yml' ? { ...item, state: 'open' } : item,
      ),
    );
    await expect(
      verifyRequiredReleaseAssets({ repo: REPO, tag: TAG, token: 't', fetchImpl: open.fetchImpl }),
    ).rejects.toThrow(/Not uploaded: latest-mac\.yml:open/);
    expect(open.calls.some((call) => call.url.includes('/releases/assets/'))).toBe(false);
  });

  it('вышедший релиз, отсутствующий или двойной — ошибка: публикует только publish-release и только черновик', async () => {
    const published = releaseWith(fullAssets(), { draft: false });
    await expect(
      verifyRequiredReleaseAssets({
        repo: REPO,
        tag: TAG,
        token: 't',
        fetchImpl: published.fetchImpl,
      }),
    ).rejects.toThrow(/already published/);

    const other = fakeGithub([
      ['/releases?', () => json([{ id: 1, tag_name: 'v0.0.9', draft: true, assets: [] }])],
    ]);
    await expect(
      verifyRequiredReleaseAssets({ repo: REPO, tag: TAG, token: 't', fetchImpl: other.fetchImpl }),
    ).rejects.toThrow(/No GitHub release with tag/);

    const twice = fakeGithub([
      [
        '/releases?',
        () =>
          json([
            { id: 1, tag_name: TAG, draft: true, assets: [] },
            { id: 2, tag_name: TAG, draft: true, assets: [] },
          ]),
      ],
    ]);
    await expect(
      verifyRequiredReleaseAssets({ repo: REPO, tag: TAG, token: 't', fetchImpl: twice.fetchImpl }),
    ).rejects.toThrow(/refusing to pick one/);
  });

  it('релиз без поля assets — все файлы недостающие, а не падение на undefined', async () => {
    const github = fakeGithub([
      ['/releases?', () => json([{ id: 1, tag_name: TAG, draft: true }])],
    ]);

    await expect(
      verifyRequiredReleaseAssets({
        repo: REPO,
        tag: TAG,
        token: 't',
        fetchImpl: github.fetchImpl,
      }),
    ).rejects.toThrow(/Missing: SHA256SUMS\.txt, latest-mac\.yml/);
  });
});
