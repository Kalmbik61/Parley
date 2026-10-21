/**
 * Документы первого релиза (README, CHANGELOG; план релиза 0.1.0, V7, правки ревью F): то, что они обещают человеку об
 * обновлении, совпадает с тем, что делает код, а имя прежнего проекта и русский текст в них не всплывают — это
 * лицо репозитория для человека, который его открыл впервые. С PR #98 README — короткий обзор, а не подробное
 * руководство: тест проверяет только то, что он ещё обещает (раздел «Updates», шаг «Allow the first launch»,
 * «Requirements»). Тексты окна, которые документ цитирует («Notifications»), берутся из `shared/strings.ts`:
 * переименовали раздел — тест напомнит о README.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { S } from './shared/strings.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const changelog = readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');

/** Раздел README: от `## Название` или `### Название` до следующего заголовка любого уровня. */
function section(title: string): string {
  const match = new RegExp(`\\n#{2,3} ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`).exec(readme);
  expect(match, `раздел «${title}» в README`).not.toBeNull();
  const start = match?.index ?? 0;
  const next = readme.slice(start + 1).search(/\n#{1,6} /);
  return readme.slice(start, next === -1 ? undefined : start + 1 + next);
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

describe('README, «Updates» и первый запуск: обещания совпадают с кодом', () => {
  const updates = flat(section('Updates'));

  it('называет раздел настроек так, как он написан в strings.ts', () => {
    expect(updates).toContain(`Settings → ${S.settings.sections.notifications}`);
  });

  it('само не обновляется — в коде нет автоустановки', () => {
    expect(updates).toContain('it does not update itself');
    const main = readFileSync(
      path.join(repoRoot, 'packages', 'desktop', 'src', 'main', 'index.ts'),
      'utf8',
    );
    expect(main).not.toMatch(/autoUpdater/);
  });

  it('⌘Q останавливает и агентов: выход идёт через сторож will-quit, который гасит хост', () => {
    expect(updates).toContain('Quit Parley with ⌘Q (this also stops its agents)');
    const main = path.join(repoRoot, 'packages', 'desktop', 'src', 'main');
    const guard = readFileSync(path.join(main, 'quit-guard.ts'), 'utf8');
    expect(guard).toContain("app.on('will-quit', onWillQuit)");
    expect(guard).toContain('await deps.stopHost()');
    const index = readFileSync(path.join(main, 'index.ts'), 'utf8');
    expect(index).toContain('guardAppQuit(app, {');
    expect(index).toContain('await connection.stopHost()');
  });

  it('после замены приложения команду xattr нужно выполнить снова — она есть в шаге «Allow the first launch»', () => {
    expect(updates).toContain('run the `xattr` command again');
    expect(section('2. Allow the first launch')).toContain(
      'xattr -dr com.apple.quarantine /Applications/Parley.app',
    );
  });
});

describe('README и CHANGELOG: Intel-сборка не проверена на Intel', () => {
  it('README, «Requirements»', () => {
    expect(flat(section('Requirements'))).toMatch(
      /The Intel build has not been tested on an Intel Mac yet/,
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

describe('версии пакетов одной сборки (ревью 0.2.0, п. 13)', () => {
  it('окно сверяет версию хоста со своей: у корня, core, protocol, host, file-icons и desktop она одна', () => {
    const version = (file: string): string =>
      (JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8')) as { version: string }).version;
    const desktop = version('packages/desktop/package.json');
    for (const file of [
      'package.json',
      'packages/core/package.json',
      'packages/protocol/package.json',
      'packages/host/package.json',
      'packages/file-icons/package.json',
    ]) {
      expect(version(file), file).toBe(desktop);
    }
  });
});
