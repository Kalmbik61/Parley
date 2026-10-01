/**
 * Страж workflow GitHub Actions (`.github/workflows/`, план релиза 0.1.0, V4 и V5). Файлы выполняются только на
 * GitHub, а ошибка в них всплывает в худший момент — при выпуске. Тест держит то, что нельзя менять случайно:
 * безопасность (имя тега и другие строки извне не попадают в `run`, токен — только в `env` шага, действия
 * закреплены), состав шагов CI и цепочку create-release → build-mac → publish-release.
 *
 * YAML не разбирается: пакета для этого в зависимостях нет, а файлы пишутся в одном ровном стиле — хватает
 * регулярных выражений по тексту, как в `release-config.test.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const names = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
const read = (name: string): string => readFileSync(path.join(workflowsDir, name), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');

/** Действия, которые workflow вправе брать, — каждое закреплено мажорной версией. Новое — осознанная правка списка. */
const ALLOWED_ACTIONS = [
  'actions/cache@v4',
  'actions/checkout@v4',
  'actions/setup-node@v4',
  'actions/upload-artifact@v4',
  'pnpm/action-setup@v4',
];

/** Тексты всех `run:` файла: однострочные и блочные (`|`, `>` с `-`/`+`). Комментарии не попадают. */
function runScripts(workflow: string): string[] {
  const lines = workflow.split('\n');
  const scripts: string[] = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (match === null) continue;
    const indent = (match[1] ?? '').length;
    const rest = (match[2] ?? '').trim();
    if (!/^[|>][+-]?\d*$/.test(rest)) {
      scripts.push(rest);
      continue;
    }
    const body: string[] = [];
    for (const next of lines.slice(index + 1)) {
      if (next.trim() !== '' && next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

describe('workflow: общие правила безопасности', () => {
  it('есть ci.yml и release.yml', () => {
    expect(names).toEqual(expect.arrayContaining(['ci.yml', 'release.yml']));
  });

  it.each(names)(
    '%s: нет pull_request_target — код PR из форка не получает токен с записью',
    (name) => {
      expect(read(name)).not.toMatch(/pull_request_target/);
    },
  );

  it.each(names)(
    '%s: ни одной подстановки ${{ … }} в run — тег и прочие строки извне идут через env',
    (name) => {
      const scripts = runScripts(read(name));

      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) expect(script).not.toContain('${{');
    },
  );

  it.each(names)('%s: действия — из закреплённого списка, с мажорной версией', (name) => {
    const used = [...read(name).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    );

    expect(used.length).toBeGreaterThan(0);
    for (const action of used) expect(ALLOWED_ACTIONS, `${name}: ${action}`).toContain(action);
  });

  it.each(names)('%s: checkout не оставляет токен в .git (persist-credentials: false)', (name) => {
    const text = read(name);
    const checkouts = text.match(/uses: actions\/checkout@v4/g) ?? [];

    expect(checkouts.length).toBeGreaterThan(0);
    expect(text.match(/^\s+persist-credentials: false$/gm) ?? []).toHaveLength(checkouts.length);
  });

  it.each(names)(
    '%s: токен репозитория — только в env отдельного шага, не в env задачи или workflow',
    (name) => {
      const lines = read(name)
        .split('\n')
        .filter((line) => line.includes('secrets.'));

      for (const line of lines)
        expect(line).toMatch(/^ {10}GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$/);
    },
  );

  it.each(names)('%s: права токена заданы явно на верхнем уровне', (name) => {
    expect(read(name)).toMatch(/^permissions:\n {2}contents: (?:read|write)\n(?! )/m);
  });
});

describe('ci.yml (V4)', () => {
  it('запускается на pull request и push в master, на macos-15, права — только чтение', () => {
    expect(ci).toMatch(/^on:\n {2}pull_request:\n {2}push:\n {4}branches: \[master\]\n/m);
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(ci).toMatch(/^ {4}runs-on: macos-15$/m);
  });

  it('шаги по порядку: install --frozen-lockfile, build, typecheck, lint, юнит-тесты всех пакетов с --retry=1', () => {
    expect(runScripts(ci)).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm build',
      'pnpm typecheck',
      'pnpm lint',
      'pnpm -r --workspace-concurrency=1 --no-bail run test --retry=1',
    ]);
  });

  it('pnpm — той версии, что в packageManager корня: своей version у action-setup нет', () => {
    for (const text of [ci, release]) {
      // Шаг — до пустой строки: от `uses:` и его `with:` (если есть).
      const step = text.slice(text.indexOf('uses: pnpm/action-setup@v4')).split('\n\n')[0] ?? '';
      expect(step).toContain('pnpm/action-setup@v4');
      expect(step).not.toMatch(/\bversion:/);
    }
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });
});

