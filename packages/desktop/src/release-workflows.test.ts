/**
 * Страж workflow GitHub Actions (`.github/workflows/`, план релиза 0.1.0, V4 и V5). Файлы выполняются только на
 * GitHub, а ошибка в них всплывает в худший момент — при выпуске. Тест держит то, что нельзя менять случайно:
 * безопасность (имя тега и другие строки извне не попадают в `run`, токен — только в `env` шага, который зовёт
 * `gh`, действия закреплены по SHA, права задач), состав шагов CI и цепочку create-release → build-mac →
 * publish-release.
 *
 * YAML не разбирается: пакета для этого в зависимостях нет, а файлы пишутся в одном ровном стиле — хватает
 * регулярных выражений по тексту, как в `release-config.test.ts`. Шаг проверки «коммит тега — в master» тест
 * ещё и выполняет: берёт его `run` из файла и гоняет в настоящем git-репозитории во временном каталоге.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const names = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
const read = (name: string): string => readFileSync(path.join(workflowsDir, name), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');

/**
 * Действия, которые workflow вправе брать: каждое — по полному SHA коммита, версия — в комментарии рядом. Подвижный
 * тег (`@v4`) переставляют без единого коммита в этом репозитории, и чужой код исполнялся бы в задаче с токеном на
 * запись; SHA не переставить. Новое действие или новая версия — осознанная правка этого списка вместе с workflow
 * (SHA — `git ls-remote --tags <репозиторий> <тег>`, у аннотированного тега — строка с `^{}`).
 */
const ALLOWED_ACTIONS: Record<string, { sha: string; version: string }> = {
  'actions/cache': { sha: '0057852bfaa89a56745cba8c7296529d2fc39830', version: 'v4.3.0' },
  'actions/checkout': { sha: '11d5960a326750d5838078e36cf38b85af677262', version: 'v4.4.0' },
  'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', version: 'v4.4.0' },
  'actions/upload-artifact': { sha: 'ea165f8d65b6e75b540449e92b4886f43607fa02', version: 'v4.6.2' },
  'pnpm/action-setup': { sha: 'b906affcce14559ad1aafd4ab0e942779e9f58b1', version: 'v4.3.0' },
};

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

/** Задачи файла: имя → текст от `  имя:` до следующей задачи. */
function jobsOf(workflow: string): Map<string, string> {
  const start = workflow.indexOf('\njobs:\n');
  const text = workflow.slice(start + '\njobs:\n'.length);
  const headers = [...text.matchAll(/^ {2}([\w-]+):\n/gm)];
  const jobs = new Map<string, string>();
  for (const [index, header] of headers.entries()) {
    const end = headers[index + 1]?.index ?? text.length;
    jobs.set(header[1] ?? '', text.slice(header.index, end));
  }
  return jobs;
}

/** Шаги задачи: текст от `      - name:` до следующего шага. */
function stepsOf(job: string): string[] {
  return job.split(/^(?= {6}- )/m).slice(1);
}

