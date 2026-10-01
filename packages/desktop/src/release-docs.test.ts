/**
 * Документы первого релиза (README, CHANGELOG; план релиза 0.1.0, V7, правки ревью F): то, что они обещают человеку об
 * обновлении, совпадает с тем, что делает код, а имя прежнего проекта и русский текст в них не всплывают — это
 * лицо репозитория для человека, который его открыл впервые. Тексты окна, которые документ цитирует («Restart
 * host…», «Check for updates»), берутся из `shared/strings.ts`: переименовали кнопку — тест напомнит о README.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { S } from './shared/strings.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

/** Раздел README третьего уровня: от `### Название` до следующего заголовка. */
function section(title: string): string {
  const start = readme.indexOf(`\n### ${title}\n`);
  expect(start, `раздел «${title}» в README`).toBeGreaterThan(-1);
  const next = readme.indexOf('\n#', start + 1);
  return readme.slice(start, next === -1 ? undefined : next);
}

/** Текст без переносов строк внутри абзацев: фразы документа не должны зависеть от того, где он сломан. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('README и CHANGELOG — для человека, который открыл репозиторий впервые', () => {
  it.each([
    ['README.md', readme],
    ['CHANGELOG.md', changelog],
  ])('%s: по-английски и без прежнего имени проекта', (_name, text) => {
    expect(text).not.toMatch(/harnas/i);
    expect(text).not.toMatch(/[Ѐ-ӿ]/);
  });
});

describe('README, «Updates»: обещания совпадают с кодом', () => {
  const updates = flat(section('Updates'));

  it('цитирует тексты окна так, как они написаны в strings.ts', () => {
    expect(updates).toContain(`"${S.update.available('X.Y.Z')}"`);
    expect(updates).toContain(`"${S.update.download}"`);
    expect(updates).toContain(`"${S.update.later}"`);
    expect(updates).toContain(`"${S.actions.restartHost}"`);
    expect(updates).toContain(`"${S.statusBar.hostOutdated}"`);
    expect(updates).toContain(`"${S.settings.checkForUpdates}"`);
    expect(updates).toContain(S.settings.sections.notifications);
  });

  it('приватность: запрос обычный, без токена и куки, но GitHub видит IP-адрес — «не спрашивает» в любом случае не обещано', () => {
    expect(updates).toMatch(/no token and no cookies/);
    expect(updates).toMatch(/GitHub does see the request itself, so your IP address/);
    expect(updates).not.toMatch(/Either way the window does not ask GitHub/);
  });

  it('переменная PARLEY_UPDATE_CHECK=off читается из снятого окружения оболочки: не ответила за срок — не видна, помогает переключатель', () => {
    expect(updates).toContain('`PARLEY_UPDATE_CHECK=off`');
    expect(updates).toMatch(/shell did not answer in time.*not seen/);
    expect(updates).toMatch(/only the switch in Settings/);
  });

  it('«Later» — только закрыть тост, версию закрывают «Download» и смахивание: так написано и так делает update-notice', () => {
    expect(updates).toMatch(
      /"Download", or swiping the toast away.*does not come back for that version/,
    );
    expect(updates).toMatch(/"Later" only closes the toast/);
    const notice = readFileSync(
      path.join(repoRoot, 'packages', 'desktop', 'src', 'renderer', 'update', 'update-notice.ts'),
      'utf8',
    );
    // Кнопка «Later» — пустой обработчик; запись версии стоит у «Download» и у смахивания.
    expect(notice).toMatch(/cancel: \{ label: S\.update\.later, onClick: \(\) => \{\} \}/);
    expect(notice).toMatch(/onDismiss: \(\) => dismiss\(version\)/);
  });

  it('из исходников (pnpm dev:desktop) проверки нет — как в main/index.ts', () => {
    expect(updates).toMatch(/started from source \(`pnpm dev:desktop`\) does not check/);
    const main = readFileSync(
      path.join(repoRoot, 'packages', 'desktop', 'src', 'main', 'index.ts'),
      'utf8',
    );
    expect(main).toContain('updateCheckAllowed(shellEnv.env, app.isPackaged)');
  });

  it('после замены приложения — «Restart host…» и без баннера: у живых агентов в командах пути внутри старого приложения', () => {
    expect(updates).toMatch(/even if the window does not say "Host is outdated — restart"/);
    expect(updates).toMatch(/only when the host lacks methods/);
    expect(updates).toMatch(/status line.*MCP server.*Codex/);
    expect(updates).toMatch(/Live agents are interrupted and come back through `--resume`/);
  });

  it('подпись ad hoc: шаги первого запуска повторяются при каждом обновлении, и macOS может спросить доступ к папкам снова', () => {
    expect(updates).toMatch(/signed ad hoc/);
    expect(updates).toMatch(/"First launch" steps repeat/);
    expect(updates).toMatch(/Documents, Desktop and Downloads/);
  });
});

describe('README, «Build `Parley.app`»: что лежит в собранном приложении', () => {
  it('рядом со встроенным node едет его LICENSE — как кладёт fetch-node и проверяет verify-packaged-apps.sh', () => {
    const build = flat(section('Build `Parley.app`'));

    expect(build).toContain('`Contents/Resources/node/bin/node`');
    expect(build).toContain('`Contents/Resources/node/LICENSE`');
    const verify = readFileSync(
      path.join(repoRoot, 'scripts', 'release', 'verify-packaged-apps.sh'),
      'utf8',
    );
    expect(verify).toContain('"$resources/node/LICENSE"');
  });
});

describe('README и CHANGELOG: Intel-сборка не проверена на Intel', () => {
  it('README, «Requirements»', () => {
    expect(flat(section('Requirements'))).toMatch(
      /Intel build is made on an Apple Silicon machine.*not been tested on an Intel Mac/,
    );
  });

  it('CHANGELOG, «Known limitations»: то же, плюс перезапуск хоста после замены приложения', () => {
    const start = changelog.indexOf('### Known limitations');
    expect(start).toBeGreaterThan(-1);
    const limitations = flat(changelog.slice(start));

    expect(limitations).toMatch(
      /Intel build is made on an Apple Silicon machine.*not been tested on an Intel Mac/,
    );
    expect(limitations).toContain(`"${S.actions.restartHost}"`);
    expect(limitations).toMatch(/steps repeat after each update/);
  });
});