describe('release.yml (V5)', () => {
  it('запускается на теге v* и вручную; у ручного запуска dry_run, по умолчанию включён', () => {
    expect(release).toMatch(
      /^on:\n {2}push:\n {4}tags: \['v\*'\]\n {2}workflow_dispatch:\n {4}inputs:\n {6}dry_run:\n/m,
    );
    expect(release).toMatch(
      /^ {6}dry_run:\n(?: {8}.*\n)*? {8}type: boolean\n(?: {8}.*\n)*? {8}default: true\n/m,
    );
  });

  it('права — contents: write; один прогон на ref, прерывать нельзя', () => {
    expect(release).toMatch(/^permissions:\n {2}contents: write\n(?! )/m);
    expect(release).toMatch(
      /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/m,
    );
  });

  it('три задачи по цепочке: create-release → build-mac → publish-release', () => {
    expect(release).toMatch(
      /^ {2}create-release:\n[\s\S]*\n {2}build-mac:\n[\s\S]*\n {2}publish-release:\n/m,
    );
    expect(release).toMatch(/^ {2}build-mac:\n(?: {4}.*\n| *\n)*? {4}needs: create-release\n/m);
    expect(release).toMatch(
      /^ {2}publish-release:\n(?: {4}.*\n| *\n)*? {4}needs: \[create-release, build-mac\]\n/m,
    );
    // Пробный прогон: create-release пропущена, и publish-release тоже; условия на publish-release нет.
    expect(release).toMatch(
      /^ {4}if: github\.event_name == 'push' \|\| inputs\.dry_run == false$/m,
    );
    expect(release.slice(release.indexOf('\n  publish-release:'))).not.toMatch(/^ {4}if:/m);
  });

  it('тег — только значением TAG в env, никогда в run', () => {
    for (const line of release.split('\n').filter((item) => item.includes('github.ref_name'))) {
      expect(line).toMatch(/^ {10}TAG: \$\{\{ github\.ref_name \}\}$/);
    }
    expect(release).toMatch(/node scripts\/release\/prepare-release\.mjs/);
  });

  it('сборка на macos-15: install с повтором, build, fetch-node для двух архитектур, dist с электрон-билдером', () => {
    const scripts = runScripts(release).join('\n----\n');

    expect(release).toMatch(/^ {2}build-mac:\n(?: {4}.*\n)*? {4}runs-on: macos-15$/m);
    expect(scripts).toMatch(
      /for attempt in 1 2 3; do\n\s+if pnpm install --frozen-lockfile; then exit 0; fi/,
    );
    const order = [
      'pnpm build',
      'pnpm --filter @parley/desktop fetch-node arm64 x64',
      'pnpm --filter @parley/desktop dist --mac --arm64 --x64 --publish never',
      'pnpm --filter @parley/desktop dist --mac --arm64 --x64 --publish always',
      'bash scripts/release/verify-packaged-apps.sh',
    ].map((command) => scripts.indexOf(command));
    expect(
      order.every((position) => position >= 0),
      `команды на месте: ${order.join(', ')}`,
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('кэш electron и electron-builder — по pnpm-lock', () => {
    expect(release).toContain('uses: actions/cache@v4');
    expect(release).toMatch(/^ {12}~\/Library\/Caches\/electron$/m);
    expect(release).toMatch(/^ {12}~\/Library\/Caches\/electron-builder$/m);
    expect(release).toContain("hashFiles('pnpm-lock.yaml')");
  });

  it('публикация и загрузка — только в настоящем релизе; пробный прогон кладёт файлы в артефакты', () => {
    expect(release).toMatch(
      /- name: Package for macOS \(dry run\)\n\s+if: needs\.create-release\.result == 'skipped'\n/,
    );
    expect(release).toMatch(
      /- name: Package for macOS and upload to the draft release\n\s+if: needs\.create-release\.result == 'success'\n/,
    );
    expect(release).toMatch(
      /- name: Keep the files as run artifacts\n\s+if: needs\.create-release\.result == 'skipped'\n/,
    );
    expect(release.match(/--publish always/g)).toHaveLength(1);
  });

  it('SHA256SUMS.txt по всем dmg и zip уходит в релиз', () => {
    const scripts = runScripts(release);

    expect(
      scripts.some((script) => script.includes('shasum -a 256 *.dmg *.zip > SHA256SUMS.txt')),
    ).toBe(true);
    expect(scripts).toContain(
      'gh release upload "$TAG" packages/desktop/dist/SHA256SUMS.txt --clobber --repo "$GITHUB_REPOSITORY"',
    );
  });

  it('гейты: после загрузки — релиз ещё черновик (с возвратом в черновик), перед публикацией — черновик и все файлы', () => {
    const scripts = runScripts(release);

    expect(scripts).toContain('node scripts/release/assert-github-release-is-draft.mjs --restore');
    const publish =
      scripts.find((script) => script.includes('verify-release-required-assets.mjs')) ?? '';
    expect(publish.indexOf('assert-github-release-is-draft.mjs')).toBeGreaterThanOrEqual(0);
    expect(publish).not.toContain('--restore');
    expect(publish.indexOf('assert-github-release-is-draft.mjs')).toBeLessThan(
      publish.indexOf('verify-release-required-assets.mjs'),
    );
  });

  it('публикует одна команда, в одной задаче: --draft=false и prerelease по тегу', () => {
    expect(release.match(/--draft=false/g)).toHaveLength(1);
    expect(runScripts(release)).toContain(
      'gh release edit "$TAG" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease="$PRERELEASE"',
    );
    expect(release.slice(release.indexOf('\n  publish-release:'))).toContain('--draft=false');
  });

  it('черновик создаёт create-release: с названием «Parley <версия>», заметками из файла и --verify-tag', () => {
    const create = runScripts(release).find((script) => script.includes('gh release create')) ?? '';

    expect(create).toContain('--draft --verify-tag');
    expect(create).toContain(
      '--title "Parley $VERSION" --notes-file "$NOTES_FILE" --prerelease="$PRERELEASE"',
    );
  });

  it('все скрипты, которые зовут workflow, лежат в репозитории', () => {
    const referenced = new Set(
      [...runScripts(release), ...runScripts(ci)].flatMap(
        (script) => script.match(/scripts\/release\/[\w.-]+/g) ?? [],
      ),
    );

    expect(referenced.size).toBeGreaterThanOrEqual(4);
    for (const script of referenced)
      expect(existsSync(path.join(repoRoot, script)), script).toBe(true);
  });
});