const stepName = (step: string): string => /^ {6}- name: (.+)$/m.exec(step)?.[1] ?? '(без имени)';

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

  it.each(names)(
    '%s: действия — из закреплённого списка, по полному SHA коммита, с версией в комментарии',
    (name) => {
      const used = [...read(name).matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)].map(
        (match) => match[1] ?? '',
      );

      expect(used.length).toBeGreaterThan(0);
      for (const line of used) {
        const match = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40}) # (v\d+\.\d+\.\d+)$/.exec(line);
        expect(match, `${name}: «${line}» — не вида «имя@<40 hex> # vX.Y.Z»`).not.toBeNull();
        const [, action = '', sha, version] = match ?? [];
        expect(ALLOWED_ACTIONS[action], `${name}: ${action}`).toEqual({ sha, version });
      }
    },
  );

  it.each(names)('%s: checkout не оставляет токен в .git (persist-credentials: false)', (name) => {
    const text = read(name);
    const checkouts = text.match(/uses: actions\/checkout@[0-9a-f]{40}/g) ?? [];

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
      const step = text.slice(text.indexOf('uses: pnpm/action-setup@')).split('\n\n')[0] ?? '';
      expect(step).toContain('pnpm/action-setup@');
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

  it('права: по умолчанию чтение, запись — у трёх задач, и каждая просит её у себя; один прогон на ref, прерывать нельзя', () => {
    expect(release).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    const jobs = jobsOf(release);
    expect([...jobs.keys()]).toEqual(['create-release', 'build-mac', 'publish-release']);
    for (const [name, job] of jobs) {
      expect(job, `${name}: права задачи`).toMatch(
        /^ {4}permissions:\n {6}contents: write\n(?! {6})/m,
      );
    }
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
      'bash scripts/release/verify-packaged-apps.sh',
    ].map((command) => scripts.indexOf(command));
    expect(
      order.every((position) => position >= 0),
      `команды на месте: ${order.join(', ')}`,
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('кэш electron и electron-builder — по pnpm-lock', () => {
    expect(release).toMatch(/uses: actions\/cache@[0-9a-f]{40} # v4\.\d+\.\d+/);
    expect(release).toMatch(/^ {12}~\/Library\/Caches\/electron$/m);
    expect(release).toMatch(/^ {12}~\/Library\/Caches\/electron-builder$/m);
    expect(release).toContain("hashFiles('pnpm-lock.yaml')");
  });

  it('загрузка в релиз — только в настоящем релизе; пробный прогон кладёт файлы в артефакты', () => {
    expect(release).toMatch(
      /- name: Upload the files to the draft release\n\s+if: needs\.create-release\.result == 'success'\n/,
    );
    expect(release).toMatch(
      /- name: Keep the files as run artifacts\n\s+if: needs\.create-release\.result == 'skipped'\n/,
    );
  });

  it('electron-builder ничего не публикует (--publish never) и токена у сборки нет: файлы в черновик кладёт шаг ниже', () => {
    const scripts = runScripts(release);
    expect(scripts.filter((script) => script.includes('--publish always'))).toEqual([]);
    expect(scripts.filter((script) => script.includes('--publish never'))).toHaveLength(1);
    // Шаг один на оба режима: пробный прогон и настоящий собирают одной командой.
    expect(release).not.toMatch(/- name: Package for macOS \(dry run\)/);
  });

  it('токен — только у шагов, которые зовут gh или скрипты scripts/release; сборка и установка зависимостей его не получают', () => {
    let withToken = 0;
    for (const [jobName, job] of jobsOf(release)) {
      for (const step of stepsOf(job)) {
        if (!step.includes('GH_TOKEN')) continue;
        withToken += 1;
        const script = runScripts(step).join('\n');
        const where = `${jobName} / ${stepName(step)}`;
        expect(script, where).toMatch(/\bgh (?:api|release) |node scripts\/release\//);
        expect(script, where).not.toMatch(/\b(?:pnpm|npm|npx|yarn|electron-builder)\b/);
      }
    }
    // create-release (черновик), build-mac (загрузка, гейт), publish-release (проверка, публикация).
    expect(withToken).toBe(5);
  });

  it('загрузка в черновик — после сборки, проверки собранного и SHA256SUMS.txt: битые файлы в релиз не попадают', () => {
    const names = stepsOf(jobsOf(release).get('build-mac') ?? '').map(stepName);
    const at = (name: string): number => {
      expect(names, name).toContain(name);
      return names.indexOf(name);
    };

    expect(at('Package for macOS')).toBeLessThan(at('Verify the packaged apps'));
    expect(at('Verify the packaged apps')).toBeLessThan(at('Create SHA256SUMS.txt'));
    expect(at('Create SHA256SUMS.txt')).toBeLessThan(at('Upload the files to the draft release'));
    expect(at('Upload the files to the draft release')).toBeLessThan(
      at('Check the release is still a draft'),
    );
  });

  it('SHA256SUMS.txt по всем dmg и zip уходит в релиз вместе с файлами сборки', () => {
    const scripts = runScripts(release);

    expect(
      scripts.some((script) => script.includes('shasum -a 256 *.dmg *.zip > SHA256SUMS.txt')),
    ).toBe(true);
    // Те же файлы, что публиковал бы electron-builder (dmg, zip, blockmap, latest-mac.yml), и сверка сумм.
    expect(scripts).toContain(
      'gh release upload "$TAG" *.dmg *.zip *.blockmap latest-mac.yml SHA256SUMS.txt --clobber --repo "$GITHUB_REPOSITORY"',
    );
    expect(release).toMatch(
      /- name: Upload the files to the draft release\n(?: {8}.*\n)*? {8}working-directory: packages\/desktop\/dist\n/,
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

  it('create-release забирает всю историю: без неё нельзя проверить, что коммит тега лежит в master', () => {
    const checkout = stepsOf(jobsOf(release).get('create-release') ?? '').find(
      (step) => stepName(step) === 'Checkout',
    );

    expect(checkout).toMatch(/^ {10}fetch-depth: 0$/m);
    expect(checkout).toMatch(/^ {10}persist-credentials: false$/m);
  });

  it('проверка коммита тега идёт после разбора тега и до создания черновика', () => {
    const names = stepsOf(jobsOf(release).get('create-release') ?? '').map(stepName);
    const check = names.indexOf('Check the tagged commit is in master');

    expect(check).toBeGreaterThan(names.indexOf('Check the tag and read the release notes'));
    expect(check).toBeLessThan(names.indexOf('Create the draft release'));
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

describe('release.yml: шаг «коммит тега лежит в master» — выполняется как написан', () => {
  const script =
    runScripts(release).find((text) => text.includes('merge-base --is-ancestor')) ?? '';
  let repo = '';

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.test',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (file: string): string => {
    writeFileSync(path.join(repo, file), file);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const runStep = () => spawnSync('bash', ['-c', script], { cwd: repo, env, encoding: 'utf8' });

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'rel-master-'));
    git('init', '-q');
    git('symbolic-ref', 'HEAD', 'refs/heads/master');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('шаг в файле есть', () => {
    expect(script).toContain('git merge-base --is-ancestor HEAD origin/master');
  });

  it('тег на коммите из истории master (и на его конце) — проходит', () => {
    const first = commit('a');
    commit('b');
    // Так выглядит master после `actions/checkout` с `fetch-depth: 0`: ветка — как удалённая `origin/master`.
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');

    git('checkout', '-q', '--detach', first);
    expect(runStep().status).toBe(0);
    git('checkout', '-q', '--detach', 'master');
    expect(runStep().status).toBe(0);
  });

  it('тег на коммите ветки, которой нет в master, — релиз не создаётся', () => {
    commit('a');
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    git('checkout', '-q', '-b', 'feat/release');
    commit('c');

    const result = runStep();

    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^::error::The tagged commit is not in the history of master/m);
  });

  it('master не найден (нет origin/master) — тоже отказ, а не тихий пропуск', () => {
    commit('a');

    expect(runStep().status).not.toBe(0);
  });
});
