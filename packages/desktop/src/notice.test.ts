/**
 * Страж лицензий сборки (ревью M7, аудит приёмки MVP): NOTICE и лицензии шрифтов Figtree и
 * Caprasimo едут в `.app` (`extraResources` electron-builder), а NOTICE называет каждый файл,
 * адаптированный из shadcn/ui, и таблицу палитр терминала из Orca, и оба шрифта — с правообладателями
 * из их OFL-файлов и происхождением (Google Fonts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const notice = readFileSync(path.join(repoRoot, 'NOTICE'), 'utf8');
const builder = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');

/** Файлы рендерера с пометкой shadcn/ui в тексте — адаптации его компонентов и утилит. */
function shadcnFiles(): string[] {
  const out: string[] = [];
  const stack = [path.join(desktopRoot, 'src', 'renderer')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.') && readFileSync(full, 'utf8').includes('shadcn/ui')) {
        out.push(path.relative(repoRoot, full));
      }
    }
  }
  return out.sort();
}

const fontsDir = path.join(desktopRoot, 'src', 'renderer', 'assets', 'fonts');
const firstLine = (file: string): string => readFileSync(path.join(fontsDir, file), 'utf8').split('\n')[0] ?? '';

describe('NOTICE и лицензии в сборке (ревью M7)', () => {
  it('electron-builder кладёт NOTICE и OFL шрифтов Figtree и Caprasimo в Contents/Resources', () => {
    expect(builder).toMatch(/- from: \.\.\/\.\.\/NOTICE\n\s+to: NOTICE\n/);
    expect(builder).toMatch(/- from: src\/renderer\/assets\/fonts\/Figtree-OFL\.txt\n\s+to: licenses\/Figtree-OFL\.txt\n/);
    expect(builder).toMatch(/- from: src\/renderer\/assets\/fonts\/Caprasimo-OFL\.txt\n\s+to: licenses\/Caprasimo-OFL\.txt\n/);
  });

  it('Geist ушёл: ни из electron-builder, ни из NOTICE', () => {
    expect(builder).not.toMatch(/geist/i);
    expect(notice).not.toMatch(/geist/i);
  });

  it('NOTICE: Figtree и Caprasimo — файлы, правообладатели из OFL-файлов, происхождение Google Fonts, лицензия рядом', () => {
    for (const [name, file, license] of [
      ['Figtree', 'Figtree-Variable.ttf', 'Figtree-OFL.txt'],
      ['Caprasimo', 'Caprasimo.ttf', 'Caprasimo-OFL.txt'],
    ] as const) {
      expect(notice, name).toContain(`\n${name}\n`);
      expect(notice, `${name}: файл`).toContain(`packages/desktop/src/renderer/assets/fonts/${file}`);
      // Строка «Copyright …» — та самая, что первой стоит в OFL-файле: правится лицензия — правится и NOTICE.
      expect(firstLine(license), `${name}: первая строка OFL`).toMatch(/^Copyright \d{4} The \w+ Project Authors/);
      expect(notice, `${name}: правообладатель`).toContain(firstLine(license));
      expect(notice, `${name}: лицензия в .app`).toContain(`Contents/Resources/licenses/${license}`);
      expect(notice, `${name}: текст лицензии`).toContain(`packages/desktop/src/renderer/assets/fonts/${license}`);
    }
    expect(notice).toContain('SIL Open Font License, Version 1.1');
    expect(notice).toMatch(/Google Fonts/);
  });

  it('NOTICE называет shadcn/ui с его лицензией MIT и каждый адаптированный файл', () => {
    expect(notice).toMatch(/\nshadcn\/ui\n/);
    expect(notice).toContain('Copyright (c) 2023 shadcn');
    const files = shadcnFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(notice, file).toContain(file);
  });

  it('NOTICE называет таблицу палитр терминала из Orca', () => {
    expect(notice).toContain('packages/desktop/src/renderer/terminal/xterm-themes.ts');
  });
});
