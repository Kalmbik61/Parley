/**
 * Страж лицензий сборки (ревью M7, аудит приёмки MVP): NOTICE и лицензия шрифта Geist едут в
 * `.app` (`extraResources` electron-builder), а NOTICE называет каждый файл, адаптированный
 * из shadcn/ui, и таблицу палитр терминала из Orca.
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

describe('NOTICE и лицензии в сборке (ревью M7)', () => {
  it('electron-builder кладёт NOTICE и OFL шрифта Geist в Contents/Resources', () => {
    expect(builder).toMatch(/- from: \.\.\/\.\.\/NOTICE\n\s+to: NOTICE\n/);
    expect(builder).toMatch(/- from: src\/renderer\/assets\/fonts\/OFL\.txt\n\s+to: licenses\/Geist-OFL\.txt\n/);
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
